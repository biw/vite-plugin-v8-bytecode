import path from "node:path";
import type { Plugin, Logger } from "vite";
import type { SourceMapInput, OutputChunk, OutputOptions } from "rollup";
import { compileToBytecode } from "./compiler";
import { getBytecodeLoaderCode } from "./loader";
import { rewriteRequireSpecifiers, transformCode } from "./transforms";
import { toRelativePath, resolveBuildOutputs, normalizePath } from "./utils";

const bytecodeChunkExtensionRE = /\.(jsc|cjsc)$/;

export interface BytecodeOptions {
  /**
   * Specify which chunks to compile to bytecode.
   * If not specified or empty array, all chunks will be compiled.
   */
  chunkAlias?: string | string[];

  /**
   * Whether to remove the original .js files after compilation.
   * @default true
   */
  removeBundleJS?: boolean;

  /**
   * Array of strings to protect by obfuscating them with String.fromCharCode.
   * Useful for sensitive strings like API keys.
   * @default []
   */
  protectedStrings?: string[];
}

/**
 * Vite plugin to compile JavaScript to V8 bytecode for Node.js and Electron
 *
 * @example
 * ```ts
 * import { bytecodePlugin } from 'vite-plugin-v8-bytecode'
 *
 * export default {
 *   plugins: [
 *     bytecodePlugin({
 *       chunkAlias: ['index'],
 *       protectedStrings: ['MY_API_KEY'],
 *       removeBundleJS: true
 *     })
 *   ]
 * }
 * ```
 */
export function bytecodePlugin(options: BytecodeOptions = {}): Plugin | null {
  // Only run in production builds
  if (process.env.NODE_ENV !== "production") {
    return null;
  }

  const {
    chunkAlias = [],
    removeBundleJS = true,
    protectedStrings = [],
  } = options;
  const _chunkAlias = Array.isArray(chunkAlias) ? chunkAlias : [chunkAlias];

  const transformAllChunks = _chunkAlias.length === 0;
  const isBytecodeChunk = (
    chunkName: string,
    outputOptions?: OutputOptions
  ): boolean => {
    return (
      transformAllChunks ||
      _chunkAlias.some(
        (alias) =>
          alias === chunkName ||
          (typeof outputOptions?.sanitizeFileName === "function" &&
            outputOptions.sanitizeFileName(alias) === chunkName)
      )
    );
  };

  const useStrict = '"use strict";';
  const bytecodeModuleLoader = "bytecode-loader.cjs";

  let logger: Logger;
  let enabled = false;
  const selectedChunkFileNames = new Set<string>();

  return {
    name: "vite:bytecode",
    apply: "build",
    enforce: "post",

    configResolved(config): void {
      logger = config.logger;

      // Check if used in renderer (not supported)
      const useInRenderer = config.plugins.some(
        (p) => p.name === "vite:electron-renderer-preset-config"
      );
      if (useInRenderer) {
        config.logger.warn("bytecodePlugin does not support renderer.");
        return;
      }

      enabled = true;

      const build = config.build;
      const resolvedOutputs = resolveBuildOutputs(
        build.rollupOptions.output,
        build.lib
      );

      if (resolvedOutputs) {
        const outputs = Array.isArray(resolvedOutputs)
          ? resolvedOutputs
          : [resolvedOutputs];

        if (outputs.some((output) => output.format !== "cjs")) {
          config.logger.warn(
            "bytecodePlugin only supports CommonJS output. " +
              "Non-CommonJS outputs will be left unchanged."
          );
        }
      }
    },

    renderChunk(
      code,
      chunk,
      outputOptions
    ): { code: string; map?: SourceMapInput } | null {
      // Transform ordinary template literals in CommonJS bytecode chunks.
      // Tagged templates are preserved because rewriting them changes semantics.
      if (
        enabled &&
        outputOptions.format === "cjs" &&
        isBytecodeChunk(chunk.name, outputOptions)
      ) {
        selectedChunkFileNames.add(normalizePath(chunk.fileName));
        return transformCode(code, protectedStrings, !!outputOptions.sourcemap);
      }
      return null;
    },

    async generateBundle(outputOptions, output): Promise<void> {
      if (!enabled || outputOptions.format !== "cjs") {
        return;
      }

      const initialOutput = Object.values(output);
      const allChunks = initialOutput.filter(
        (file): file is OutputChunk => file.type === "chunk"
      );
      const chunks = allChunks.filter(
        (chunk) =>
          selectedChunkFileNames.has(normalizePath(chunk.fileName)) ||
          isBytecodeChunk(chunk.name, outputOptions)
      );

      if (chunks.length === 0) {
        return;
      }

      const bytecodeFileNames = new Map(
        chunks.map((chunk) => [
          normalizePath(chunk.fileName),
          getBytecodeFileName(normalizePath(chunk.fileName)),
        ])
      );

      const getBytecodeLoaderBlock = (chunkFileName: string): string => {
        return `require("${toRelativePath(
          bytecodeModuleLoader,
          normalizePath(chunkFileName)
        )}");`;
      };

      if (!removeBundleJS) {
        const retainedFileNames = new Map(
          allChunks.map((chunk) => [
            normalizePath(chunk.fileName),
            `_${normalizePath(chunk.fileName)}`,
          ])
        );

        for (const chunk of allChunks) {
          const retainedFileName = retainedFileNames.get(
            normalizePath(chunk.fileName)
          )!;
          let retainedCode = rewriteChunkRequires(
            chunk.code,
            chunk.fileName,
            retainedFileName,
            retainedFileNames
          ).code;
          const sourceMapFileName = getSourceMapFileName(chunk);

          if (sourceMapFileName && output[sourceMapFileName]?.type === "asset") {
            const retainedMapFileName = `_${sourceMapFileName}`;
            retainedCode = replaceSourceMapReference(
              retainedCode,
              path.posix.basename(retainedMapFileName)
            );
            const sourceMap = output[sourceMapFileName];
            this.emitFile({
              type: "asset",
              fileName: retainedMapFileName,
              source: updateSourceMapFile(
                sourceMap.source,
                path.posix.basename(retainedFileName)
              ),
            });
          }

          this.emitFile({
            type: "asset",
            fileName: retainedFileName,
            source: retainedCode,
          });
        }
      }

      for (const chunk of allChunks) {
        const normalizedFileName = normalizePath(chunk.fileName);
        const selected = bytecodeFileNames.has(normalizedFileName);
        const rewritten = rewriteChunkRequires(
          chunk.code,
          chunk.fileName,
          chunk.fileName,
          bytecodeFileNames
        );

        if (!selected) {
          chunk.code = rewritten.rewritten
            ? injectLoader(
                rewritten.code,
                getBytecodeLoaderBlock(chunk.fileName)
              )
            : rewritten.code;
          continue;
        }

        const bytecodeFileName = bytecodeFileNames.get(normalizedFileName)!;
        const bytecodeBuffer = await compileToBytecode(
          stripShebang(rewritten.code)
        );

        this.emitFile({
          type: "asset",
          fileName: bytecodeFileName,
          source: bytecodeBuffer,
        });

        const sourceMapFileName = getSourceMapFileName(chunk);
        if (sourceMapFileName) {
          delete output[sourceMapFileName];
        }

        if (chunk.isEntry) {
          const shebang = getShebang(chunk.code);
          const bytecodeLoaderBlock = getBytecodeLoaderBlock(chunk.fileName);
          const bytecodeModuleBlock = `module.exports = require("${toRelativePath(
            bytecodeFileName,
            chunk.fileName
          )}");`;
          chunk.code = `${shebang}${useStrict}\n${bytecodeLoaderBlock}\n${bytecodeModuleBlock}\n`;
          chunk.map = null;
        } else {
          delete output[chunk.fileName];
        }
      }

      const loaderCode = getBytecodeLoaderCode();
      const existingLoader = output[bytecodeModuleLoader];
      if (existingLoader) {
        if (
          existingLoader.type !== "asset" ||
          String(existingLoader.source) !== loaderCode
        ) {
          this.error(
            `Cannot emit ${bytecodeModuleLoader}: another output already uses that filename.`
          );
        }
      } else {
        this.emitFile({
          type: "asset",
          source: loaderCode,
          name: "Bytecode Loader File",
          fileName: bytecodeModuleLoader,
        });
      }
    },

    writeBundle(outputOptions, output): void {
      if (enabled && outputOptions.format === "cjs") {
        const bytecodeChunkCount = Object.keys(output).filter((chunk) =>
          bytecodeChunkExtensionRE.test(chunk)
        ).length;
        logger.info(`✓ ${bytecodeChunkCount} chunks compiled into bytecode.`);
      }
    },
  };
}

