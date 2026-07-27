import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  compileToBytecode,
  compileToBytecodeForRuntime,
  resolveElectronPath,
} from "../src/compiler";
import { getBytecodeLoaderCode } from "../src/loader";

/**
 * Node and Electron ship different V8 builds, so cached data produced by one is
 * rejected by the other. These tests pin that asymmetry down in both
 * directions, because it is the entire reason the `runtime` option exists.
 *
 * Every load runs in a freshly spawned process. That is not incidental: V8
 * keeps an in-isolate compilation cache keyed by source text, and the dummy
 * source this loader reconstructs depends only on the *length* recorded in the
 * bytecode header. Node- and Electron-compiled buffers for the same input
 * therefore rebuild a byte-identical dummy source. Loading both in one isolate
 * makes the second load silently reuse the first one's compilation, reporting
 * `cachedDataRejected === false` for bytecode that was in fact incompatible.
 * An earlier version of this file did exactly that and asserted success, so it
 * passed while proving nothing. Do not load bytecode in the test process.
 */

const source = `
"use strict";
module.exports = { greet: (name) => "Hello, " + name + "!" };
`;

const hasElectronDisplay =
  process.platform !== "linux" ||
  Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);

// A missing display used to skip every real-Electron test and still report
// green. In CI that silently deletes the coverage this file exists to provide.
if (process.env.CI && !hasElectronDisplay) {
  throw new Error(
    "Electron tests require a display in CI. Run the suite under `xvfb-run --auto-servernum`."
  );
}

type LoadResult = {
  error: string | null;
  rejected: boolean | null;
  value: string | null;
};

/**
 * Loads `input.jsc` through the loader the plugin actually ships, so a
 * rejection here is the exact failure a consumer would hit. `rejected` is
 * derived from the loader's own error at `src/loader.ts:68-70` rather than
 * from a private re-implementation of its header handling.
 */
const loaderCore = String.raw`
const fs = require("node:fs");
require("./bytecode-loader.cjs");

function loadBytecode() {
  try {
    const loaded = require("./input.jsc");
    return { error: null, rejected: false, value: loaded.greet("Test") };
  } catch (error) {
    return {
      error: error.message,
      rejected: error.message.includes("cachedDataRejected"),
      value: null,
    };
  }
}
`;

const nodeLoaderScript = `${loaderCore}
fs.writeFileSync(process.argv[2], JSON.stringify(loadBytecode()));
`;

const electronLoaderScript = `const { app } = require("electron");
${loaderCore}
try {
  fs.writeFileSync(
    process.env.VITE_BYTECODE_RESULT,
    JSON.stringify(loadBytecode())
  );
  app.exit(0);
} catch (error) {
  console.error(error);
  app.exit(1);
}
`;

/** Writes a runnable directory holding the bytecode and the shipped loader. */
async function createLoadDirectory(
  prefix: string,
  bytecode: Buffer,
  entryName: string,
  entryScript: string
): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));

  await Promise.all([
    writeFile(path.join(directory, "input.jsc"), bytecode),
    writeFile(path.join(directory, "bytecode-loader.cjs"), getBytecodeLoaderCode()),
    writeFile(path.join(directory, entryName), entryScript),
  ]);

  return directory;
}

