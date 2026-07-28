import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  compileToBytecodeForRuntime,
  resolveElectronPath,
} from "../src/compiler";
import { getBytecodeLoaderCode } from "../src/loader";

/**
 * Bytecode does not work in a preload script, and this pins down why so the
 * limitation is a known quantity rather than a support question.
 *
 * Two independent blockers, one per sandbox mode:
 *
 * - Sandboxed preload, which is Electron's default, resolves `require` against
 *   a small allowlist of built-in modules. The generated loader is a file on
 *   disk, so it cannot be reached at all.
 * - Unsandboxed preload can reach the loader, but preload runs in the renderer,
 *   and V8 there rejects cached data produced by the main process.
 *
 * The main process control in each run loads the same bytes successfully,
 * which is what makes this a statement about the context rather than about the
 * bytecode. That matches the plugin already disabling itself for renderer
 * builds (`src/index.ts:117-123`); preload is the same constraint.
 *
 * These assertions describe a limitation, so they fail if Electron ever makes
 * it work. That is the point: the failure means preload support became
 * possible and this file should be revisited.
 */

const hasElectronDisplay =
  process.platform !== "linux" ||
  Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);

if (process.env.CI && !hasElectronDisplay) {
  throw new Error(
    "Electron tests require a display in CI. Run the suite under `xvfb-run --auto-servernum`."
  );
}

type PreloadOutcome = {
  error: string | null;
  ok: boolean;
  value: number | null;
};

type ProbeResult = {
  mainProcess: PreloadOutcome;
  preload: PreloadOutcome;
};

/** Reports its own outcome over IPC so a failure is data rather than a crash. */
const preloadScript = String.raw`
"use strict";
const { ipcRenderer } = require("electron");

let outcome;
try {
  require("./bytecode-loader.cjs");
  outcome = { error: null, ok: true, value: require("./value.cjsc") };
} catch (error) {
  outcome = { error: error.message, ok: false, value: null };
}

ipcRenderer.send("preload-outcome", outcome);
`;

const mainScript = String.raw`
const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const result = {
  mainProcess: { error: null, ok: false, value: null },
  preload: { error: "preload never reported", ok: false, value: null },
};

function finish() {
  fs.writeFileSync(process.env.VITE_BYTECODE_RESULT, JSON.stringify(result));
  app.exit(0);
}

ipcMain.on("preload-outcome", (_event, outcome) => {
  result.preload = outcome;
  finish();
});

app.whenReady().then(async () => {
  // Control: the identical bytes, loaded in the main process.
  try {
    require("./bytecode-loader.cjs");
    result.mainProcess = {
      error: null,
      ok: true,
      value: require("./value.cjsc"),
    };
  } catch (error) {
    result.mainProcess = { error: error.message, ok: false, value: null };
  }

  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
      sandbox: process.env.VITE_BYTECODE_SANDBOX === "1",
    },
  });

  await window.loadURL("data:text/html,<html></html>");
  setTimeout(finish, 10000).unref();
});
`;

function runElectronApplication(
  directory: string,
  resultPath: string,
  sandbox: boolean
): Promise<void> {
  return new Promise((resolve, reject) => {
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      VITE_BYTECODE_RESULT: resultPath,
      VITE_BYTECODE_SANDBOX: sandbox ? "1" : "0",
    };
    delete environment.ELECTRON_RUN_AS_NODE;

    const args = [
      `--user-data-dir=${path.join(directory, `user-data-${String(sandbox)}`)}`,
    ];
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

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settleOnce(
        new Error(
          `Electron did not exit within 60s: ${Buffer.concat(stderr)
            .toString("utf8")
            .trim()}`
        )
      );
    }, 60_000);

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

describe.skipIf(!hasElectronDisplay)("Electron preload scripts", () => {
  const results = new Map<boolean, ProbeResult>();

  beforeAll(async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "vite-bytecode-preload-")
    );

    try {
      const bytecode = await compileToBytecodeForRuntime(
        '"use strict";\nmodule.exports = 42;\n',
        { runtime: "electron" }
      );

      await Promise.all([
        writeFile(path.join(directory, "value.cjsc"), bytecode),
        writeFile(
          path.join(directory, "bytecode-loader.cjs"),
          getBytecodeLoaderCode()
        ),
        writeFile(path.join(directory, "preload.cjs"), preloadScript),
        writeFile(path.join(directory, "main.cjs"), mainScript),
        writeFile(
          path.join(directory, "package.json"),
          JSON.stringify({
            main: "main.cjs",
            name: "vite-bytecode-preload",
            private: true,
          })
        ),
      ]);

      for (const sandbox of [false, true]) {
        const resultPath = path.join(
          directory,
          `result-${String(sandbox)}.json`
        );
        await runElectronApplication(directory, resultPath, sandbox);
        results.set(
          sandbox,
          JSON.parse(await readFile(resultPath, "utf8")) as ProbeResult
        );
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 180_000);

  it("loads the same bytecode in the main process", () => {
    // Without this the rejections below would only show that something failed,
    // not that the context is what makes the difference.
    for (const sandbox of [false, true]) {
      const result = results.get(sandbox);
      expect(result?.mainProcess).toEqual({
        error: null,
        ok: true,
        value: 42,
      });
    }
  });

  it("cannot reach the loader from a sandboxed preload", () => {
    const { preload } = results.get(true) as ProbeResult;

    expect(preload.ok).toBe(false);
    expect(preload.error).toMatch(/module not found/i);
  });

  it("rejects main-process bytecode in an unsandboxed preload", () => {
    const { preload } = results.get(false) as ProbeResult;

    expect(preload.ok).toBe(false);
    expect(preload.error).toMatch(/cachedDataRejected/);
  });
});
