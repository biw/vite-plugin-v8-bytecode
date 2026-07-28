import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "electron-vite";
import { describe, expect, it } from "vitest";
import { resolveElectronPath } from "../src/compiler";
import { bytecodePlugin } from "../src/index";

const pluginRegistry = globalThis as typeof globalThis & {
  __viteBytecodeElectronVitePlugin?: ReturnType<typeof bytecodePlugin>;
};

function runElectronApplication(
  applicationDirectory: string,
  environmentOverrides: NodeJS.ProcessEnv
): Promise<void> {
  return new Promise((resolve, reject) => {
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      ...environmentOverrides,
    };
    delete environment.ELECTRON_RUN_AS_NODE;

    const args = [
      `--user-data-dir=${path.join(applicationDirectory, "user-data")}`,
    ];
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

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settleOnce(
        new Error(
          `Electron did not exit within 30s: ${Buffer.concat(stderr)
            .toString("utf8")
            .trim()}`
        )
      );
    }, 30_000);

    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", settleOnce);
    child.on("close", (exitCode, signal) => {
      if (exitCode !== 0 || signal) {
        const details = Buffer.concat(stderr).toString("utf8").trim();
        settleOnce(
          new Error(
            `Electron exited with ${signal ?? `code ${String(exitCode)}`}${
              details ? `: ${details}` : ""
            }`
          )
        );
        return;
      }
      settleOnce();
    });
  });
}

async function listFiles(
  directory: string,
  relativeDirectory = ""
): Promise<string[]> {
  const entries = await readdir(path.join(directory, relativeDirectory), {
    withFileTypes: true,
  });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const relativePath = path.join(relativeDirectory, entry.name);
      return entry.isDirectory()
        ? listFiles(directory, relativePath)
        : [relativePath];
    })
  );

  return files.flat().map((file) => file.split(path.sep).join("/")).sort();
}

function restoreEnvironment(
  name: "NODE_ENV" | "NODE_ENV_ELECTRON_VITE",
  value: string | undefined
): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

const hasElectronDisplay =
  process.platform !== "linux" ||
  Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);

if (process.env.CI && !hasElectronDisplay) {
  throw new Error(
    "Electron integration tests require DISPLAY or WAYLAND_DISPLAY in CI"
  );
}

describe.skipIf(!hasElectronDisplay)("electron-vite integration", () => {
  it.each(["commonjs", "module"] as const)(
    "builds a type-%s main process and leaves the renderer as JavaScript",
    async (packageType) => {
      const applicationDirectory = await realpath(
        await mkdtemp(path.join(tmpdir(), "vite-bytecode-electron-vite-"))
      );
      const mainDirectory = path.join(applicationDirectory, "src", "main");
      const rendererDirectory = path.join(
        applicationDirectory,
        "src",
        "renderer"
      );
      const electronModuleDirectory = path.join(
        applicationDirectory,
        "node_modules",
        "electron"
      );
      const outputDirectory = path.join(applicationDirectory, "out");
      const resultPath = path.join(applicationDirectory, "result.json");
      const configPath = path.join(
        applicationDirectory,
        "electron.vite.config.mjs"
      );
      const priorNodeEnv = process.env.NODE_ENV;
      const priorElectronViteNodeEnv = process.env.NODE_ENV_ELECTRON_VITE;
      const priorPlugin = pluginRegistry.__viteBytecodeElectronVitePlugin;

      try {
        process.env.NODE_ENV = "production";
        // electron-vite loads its config outside Vitest's TypeScript transform
        // pipeline. Reuse the source plugin already imported by this test so
        // the suite does not depend on a prebuilt dist directory.
        pluginRegistry.__viteBytecodeElectronVitePlugin = bytecodePlugin({
          runtime: "electron",
        });
        await Promise.all([
          mkdir(mainDirectory, { recursive: true }),
          mkdir(rendererDirectory, { recursive: true }),
          mkdir(electronModuleDirectory, { recursive: true }),
        ]);
        await Promise.all([
          writeFile(
            path.join(electronModuleDirectory, "index.js"),
            `module.exports = ${JSON.stringify(resolveElectronPath())};`
          ),
          writeFile(
            path.join(mainDirectory, "index.js"),
            `
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  await window.loadFile(path.join(__dirname, "../renderer/index.html"));
  const result = await window.webContents.executeJavaScript(
    "globalThis.rendererResult"
  );
  fs.writeFileSync(process.env.VITE_BYTECODE_RENDERER_RESULT, JSON.stringify(result));
  app.exit(0);
});
`
          ),
          writeFile(
            path.join(rendererDirectory, "renderer.js"),
            'globalThis.rendererResult = { answer: 42, requireType: typeof require };'
          ),
          writeFile(
            path.join(rendererDirectory, "index.html"),
            '<script type="module" src="./renderer.js"></script>'
          ),
          writeFile(
            path.join(applicationDirectory, "package.json"),
            JSON.stringify({
              main: "out/main/index.js",
              name: "vite-bytecode-electron-vite",
              private: true,
              type: packageType,
            })
          ),
          writeFile(
            configPath,
            `
const sharedPlugin = globalThis.__viteBytecodeElectronVitePlugin;
if (!sharedPlugin) {
  throw new Error("Missing bytecode plugin test instance");
}

export default {
  main: {
    root: ${JSON.stringify(applicationDirectory)},
    plugins: [sharedPlugin]
  },
  renderer: {
    root: ${JSON.stringify(rendererDirectory)},
    plugins: [sharedPlugin],
    build: {
      outDir: ${JSON.stringify(path.join(outputDirectory, "renderer"))}
    }
  }
};
`
          ),
        ]);

        await build({
          configFile: configPath,
          logLevel: "silent",
          root: applicationDirectory,
        });

        const mainFiles = await listFiles(path.join(outputDirectory, "main"));
        const rendererFiles = await listFiles(
          path.join(outputDirectory, "renderer")
        );
        expect(mainFiles).toEqual(
          expect.arrayContaining([
            "bytecode-loader.cjs",
            "index.js",
            "index.jsc",
          ])
        );
        expect(mainFiles.includes("package.json")).toBe(
          packageType === "module"
        );
        expect(rendererFiles).toContain("index.html");
        expect(rendererFiles.some((file) => /\.js$/.test(file))).toBe(true);
        expect(rendererFiles.every((file) => !/\.c?jsc$/.test(file))).toBe(
          true
        );
        if (packageType === "module") {
          expect(
            JSON.parse(
              await readFile(
                path.join(outputDirectory, "main", "package.json"),
                "utf8"
              )
            )
          ).toEqual({ type: "commonjs" });
        }
        expect(
          JSON.parse(
            await readFile(
              path.join(applicationDirectory, "package.json"),
              "utf8"
            )
          ).main
        ).toBe("out/main/index.js");

        await runElectronApplication(applicationDirectory, {
          VITE_BYTECODE_RENDERER_RESULT: resultPath,
        });
        expect(JSON.parse(await readFile(resultPath, "utf8"))).toEqual({
          answer: 42,
          requireType: "undefined",
        });
      } finally {
        restoreEnvironment("NODE_ENV", priorNodeEnv);
        restoreEnvironment(
          "NODE_ENV_ELECTRON_VITE",
          priorElectronViteNodeEnv
        );
        if (priorPlugin === undefined) {
          delete pluginRegistry.__viteBytecodeElectronVitePlugin;
        } else {
          pluginRegistry.__viteBytecodeElectronVitePlugin = priorPlugin;
        }
        await rm(applicationDirectory, { force: true, recursive: true });
      }
    },
    60_000
  );
});
