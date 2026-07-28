import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  compileToBytecodeBatchForRuntime,
  resolveElectronPath,
} from "../src/compiler";
import { getBytecodeLoaderCode } from "../src/loader";
import { transformCode } from "../src/transforms";
import { LANGUAGE_CASES } from "./language-cases";

/**
 * The same language matrix `test/integration.test.ts` runs under Node, executed
 * in a real Electron main process.
 *
 * Electron builds Node against Chromium's V8, so these cases passing on Node
 * says nothing about the runtime consumers actually ship. Every other Electron
 * test in this repository executes a trivial payload and proves the pipeline
 * works at all; this one proves it preserves JavaScript semantics.
 *
 * Cost is two Electron launches for the whole matrix rather than two per case:
 * one batch compile, then one application that loads every fixture. Both happen
 * in `beforeAll`, and each case gets its own assertion against the collected
 * results so a failure names the feature that broke.
 */

const hasElectronDisplay =
  process.platform !== "linux" ||
  Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);

if (process.env.CI && !hasElectronDisplay) {
  throw new Error(
    "Electron tests require a display in CI. Run the suite under `xvfb-run --auto-servernum`."
  );
}

type CaseResult = {
  error: string | null;
  ok: boolean;
  received: string | null;
};

/**
 * Loads every fixture through the shipped loader and reports per case. Each
 * result is awaited because some fixtures export a promise, matching what the
 * Node runner does.
 */
const mainScript = String.raw`
const { app } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
require("./bytecode-loader.cjs");

const expected = JSON.parse(fs.readFileSync(path.join(__dirname, "expected.json"), "utf8"));

app.whenReady().then(async () => {
  const results = [];

  for (let index = 0; index < expected.length; index += 1) {
    try {
      const loaded = await Promise.resolve(require("./case-" + index + ".jsc"));
      results.push({
        error: null,
        ok: Object.is(loaded, expected[index]),
        received: typeof loaded === "string" ? loaded : JSON.stringify(loaded) ?? String(loaded),
      });
    } catch (error) {
      results.push({ error: error.message, ok: false, received: null });
    }
  }

  fs.writeFileSync(
    path.join(app.getPath("userData"), "results.json"),
    JSON.stringify(results)
  );
  app.exit(0);
});
`;

function runElectronApplication(
  directory: string,
  userDataDirectory: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const environment: NodeJS.ProcessEnv = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;

    const args = [`--user-data-dir=${userDataDirectory}`];
    if (process.platform === "linux" && process.getuid?.() === 0) {
      args.push("--no-sandbox");
    }
    args.push(directory);

    const child = spawn(resolveElectronPath(), args, {
      env: environment,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const stderr: Buffer[] = [];
    let settled = false;

    const settleOnce = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    // Without this a main process that throws before creating a window hangs
    // forever and the real stack trace stays stuck in an unread pipe.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settleOnce(
        new Error(
          `Electron did not exit within 120s: ${Buffer.concat(stderr)
            .toString("utf8")
            .trim()}`
        )
      );
    }, 120_000);

    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", settleOnce);
    child.on("close", (exitCode, signal) => {
      if (exitCode !== 0 || signal) {
        settleOnce(
          new Error(
            `Electron exited with ${signal ?? `code ${String(exitCode)}`}: ${Buffer.concat(
              stderr
            )
              .toString("utf8")
              .trim()}`
          )
        );
        return;
      }
      settleOnce();
    });
  });
}

describe.skipIf(!hasElectronDisplay)("Electron language compatibility", () => {
  let results: CaseResult[];

  beforeAll(async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "vite-bytecode-electron-language-")
    );
    const userDataDirectory = path.join(directory, "user-data");

    try {
      const sources = LANGUAGE_CASES.map(([feature, code]) => {
        const transformed = transformCode(code, []);
        if (!transformed) {
          throw new Error(`Transform returned null for ${feature}`);
        }
        return transformed.code;
      });

      // One Electron process compiles the whole matrix.
      const bytecode = await compileToBytecodeBatchForRuntime(sources, {
        runtime: "electron",
      });

      await Promise.all([
        ...bytecode.map((buffer, index) =>
          writeFile(path.join(directory, `case-${String(index)}.jsc`), buffer)
        ),
        writeFile(
          path.join(directory, "expected.json"),
          JSON.stringify(LANGUAGE_CASES.map(([, , expected]) => expected))
        ),
        writeFile(
          path.join(directory, "bytecode-loader.cjs"),
          getBytecodeLoaderCode()
        ),
        writeFile(path.join(directory, "main.cjs"), mainScript),
        writeFile(
          path.join(directory, "package.json"),
          JSON.stringify({
            main: "main.cjs",
            name: "vite-bytecode-electron-language",
            private: true,
          })
        ),
      ]);

      // The matrix includes a case that requires a real package, and the Node
      // runner resolves it by living inside the repository. This directory is
      // in the system temp, so it needs the link to resolve the same way.
      await symlink(
        fileURLToPath(new URL("../node_modules", import.meta.url)),
        path.join(directory, "node_modules"),
        "dir"
      );

      // One Electron process runs it.
      await runElectronApplication(directory, userDataDirectory);

      results = JSON.parse(
        await readFile(path.join(userDataDirectory, "results.json"), "utf8")
      ) as CaseResult[];
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 300_000);

  it("reports a result for every case", () => {
    expect(results).toHaveLength(LANGUAGE_CASES.length);
  });

  it.each(LANGUAGE_CASES.map(([feature], index) => [feature, index] as const))(
    "preserves %s through Electron bytecode execution",
    (_feature, index) => {
      const result = results[index];

      expect(result.error).toBeNull();
      expect(result.ok).toBe(true);
    }
  );
});
