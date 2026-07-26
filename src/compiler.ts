import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import v8 from "node:v8";

export type NodeBytecodeRuntimeOptions = {
  electronPath?: never;
  runtime?: "node";
};

export type ElectronBytecodeRuntimeOptions = {
  electronPath?: string;
  runtime: "electron";
};

export type BytecodeRuntimeOptions =
  | ElectronBytecodeRuntimeOptions
  | NodeBytecodeRuntimeOptions;

// Set V8 flags for eager compilation - MUST be done before any scripts are compiled
// These flags ensure that all functions are compiled immediately, not lazily
// This is CRITICAL for bytecode caching to work properly
try {
  v8.setFlagsFromString("--no-lazy");
  v8.setFlagsFromString("--no-flush-bytecode");
} catch (e) {
  // Flags may already be set or not supported in this V8 version
  console.warn("Warning: Could not set V8 flags for bytecode compilation:", e);
}

/**
 * Wraps code in CommonJS module wrapper format
 * This is required for bytecode to work properly with the loader
 */
function wrapInModuleWrapper(code: string): string {
  return `(function (exports, require, module, __filename, __dirname) { ${code}\n});`;
}

/**
 * Compiles JavaScript code to V8 bytecode using Node.js's vm.Script API
 */
export function compileToBytecode(code: string): Buffer {
  // Wrap the code in CommonJS module format
  const wrappedCode = wrapInModuleWrapper(code);

  // Create a script with cached data generation enabled
  const script = new vm.Script(wrappedCode, {
    produceCachedData: true,
  });

  if (!script.cachedData) {
    throw new Error("Failed to generate bytecode: cachedData is undefined");
  }

  const bytecode = script.cachedData;

  // Set the flag hash header for compatibility
  setFlagHashHeader(bytecode);

  return bytecode;
}

const electronCompilerScript = String.raw`
const { app } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const v8 = require("node:v8");

v8.setFlagsFromString("--no-lazy");
v8.setFlagsFromString("--no-flush-bytecode");

try {
  const sourceDirectory = process.env.VITE_PLUGIN_V8_BYTECODE_SOURCE_DIRECTORY;
  const outputDirectory = process.env.VITE_PLUGIN_V8_BYTECODE_OUTPUT_DIRECTORY;
  const sourceCount = Number(process.env.VITE_PLUGIN_V8_BYTECODE_SOURCE_COUNT);

  if (
    !sourceDirectory ||
    !outputDirectory ||
    !Number.isSafeInteger(sourceCount) ||
    sourceCount < 0
  ) {
    throw new Error("Electron bytecode compiler received invalid input paths");
  }

  for (let index = 0; index < sourceCount; index += 1) {
    const code = fs.readFileSync(
      path.join(sourceDirectory, String(index)),
      "utf8"
    );
    const wrappedCode =
      "(function (exports, require, module, __filename, __dirname) { " +
      code +
      "\n});";
    const script = new vm.Script(wrappedCode, { produceCachedData: true });

    if (!script.cachedData) {
      throw new Error(
        "Failed to generate Electron bytecode: cachedData is undefined"
      );
    }

    fs.writeFileSync(
      path.join(outputDirectory, String(index)),
      script.cachedData
    );
  }

  app.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.stack : error);
  app.exit(1);
}
`;

export function resolveElectronPath(
  electronPath?: string,
  resolutionBase = process.cwd()
): string {
  if (electronPath) {
    return path.resolve(resolutionBase, electronPath);
  }

  const projectRequire = createRequire(path.join(resolutionBase, "package.json"));
  let electronModulePath: string;
  try {
    electronModulePath = projectRequire.resolve("electron");
  } catch {
    throw new Error(
      "Unable to resolve Electron. Install Electron in the consuming project or pass electronPath."
    );
  }

  const resolvedElectronPath: unknown = projectRequire(electronModulePath);
  if (typeof resolvedElectronPath !== "string") {
    throw new Error(
      `Electron module did not export an executable path: ${electronModulePath}`
    );
  }

  return resolvedElectronPath;
}

function runElectronCompiler(
  executablePath: string,
  applicationDirectory: string,
  sourceDirectory: string,
  outputDirectory: string,
  sourceCount: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      VITE_PLUGIN_V8_BYTECODE_OUTPUT_DIRECTORY: outputDirectory,
      VITE_PLUGIN_V8_BYTECODE_SOURCE_COUNT: String(sourceCount),
      VITE_PLUGIN_V8_BYTECODE_SOURCE_DIRECTORY: sourceDirectory,
    };
    delete environment.ELECTRON_RUN_AS_NODE;

    const args = [
      `--user-data-dir=${path.join(applicationDirectory, "user-data")}`,
    ];
    if (process.platform === "linux" && process.getuid?.() === 0) {
      args.push("--no-sandbox");
    }
    args.push(applicationDirectory);

    const child = spawn(executablePath, args, {
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
            `Electron bytecode compiler exited with ${
              signal ?? `code ${String(exitCode)}`
            }${details ? `: ${details}` : ""}`
          )
        );
        return;
      }

      settled = true;
      resolve();
    });
  });
}

