import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { build, type Plugin } from "vite";
import { describe, expect, it } from "vitest";
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

  it(
    "does not inject require into a context-isolated renderer when a plugin instance is reused",
    async () => {
      const applicationDirectory = await mkdtemp(
        path.join(tmpdir(), "vite-bytecode-secure-renderer-")
      );
      const activationEntry = path.join(applicationDirectory, "activation.js");
      const rendererEntry = path.join(applicationDirectory, "renderer.js");
      const rendererDirectory = path.join(applicationDirectory, "renderer");
      const resultPath = path.join(applicationDirectory, "result.json");
      const priorNodeEnv = process.env.NODE_ENV;
      const rendererMarker: Plugin = {
        name: "vite:electron-renderer-preset-config",
      };

      try {
        process.env.NODE_ENV = "production";
        const sharedPlugin = bytecodePlugin();
        await Promise.all([
          writeFile(activationEntry, "module.exports = 42;"),
          writeFile(
            rendererEntry,
            'globalThis.rendererResult = { answer: 42, requireType: typeof require };'
          ),
        ]);
        // Reusing a plugin instance across Electron configs used to leave its
        // main-process state enabled when the renderer config was resolved.
        await build({
          configFile: false,
          logLevel: "silent",
          plugins: [sharedPlugin],
          root: applicationDirectory,
          build: {
            write: false,
            rollupOptions: {
              input: activationEntry,
              output: { entryFileNames: "activation.cjs", format: "cjs" },
            },
          },
        });
        await build({
          configFile: false,
          logLevel: "silent",
          plugins: [rendererMarker, sharedPlugin],
          root: applicationDirectory,
          build: {
            emptyOutDir: true,
            outDir: rendererDirectory,
            rollupOptions: {
              input: rendererEntry,
              output: { entryFileNames: "renderer.js", format: "cjs" },
            },
          },
        });

        expect(await readdir(rendererDirectory)).toEqual(["renderer.js"]);
        await Promise.all([
          writeFile(
            path.join(applicationDirectory, "index.html"),
            '<script src="./renderer/renderer.js"></script>'
          ),
          writeFile(
            path.join(applicationDirectory, "main.cjs"),
            `
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  await window.loadFile(path.join(__dirname, "index.html"));
  const result = await window.webContents.executeJavaScript(
    "globalThis.rendererResult"
  );
  fs.writeFileSync(process.env.VITE_BYTECODE_RENDERER_RESULT, JSON.stringify(result));
  app.exit(0);
});
`
          ),
          writeFile(
            path.join(applicationDirectory, "package.json"),
            JSON.stringify({
              main: "main.cjs",
              name: "vite-bytecode-secure-renderer",
              private: true,
            })
          ),
        ]);

        await runElectronApplication(applicationDirectory, {
          VITE_BYTECODE_RENDERER_RESULT: resultPath,
        });
        expect(JSON.parse(await readFile(resultPath, "utf8"))).toEqual({
          answer: 42,
          requireType: "undefined",
        });
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
