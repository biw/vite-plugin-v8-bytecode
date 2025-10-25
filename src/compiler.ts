import vm from "node:vm";
import v8 from "node:v8";

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
