import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPackage } from "@electron/asar";
import { build } from "vite";
import { describe, expect, it } from "vitest";
import { resolveElectronPath } from "../src/compiler";
import { bytecodePlugin } from "../src/index";

/**
 * Every packaged Electron app ships its sources inside `app.asar` by default,
 * so this is the shape real consumers actually run. The loader reads bytecode
 * with a plain `fs.readFileSync` (`src/loader.ts:42`), which only works in a
 * package because Electron patches `fs` to see into the archive — worth
 * proving rather than assuming, since a regression here would be invisible to
 * every other test in the suite.
 */

const hasElectronDisplay =
  process.platform !== "linux" ||
  Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);

if (process.env.CI && !hasElectronDisplay) {
  throw new Error(
    "Electron tests require a display in CI. Run the suite under `xvfb-run --auto-servernum`."
  );
}

/**
 * Reports through `userData` rather than an environment variable: this entry is
 * bundled by Vite, which statically replaces `process.env` reads, so anything
 * passed that way arrives as `undefined` inside the bytecode.
 */
const entrySource = `
const { app } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const answer = [20, 22].reduce((total, value) => total + value, 0);

app.whenReady().then(() => {
  fs.writeFileSync(
    path.join(app.getPath("userData"), "result.json"),
    JSON.stringify({ answer: answer, directory: __dirname })
  );
  app.exit(0);
});
`;

function runElectronApplication(
  applicationPath: string,
  userDataDirectory: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const environment: NodeJS.ProcessEnv = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;

    const args = [`--user-data-dir=${userDataDirectory}`];
    if (process.platform === "linux" && process.getuid?.() === 0) {
      args.push("--no-sandbox");
    }
    args.push(applicationPath);

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

    // An Electron main process that throws before creating a window never
    // exits on its own, so without this a failure surfaces as an opaque test
    // timeout with the actual stack trace stuck in an unread pipe.
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

describe.skipIf(!hasElectronDisplay)("Electron asar packaging", () => {
  it(
    "loads bytecode from inside app.asar",
    async () => {
      const workingDirectory = await mkdtemp(
        path.join(tmpdir(), "vite-bytecode-asar-")
      );
      const outputDirectory = path.join(workingDirectory, "dist");
      const entryPath = path.join(workingDirectory, "main.cjs");
      const archivePath = path.join(workingDirectory, "app.asar");
      const userDataDirectory = path.join(workingDirectory, "user-data");
      const priorNodeEnv = process.env.NODE_ENV;

      try {
        await writeFile(entryPath, entrySource);
        process.env.NODE_ENV = "production";
        await build({
          configFile: false,
          logLevel: "silent",
          plugins: [
            bytecodePlugin({
              // Exercises the explicit electronPath branch, which also spares
              // the build from resolving Electron out of a bare temp dir.
              electronPath: resolveElectronPath(),
              runtime: "electron",
            }),
          ],
          root: workingDirectory,
          build: {
            emptyOutDir: true,
            outDir: outputDirectory,
            rollupOptions: {
              // Vite targets the browser by default, which stubs out node
              // builtins instead of leaving them to the Electron runtime.
              external: ["electron", /^node:/],
              input: entryPath,
              output: { entryFileNames: "main.cjs", format: "cjs" },
            },
          },
        });
        await writeFile(
          path.join(outputDirectory, "package.json"),
          JSON.stringify({
            main: "main.cjs",
            name: "vite-bytecode-asar",
            private: true,
          })
        );

        await createPackage(outputDirectory, archivePath);
        // The unpacked build is removed so a passing run cannot be explained
        // by Electron quietly falling back to loose files on disk.
        await rm(outputDirectory, { force: true, recursive: true });

        await runElectronApplication(archivePath, userDataDirectory);

        const result = JSON.parse(
          await readFile(path.join(userDataDirectory, "result.json"), "utf8")
        ) as { answer: number; directory: string };
        expect(result.answer).toBe(42);
        expect(result.directory).toContain("app.asar");
      } finally {
        if (priorNodeEnv === undefined) {
          delete process.env.NODE_ENV;
        } else {
          process.env.NODE_ENV = priorNodeEnv;
        }
        await rm(workingDirectory, { force: true, recursive: true });
      }
    },
    90_000
  );
});
