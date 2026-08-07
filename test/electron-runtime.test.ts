import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { build } from "vite";
import { describe, expect, it } from "vite-plus/test";
import {
  compileToBytecodeBatchForRuntime,
  compileToBytecodeForRuntime,
  resolveElectronPath,
} from "../src/compiler";
import { bytecodePlugin } from "../src/index";

const source = `
const greet = (name) => "Hello, " + name + "!";
module.exports = { greet };
`;

function runElectronApplication(
  applicationDirectory: string,
  environmentOverrides: NodeJS.ProcessEnv = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      ...environmentOverrides,
    };
    delete environment.ELECTRON_RUN_AS_NODE;

    const args = [`--user-data-dir=${path.join(applicationDirectory, "user-data")}`];
    if (process.platform === "linux" && process.getuid?.() === 0) {
      args.push("--no-sandbox");
    }
    args.push(applicationDirectory);

    const child = spawn(resolveElectronPath(), args, {
      env: environment,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const stderr: Buffer[] = [];
    let settled = false;

    const rejectOnce = (error: Error): void => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };

    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", rejectOnce);
    child.on("close", (exitCode, signal) => {
      if (settled) {
        return;
      }
      if (exitCode !== 0 || signal) {
        const details = Buffer.concat(stderr).toString("utf8").trim();
        rejectOnce(
          new Error(
            `Electron exited with ${signal ?? `code ${String(exitCode)}`}${
              details ? `: ${details}` : ""
            }`
          )
        );
        return;
      }
      settled = true;
      resolve();
    });
  });
}

const hasElectronDisplay =
  process.platform !== "linux" ||
  Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);

describe.skipIf(!hasElectronDisplay)("Electron bytecode runtime", () => {
  it(
    "compiles a batch in a real Electron main process",
    async () => {
      const bytecode = await compileToBytecodeBatchForRuntime(
        [source, "module.exports = 42;"],
        { runtime: "electron" }
      );

      expect(bytecode).toHaveLength(2);
      expect(bytecode.every((buffer) => buffer.length > 0)).toBe(true);
    },
    30_000
  );

  it(
    "runs Vite-produced bytecode through the generated loader in Electron",
    async () => {
      const applicationDirectory = await mkdtemp(
        path.join(tmpdir(), "vite-bytecode-electron-main-")
      );
      const outputDirectory = path.join(applicationDirectory, "dist");
      const entryPath = path.join(applicationDirectory, "main.cjs");
      const priorNodeEnv = process.env.NODE_ENV;

      try {
        const electronModuleDirectory = path.join(
          applicationDirectory,
          "node_modules",
          "electron"
        );
        await mkdir(electronModuleDirectory, { recursive: true });
        await Promise.all([
          writeFile(
            path.join(electronModuleDirectory, "index.js"),
            `module.exports = ${JSON.stringify(resolveElectronPath())};`
          ),
          writeFile(
            entryPath,
            `
const { app } = require("electron");
if ([20, 22].reduce((total, value) => total + value, 0) !== 42) {
  throw new Error("Unexpected bytecode result");
}
app.exit(0);
`
          ),
        ]);
        process.env.NODE_ENV = "production";
        await build({
          configFile: false,
          logLevel: "silent",
          plugins: [
            bytecodePlugin({
              runtime: "electron",
            }),
          ],
          root: applicationDirectory,
          build: {
            emptyOutDir: true,
            outDir: outputDirectory,
            rollupOptions: {
              external: ["electron"],
              input: entryPath,
              output: {
                entryFileNames: "main.cjs",
                format: "cjs",
              },
            },
          },
        });
        await writeFile(
          path.join(outputDirectory, "package.json"),
          JSON.stringify({
            main: "main.cjs",
            name: "vite-bytecode-electron-main",
            private: true,
          })
        );

        expect(await readdir(outputDirectory)).toEqual(
          expect.arrayContaining([
            "bytecode-loader.cjs",
            "main.cjs",
            "main.cjsc",
          ])
        );
        await rm(path.join(applicationDirectory, "node_modules"), {
          force: true,
          recursive: true,
        });
        await runElectronApplication(outputDirectory);
      } finally {
        if (priorNodeEnv === undefined) {
          delete process.env.NODE_ENV;
        } else {
          process.env.NODE_ENV = priorNodeEnv;
        }
        await rm(applicationDirectory, { force: true, recursive: true });
      }
    },
    30_000
  );

  it("resolves Electron from a supplied Vite project root", async () => {
    const applicationDirectory = await mkdtemp(
      path.join(tmpdir(), "vite-bytecode-electron-resolution-")
    );
    const expectedElectronPath = resolveElectronPath();

    try {
      const electronDirectory = path.join(
        applicationDirectory,
        "node_modules",
        "electron"
      );
      await mkdir(electronDirectory, { recursive: true });
      await writeFile(
        path.join(electronDirectory, "index.js"),
        `module.exports = ${JSON.stringify(expectedElectronPath)};`
      );

      expect(resolveElectronPath(undefined, applicationDirectory)).toBe(
        expectedElectronPath
      );
    } finally {
      await rm(applicationDirectory, { force: true, recursive: true });
    }
  });
});

describe("Node runtime selection", () => {
  it("keeps Node as the default bytecode runtime", async () => {
    const bytecode = await compileToBytecodeForRuntime(source);
    const sourceLength = bytecode.readUInt32LE(8);
    const dummyCode =
      sourceLength > 1 ? `"${"\u200b".repeat(sourceLength - 2)}"` : "";
    const script = new vm.Script(dummyCode, { cachedData: bytecode });

    expect(script.cachedDataRejected).toBe(false);
  });

  it("compiles only the CommonJS side of a mixed-output build", async () => {
    const applicationDirectory = await mkdtemp(
      path.join(tmpdir(), "vite-bytecode-mixed-runtime-")
    );
    const outputDirectory = path.join(applicationDirectory, "dist");
    const entryPath = path.join(applicationDirectory, "main.js");
    const priorNodeEnv = process.env.NODE_ENV;

    try {
      await writeFile(entryPath, "export const answer = 42;");
      process.env.NODE_ENV = "production";
      await build({
        configFile: false,
        logLevel: "silent",
        plugins: [bytecodePlugin()],
        root: applicationDirectory,
        build: {
          emptyOutDir: true,
          outDir: outputDirectory,
          rollupOptions: {
            input: entryPath,
            output: [
              { entryFileNames: "cjs/[name].cjs", format: "cjs" },
              { entryFileNames: "esm/[name].js", format: "es" },
            ],
          },
        },
      });

      await Promise.all([
        access(path.join(outputDirectory, "bytecode-loader.cjs")),
        access(path.join(outputDirectory, "cjs", "main.cjsc")),
        access(path.join(outputDirectory, "cjs", "main.cjs")),
        access(path.join(outputDirectory, "esm", "main.js")),
      ]);
    } finally {
      if (priorNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = priorNodeEnv;
      }
      await rm(applicationDirectory, { force: true, recursive: true });
    }
  });
});
