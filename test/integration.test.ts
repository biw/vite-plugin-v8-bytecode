import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { compileToBytecode } from "../src/compiler";
import { getBytecodeLoaderCode } from "../src/loader";

describe("Integration Tests - Real-world Scenarios", () => {
  const testDir = path.join(__dirname, "integration-temp");
  const testFiles: string[] = [];

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

  it("should execute transformed code (with template literals converted)", () => {
    // Simulates code that went through Babel transformation
    // (like what happens in Vite's renderChunk)
    const transformedCode = `
"use strict";
function greet(name) {
  return "Hello, " + name + "!";  // Was template literal, now concatenation
}
const message = (function(arr) { return String.fromCharCode(...arr); })([84,69,83,84]);
console.log(greet("Transformed"));
console.log("Protected:", message);
module.exports = { greet, message };
`;

    const bytecode = compileToBytecode(transformedCode);
    const bytecodeFile = path.join(testDir, "transformed.jsc");
    fs.writeFileSync(bytecodeFile, bytecode);
    testFiles.push(bytecodeFile);

    const loaderCode = getBytecodeLoaderCode();
    const loaderFile = path.join(testDir, "bytecode-loader.cjs");
    fs.writeFileSync(loaderFile, loaderCode);
    testFiles.push(loaderFile);

    const entryCode = `
"use strict";
require("./bytecode-loader.cjs");
const result = require("./transformed.jsc");
console.log("Message:", result.message);
`;
    const entryFile = path.join(testDir, "entry-transformed.cjs");
    fs.writeFileSync(entryFile, entryCode);
    testFiles.push(entryFile);

    try {
      const output = execSync(`node ${entryFile}`, {
        encoding: "utf8",
        cwd: testDir,
      });

      console.log("Transformed output:", output);
      expect(output).toContain("Hello, Transformed!");
      expect(output).toContain("Protected: TEST");
      expect(output).toContain("Message: TEST");
    } catch (error: any) {
      console.error("Transformed test failed:", error.message);
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
      throw new Error(
        `Execution failed with exit code ${error.status}\nStderr: ${error.stderr}`
      );
    }
  });
});