function getBytecodeFileName(fileName: string): string {
  return /\.(?:c?js)$/i.test(fileName) ? `${fileName}c` : `${fileName}.jsc`;
}

function rewriteChunkRequires(
  code: string,
  originalCallerFileName: string,
  outputCallerFileName: string,
  outputFileNames: ReadonlyMap<string, string>
): { code: string; rewritten: boolean } {
  return rewriteRequireSpecifiers(code, (specifier) => {
    if (!specifier.startsWith(".")) {
      return undefined;
    }

    const resolvedFileName = normalizePath(
      path.posix.normalize(
        path.posix.join(
          path.posix.dirname(normalizePath(originalCallerFileName)),
          specifier
        )
      )
    );
    const outputFileName = outputFileNames.get(resolvedFileName);
    return outputFileName
      ? toRelativePath(outputFileName, normalizePath(outputCallerFileName))
      : undefined;
  });
}

function getShebang(code: string): string {
  return code.match(/^#![^\n]*(?:\n|$)/)?.[0] ?? "";
}

function stripShebang(code: string): string {
  return code.slice(getShebang(code).length);
}

function injectLoader(code: string, loaderBlock: string): string {
  const shebang = getShebang(code);
  const body = code.slice(shebang.length);
  const directive = body.match(/^(\s*(?:"use strict"|'use strict');)/)?.[0];
  const insertionPoint = shebang.length + (directive?.length ?? 0);
  return `${code.slice(0, insertionPoint)}\n${loaderBlock}${code.slice(
    insertionPoint
  )}`;
}

function getSourceMapFileName(chunk: OutputChunk): string | undefined {
  return chunk.sourcemapFileName
    ? normalizePath(chunk.sourcemapFileName)
    : undefined;
}

function replaceSourceMapReference(code: string, fileName: string): string {
  return code.replace(
    /([#@]\s*sourceMappingURL=)([^\s]+)/g,
    (_match, prefix: string) => `${prefix}${fileName}`
  );
}

function updateSourceMapFile(
  source: string | Uint8Array,
  fileName: string
): string | Uint8Array {
  if (typeof source !== "string") {
    return source;
  }

  try {
    const sourceMap = JSON.parse(source) as { file?: string };
    sourceMap.file = fileName;
    return JSON.stringify(sourceMap);
  } catch {
    return source;
  }
}

// Export types
export type { Plugin };
