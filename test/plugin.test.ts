import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { build, type Plugin } from "vite";
import type { RollupOutput } from "rollup";
import { bytecodePlugin } from "../src/index";

describe("bytecodePlugin output formats", () => {
  let fixtureDir: string;
  let originalNodeEnv: string | undefined;

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    fixtureDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "vite-plugin-v8-bytecode-")
    );
    fs.writeFileSync(
      path.join(fixtureDir, "entry.js"),
      [
        "const tag = (strings, value) => ({",
        "  cooked: strings[0],",
        "  raw: strings.raw[0],",
        "  value",
        "});",
        "export const answer = `${40 + 2}`;",
        "export const tagged = tag`line\\n${answer}`;",
        "",
      ].join("\n")
    );
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  async function buildLibrary(
    formats?: Array<"es" | "cjs" | "umd">
  ): Promise<RollupOutput[]> {
    const result = await build({
      configFile: false,
      logLevel: "silent",
      plugins: [bytecodePlugin()],
      build: {
        write: false,
        minify: false,
        lib: {
          entry: path.join(fixtureDir, "entry.js"),
          name: "RegressionFixture",
          fileName: (format) =>
            format === "cjs" ? "entry.cjs" : `entry.${format}.js`,
          ...(formats ? { formats } : {}),
        },
      },
    });

    return (Array.isArray(result) ? result : [result]) as RollupOutput[];
  }

  async function buildSplitChunk({
    sourcemap = false,
    strict = true,
  }: {
    sourcemap?: boolean;
    strict?: boolean;
  } = {}): Promise<RollupOutput> {
    const entryPath = path.join(fixtureDir, "split-entry.js");
    const secretPath = path.join(fixtureDir, "split-secret.js");
    fs.writeFileSync(
      entryPath,
      ['import { secret } from "./split-secret.js";', "console.log(secret);"].join(
        "\n"
      )
    );
    fs.writeFileSync(
      secretPath,
      'export const secret = "TOP_SECRET_VALUE";\n'
    );

    return (await build({
      configFile: false,
      logLevel: "silent",
      plugins: [
        bytecodePlugin({
          chunkAlias: "secret",
          protectedStrings: ["TOP_SECRET_VALUE"],
        }),
      ],
      build: {
        write: false,
        sourcemap,
        rollupOptions: {
          input: entryPath,
          output: {
            format: "cjs",
            strict,
            entryFileNames: "entry.cjs",
            chunkFileNames: "[name].js",
            manualChunks(id) {
              if (id.endsWith("split-secret.js")) {
                return "secret";
              }
            },
          },
        },
      },
    })) as RollupOutput;
  }

  function writeOutput(output: RollupOutput): string {
    const outputDir = path.join(fixtureDir, "dist");

    for (const file of output.output) {
      const filePath = path.join(outputDir, file.fileName);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(
        filePath,
        file.type === "chunk" ? file.code : file.source
      );
    }

    return outputDir;
  }

  it("does not crash when library formats use Vite defaults", async () => {
    const outputs = await buildLibrary();

    expect(outputs).toHaveLength(2);
    expect(
      outputs.flatMap((output) => output.output.map((file) => file.fileName))
    ).not.toContain("bytecode-loader.cjs");
  });

  it("compiles a CommonJS-only library output", async () => {
    const [output] = await buildLibrary(["cjs"]);
    const files = output.output.map((file) => file.fileName);
    const entry = output.output.find(
      (file) => file.type === "chunk" && file.fileName === "entry.cjs"
    );

    expect(files).toContain("entry.cjsc");
    expect(files).toContain("bytecode-loader.cjs");
    expect(entry).toMatchObject({ type: "chunk" });
    expect(entry?.type === "chunk" ? entry.code : "").toContain(
      'require("./entry.cjsc")'
    );

    const outputDir = writeOutput(output);
    const exports = JSON.parse(
      execFileSync(
        process.execPath,
        ["-e", 'process.stdout.write(JSON.stringify(require("./entry.cjs")))'],
        { cwd: outputDir, encoding: "utf8" }
      )
    );
    expect(exports).toEqual({
      answer: "42",
      tagged: {
        cooked: "line\n",
        raw: "line\\n",
        value: "42",
      },
    });
  });

  it("compiles only the CommonJS side of a mixed-format library", async () => {
    const outputs = await buildLibrary(["cjs", "es"]);
    const cjsOutput = outputs.find((output) =>
      output.output.some((file) => file.fileName === "entry.cjs")
    );
    const esOutput = outputs.find((output) =>
      output.output.some((file) => file.fileName === "entry.es.js")
    );
    const esFiles = esOutput?.output.map((file) => file.fileName) ?? [];
    const esEntry = esOutput?.output.find(
      (file) => file.type === "chunk" && file.fileName === "entry.es.js"
    );

    expect(cjsOutput).toBeDefined();
    expect(
      cjsOutput?.output.map((file) => file.fileName)
    ).toContain("entry.cjsc");
    expect(esOutput).toBeDefined();
    expect(esFiles).not.toContain("bytecode-loader.cjs");
    expect(esFiles.every((fileName) => !/\.c?jsc$/.test(fileName))).toBe(true);
    expect(esEntry?.type === "chunk" ? esEntry.code : "").toContain("export");
  });

  it("injects the bytecode loader when Rollup strict mode is disabled", async () => {
    const result = await buildSplitChunk({ strict: false });
    const entry = result.output.find(
      (file) => file.type === "chunk" && file.fileName === "entry.cjs"
    );
    const entryCode = entry?.type === "chunk" ? entry.code : "";

    expect(entryCode).toContain('require("./bytecode-loader.cjs")');
    expect(entryCode).toContain('require("./secret.jsc")');
  });

  it("does not leave source maps for removed JavaScript chunks", async () => {
    const result = await buildSplitChunk({ sourcemap: true });
    const files = result.output.map((file) => file.fileName);

    expect(files).toContain("secret.jsc");
    expect(files).not.toContain("secret.js");
    expect(files).not.toContain("secret.js.map");
  });

  it("rewrites only exact bytecode chunk filenames", async () => {
    const virtualIds = new Set([
      "virtual:entry",
      "virtual:bytecode",
      "virtual:plain",
    ]);
    const virtualModules = {
      name: "virtual-regex-filenames",
      resolveId(id: string) {
        return virtualIds.has(id) ? `\0${id}` : null;
      },
      load(id: string) {
        if (id === "\0virtual:entry") {
          return [
            'import { encoded } from "virtual:bytecode";',
            'import { plain } from "virtual:plain";',
            "console.log(encoded, plain);",
          ].join("\n");
        }
        if (id === "\0virtual:bytecode") {
          return 'export const encoded = "encoded";';
        }
        if (id === "\0virtual:plain") {
          return 'export const plain = "plain";';
        }
        return null;
      },
    };

    const result = (await build({
      configFile: false,
      logLevel: "silent",
      plugins: [
        virtualModules,
        bytecodePlugin({ chunkAlias: "feature.v1" }),
      ],
      build: {
        write: false,
        rollupOptions: {
          input: "virtual:entry",
          output: {
            format: "cjs",
            entryFileNames: "entry.cjs",
            chunkFileNames: "[name].js",
            manualChunks(id) {
              if (id.endsWith("virtual:bytecode")) {
                return "feature.v1";
              }
              if (id.endsWith("virtual:plain")) {
                return "featureXv1Yjs";
              }
            },
          },
        },
      },
    })) as RollupOutput;
    const files = result.output.map((file) => file.fileName);
    const entry = result.output.find(
      (file) => file.type === "chunk" && file.fileName === "entry.cjs"
    );
    const entryCode = entry?.type === "chunk" ? entry.code : "";

    expect(files).toContain("feature.v1.jsc");
    expect(files).toContain("featureXv1Yjs.js");
    expect(entryCode).toContain('require("./feature.v1.jsc")');
    expect(entryCode).toContain('require("./featureXv1Yjs.js")');
    expect(entryCode).not.toContain("featureXv1Yjsc.js");
  });

  it("does not rewrite require-like text inside string literals", async () => {
    const virtualIds = new Set(["virtual:entry", "virtual:secret"]);
    const virtualModules = {
      name: "virtual-require-like-string",
      resolveId(id: string) {
        return virtualIds.has(id) ? `\0${id}` : null;
      },
      load(id: string) {
        if (id === "\0virtual:entry") {
          return [
            'import { secret } from "virtual:secret";',
            'export const marker = \'require("./secret.js")\';',
            "export const loaded = secret;",
          ].join("\n");
        }
        if (id === "\0virtual:secret") {
          return 'export const secret = "loaded";';
        }
        return null;
      },
    };

    const result = (await build({
      configFile: false,
      logLevel: "silent",
      plugins: [
        virtualModules,
        bytecodePlugin({ chunkAlias: "secret" }),
      ],
      build: {
        write: false,
        rollupOptions: {
          preserveEntrySignatures: "strict",
          input: "virtual:entry",
          output: {
            format: "cjs",
            entryFileNames: "entry.cjs",
            chunkFileNames: "[name].js",
            manualChunks(id) {
              if (id.endsWith("virtual:secret")) {
                return "secret";
              }
            },
          },
        },
      },
    })) as RollupOutput;
    const entry = result.output.find(
      (file) => file.type === "chunk" && file.fileName === "entry.cjs"
    );
    const entryCode = entry?.type === "chunk" ? entry.code : "";
    const outputDir = writeOutput(result);
    expect(entryCode).toContain('require("./secret.jsc")');
    expect(entryCode).toContain('\'require("./secret.js")\'');
    const exports = JSON.parse(
      execFileSync(
        process.execPath,
        ["-e", 'process.stdout.write(JSON.stringify(require("./entry.cjs")))'],
        { cwd: outputDir, encoding: "utf8" }
      )
    );

    expect(exports).toEqual({
      loaded: "loaded",
      marker: 'require("./secret.js")',
    });
  });

  it("distinguishes chunks with the same basename in different directories", async () => {
    const virtualIds = new Set([
      "virtual:entry",
      "virtual:bytecode",
      "virtual:plain",
    ]);
    const virtualModules = {
      name: "virtual-duplicate-basenames",
      resolveId(id: string) {
        return virtualIds.has(id) ? `\0${id}` : null;
      },
      load(id: string) {
        if (id === "\0virtual:entry") {
          return [
            'import { encoded } from "virtual:bytecode";',
            'import { plain } from "virtual:plain";',
            "console.log(encoded, plain);",
          ].join("\n");
        }
        if (id === "\0virtual:bytecode") {
          return 'export const encoded = "encoded";';
        }
        if (id === "\0virtual:plain") {
          return 'export const plain = "plain";';
        }
        return null;
      },
    };

    const result = (await build({
      configFile: false,
      logLevel: "silent",
      plugins: [
        virtualModules,
        bytecodePlugin({ chunkAlias: "encoded" }),
      ],
      build: {
        write: false,
        rollupOptions: {
          input: "virtual:entry",
          output: {
            format: "cjs",
            entryFileNames: "entry.cjs",
            chunkFileNames(chunk) {
              return chunk.name === "encoded"
                ? "compiled/shared.js"
                : "plain/shared.js";
            },
            manualChunks(id) {
              if (id.endsWith("virtual:bytecode")) {
                return "encoded";
              }
              if (id.endsWith("virtual:plain")) {
                return "plain";
              }
            },
          },
        },
      },
    })) as RollupOutput;
    const files = result.output.map((file) => file.fileName);
    const entry = result.output.find(
      (file) => file.type === "chunk" && file.fileName === "entry.cjs"
    );
    const entryCode = entry?.type === "chunk" ? entry.code : "";

    expect(files).toContain("compiled/shared.jsc");
    expect(files).toContain("plain/shared.js");
    expect(entryCode).toContain('require("./compiled/shared.jsc")');
    expect(entryCode).toContain('require("./plain/shared.js")');
    expect(entryCode).not.toContain('require("./plain/shared.jsc")');
  });

  it("loads bytecode used only by a dynamically imported chunk", async () => {
    const virtualIds = new Set([
      "virtual:entry",
      "virtual:middle",
      "virtual:secret",
    ]);
    const virtualModules = {
      name: "virtual-dynamic-bytecode",
      resolveId(id: string) {
        return virtualIds.has(id) ? `\0${id}` : null;
      },
      load(id: string) {
        if (id === "\0virtual:entry") {
          return [
            'import("virtual:middle").then(({ middle }) => {',
            "  console.log(middle);",
            "});",
          ].join("\n");
        }
        if (id === "\0virtual:middle") {
          return [
            'import { secret } from "virtual:secret";',
            "export const middle = secret;",
          ].join("\n");
        }
        if (id === "\0virtual:secret") {
          return 'export const secret = "ok";';
        }
        return null;
      },
    };

    const result = (await build({
      configFile: false,
      logLevel: "silent",
      plugins: [
        virtualModules,
        bytecodePlugin({ chunkAlias: "secret" }),
      ],
      build: {
        write: false,
        rollupOptions: {
          input: "virtual:entry",
          output: {
            format: "cjs",
            entryFileNames: "entry.cjs",
            chunkFileNames: "[name].js",
            manualChunks(id) {
              if (id.endsWith("virtual:secret")) {
                return "secret";
              }
            },
          },
        },
      },
    })) as RollupOutput;
    const entry = result.output.find(
      (file) => file.type === "chunk" && file.fileName === "entry.cjs"
    );
    const middle = result.output.find(
      (file) =>
        file.type === "chunk" &&
        file.fileName !== "entry.cjs" &&
        file.fileName.endsWith(".js")
    );
    const entryCode = entry?.type === "chunk" ? entry.code : "";
    const middleCode = middle?.type === "chunk" ? middle.code : "";

    expect(middleCode).toContain('require("./secret.jsc")');
    expect(`${entryCode}\n${middleCode}`).toContain(
      'require("./bytecode-loader.cjs")'
    );
  });

  it.each(["entry.bin", "entry"])(
    "uses a registered bytecode extension for output filename %s",
    async (entryFileName) => {
      const virtualModules = {
        name: `virtual-extension-${entryFileName}`,
        resolveId(id: string) {
          return id === "virtual:entry" ? "\0virtual:entry" : null;
        },
        load(id: string) {
          return id === "\0virtual:entry" ? 'module.exports = "ok";' : null;
        },
      };

      const result = (await build({
        configFile: false,
        logLevel: "silent",
        plugins: [virtualModules, bytecodePlugin()],
        build: {
          write: false,
          rollupOptions: {
            input: "virtual:entry",
            output: {
              format: "cjs",
              entryFileNames: entryFileName,
            },
          },
        },
      })) as RollupOutput;
      const entry = result.output.find(
        (file) => file.type === "chunk" && file.fileName === entryFileName
      );
      const bytecode = result.output.find(
        (file) => file.type === "asset" && /\.c?jsc$/.test(file.fileName)
      );
      const entryCode = entry?.type === "chunk" ? entry.code : "";

      expect(bytecode).toBeDefined();
      expect(entryCode).toContain(
        `require("./${path.basename(bytecode?.fileName ?? "")}")`
      );
    }
  );

  it("keeps nested original JavaScript executable with partial bytecode selection", async () => {
    const entryPath = path.join(fixtureDir, "keep-entry.js");
    const plainPath = path.join(fixtureDir, "keep-plain.js");
    fs.writeFileSync(
      entryPath,
      ['import { plain } from "./keep-plain.js";', "console.log(plain);"].join(
        "\n"
      )
    );
    fs.writeFileSync(plainPath, 'export const plain = "plain";\n');

    const result = (await build({
      configFile: false,
      logLevel: "silent",
      plugins: [
        bytecodePlugin({
          chunkAlias: "entry",
          removeBundleJS: false,
        }),
      ],
      build: {
        write: false,
        rollupOptions: {
          input: { entry: entryPath },
          output: {
            format: "cjs",
            entryFileNames: "nested/entry.cjs",
            chunkFileNames: "nested/[name].js",
            manualChunks(id) {
              if (id.endsWith("keep-plain.js")) {
                return "plain";
              }
            },
          },
        },
      },
    })) as RollupOutput;
    const outputDir = writeOutput(result);

    expect(() =>
      execFileSync(process.execPath, ["_nested/entry.cjs"], {
        cwd: outputDir,
        encoding: "utf8",
      })
    ).not.toThrow();
  });

  it("keeps source maps paired with retained original JavaScript", async () => {
    const buildResult = await build({
      configFile: false,
      logLevel: "silent",
      plugins: [bytecodePlugin({ removeBundleJS: false })],
      build: {
        write: false,
        sourcemap: true,
        lib: {
          entry: path.join(fixtureDir, "entry.js"),
          name: "RegressionFixture",
          fileName: () => "entry.cjs",
          formats: ["cjs"],
        },
      },
    });
    const result = (
      Array.isArray(buildResult) ? buildResult[0] : buildResult
    ) as RollupOutput;
    const files = result.output.map((file) => file.fileName);
    const retainedEntry = result.output.find(
      (file) => file.type === "asset" && file.fileName === "_entry.cjs"
    );

    expect(files).toContain("_entry.cjs");
    expect(files).toContain("_entry.cjs.map");
    expect(
      retainedEntry?.type === "asset" ? String(retainedEntry.source) : ""
    ).toContain(
      "sourceMappingURL=_entry.cjs.map"
    );
  });

  it("keeps a fully bytecoded split bundle executable as original JavaScript", async () => {
    const entryPath = path.join(fixtureDir, "retained-entry.js");
    const dependencyPath = path.join(fixtureDir, "retained-dependency.js");
    fs.writeFileSync(
      entryPath,
      [
        'import { value } from "./retained-dependency.js";',
        "console.log(value);",
      ].join("\n")
    );
    fs.writeFileSync(
      dependencyPath,
      'export const value = "retained bundle works";\n'
    );

    const result = (await build({
      configFile: false,
      logLevel: "silent",
      plugins: [bytecodePlugin({ removeBundleJS: false })],
      build: {
        write: false,
        rollupOptions: {
          input: { entry: entryPath },
          output: {
            format: "cjs",
            entryFileNames: "entry.cjs",
            chunkFileNames: "[name].js",
            manualChunks(id) {
              if (id.endsWith("retained-dependency.js")) {
                return "dependency";
              }
            },
          },
        },
      },
    })) as RollupOutput;
    const outputDir = writeOutput(result);

    expect(
      execFileSync(process.execPath, ["_entry.cjs"], {
        cwd: outputDir,
        encoding: "utf8",
      })
    ).toContain("retained bundle works");
  });

  it("does not emit stale plaintext source maps for bytecode-only chunks", async () => {
    const protectedValue = "SOURCE_MAP_SECRET_VALUE";
    fs.writeFileSync(
      path.join(fixtureDir, "entry.js"),
      `export const secret = ${JSON.stringify(protectedValue)};\n`
    );

    const buildResult = await build({
      configFile: false,
      logLevel: "silent",
      plugins: [bytecodePlugin({ protectedStrings: [protectedValue] })],
      build: {
        write: false,
        sourcemap: true,
        lib: {
          entry: path.join(fixtureDir, "entry.js"),
          name: "SourceMapFixture",
          fileName: () => "entry.cjs",
          formats: ["cjs"],
        },
      },
    });
    const result = (
      Array.isArray(buildResult) ? buildResult[0] : buildResult
    ) as RollupOutput;
    const sourceMaps = result.output.filter((file) =>
      file.fileName.endsWith(".map")
    );
    const emittedText = result.output
      .filter(
        (file) =>
          file.type === "chunk" ||
          (file.type === "asset" && typeof file.source === "string")
      )
      .map((file) => (file.type === "chunk" ? file.code : file.source))
      .join("\n");

    expect(sourceMaps).toEqual([]);
    expect(emittedText).not.toContain(protectedValue);
  });

  it("rejects conflicting bytecode loader assets", async () => {
    const virtualModules = {
      name: "virtual-loader-collision",
      resolveId(id: string) {
        return id === "virtual:entry" ? "\0virtual:entry" : null;
      },
      load(id: string) {
        return id === "\0virtual:entry" ? 'module.exports = "ok";' : null;
      },
    };
    const conflictingLoader: Plugin = {
      name: "conflicting-bytecode-loader",
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "bytecode-loader.cjs",
          source: 'module.exports = "not a bytecode loader";',
        });
      },
    };

    await expect(
      build({
        configFile: false,
        logLevel: "silent",
        plugins: [virtualModules, conflictingLoader, bytecodePlugin()],
        build: {
          write: false,
          rollupOptions: {
            input: "virtual:entry",
            output: {
              format: "cjs",
              entryFileNames: "entry.cjs",
            },
          },
        },
      })
    ).rejects.toThrow(/bytecode-loader\.cjs/i);
  });

  it("preserves a shebang while compiling a CommonJS entry", async () => {
    const virtualModules = {
      name: "virtual-shebang",
      resolveId(id: string) {
        return id === "virtual:entry" ? "\0virtual:entry" : null;
      },
      load(id: string) {
        return id === "\0virtual:entry" ? 'console.log("ok");' : null;
      },
    };

    const result = (await build({
      configFile: false,
      logLevel: "silent",
      plugins: [virtualModules, bytecodePlugin()],
      build: {
        write: false,
        rollupOptions: {
          input: "virtual:entry",
          output: {
            format: "cjs",
            banner: "#!/usr/bin/env node",
            entryFileNames: "entry.cjs",
          },
        },
      },
    })) as RollupOutput;
    const entry = result.output.find(
      (file) => file.type === "chunk" && file.fileName === "entry.cjs"
    );

    expect(entry?.type === "chunk" ? entry.code : "").toMatch(
      /^#!\/usr\/bin\/env node/
    );
  });

  it("loads bytecode behind a static preserveModules import chain", async () => {
    const virtualIds = new Set([
      "virtual:entry",
      "virtual:middle",
      "virtual:secret",
    ]);
    const virtualModules = {
      name: "virtual-preserve-modules",
      resolveId(id: string) {
        return virtualIds.has(id) ? `\0${id}` : null;
      },
      load(id: string) {
        if (id === "\0virtual:entry") {
          return [
            'import { middle } from "virtual:middle";',
            "console.log(middle);",
          ].join("\n");
        }
        if (id === "\0virtual:middle") {
          return [
            'import { secret } from "virtual:secret";',
            "export const middle = secret;",
          ].join("\n");
        }
        if (id === "\0virtual:secret") {
          return 'export const secret = "ok";';
        }
        return null;
      },
    };

    const result = (await build({
      configFile: false,
      logLevel: "silent",
      plugins: [
        virtualModules,
        bytecodePlugin({
          chunkAlias: "_virtual/_virtual_secret",
        }),
      ],
      build: {
        write: false,
        rollupOptions: {
          preserveEntrySignatures: "strict",
          input: "virtual:entry",
          output: {
            format: "cjs",
            preserveModules: true,
            entryFileNames: "[name].js",
          },
        },
      },
    })) as RollupOutput;
    const javaScriptChunks = result.output.filter(
      (file) => file.type === "chunk"
    );
    const combinedCode = javaScriptChunks.map((chunk) => chunk.code).join("\n");

    expect(combinedCode).toContain('require("./_virtual_secret.jsc")');
    expect(combinedCode).toContain('require("../bytecode-loader.cjs")');
  });

  it("matches chunk aliases before Rollup filename sanitization", async () => {
    const virtualIds = new Set(["virtual:entry", "virtual:feature"]);
    const virtualModules = {
      name: "virtual-sanitized-alias",
      resolveId(id: string) {
        return virtualIds.has(id) ? `\0${id}` : null;
      },
      load(id: string) {
        if (id === "\0virtual:entry") {
          return [
            'import { value } from "virtual:feature";',
            "console.log(value);",
          ].join("\n");
        }
        if (id === "\0virtual:feature") {
          return 'export const value = "ok";';
        }
        return null;
      },
    };

    const result = (await build({
      configFile: false,
      logLevel: "silent",
      plugins: [
        virtualModules,
        bytecodePlugin({ chunkAlias: "feature+v1" }),
      ],
      build: {
        write: false,
        rollupOptions: {
          input: "virtual:entry",
          output: {
            format: "cjs",
            entryFileNames: "entry.cjs",
            chunkFileNames: "[name].js",
            manualChunks(id) {
              if (id.endsWith("virtual:feature")) {
                return "feature+v1";
              }
            },
          },
        },
      },
    })) as RollupOutput;
    const files = result.output.map((file) => file.fileName);

    expect(files).toContain("feature_v1.jsc");
    expect(files).not.toContain("feature_v1.js");
  });
});
