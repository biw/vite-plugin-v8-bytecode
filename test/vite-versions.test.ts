import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { build as buildVite7 } from "vite";
import { build as buildVite8 } from "vite8";
import { bytecodePlugin } from "../src/index";

type BuildFunction = (config: never) => Promise<unknown>;

type OutputFile = {
  fileName: string;
  source?: string | Uint8Array;
  type: "asset" | "chunk";
  code?: string;
};

type BuildOutput = {
  output: OutputFile[];
};

const viteBuilds: Array<{ build: BuildFunction; version: string }> = [
  { build: buildVite7, version: "Vite 7" },
  { build: buildVite8, version: "Vite 8" },
];

describe("Vite major-version compatibility", () => {
  let fixtureDirectory: string;
  let originalNodeEnv: string | undefined;

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "vite-bytecode-vite-version-"));
    fs.writeFileSync(
      path.join(fixtureDirectory, "entry.js"),
      'console.log("bytecode output works");\n',
    );
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    fs.rmSync(fixtureDirectory, { recursive: true, force: true });
  });

  it.each(viteBuilds)("builds and executes bytecode with $version", async ({ build }) => {
    const result = await build({
      configFile: false,
      logLevel: "silent",
      plugins: [bytecodePlugin()],
      root: fixtureDirectory,
      build: {
        rollupOptions: {
          input: path.join(fixtureDirectory, "entry.js"),
          output: {
            entryFileNames: "entry.cjs",
            format: "cjs",
          },
        },
        write: false,
      },
    } as never);
    const output = (Array.isArray(result) ? result[0] : result) as BuildOutput;
    const outputDirectory = path.join(fixtureDirectory, "dist");

    for (const file of output.output) {
      const outputPath = path.join(outputDirectory, file.fileName);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, file.type === "chunk" ? file.code! : file.source!);
    }

    expect(output.output.map((file) => file.fileName)).toEqual(
      expect.arrayContaining(["bytecode-loader.cjs", "entry.cjs", "entry.cjsc"]),
    );
    expect(
      execFileSync(process.execPath, ["entry.cjs"], {
        cwd: outputDirectory,
        encoding: "utf8",
      }),
    ).toBe("bytecode output works\n");
  });
});
