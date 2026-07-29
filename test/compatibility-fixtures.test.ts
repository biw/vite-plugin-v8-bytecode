import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compileToBytecode } from "../src/compiler";
import { getBytecodeLoaderCode } from "../src/loader";

const fixtureDirectory = path.join(__dirname, "fixtures", "compatibility");
const currentNodeMajor = Number.parseInt(process.versions.node, 10);
const fixtureVersionPattern = /\.(\d+)\.js$/;

const allFixtures = fs
  .readdirSync(fixtureDirectory)
  .filter((fileName) => fixtureVersionPattern.test(fileName))
  .sort();
const compatibleFixtures = allFixtures.filter((fileName) => {
  const match = fixtureVersionPattern.exec(fileName);
  return match !== null && Number.parseInt(match[1], 10) <= currentNodeMajor;
});

describe(`raw JavaScript compatibility fixtures on Node ${currentNodeMajor}`, () => {
  it("selects fixtures strictly by their Node.js version suffix", () => {
    expect(compatibleFixtures.length).toBeGreaterThan(0);
    expect(
      compatibleFixtures.every((fileName) => {
        const match = fixtureVersionPattern.exec(fileName);
        return match !== null && Number.parseInt(match[1], 10) <= currentNodeMajor;
      })
    ).toBe(true);
  });

  it.each(compatibleFixtures)(
    "compiles and executes %s as bytecode",
    (fixtureName) => {
      const temporaryDirectory = fs.mkdtempSync(
        path.join(os.tmpdir(), "vite-bytecode-compatibility-")
      );

      try {
        const rawSource = fs.readFileSync(
          path.join(fixtureDirectory, fixtureName),
          "utf8"
        );

        fs.writeFileSync(
          path.join(temporaryDirectory, "fixture.jsc"),
          compileToBytecode(rawSource)
        );
        fs.writeFileSync(
          path.join(temporaryDirectory, "bytecode-loader.cjs"),
          getBytecodeLoaderCode()
        );
        fs.writeFileSync(
          path.join(temporaryDirectory, "entry.cjs"),
          [
            '"use strict";',
            'require("./bytecode-loader.cjs");',
            'Promise.resolve(require("./fixture.jsc")).then(',
            "  () => process.stdout.write(\"fixture passed\"),",
            "  (error) => {",
            "    console.error(error);",
            "    process.exitCode = 1;",
            "  }",
            ");",
          ].join("\n")
        );

        expect(
          execFileSync(process.execPath, ["entry.cjs"], {
            cwd: temporaryDirectory,
            encoding: "utf8",
          })
        ).toBe("fixture passed");
      } finally {
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
      }
    }
  );
});
