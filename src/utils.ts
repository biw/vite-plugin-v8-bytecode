import path from "node:path";
import type { LibraryOptions } from "vite";
import type { OutputOptions } from "rollup";

/**
 * Converts an absolute path to a relative path for require() statements
 */
export function toRelativePath(from: string, to: string): string {
  const relativePath = path.relative(path.dirname(to), from);
  // Ensure the path starts with ./ or ../
  return relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
}

/**
 * Resolves build outputs considering library options
 */
export function resolveBuildOutputs(
  outputs: OutputOptions | OutputOptions[] | undefined,
  libOptions: LibraryOptions | false
): OutputOptions | OutputOptions[] | undefined {
  if (libOptions && !Array.isArray(outputs)) {
    const libFormats = libOptions.formats || [];
    return libFormats.map((format) => ({ ...outputs, format }));
  }
  return outputs;
}

/**
 * Detects if code is using ES modules or CommonJS
 */
export function detectModuleFormat(code: string): "esm" | "cjs" {
  // Simple heuristic: check for import/export statements
  const esmPattern = /\b(import|export)\s+/;
  return esmPattern.test(code) ? "esm" : "cjs";
}

/**
 * Wraps ES module code in a CommonJS wrapper
 * This allows ES modules to work with the bytecode loader
 */
export function wrapESModuleAsCommonJS(code: string): string {
  // For ES modules, we need to wrap them in a CommonJS-compatible format
  // This is a simplified approach - for production use, you might want a more robust solution
  return `(function(exports, require, module, __filename, __dirname) {
'use strict';
${code}
})`;
}

/**
 * Normalizes path separators to forward slashes
 */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}
