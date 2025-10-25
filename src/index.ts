import path from "node:path";
import colors from "picocolors";
import type { Plugin, Logger } from "vite";
import MagicString from "magic-string";
import type { SourceMapInput, OutputChunk } from "rollup";
import { compileToBytecode } from "./compiler";
import { getBytecodeLoaderCode } from "./loader";
import { transformCode } from "./transforms";
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
  const isBytecodeChunk = (chunkName: string): boolean => {
    return (
      transformAllChunks || _chunkAlias.some((alias) => alias === chunkName)
    );
  };

  const useStrict = '"use strict";';
  const bytecodeModuleLoader = "bytecode-loader.cjs";

  let logger: Logger;
  let supported = false;

  return {
    name: "vite:bytecode",
    apply: "build",
    enforce: "post",

    configResolved(config): void {
      if (supported) {
        return;
      }

      logger = config.logger;

      // Check if used in renderer (not supported)
      const useInRenderer = config.plugins.some(
        (p) => p.name === "vite:electron-renderer-preset-config"
      );
      if (useInRenderer) {
        config.logger.warn(
          colors.yellow("bytecodePlugin does not support renderer.")
        );
        return;
      }

      const build = config.build;
      const resolvedOutputs = resolveBuildOutputs(
        build.rollupOptions.output,
        build.lib
      );

      if (resolvedOutputs) {
        const outputs = Array.isArray(resolvedOutputs)
          ? resolvedOutputs
          : [resolvedOutputs];
        const output = outputs[0];

        if (output.format === "es") {
          config.logger.warn(
            colors.yellow(
              "bytecodePlugin does not support ES module output format. " +
                'Please set "build.rollupOptions.output.format" to "cjs".'
            )
          );
        }

        supported = output.format === "cjs" && !useInRenderer;
      }
    },

    renderChunk(
      code,
      chunk,
      { sourcemap }
    ): { code: string; map?: SourceMapInput } | null {
      // ALWAYS transform bytecode chunks to convert template literals
      // Template literals don't work in V8 cached bytecode
      if (supported && isBytecodeChunk(chunk.name)) {
        return transformCode(code, protectedStrings, !!sourcemap);
      }
      return null;
    },

    async generateBundle(_, output): Promise<void> {
      if (!supported) {
        return;
      }

      const _chunks = Object.values(output);
      const chunks = _chunks.filter(
        (chunk) => chunk.type === "chunk" && isBytecodeChunk(chunk.name)
      ) as OutputChunk[];

      if (chunks.length === 0) {
        return;
      }

      const bytecodeChunks = chunks.map((chunk) => chunk.fileName);
      const nonEntryChunks = chunks
        .filter((chunk) => !chunk.isEntry)
        .map((chunk) => path.basename(chunk.fileName));

      // Create regex to match require() calls for non-entry chunks
      const pattern = nonEntryChunks.map((chunk) => `(${chunk})`).join("|");
      const bytecodeRE = pattern
        ? new RegExp(`require\\(\\S*(?=(${pattern})\\S*\\))`, "g")
        : null;

      const getBytecodeLoaderBlock = (chunkFileName: string): string => {
        return `require("${toRelativePath(
          bytecodeModuleLoader,
          normalizePath(chunkFileName)
        )}");`;
      };

      let bytecodeChunkCount = 0;

      const bundles = Object.keys(output);

      await Promise.all(
        bundles.map(async (name) => {
          const chunk = output[name];
          if (chunk.type === "chunk") {
            let _code = chunk.code;

            // Update require() calls to point to .jsc files
            if (bytecodeRE) {
              let match: RegExpExecArray | null;
              let s: MagicString | undefined;
              while ((match = bytecodeRE.exec(_code))) {
                s ||= new MagicString(_code);
                const [prefix, chunkName] = match;
                const len = prefix.length + chunkName.length;
                s.overwrite(
                  match.index,
                  match.index + len,
                  prefix + chunkName + "c",
                  {
                    contentOnly: true,
                  }
                );
              }
              if (s) {
                _code = s.toString();
              }
            }

            if (bytecodeChunks.includes(name)) {
              // Compile this chunk to bytecode
              const bytecodeBuffer = await compileToBytecode(_code);

              this.emitFile({
                type: "asset",
                fileName: name + "c",
                source: bytecodeBuffer,
              });

              if (!removeBundleJS) {
                // Keep original JS file with underscore prefix
                this.emitFile({
                  type: "asset",
                  fileName: "_" + chunk.fileName,
                  source: chunk.code,
                });
              }

              if (chunk.isEntry) {
                // For entry chunks, replace with loader code
                const bytecodeLoaderBlock = getBytecodeLoaderBlock(
                  chunk.fileName
                );
                const bytecodeModuleBlock = `require("./${
                  path.basename(name) + "c"
                }");`;
                const code = `${useStrict}\n${bytecodeLoaderBlock}\n${bytecodeModuleBlock}\n`;
                chunk.code = code;
              } else {
                // For non-entry chunks, remove the original chunk
                delete output[chunk.fileName];
              }

              bytecodeChunkCount += 1;
            } else {
              // This chunk is not being compiled to bytecode, but may import bytecode chunks
              if (chunk.isEntry) {
                let hasBytecodeModule = false;
                const idsToHandle = new Set([
                  ...chunk.imports,
                  ...chunk.dynamicImports,
                ]);

                for (const moduleId of idsToHandle) {
                  if (bytecodeChunks.includes(moduleId)) {
                    hasBytecodeModule = true;
                    break;
                  }
                  const moduleInfo = this.getModuleInfo(moduleId);
                  if (moduleInfo && !moduleInfo.isExternal) {
                    const { importers, dynamicImporters } = moduleInfo;
                    for (const importerId of importers)
                      idsToHandle.add(importerId);
                    for (const importerId of dynamicImporters)
                      idsToHandle.add(importerId);
                  }
                }

                _code = hasBytecodeModule
                  ? _code.replace(
                      /("use strict";)|('use strict';)/,
                      `${useStrict}\n${getBytecodeLoaderBlock(chunk.fileName)}`
                    )
                  : _code;
              }
              chunk.code = _code;
            }
          }
        })
      );

      // Emit bytecode loader if we compiled any chunks
      if (
        bytecodeChunkCount &&
        !_chunks.some(
          (ass) => ass.type === "asset" && ass.fileName === bytecodeModuleLoader
        )
      ) {
        this.emitFile({
          type: "asset",
          source: getBytecodeLoaderCode(),
          name: "Bytecode Loader File",
          fileName: bytecodeModuleLoader,
        });
      }
    },

    writeBundle(_, output): void {
      if (supported) {
        const bytecodeChunkCount = Object.keys(output).filter((chunk) =>
          bytecodeChunkExtensionRE.test(chunk)
        ).length;
        logger.info(
          `${colors.green(
            `✓`
          )} ${bytecodeChunkCount} chunks compiled into bytecode.`
        );
      }
    },
  };
}

// Export types
export type { Plugin };
