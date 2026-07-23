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
    if (libFormats.length > 0) {
      return libFormats.map((format) => ({ ...outputs, format }));
    }
  }
  return outputs;
}

/**
 * Normalizes path separators to forward slashes
 */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}
