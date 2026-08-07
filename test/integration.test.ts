import { describe, it, expect, beforeEach, afterEach } from "vite-plus/test";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import { compileToBytecode } from "../src/compiler";
import { getBytecodeLoaderCode } from "../src/loader";
import { LANGUAGE_CASES } from "./language-cases";

describe("Integration Tests - Real-world Scenarios", () => {
  const testDir = path.join(__dirname, "integration-temp");
  const testFiles: string[] = [];

  function writeTestFile(name: string, contents: string | Buffer): string {
    const filename = path.join(testDir, name);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, contents);
    testFiles.push(filename);
    return filename;
  }

  function writeBytecodeFixture(name: string, code: string): string {
    return writeTestFile(name, compileToBytecode(code));
  }

  function installLoader(): string {
    return writeTestFile("bytecode-loader.cjs", getBytecodeLoaderCode());
  }

  function runNode(entryFile: string): string {
    return execFileSync(process.execPath, [entryFile], {
      encoding: "utf8",
      cwd: testDir,
    });
  }

  beforeEach(() => {
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
  });

  afterEach(() => {
    // Clean up test files
    for (const file of testFiles) {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    }
    testFiles.length = 0;

    // Remove test directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("should execute bytecode with functions in a separate Node process", () => {
    // This test simulates what happens when you run:
    // node dist-simple/simple.js
    //
    // Key difference from unit tests: This runs in a SEPARATE process,
    // just like the real application does!

    const testCode = `
"use strict";
function greet(name) {
  return "Hello, " + name + "!";
}
console.log("About to call greet...");
const result = greet("World");
console.log("Result:", result);
module.exports = { greet, result };
`;

    // Step 1: Compile to bytecode (simulates Vite build)
    const bytecode = compileToBytecode(testCode);
    const bytecodeFile = path.join(testDir, "test.jsc");
    fs.writeFileSync(bytecodeFile, bytecode);
    testFiles.push(bytecodeFile);

    // Step 2: Create loader file (simulates what Vite generates)
    const loaderCode = getBytecodeLoaderCode();
    const loaderFile = path.join(testDir, "bytecode-loader.cjs");
    fs.writeFileSync(loaderFile, loaderCode);
    testFiles.push(loaderFile);

    // Step 3: Create entry point (simulates dist/simple.js)
    // IMPORTANT: Use .cjs extension to force CommonJS mode
    const entryCode = `
"use strict";
require("./bytecode-loader.cjs");
const result = require("./test.jsc");
console.log("Loaded from bytecode:", result);
`;
    const entryFile = path.join(testDir, "entry.cjs");
    fs.writeFileSync(entryFile, entryCode);
    testFiles.push(entryFile);

    // Step 4: Execute in a separate Node process (THIS IS THE KEY!)
    // This is what fails in the real app but passes in our unit tests
    try {
      const output = execSync(`node ${entryFile}`, {
        encoding: "utf8",
        cwd: testDir,
      });

      console.log("Process output:", output);
      expect(output).toContain("About to call greet...");
      expect(output).toContain("Result: Hello, World!");
    } catch (error: any) {
      console.error("Process failed with:", error.message);
      console.error("Stdout:", error.stdout);
      console.error("Stderr:", error.stderr);
      throw error;
    }
  });

  it("should execute bytecode with arrow functions in a separate Node process", () => {
    const testCode = `
"use strict";
const greet = (name) => "Hello, " + name + "!";
console.log("Testing arrow function...");
console.log(greet("Arrow"));
module.exports = { greet };
`;

    const bytecode = compileToBytecode(testCode);
    const bytecodeFile = path.join(testDir, "arrow.jsc");
    fs.writeFileSync(bytecodeFile, bytecode);
    testFiles.push(bytecodeFile);

    const loaderCode = getBytecodeLoaderCode();
    const loaderFile = path.join(testDir, "bytecode-loader.cjs");
    fs.writeFileSync(loaderFile, loaderCode);
    testFiles.push(loaderFile);

    const entryCode = `
"use strict";
require("./bytecode-loader.cjs");
require("./arrow.jsc");
`;
    const entryFile = path.join(testDir, "entry-arrow.cjs");
    fs.writeFileSync(entryFile, entryCode);
    testFiles.push(entryFile);

    try {
      const output = execSync(`node ${entryFile}`, {
        encoding: "utf8",
        cwd: testDir,
      });

      console.log("Arrow function output:", output);
      expect(output).toContain("Testing arrow function...");
      expect(output).toContain("Hello, Arrow!");
    } catch (error: any) {
      console.error("Arrow function test failed:", error.message);
      console.error("Stdout:", error.stdout);
      console.error("Stderr:", error.stderr);
      throw error;
    }
  });

  it("should execute raw template literals from bytecode", () => {
    const templateLiteralCode = `
"use strict";
function greet(name) {
  return \`Hello, \${name}!\`;
}
const message = \`Template \${"literal"}\`;
console.log(greet("Bytecode"));
console.log(message);
module.exports = { greet, message };
`;

    const bytecode = compileToBytecode(templateLiteralCode);
    const bytecodeFile = path.join(testDir, "template-literal.jsc");
    fs.writeFileSync(bytecodeFile, bytecode);
    testFiles.push(bytecodeFile);

    const loaderCode = getBytecodeLoaderCode();
    const loaderFile = path.join(testDir, "bytecode-loader.cjs");
    fs.writeFileSync(loaderFile, loaderCode);
    testFiles.push(loaderFile);

    const entryCode = `
"use strict";
require("./bytecode-loader.cjs");
const result = require("./template-literal.jsc");
console.log("Message:", result.message);
`;
    const entryFile = path.join(testDir, "entry-template-literal.cjs");
    fs.writeFileSync(entryFile, entryCode);
    testFiles.push(entryFile);

    try {
      const output = execSync(`node ${entryFile}`, {
        encoding: "utf8",
        cwd: testDir,
      });

      expect(output).toContain("Hello, Bytecode!");
      expect(output).toContain("Template literal");
      expect(output).toContain("Message: Template literal");
    } catch (error: any) {
      console.error("Template literal test failed:", error.message);
      console.error("Stdout:", error.stdout);
      console.error("Stderr:", error.stderr);
      throw error;
    }
  });

  it("should match the exact scenario from examples/simple-app", () => {
    // This replicates the EXACT structure that Vite generates
    const viteGeneratedCode = `
"use strict";
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

const API_KEY = (function(arr) { return String.fromCharCode(...arr); })([77,89,95,83,69,67,82,69,84,95,65,80,73,95,75,69,89]);
const VERSION = "1.0.0";

function greet(name) {
  return "Hello, " + name + "!";
}

function getConfig() {
  return {
    apiKey: API_KEY,
    version: VERSION,
    environment: "production"
  };
}

console.log("=== Simple Bytecode Test App ===");
console.log(greet("World"));
console.log("Version:", VERSION);
console.log("API Key:", API_KEY);
console.log("Config:", getConfig());
console.log("✓ Bytecode execution successful!");

exports.greet = greet;
exports.getConfig = getConfig;
exports.API_KEY = API_KEY;
exports.VERSION = VERSION;
`;

    // Compile to bytecode
    const bytecode = compileToBytecode(viteGeneratedCode);
    const bytecodeFile = path.join(testDir, "simple.jsc");
    fs.writeFileSync(bytecodeFile, bytecode);
    testFiles.push(bytecodeFile);

    // Create loader
    const loaderCode = getBytecodeLoaderCode();
    const loaderFile = path.join(testDir, "bytecode-loader.cjs");
    fs.writeFileSync(loaderFile, loaderCode);
    testFiles.push(loaderFile);

    // Create entry point (mimics what Vite generates)
    const entryCode = `"use strict";
require("./bytecode-loader.cjs");
require("./simple.jsc");
`;
    const entryFile = path.join(testDir, "simple.cjs");
    fs.writeFileSync(entryFile, entryCode);
    testFiles.push(entryFile);

    // Execute in separate process
    try {
      const output = execSync(`node ${entryFile}`, {
        encoding: "utf8",
        cwd: testDir,
        timeout: 5000,
      });

      console.log("\n=== SIMPLE APP OUTPUT ===");
      console.log(output);
      console.log("=== END OUTPUT ===\n");

      // Verify expected output
      expect(output).toContain("=== Simple Bytecode Test App ===");
      expect(output).toContain("Hello, World!");
      expect(output).toContain("Version: 1.0.0");
      expect(output).toContain("MY_SECRET_API_KEY");
      expect(output).toContain("✓ Bytecode execution successful!");
    } catch (error: any) {
      console.error("\n=== TEST FAILED ===");
      console.error("Exit code:", error.status);
      console.error("Stdout:", error.stdout);
      console.error("Stderr:", error.stderr);
      console.error("=== END ERROR ===\n");
      throw new Error(`Execution failed with exit code ${error.status}\nStderr: ${error.stderr}`);
    }
  });

  it("exposes the complete require.resolve API inside bytecode modules", () => {
    writeBytecodeFixture(
      "resolve-api.jsc",
      `
"use strict";
const paths = require.resolve.paths("vite");
module.exports = {
  builtin: require.resolve("node:path"),
  hasSearchPaths: Array.isArray(paths) && paths.length > 0
};
`,
    );
    installLoader();
    const entryFile = writeTestFile(
      "resolve-api.cjs",
      `
"use strict";
require("./bytecode-loader.cjs");
const result = require("./resolve-api.jsc");
if (result.builtin !== "node:path" || !result.hasSearchPaths) {
  throw new Error("bytecode require.resolve API did not match CommonJS");
}
console.log("complete require.resolve API");
`,
    );

    expect(() => runNode(entryFile)).not.toThrow();
  });

  it("preserves CommonJS metadata, cache identity, and relative resolution", () => {
    writeTestFile("nested/dependency.cjs", `module.exports = { token: Symbol("dependency") };`);
    writeBytecodeFixture(
      "nested/semantics.jsc",
      `
"use strict";
const dependency = require("./dependency.cjs");
module.exports = {
  dependency,
  filename: __filename,
  dirname: __dirname,
  parentFilename: module.parent && module.parent.filename,
  mainFilename: require.main && require.main.filename,
  cached: require.cache[__filename] === module,
  extensionRegistered: typeof require.extensions[".jsc"] === "function"
};
`,
    );
    installLoader();
    const entryFile = writeTestFile(
      "semantics.cjs",
      `
"use strict";
const path = require("node:path");
require("./bytecode-loader.cjs");
const first = require("./nested/semantics.jsc");
const second = require("./nested/semantics.jsc");
if (first !== second) throw new Error("bytecode module was not cached");
if (!first.cached) throw new Error("module was absent from require.cache");
if (!first.extensionRegistered) throw new Error(".jsc extension was not registered");
if (first.filename !== path.join(__dirname, "nested/semantics.jsc")) {
  throw new Error("incorrect __filename");
}
if (first.dirname !== path.join(__dirname, "nested")) {
  throw new Error("incorrect __dirname");
}
if (first.parentFilename !== __filename || first.mainFilename !== __filename) {
  throw new Error("incorrect CommonJS parent/main metadata");
}
console.log("CommonJS semantics preserved");
`,
    );

    expect(runNode(entryFile)).toContain("CommonJS semantics preserved");
  });

  it("supports circular dependencies crossing bytecode and JavaScript", () => {
    writeBytecodeFixture(
      "cycle/a.jsc",
      `
"use strict";
exports.phase = "a-loading";
const b = require("./b.cjs");
exports.phaseSeenByB = b.phaseSeenFromA;
exports.phase = "a-ready";
`,
    );
    writeTestFile(
      "cycle/b.cjs",
      `
"use strict";
const a = require("./a.jsc");
exports.phaseSeenFromA = a.phase;
`,
    );
    installLoader();
    const entryFile = writeTestFile(
      "cycle.cjs",
      `
"use strict";
require("./bytecode-loader.cjs");
const a = require("./cycle/a.jsc");
if (a.phase !== "a-ready" || a.phaseSeenByB !== "a-loading") {
  throw new Error("circular dependency exposed incorrect partial exports");
}
console.log("circular dependency preserved");
`,
    );

    expect(runNode(entryFile)).toContain("circular dependency preserved");
  });

  it.each(LANGUAGE_CASES)(
    "preserves %s through raw bytecode execution",
    (_feature, moduleCode, expected) => {
      writeBytecodeFixture("compatibility.jsc", moduleCode);
      installLoader();
      const entryFile = writeTestFile(
        "compatibility.cjs",
        `
"use strict";
require("./bytecode-loader.cjs");
Promise.resolve(require("./compatibility.jsc")).then(
  (result) => {
    const expected = ${JSON.stringify(expected)};
    if (!Object.is(result, expected)) {
      throw new Error(
        "expected " + JSON.stringify(expected) +
        " but received " + JSON.stringify(result)
      );
    }
    console.log("compatibility case preserved");
  },
  (error) => {
    console.error(error);
    process.exitCode = 1;
  }
);
`,
      );

      expect(runNode(entryFile)).toContain("compatibility case preserved");
    },
  );

  it("supports native dynamic import inside bytecode modules", () => {
    writeBytecodeFixture(
      "dynamic-import.jsc",
      `
"use strict";
module.exports = import("node:path").then((path) => ({
  basename: path.basename("/tmp/example.js"),
  hasJoin: typeof path.join === "function"
}));
`,
    );
    installLoader();
    const entryFile = writeTestFile(
      "dynamic-import.cjs",
      `
"use strict";
require("./bytecode-loader.cjs");
require("./dynamic-import.jsc").then(
  (result) => {
    if (result.basename !== "example.js" || !result.hasJoin) {
      throw new Error("dynamic import returned incorrect exports");
    }
    console.log("native dynamic import preserved");
  },
  (error) => {
    console.error(error);
    process.exitCode = 1;
  }
);
`,
    );

    expect(runNode(entryFile)).toContain("native dynamic import preserved");
  });

  it("loads ordinary bytecode without the VM default-loader constant", () => {
    writeBytecodeFixture(
      "legacy-vm.jsc",
      `
"use strict";
module.exports = { answer: 42 };
`,
    );
    installLoader();
    const entryFile = writeTestFile(
      "legacy-vm.cjs",
      `
"use strict";
require("node:vm").constants = undefined;
require("./bytecode-loader.cjs");
const result = require("./legacy-vm.jsc");
if (result.answer !== 42) {
  throw new Error("legacy VM bytecode returned incorrect exports");
}
console.log("legacy VM bytecode preserved");
`,
    );

    expect(runNode(entryFile)).toContain("legacy VM bytecode preserved");
  });

  it("rejects truncated bytecode before trusting its source-length header", () => {
    const craftedBytecode = Buffer.alloc(16);
    craftedBytecode.writeUInt32LE(1_000_002, 8);
    writeTestFile("crafted.jsc", craftedBytecode);
    installLoader();
    const entryFile = writeTestFile(
      "crafted.cjs",
      `
"use strict";
require("./bytecode-loader.cjs");
const originalRepeat = String.prototype.repeat;
String.prototype.repeat = function (count) {
  if (count > 10_000) {
    throw new Error("untrusted bytecode requested a large allocation");
  }
  return originalRepeat.call(this, count);
};
try {
  require("./crafted.jsc");
} catch (error) {
  if (error && error.message === "untrusted bytecode requested a large allocation") {
    throw error;
  }
  if (error && /invalid|incompatible|bytecode|cached data/i.test(error.message)) {
    console.log("crafted bytecode safely rejected");
    process.exit(0);
  }
  throw error;
}
throw new Error("crafted bytecode was unexpectedly accepted");
`,
    );

    expect(() => runNode(entryFile)).not.toThrow();
  });
});
