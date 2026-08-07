import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { build, type Plugin, type Rolldown } from "vite";
import { bytecodePlugin } from "../src/index";

type RollupOutput = Rolldown.RolldownOutput;

describe("bytecodePlugin output formats", () => {
  const obfuscatedMarker = "INTERNAL_PROTOCOL_MARKER";
  let fixtureDir: string;
  let originalNodeEnv: string | undefined;

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "vite-plugin-v8-bytecode-"));
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
      ].join("\n"),
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

  async function buildLibrary(formats?: Array<"es" | "cjs" | "umd">): Promise<RollupOutput[]> {
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
          fileName: (format) => (format === "cjs" ? "entry.cjs" : `entry.${format}.js`),
          ...(formats ? { formats } : {}),
        },
      },
    });

    return (Array.isArray(result) ? result : [result]) as RollupOutput[];
  }

  async function buildDefaultApplication(
    packageType: "commonjs" | "module",
  ): Promise<RollupOutput> {
    fs.writeFileSync(
      path.join(fixtureDir, "package.json"),
      JSON.stringify({ private: true, type: packageType }),
    );

    return (await build({
      configFile: false,
      logLevel: "silent",
      plugins: [bytecodePlugin()],
      root: fixtureDir,
      build: {
        write: false,
        rolldownOptions: {
          input: path.join(fixtureDir, "entry.js"),
          preserveEntrySignatures: "strict",
        },
      },
    })) as RollupOutput;
  }

  async function buildSplitChunk({
    sourcemap = false,
    strict = true,
  }: {
    sourcemap?: boolean;
    strict?: boolean;
  } = {}): Promise<RollupOutput> {
    const entryPath = path.join(fixtureDir, "split-entry.js");
    const markerPath = path.join(fixtureDir, "split-marker.js");
    fs.writeFileSync(
      entryPath,
      ['import { marker } from "./split-marker.js";', "console.log(marker);"].join("\n"),
    );
    fs.writeFileSync(markerPath, `export const marker = ${JSON.stringify(obfuscatedMarker)};\n`);

    return (await build({
      configFile: false,
      logLevel: "silent",
      plugins: [
        bytecodePlugin({
          chunkAlias: "marker",
          obfuscatedStrings: [obfuscatedMarker],
        }),
      ],
      build: {
        write: false,
        sourcemap,
        rolldownOptions: {
          input: entryPath,
          output: {
            format: "cjs",
            strict,
            entryFileNames: "entry.cjs",
            chunkFileNames: "[name].js",
            manualChunks(id) {
              if (id.endsWith("split-marker.js")) {
                return "marker";
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
      fs.writeFileSync(filePath, file.type === "chunk" ? file.code : file.source);
    }

    return outputDir;
  }

  it("rejects the removed option with safe migration guidance", () => {
    expect(() =>
      bytecodePlugin({
        protectedStrings: ["LEGACY_VALUE"],
      } as never),
    ).toThrow(
      '"protectedStrings" was renamed to "obfuscatedStrings". ' +
        "It provides reversible obfuscation only and must not be used for secrets.",
    );
  });

  it("defaults a library build to CommonJS", async () => {
    const [output] = await buildLibrary();

    expect(output.output.map((file) => file.fileName)).toEqual(
      expect.arrayContaining(["bytecode-loader.cjs", "entry.cjs", "entry.cjsc"]),
    );
  });

  it("compiles a CommonJS-only library output", async () => {
    const [output] = await buildLibrary(["cjs"]);
    const files = output.output.map((file) => file.fileName);
    const entry = output.output.find(
      (file) => file.type === "chunk" && file.fileName === "entry.cjs",
    );

    expect(files).toContain("entry.cjsc");
    expect(files).toContain("bytecode-loader.cjs");
    expect(entry).toMatchObject({ type: "chunk" });
    expect(entry?.type === "chunk" ? entry.code : "").toContain('require("./entry.cjsc")');

    const outputDir = writeOutput(output);
    const exports = JSON.parse(
      execFileSync(
        process.execPath,
        ["-e", 'process.stdout.write(JSON.stringify(require("./entry.cjs")))'],
        { cwd: outputDir, encoding: "utf8" },
      ),
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

  it("leaves an explicitly configured ES library unchanged", async () => {
    const [output] = await buildLibrary(["es"]);
    const files = output.output.map((file) => file.fileName);

    expect(files).toContain("entry.es.js");
    expect(files).not.toContain("bytecode-loader.cjs");
    expect(files.every((fileName) => !/\.c?jsc$/.test(fileName))).toBe(true);
  });

  it("compiles only the CommonJS side of a mixed-format library", async () => {
    const outputs = await buildLibrary(["cjs", "es"]);
    const cjsOutput = outputs.find((output) =>
      output.output.some((file) => file.fileName === "entry.cjs"),
    );
    const esOutput = outputs.find((output) =>
      output.output.some((file) => file.fileName === "entry.es.js"),
    );
    const esFiles = esOutput?.output.map((file) => file.fileName) ?? [];
    const esEntry = esOutput?.output.find(
      (file) => file.type === "chunk" && file.fileName === "entry.es.js",
    );

    expect(cjsOutput).toBeDefined();
    expect(cjsOutput?.output.map((file) => file.fileName)).toContain("entry.cjsc");
    expect(esOutput).toBeDefined();
    expect(esFiles).not.toContain("bytecode-loader.cjs");
    expect(esFiles.every((fileName) => !/\.c?jsc$/.test(fileName))).toBe(true);
    expect(esEntry?.type === "chunk" ? esEntry.code : "").toContain("export");
  });

  it("defaults an application build to CommonJS", async () => {
    const result = await buildDefaultApplication("commonjs");
    const entry = result.output.find((file) => file.type === "chunk" && file.isEntry);
    const files = result.output.map((file) => file.fileName);

    expect(entry?.fileName).toMatch(/^assets\/entry-[\w-]+\.js$/);
    expect(files).toContain("bytecode-loader.cjs");
    expect(files).toContain(entry?.fileName.replace(/\.js$/, ".jsc"));
    expect(files).not.toContain("package.json");

    const outputDirectory = writeOutput(result);
    const exports = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "-e",
          `process.stdout.write(JSON.stringify(require(${JSON.stringify(
            `./${entry?.fileName}`,
          )})))`,
        ],
        { cwd: outputDirectory, encoding: "utf8" },
      ),
    );
    expect(exports.answer).toBe("42");
  });

  it("leaves an explicitly configured ES application unchanged", async () => {
    const result = (await build({
      configFile: false,
      logLevel: "silent",
      plugins: [bytecodePlugin()],
      root: fixtureDir,
      build: {
        write: false,
        rolldownOptions: {
          input: path.join(fixtureDir, "entry.js"),
          output: {
            entryFileNames: "index.js",
            format: "es",
          },
          preserveEntrySignatures: "strict",
        },
      },
    })) as RollupOutput;
    const files = result.output.map((file) => file.fileName);
    const entry = result.output.find(
      (file) => file.type === "chunk" && file.fileName === "index.js",
    );

    expect(files).toEqual(["index.js"]);
    expect(entry?.type === "chunk" ? entry.code : "").toContain("export");
  });

  it("adds a CommonJS boundary for default output in a type-module package", async () => {
    const result = await buildDefaultApplication("module");
    const entry = result.output.find((file) => file.type === "chunk" && file.isEntry);
    const packageAsset = result.output.find(
      (file) => file.type === "asset" && file.fileName === "package.json",
    );

    expect(entry?.fileName).toMatch(/^assets\/entry-[\w-]+\.js$/);
    expect(packageAsset?.type === "asset" ? packageAsset.source : "").toBe(
      '{\n  "type": "commonjs"\n}\n',
    );

    const outputDirectory = writeOutput(result);
    const exports = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "-e",
          `process.stdout.write(JSON.stringify(require(${JSON.stringify(
            `./${entry?.fileName}`,
          )})))`,
        ],
        { cwd: outputDirectory, encoding: "utf8" },
      ),
    );
    expect(exports.answer).toBe("42");
  });

  it("keeps default output runnable when no chunk alias matches", async () => {
    fs.writeFileSync(
      path.join(fixtureDir, "package.json"),
      JSON.stringify({ private: true, type: "module" }),
    );

    const result = (await build({
      configFile: false,
      logLevel: "silent",
      plugins: [bytecodePlugin({ chunkAlias: "missing" })],
      root: fixtureDir,
      build: {
        write: false,
        rolldownOptions: {
          input: path.join(fixtureDir, "entry.js"),
          preserveEntrySignatures: "strict",
        },
      },
    })) as RollupOutput;
    const entry = result.output.find((file) => file.type === "chunk" && file.isEntry);
    const files = result.output.map((file) => file.fileName);

    expect(files).toContain("package.json");
    expect(files).not.toContain("bytecode-loader.cjs");
    expect(files.every((fileName) => !/\.c?jsc$/.test(fileName))).toBe(true);

    const outputDirectory = writeOutput(result);
    const exports = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "-e",
          `process.stdout.write(JSON.stringify(require(${JSON.stringify(
            `./${entry?.fileName}`,
          )})))`,
        ],
        { cwd: outputDirectory, encoding: "utf8" },
      ),
    );
    expect(exports.answer).toBe("42");
  });

  it("keeps an explicit CommonJS .js entry runnable in a type-module package", async () => {
    fs.writeFileSync(
      path.join(fixtureDir, "package.json"),
      JSON.stringify({ private: true, type: "module" }),
    );

    const result = (await build({
      configFile: false,
      logLevel: "silent",
      plugins: [bytecodePlugin()],
      root: fixtureDir,
      build: {
        write: false,
        rolldownOptions: {
          input: path.join(fixtureDir, "entry.js"),
          preserveEntrySignatures: "strict",
          output: {
            entryFileNames: "index.js",
            format: "cjs",
          },
        },
      },
    })) as RollupOutput;

    expect(result.output.map((file) => file.fileName)).toEqual(
      expect.arrayContaining(["bytecode-loader.cjs", "index.js", "index.jsc", "package.json"]),
    );

    const outputDirectory = writeOutput(result);
    const exports = JSON.parse(
      execFileSync(
        process.execPath,
        ["-e", 'process.stdout.write(JSON.stringify(require("./index.js")))'],
        { cwd: outputDirectory, encoding: "utf8" },
      ),
    );
    expect(exports.answer).toBe("42");
  });

  it("keeps an explicit CommonJS .js library entry runnable in a type-module package", async () => {
    fs.writeFileSync(
      path.join(fixtureDir, "package.json"),
      JSON.stringify({ private: true, type: "module" }),
    );

    const buildResult = await build({
      configFile: false,
      logLevel: "silent",
      plugins: [bytecodePlugin()],
      root: fixtureDir,
      build: {
        lib: {
          entry: path.join(fixtureDir, "entry.js"),
          fileName: () => "index.js",
          formats: ["cjs"],
          name: "RegressionFixture",
        },
        write: false,
      },
    });
    const result = (Array.isArray(buildResult) ? buildResult[0] : buildResult) as RollupOutput;

    expect(result.output.map((file) => file.fileName)).toEqual(
      expect.arrayContaining(["bytecode-loader.cjs", "index.js", "index.jsc", "package.json"]),
    );

    const outputDirectory = writeOutput(result);
    const exports = JSON.parse(
      execFileSync(
        process.execPath,
        ["-e", 'process.stdout.write(JSON.stringify(require("./index.js")))'],
        { cwd: outputDirectory, encoding: "utf8" },
      ),
    );
    expect(exports.answer).toBe("42");
  });

  it("uses the package type nearest the output directory", async () => {
    fs.writeFileSync(
      path.join(fixtureDir, "package.json"),
      JSON.stringify({ private: true, type: "module" }),
    );
    const outputDirectory = path.join(fixtureDir, "commonjs-output");
    fs.mkdirSync(outputDirectory);
    fs.writeFileSync(
      path.join(outputDirectory, "package.json"),
      JSON.stringify({ private: true, type: "commonjs" }),
    );

    const result = (await build({
      configFile: false,
      logLevel: "silent",
      plugins: [bytecodePlugin()],
      root: fixtureDir,
      build: {
        outDir: outputDirectory,
        write: false,
        rolldownOptions: {
          input: path.join(fixtureDir, "entry.js"),
          output: {
            entryFileNames: "index.js",
            format: "cjs",
          },
        },
      },
    })) as RollupOutput;

    expect(result.output.map((file) => file.fileName)).toEqual(
      expect.arrayContaining(["index.js", "index.jsc"]),
    );
  });

  it("stops at an emitted package boundary without a type field", async () => {
    fs.writeFileSync(
      path.join(fixtureDir, "package.json"),
      JSON.stringify({ private: true, type: "module" }),
    );
    const emittedPackage: Plugin = {
      name: "emitted-commonjs-package-boundary",
      buildStart() {
        this.emitFile({
          type: "asset",
          fileName: "package.json",
          source: JSON.stringify({ private: true }),
        });
      },
    };

    const result = (await build({
      configFile: false,
      logLevel: "silent",
      plugins: [bytecodePlugin(), emittedPackage],
      root: fixtureDir,
      build: {
        write: false,
        rolldownOptions: {
          input: path.join(fixtureDir, "entry.js"),
          output: {
            entryFileNames: "index.js",
            format: "cjs",
          },
        },
      },
    })) as RollupOutput;

    expect(result.output.map((file) => file.fileName)).toEqual(
      expect.arrayContaining(["package.json", "index.js", "index.jsc"]),
    );
  });

  it("prefers a nearer on-disk package over an emitted ancestor package", async () => {
    const outputDirectory = path.join(fixtureDir, "mixed-package-output");
    const nestedOutputDirectory = path.join(outputDirectory, "sub");
    fs.mkdirSync(nestedOutputDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(nestedOutputDirectory, "package.json"),
      JSON.stringify({ private: true, type: "commonjs" }),
    );
    const emittedPackage: Plugin = {
      name: "emitted-module-package-boundary",
      buildStart() {
        this.emitFile({
          type: "asset",
          fileName: "package.json",
          source: JSON.stringify({ private: true, type: "module" }),
        });
      },
    };

    const result = (await build({
      configFile: false,
      logLevel: "silent",
      plugins: [bytecodePlugin(), emittedPackage],
      root: fixtureDir,
      build: {
        outDir: outputDirectory,
        write: false,
        rolldownOptions: {
          input: path.join(fixtureDir, "entry.js"),
          output: {
            entryFileNames: "sub/index.js",
            format: "cjs",
          },
        },
      },
    })) as RollupOutput;

    expect(result.output.map((file) => file.fileName)).toEqual(
      expect.arrayContaining(["package.json", "sub/index.js", "sub/index.jsc"]),
    );
  });

  it("executes a CommonJS .cjs entry inside a type-module package", async () => {
    fs.writeFileSync(
      path.join(fixtureDir, "package.json"),
      JSON.stringify({ private: true, type: "module" }),
    );
    const [result] = await buildLibrary(["cjs"]);
    const outputDirectory = writeOutput(result);
    fs.writeFileSync(
      path.join(outputDirectory, "package.json"),
      JSON.stringify({ private: true, type: "module" }),
    );

    const exports = JSON.parse(
      execFileSync(
        process.execPath,
        ["-e", 'process.stdout.write(JSON.stringify(require("./entry.cjs")))'],
        { cwd: outputDirectory, encoding: "utf8" },
      ),
    );
    expect(exports.answer).toBe("42");
  });

  it("keeps an uncompiled CommonJS .js chunk runnable in a type-module package", async () => {
    fs.writeFileSync(
      path.join(fixtureDir, "package.json"),
      JSON.stringify({ private: true, type: "module" }),
    );
    const dependencyPath = path.join(fixtureDir, "dependency.js");
    fs.writeFileSync(
      path.join(fixtureDir, "entry.js"),
      ['import { answer } from "./dependency.js";', "export { answer };"].join("\n"),
    );
    fs.writeFileSync(dependencyPath, "export const answer = 42;");

    const result = (await build({
      configFile: false,
      logLevel: "silent",
      plugins: [bytecodePlugin({ chunkAlias: "entry" })],
      root: fixtureDir,
      build: {
        write: false,
        rolldownOptions: {
          input: path.join(fixtureDir, "entry.js"),
          preserveEntrySignatures: "strict",
          output: {
            entryFileNames: "entry.cjs",
            chunkFileNames: "[name].js",
            format: "cjs",
            manualChunks(id) {
              return id.endsWith("/dependency.js") ? "dependency" : undefined;
            },
          },
        },
      },
    })) as RollupOutput;

    expect(result.output.map((file) => file.fileName)).toEqual(
      expect.arrayContaining(["dependency.js", "entry.cjs", "entry.cjsc", "package.json"]),
    );

    const outputDirectory = writeOutput(result);
    const exports = JSON.parse(
      execFileSync(
        process.execPath,
        ["-e", 'process.stdout.write(JSON.stringify(require("./entry.cjs")))'],
        { cwd: outputDirectory, encoding: "utf8" },
      ),
    );
    expect(exports.answer).toBe(42);
  });

  it("rejects .js output when an existing output package is explicitly ESM", async () => {
    fs.writeFileSync(
      path.join(fixtureDir, "package.json"),
      JSON.stringify({ private: true, type: "module" }),
    );
    const outputDirectory = path.join(fixtureDir, "module-output");
    fs.mkdirSync(outputDirectory);
    fs.writeFileSync(
      path.join(outputDirectory, "package.json"),
      JSON.stringify({ private: true, type: "module" }),
    );

    await expect(
      build({
        configFile: false,
        logLevel: "silent",
        plugins: [bytecodePlugin()],
        root: fixtureDir,
        build: {
          outDir: outputDirectory,
          write: false,
          rolldownOptions: {
            input: path.join(fixtureDir, "entry.js"),
            output: {
              entryFileNames: "index.js",
              format: "cjs",
            },
          },
        },
      }),
    ).rejects.toThrow(/index\.js.*type.*module.*\.cjs/is);
  });

  it("rejects .js output under a nested ESM package boundary", async () => {
    fs.writeFileSync(
      path.join(fixtureDir, "package.json"),
      JSON.stringify({ private: true, type: "module" }),
    );
    const outputDirectory = path.join(fixtureDir, "nested-boundary-output");
    fs.mkdirSync(path.join(outputDirectory, "nested"), { recursive: true });
    fs.writeFileSync(
      path.join(outputDirectory, "nested", "package.json"),
      JSON.stringify({ private: true, type: "module" }),
    );

    await expect(
      build({
        configFile: false,
        logLevel: "silent",
        plugins: [bytecodePlugin()],
        root: fixtureDir,
        build: {
          emptyOutDir: false,
          outDir: outputDirectory,
          write: false,
          rolldownOptions: {
            input: path.join(fixtureDir, "entry.js"),
            output: {
              entryFileNames: "nested/index.js",
              format: "cjs",
            },
          },
        },
      }),
    ).rejects.toThrow(/nested\/index\.js.*type.*module.*\.cjs/is);
  });

  it("executes a CommonJS .js entry inside a type-commonjs package", async () => {
    fs.writeFileSync(
      path.join(fixtureDir, "package.json"),
      JSON.stringify({ private: true, type: "commonjs" }),
    );
    fs.writeFileSync(path.join(fixtureDir, "entry.js"), "module.exports = { answer: 42 };");

    const result = (await build({
      configFile: false,
      logLevel: "silent",
      plugins: [bytecodePlugin()],
      root: fixtureDir,
      build: {
        write: false,
        rolldownOptions: {
          input: path.join(fixtureDir, "entry.js"),
          output: {
            entryFileNames: "index.js",
            format: "cjs",
          },
        },
      },
    })) as RollupOutput;
    const outputDirectory = writeOutput(result);
    const exports = JSON.parse(
      execFileSync(
        process.execPath,
        ["-e", 'process.stdout.write(JSON.stringify(require("./index.js")))'],
        { cwd: outputDirectory, encoding: "utf8" },
      ),
    );

    expect(exports.answer).toBe(42);
  });

  it("injects the bytecode loader when Rollup strict mode is disabled", async () => {
    const result = await buildSplitChunk({ strict: false });
    const entry = result.output.find(
      (file) => file.type === "chunk" && file.fileName === "entry.cjs",
    );
    const entryCode = entry?.type === "chunk" ? entry.code : "";

    expect(entryCode).toContain('require("./bytecode-loader.cjs")');
    expect(entryCode).toContain('require("./marker.jsc")');
  });

  it("does not leave source maps for removed JavaScript chunks", async () => {
    const result = await buildSplitChunk({ sourcemap: true });
    const files = result.output.map((file) => file.fileName);

    expect(files).toContain("marker.jsc");
    expect(files).not.toContain("marker.js");
    expect(files).not.toContain("marker.js.map");
  });

  it("does not store an obfuscated literal verbatim in bytecode", async () => {
    const result = await buildSplitChunk();
    const bytecode = result.output.find(
      (file) => file.type === "asset" && file.fileName === "marker.jsc",
    );

    expect(bytecode?.type).toBe("asset");
    if (!bytecode || bytecode.type !== "asset") {
      throw new Error("Expected marker.jsc to be emitted as a bytecode asset");
    }

    const bytes =
      typeof bytecode.source === "string"
        ? Buffer.from(bytecode.source)
        : Buffer.from(
            bytecode.source.buffer,
            bytecode.source.byteOffset,
            bytecode.source.byteLength,
          );
    expect(bytes.includes(Buffer.from(obfuscatedMarker))).toBe(false);
  });

  it("rewrites only exact bytecode chunk filenames", async () => {
    const virtualIds = new Set(["virtual:entry", "virtual:bytecode", "virtual:plain"]);
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
      root: fixtureDir,
      plugins: [virtualModules, bytecodePlugin({ chunkAlias: "feature.v1" })],
      build: {
        write: false,
        rolldownOptions: {
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
      (file) => file.type === "chunk" && file.fileName === "entry.cjs",
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
            "export const marker = 'require(\"./secret.js\")';",
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
      root: fixtureDir,
      plugins: [virtualModules, bytecodePlugin({ chunkAlias: "secret" })],
      build: {
        write: false,
        rolldownOptions: {
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
      (file) => file.type === "chunk" && file.fileName === "entry.cjs",
    );
    const entryCode = entry?.type === "chunk" ? entry.code : "";
    const outputDir = writeOutput(result);
    expect(entryCode).toContain('require("./secret.jsc")');
    expect(entryCode).toContain('require("./secret.js")');
    const exports = JSON.parse(
      execFileSync(
        process.execPath,
        ["-e", 'process.stdout.write(JSON.stringify(require("./entry.cjs")))'],
        { cwd: outputDir, encoding: "utf8" },
      ),
    );

    expect(exports).toEqual({
      loaded: "loaded",
      marker: 'require("./secret.js")',
    });
  });

  it("distinguishes chunks with the same basename in different directories", async () => {
    const virtualIds = new Set(["virtual:entry", "virtual:bytecode", "virtual:plain"]);
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
      root: fixtureDir,
      plugins: [virtualModules, bytecodePlugin({ chunkAlias: "encoded" })],
      build: {
        write: false,
        rolldownOptions: {
          input: "virtual:entry",
          output: {
            format: "cjs",
            entryFileNames: "entry.cjs",
            chunkFileNames(chunk) {
              return chunk.name === "encoded" ? "compiled/shared.js" : "plain/shared.js";
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
      (file) => file.type === "chunk" && file.fileName === "entry.cjs",
    );
    const entryCode = entry?.type === "chunk" ? entry.code : "";

    expect(files).toContain("compiled/shared.jsc");
    expect(files).toContain("plain/shared.js");
    expect(entryCode).toContain('require("./compiled/shared.jsc")');
    expect(entryCode).toContain('require("./plain/shared.js")');
    expect(entryCode).not.toContain('require("./plain/shared.jsc")');
  });

  it("loads bytecode used only by a dynamically imported chunk", async () => {
    const virtualIds = new Set(["virtual:entry", "virtual:middle", "virtual:secret"]);
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
          return ['import { secret } from "virtual:secret";', "export const middle = secret;"].join(
            "\n",
          );
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
      root: fixtureDir,
      plugins: [virtualModules, bytecodePlugin({ chunkAlias: "_virtual_middle" })],
      build: {
        write: false,
        rolldownOptions: {
          input: "virtual:entry",
          output: {
            format: "cjs",
            entryFileNames: "entry.cjs",
            chunkFileNames: "[name].js",
          },
        },
      },
    })) as RollupOutput;
    const emittedCode = result.output
      .filter((file) => file.type === "chunk")
      .map((chunk) => chunk.code)
      .join("\n");

    expect(result.output.map((file) => file.fileName)).toContain("_virtual_middle.jsc");
    expect(emittedCode).toContain('require("./_virtual_middle.jsc")');
    expect(emittedCode).toContain('require("./bytecode-loader.cjs")');
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
          rolldownOptions: {
            input: "virtual:entry",
            output: {
              format: "cjs",
              entryFileNames: entryFileName,
            },
          },
        },
      })) as RollupOutput;
      const entry = result.output.find(
        (file) => file.type === "chunk" && file.fileName === entryFileName,
      );
      const bytecode = result.output.find(
        (file) => file.type === "asset" && /\.c?jsc$/.test(file.fileName),
      );
      const entryCode = entry?.type === "chunk" ? entry.code : "";

      expect(bytecode).toBeDefined();
      expect(entryCode).toContain(`require("./${path.basename(bytecode?.fileName ?? "")}")`);
    },
  );

  it("keeps nested original JavaScript executable with partial bytecode selection", async () => {
    const entryPath = path.join(fixtureDir, "keep-entry.js");
    const plainPath = path.join(fixtureDir, "keep-plain.js");
    fs.writeFileSync(
      entryPath,
      ['import { plain } from "./keep-plain.js";', "console.log(plain);"].join("\n"),
    );
    fs.writeFileSync(plainPath, 'export const plain = "plain";\n');

    const result = (await build({
      configFile: false,
      logLevel: "silent",
      root: fixtureDir,
      plugins: [
        bytecodePlugin({
          chunkAlias: "entry",
          removeBundleJS: false,
        }),
      ],
      build: {
        write: false,
        rolldownOptions: {
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
      }),
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
    const result = (Array.isArray(buildResult) ? buildResult[0] : buildResult) as RollupOutput;
    const files = result.output.map((file) => file.fileName);
    const retainedEntry = result.output.find(
      (file) => file.type === "asset" && file.fileName === "_entry.cjs",
    );

    expect(files).toContain("_entry.cjs");
    expect(files).toContain("_entry.cjs.map");
    expect(retainedEntry?.type === "asset" ? String(retainedEntry.source) : "").toContain(
      "sourceMappingURL=_entry.cjs.map",
    );
  });

  it("keeps obfuscated retained JavaScript executable with a valid source map", async () => {
    const marker = "RETAINED_SOURCE_MAP_MARKER";
    fs.writeFileSync(
      path.join(fixtureDir, "entry.js"),
      `export const marker = ${JSON.stringify(marker)};\n`,
    );

    const buildResult = await build({
      configFile: false,
      logLevel: "silent",
      plugins: [
        bytecodePlugin({
          obfuscatedStrings: [marker],
          removeBundleJS: false,
        }),
      ],
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
    const result = (Array.isArray(buildResult) ? buildResult[0] : buildResult) as RollupOutput;
    const retainedMap = result.output.find(
      (file) => file.type === "asset" && file.fileName === "_entry.cjs.map",
    );
    const sourceMap =
      retainedMap?.type === "asset" ? JSON.parse(String(retainedMap.source)) : undefined;
    const outputDirectory = writeOutput(result);
    const exported = JSON.parse(
      execFileSync(
        process.execPath,
        ["-e", 'process.stdout.write(JSON.stringify(require("./_entry.cjs")))'],
        { cwd: outputDirectory, encoding: "utf8" },
      ),
    );

    expect(exported.marker).toBe(marker);
    expect(sourceMap).toMatchObject({
      file: "_entry.cjs",
      version: 3,
    });
    expect(sourceMap.names).toEqual(expect.any(Array));
    expect(sourceMap.mappings).not.toBe("");
  });

  it("keeps a fully bytecoded split bundle executable as original JavaScript", async () => {
    const entryPath = path.join(fixtureDir, "retained-entry.js");
    const dependencyPath = path.join(fixtureDir, "retained-dependency.js");
    fs.writeFileSync(
      entryPath,
      ['import { value } from "./retained-dependency.js";', "console.log(value);"].join("\n"),
    );
    fs.writeFileSync(dependencyPath, 'export const value = "retained bundle works";\n');

    const result = (await build({
      configFile: false,
      logLevel: "silent",
      plugins: [bytecodePlugin({ removeBundleJS: false })],
      build: {
        write: false,
        rolldownOptions: {
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
      }),
    ).toContain("retained bundle works");
  });

  it("keeps selected .js chunks executable as retained CommonJS in a type-module package", async () => {
    fs.writeFileSync(
      path.join(fixtureDir, "package.json"),
      JSON.stringify({ private: true, type: "module" }),
    );
    const entryPath = path.join(fixtureDir, "retained-module-entry.js");
    const dependencyPath = path.join(fixtureDir, "retained-module-dependency.js");
    fs.writeFileSync(
      entryPath,
      ['import { value } from "./retained-module-dependency.js";', "console.log(value);"].join(
        "\n",
      ),
    );
    fs.writeFileSync(dependencyPath, 'export const value = "retained module bundle works";\n');

    const result = (await build({
      configFile: false,
      logLevel: "silent",
      plugins: [bytecodePlugin({ removeBundleJS: false })],
      root: fixtureDir,
      build: {
        write: false,
        rolldownOptions: {
          input: { entry: entryPath },
          output: {
            format: "cjs",
            entryFileNames: "entry.cjs",
            chunkFileNames: "[name].js",
            manualChunks(id) {
              if (id.endsWith("retained-module-dependency.js")) {
                return "dependency";
              }
            },
          },
        },
      },
    })) as RollupOutput;
    const outputDir = writeOutput(result);
    fs.writeFileSync(
      path.join(outputDir, "package.json"),
      JSON.stringify({ private: true, type: "module" }),
    );

    expect(result.output.map((file) => file.fileName)).toContain("_dependency.js.cjs");
    expect(
      execFileSync(process.execPath, ["_entry.cjs"], {
        cwd: outputDir,
        encoding: "utf8",
      }),
    ).toContain("retained module bundle works");
  });

  it("keeps same-stem retained extension variants distinct", async () => {
    fs.writeFileSync(
      path.join(fixtureDir, "package.json"),
      JSON.stringify({ private: true, type: "module" }),
    );
    const entryPath = path.join(fixtureDir, "retained-collision-entry.js");
    const jsChunkPath = path.join(fixtureDir, "retained-collision-js.js");
    const cjsChunkPath = path.join(fixtureDir, "retained-collision-cjs.js");
    const compoundChunkPath = path.join(fixtureDir, "retained-collision-compound.js");
    fs.writeFileSync(
      entryPath,
      [
        'import { jsValue } from "./retained-collision-js.js";',
        'import { cjsValue } from "./retained-collision-cjs.js";',
        'import { compoundValue } from "./retained-collision-compound.js";',
        "console.log(jsValue, cjsValue, compoundValue);",
      ].join("\n"),
    );
    fs.writeFileSync(jsChunkPath, 'export const jsValue = "js";\n');
    fs.writeFileSync(cjsChunkPath, 'export const cjsValue = "cjs";\n');
    fs.writeFileSync(compoundChunkPath, 'export const compoundValue = "compound";\n');

    const result = (await build({
      configFile: false,
      logLevel: "silent",
      plugins: [bytecodePlugin({ removeBundleJS: false })],
      root: fixtureDir,
      build: {
        write: false,
        rolldownOptions: {
          input: {
            entry: entryPath,
            javascript: jsChunkPath,
            commonjs: cjsChunkPath,
            compound: compoundChunkPath,
          },
          output: {
            format: "cjs",
            entryFileNames(chunk) {
              if (chunk.name === "entry") {
                return "entry.cjs";
              }
              if (chunk.name === "javascript") {
                return "foo.js";
              }
              return chunk.name === "commonjs" ? "foo.cjs" : "foo.js.cjs";
            },
          },
        },
      },
    })) as RollupOutput;
    const outputDir = writeOutput(result);
    fs.writeFileSync(
      path.join(outputDir, "package.json"),
      JSON.stringify({ private: true, type: "module" }),
    );
    const files = result.output.map((file) => file.fileName);

    expect(files).toEqual(expect.arrayContaining(["_foo.js.cjs", "_foo.cjs", "_foo.js.1.cjs"]));
    expect(
      execFileSync(process.execPath, ["_entry.cjs"], {
        cwd: outputDir,
        encoding: "utf8",
      }),
    ).toContain("js cjs compound");
  });

  it("disambiguates retained chunks from existing output names", async () => {
    fs.writeFileSync(
      path.join(fixtureDir, "package.json"),
      JSON.stringify({ private: true, type: "module" }),
    );
    const entryPath = path.join(fixtureDir, "reserved-name-entry.js");
    const selectedPath = path.join(fixtureDir, "reserved-name-selected.js");
    const existingPath = path.join(fixtureDir, "reserved-name-existing.js");
    fs.writeFileSync(
      entryPath,
      [
        'import { selectedValue } from "./reserved-name-selected.js";',
        'import { existingValue } from "./reserved-name-existing.js";',
        "console.log(selectedValue, existingValue);",
      ].join("\n"),
    );
    fs.writeFileSync(selectedPath, 'export const selectedValue = "selected";\n');
    fs.writeFileSync(existingPath, 'export const existingValue = "existing";\n');

    const result = (await build({
      configFile: false,
      logLevel: "silent",
      plugins: [
        bytecodePlugin({
          chunkAlias: ["selected"],
          removeBundleJS: false,
        }),
      ],
      root: fixtureDir,
      build: {
        write: false,
        rolldownOptions: {
          input: { entry: entryPath },
          output: {
            format: "cjs",
            entryFileNames: "entry.cjs",
            chunkFileNames(chunk) {
              return chunk.name === "selected" ? "foo.js" : "_foo.js.cjs";
            },
            manualChunks(id) {
              if (id.endsWith("reserved-name-selected.js")) {
                return "selected";
              }
              if (id.endsWith("reserved-name-existing.js")) {
                return "existing";
              }
            },
          },
        },
      },
    })) as RollupOutput;
    const outputDir = writeOutput(result);
    fs.writeFileSync(
      path.join(outputDir, "package.json"),
      JSON.stringify({ private: true, type: "module" }),
    );
    const files = result.output.map((file) => file.fileName);

    expect(files).toEqual(expect.arrayContaining(["_foo.js.cjs", "_foo.js.1.cjs", "__foo.js.cjs"]));
    expect(
      execFileSync(process.execPath, ["_entry.cjs"], {
        cwd: outputDir,
        encoding: "utf8",
      }),
    ).toContain("selected existing");
  });

  it("does not emit stale plaintext source maps for bytecode-only chunks", async () => {
    const obfuscatedValue = "SOURCE_MAP_MARKER";
    fs.writeFileSync(
      path.join(fixtureDir, "entry.js"),
      `export const marker = ${JSON.stringify(obfuscatedValue)};\n`,
    );

    const buildResult = await build({
      configFile: false,
      logLevel: "silent",
      plugins: [bytecodePlugin({ obfuscatedStrings: [obfuscatedValue] })],
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
    const result = (Array.isArray(buildResult) ? buildResult[0] : buildResult) as RollupOutput;
    const sourceMaps = result.output.filter((file) => file.fileName.endsWith(".map"));
    const emittedText = result.output
      .filter(
        (file) =>
          file.type === "chunk" || (file.type === "asset" && typeof file.source === "string"),
      )
      .map((file) => (file.type === "chunk" ? file.code : file.source))
      .join("\n");

    expect(sourceMaps).toEqual([]);
    expect(emittedText).not.toContain(obfuscatedValue);
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
          rolldownOptions: {
            input: "virtual:entry",
            output: {
              format: "cjs",
              entryFileNames: "entry.cjs",
            },
          },
        },
      }),
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
        rolldownOptions: {
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
      (file) => file.type === "chunk" && file.fileName === "entry.cjs",
    );

    expect(entry?.type === "chunk" ? entry.code : "").toMatch(/^#!\/usr\/bin\/env node/);
  });

  it("loads bytecode behind a static preserveModules import chain", async () => {
    const virtualIds = new Set(["virtual:entry", "virtual:middle", "virtual:secret"]);
    const virtualModules = {
      name: "virtual-preserve-modules",
      resolveId(id: string) {
        return virtualIds.has(id) ? `\0${id}` : null;
      },
      load(id: string) {
        if (id === "\0virtual:entry") {
          return ['import { middle } from "virtual:middle";', "console.log(middle);"].join("\n");
        }
        if (id === "\0virtual:middle") {
          return ['import { secret } from "virtual:secret";', "export const middle = secret;"].join(
            "\n",
          );
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
      root: fixtureDir,
      plugins: [
        virtualModules,
        bytecodePlugin({
          chunkAlias: "_virtual/_virtual_middle",
        }),
      ],
      build: {
        write: false,
        rolldownOptions: {
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
    const javaScriptChunks = result.output.filter((file) => file.type === "chunk");
    const combinedCode = javaScriptChunks.map((chunk) => chunk.code).join("\n");

    expect(result.output.map((file) => file.fileName)).toContain("_virtual/_virtual_middle.jsc");
    expect(combinedCode).toContain('require("./_virtual_middle.jsc")');
    expect(combinedCode).toContain('require("../bytecode-loader.cjs")');
  });

  it("matches chunk aliases before Rollup filename sanitization", async () => {
    const virtualIds = new Set(["virtual:entry", "virtual:feature"]);
    const virtualModules = {
      name: "virtual-sanitized-alias",
      buildStart(this: Rolldown.PluginContext) {
        this.emitFile({
          type: "chunk",
          id: "virtual:feature",
          name: "feature+v1",
        });
      },
      resolveId(id: string) {
        return virtualIds.has(id) ? `\0${id}` : null;
      },
      load(id: string) {
        if (id === "\0virtual:entry") {
          return ['import { value } from "virtual:feature";', "console.log(value);"].join("\n");
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
      plugins: [virtualModules, bytecodePlugin({ chunkAlias: "feature+v1" })],
      build: {
        write: false,
        rolldownOptions: {
          input: "virtual:entry",
          output: {
            format: "cjs",
            entryFileNames: "entry.cjs",
            chunkFileNames: "[name].js",
          },
        },
      },
    })) as RollupOutput;
    const files = result.output.map((file) => file.fileName);
    const featureEntry = result.output.find(
      (file) => file.type === "chunk" && file.fileName === "feature_v1.js",
    );

    expect(files).toContain("feature_v1.jsc");
    expect(featureEntry?.type === "chunk" ? featureEntry.code : "").toContain(
      'require("./feature_v1.jsc")',
    );
  });
});