/** Loads bytecode in a pristine Node process. */
async function loadInNode(bytecode: Buffer): Promise<LoadResult> {
  const directory = await createLoadDirectory(
    "vite-bytecode-node-load-",
    bytecode,
    "load.cjs",
    nodeLoaderScript
  );
  const resultPath = path.join(directory, "result.json");

  try {
    execFileSync(process.execPath, [path.join(directory, "load.cjs"), resultPath], {
      stdio: ["ignore", "ignore", "pipe"],
    });

    return JSON.parse(await readFile(resultPath, "utf8")) as LoadResult;
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

/** Loads bytecode in a real Electron main process. */
async function loadInElectron(bytecode: Buffer): Promise<LoadResult> {
  const directory = await createLoadDirectory(
    "vite-bytecode-electron-load-",
    bytecode,
    "main.cjs",
    electronLoaderScript
  );
  const resultPath = path.join(directory, "result.json");

  try {
    await writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({
        main: "main.cjs",
        name: "vite-bytecode-electron-load",
        private: true,
      })
    );

    await new Promise<void>((resolve, reject) => {
      const environment: NodeJS.ProcessEnv = {
        ...process.env,
        VITE_BYTECODE_RESULT: resultPath,
      };
      // The plugin compiles in a real main process, never in Node mode, so the
      // harness has to match or it would exercise a different V8 entry path.
      delete environment.ELECTRON_RUN_AS_NODE;

      const args = [`--user-data-dir=${path.join(directory, "user-data")}`];
      if (process.platform === "linux" && process.getuid?.() === 0) {
        args.push("--no-sandbox");
      }
      args.push(directory);

      const child = spawn(resolveElectronPath(), args, {
        env: environment,
        stdio: ["ignore", "ignore", "pipe"],
      });
      const stderr: Buffer[] = [];

      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", reject);
      child.on("close", (exitCode, signal) => {
        if (exitCode !== 0 || signal) {
          const details = Buffer.concat(stderr).toString("utf8").trim();
          reject(
            new Error(
              `Electron exited with ${signal ?? `code ${String(exitCode)}`}${
                details ? `: ${details}` : ""
              }`
            )
          );
          return;
        }
        resolve();
      });
    });

    return JSON.parse(await readFile(resultPath, "utf8")) as LoadResult;
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

/** Reads version metadata out of the Electron binary itself. */
function readElectronVersions(): {
  electron: string;
  node: string;
  v8: string;
} {
  const output = execFileSync(
    resolveElectronPath(),
    [
      "-p",
      "JSON.stringify({electron: process.versions.electron, node: process.versions.node, v8: process.versions.v8})",
    ],
    { encoding: "utf8", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } }
  );

  return JSON.parse(output.trim()) as {
    electron: string;
    node: string;
    v8: string;
  };
}

describe.skipIf(!hasElectronDisplay)("Node and Electron bytecode runtimes", () => {
  let nodeBytecode: Buffer;
  let electronBytecode: Buffer;

  beforeAll(async () => {
    nodeBytecode = compileToBytecode(source);
    // Goes through the same production path the plugin uses for
    // `runtime: "electron"`, rather than a hand-rolled compiler script.
    electronBytecode = await compileToBytecodeForRuntime(source, {
      runtime: "electron",
    });
  }, 60_000);

  it("executes Node-compiled bytecode in Node", async () => {
    const result = await loadInNode(nodeBytecode);

    expect(result).toEqual({
      error: null,
      rejected: false,
      value: "Hello, Test!",
    });
  });

  it(
    "executes Electron-compiled bytecode in Electron",
    async () => {
      const result = await loadInElectron(electronBytecode);

      expect(result).toEqual({
        error: null,
        rejected: false,
        value: "Hello, Test!",
      });
    },
    30_000
  );

  it("rejects Electron-compiled bytecode in Node", async () => {
    const result = await loadInNode(electronBytecode);

    expect(result.rejected).toBe(true);
    expect(result.value).toBeNull();
  });

  it(
    "rejects Node-compiled bytecode in Electron",
    async () => {
      const result = await loadInElectron(nodeBytecode);

      expect(result.rejected).toBe(true);
      expect(result.value).toBeNull();
    },
    30_000
  );

  it("produces a different cached-data header per runtime", () => {
    // Bytes 0-3 are V8's magic number and 4-7 its version hash. Compatibility
    // is decided here, which is why matching Node versions prove nothing.
    expect(electronBytecode.subarray(0, 8)).not.toEqual(
      nodeBytecode.subarray(0, 8)
    );
  });

  it("ships a different V8 than the host Node even when Node versions match", () => {
    const versions = readElectronVersions();

    expect(versions.electron).toBeTruthy();
    expect(versions.v8).not.toBe(process.versions.v8);
  });
});