async function compileToElectronBytecodeBatch(
  codes: string[],
  electronPath?: string,
  resolutionBase?: string
): Promise<Buffer[]> {
  if (codes.length === 0) {
    return [];
  }

  const executablePath = resolveElectronPath(electronPath, resolutionBase);
  const applicationDirectory = await mkdtemp(
    path.join(tmpdir(), "vite-plugin-v8-bytecode-")
  );
  const sourceDirectory = path.join(applicationDirectory, "source");
  const outputDirectory = path.join(applicationDirectory, "output");

  try {
    await Promise.all([
      mkdir(sourceDirectory),
      mkdir(outputDirectory),
      writeFile(
        path.join(applicationDirectory, "package.json"),
        JSON.stringify({
          main: "compiler.cjs",
          name: "vite-plugin-v8-bytecode-compiler",
          private: true,
        })
      ),
      writeFile(
        path.join(applicationDirectory, "compiler.cjs"),
        electronCompilerScript
      ),
    ]);
    await Promise.all(
      codes.map((code, index) =>
        writeFile(path.join(sourceDirectory, String(index)), code)
      )
    );

    await runElectronCompiler(
      executablePath,
      applicationDirectory,
      sourceDirectory,
      outputDirectory,
      codes.length
    );

    const bytecode = await Promise.all(
      codes.map((_, index) => readFile(path.join(outputDirectory, String(index))))
    );
    if (bytecode.some((buffer) => buffer.length === 0)) {
      throw new Error("Electron bytecode compiler produced an empty output");
    }

    return bytecode;
  } finally {
    await rm(applicationDirectory, { force: true, recursive: true });
  }
}

/** Compiles bytecode in the V8 runtime that will execute the built bundle. */
export async function compileToBytecodeForRuntime(
  code: string,
  options: BytecodeRuntimeOptions = {},
  resolutionBase?: string
): Promise<Buffer> {
  const [bytecode] = await compileToBytecodeBatchForRuntime(
    [code],
    options,
    resolutionBase
  );
  if (!bytecode) {
    throw new Error("Bytecode compiler produced no output");
  }
  return bytecode;
}

/** Compiles multiple chunks in one Electron main process when appropriate. */
export function compileToBytecodeBatchForRuntime(
  codes: string[],
  options: BytecodeRuntimeOptions = {},
  resolutionBase?: string
): Promise<Buffer[]> {
  if (options.runtime === "electron") {
    return compileToElectronBytecodeBatch(
      codes,
      options.electronPath,
      resolutionBase
    );
  }

  return Promise.resolve(codes.map((code) => compileToBytecode(code)));
}

// Cache the dummy bytecode for flag hash
let dummyBytecode: Buffer | undefined;

/**
 * Sets the flag hash header in the bytecode buffer for compatibility
 * This ensures the bytecode can be loaded correctly by different V8 versions
 */
function setFlagHashHeader(bytecodeBuffer: Buffer): void {
  const FLAG_HASH_OFFSET = 12;

  if (!dummyBytecode) {
    // Create a dummy script to get the current flag hash
    const script = new vm.Script("", {
      produceCachedData: true,
    });
    dummyBytecode = script.cachedData;
  }

  if (dummyBytecode && dummyBytecode.length > FLAG_HASH_OFFSET + 4) {
    // Copy the flag hash from dummy bytecode to the target bytecode
    dummyBytecode
      .subarray(FLAG_HASH_OFFSET, FLAG_HASH_OFFSET + 4)
      .copy(bytecodeBuffer, FLAG_HASH_OFFSET);
  }
}

/**
 * Gets the source hash header from bytecode buffer
 * Used to determine the dummy code length needed for loading
 */
export function getSourceHashHeader(bytecodeBuffer: Buffer): Buffer {
  const SOURCE_HASH_OFFSET = 8;
  return bytecodeBuffer.subarray(SOURCE_HASH_OFFSET, SOURCE_HASH_OFFSET + 4);
}

/**
 * Converts a 4-byte buffer to a number (little-endian)
 */
export function buffer2Number(buffer: Buffer): number {
  let ret = 0;
  ret |= buffer[3] << 24;
  ret |= buffer[2] << 16;
  ret |= buffer[1] << 8;
  ret |= buffer[0];
  return ret;
}
