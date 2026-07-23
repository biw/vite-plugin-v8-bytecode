import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import { compileToBytecode } from "../src/compiler";
import { getBytecodeLoaderCode } from "../src/loader";
import { transformCode } from "../src/transforms";

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

  function writeTransformedBytecodeFixture(name: string, code: string): string {
    const transformed = transformCode(code, []);
    if (!transformed) {
      throw new Error("JavaScript transformation unexpectedly returned null");
    }
    return writeBytecodeFixture(name, transformed.code);
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
`
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
`
    );

    expect(() => runNode(entryFile)).not.toThrow();
  });

  it("preserves CommonJS metadata, cache identity, and relative resolution", () => {
    writeTestFile(
      "nested/dependency.cjs",
      `module.exports = { token: Symbol("dependency") };`
    );
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
`
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
`
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
`
    );
    writeTestFile(
      "cycle/b.cjs",
      `
"use strict";
const a = require("./a.jsc");
exports.phaseSeenFromA = a.phase;
`
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
`
    );

    expect(runNode(entryFile)).toContain("circular dependency preserved");
  });

  it.each([
    [
      "generator functions",
      `
"use strict";
function* values() {
  yield 1;
  yield 2;
  yield 3;
}
module.exports = Promise.resolve([...values()].join(","));
`,
      "1,2,3",
    ],
    [
      "async functions",
      `
"use strict";
async function read() {
  await Promise.resolve();
  return 42;
}
module.exports = read();
`,
      42,
    ],
    [
      "async generator functions",
      `
"use strict";
async function* values() {
  yield await Promise.resolve(1);
  yield await Promise.resolve(2);
}
module.exports = (async function () {
  const result = [];
  for await (const value of values()) {
    result.push(value);
  }
  return result.join(",");
})();
`,
      "1,2",
    ],
    [
      "private class fields",
      `
"use strict";
class Counter {
  #value = 40;
  increment() {
    this.#value += 2;
    return this.#value;
  }
}
module.exports = Promise.resolve(new Counter().increment());
`,
      42,
    ],
    [
      "class static blocks",
      `
"use strict";
class Configuration {
  static {
    this.answer = 40 + 2;
  }
}
module.exports = Promise.resolve(Configuration.answer);
`,
      42,
    ],
    [
      "direct eval closures",
      `
"use strict";
function evaluate(value) {
  return eval("value + 2");
}
module.exports = Promise.resolve(evaluate(40));
`,
      42,
    ],
    [
      "Unicode set regular expressions",
      `
"use strict";
const lettersExceptB = /[a--b]/v;
module.exports = Promise.resolve(
  lettersExceptB.test("a") && !lettersExceptB.test("b")
);
`,
      true,
    ],
    [
      "Proxy and Reflect",
      `
"use strict";
const target = { answer: 42 };
const proxy = new Proxy(target, {
  get(object, property, receiver) {
    return Reflect.get(object, property, receiver);
  }
});
module.exports = Promise.resolve(proxy.answer);
`,
      42,
    ],
    [
      "BigInt and numeric separators",
      `
"use strict";
module.exports = Promise.resolve((1_000_000n + 2n).toString());
`,
      "1000002",
    ],
    [
      "recursive functions",
      `
"use strict";
function factorial(value) {
  return value <= 1 ? 1 : value * factorial(value - 1);
}
module.exports = Promise.resolve(factorial(6));
`,
      720,
    ],
    [
      "class inheritance, accessors, and computed methods",
      `
"use strict";
const methodName = "read";
class Base {
  constructor(value) {
    this.value = value;
  }
  get doubled() {
    return this.value * 2;
  }
}
class Derived extends Base {
  [methodName]() {
    return super.doubled + 2;
  }
}
module.exports = Promise.resolve(new Derived(20).read());
`,
      42,
    ],
    [
      "destructuring, defaults, rest, and spread",
      `
"use strict";
function combine({ first = 1, ...rest }, ...values) {
  const copy = { ...rest };
  return [first, copy.second, ...values].join(",");
}
module.exports = Promise.resolve(combine({ second: 2 }, 3, 4));
`,
      "1,2,3,4",
    ],
    [
      "optional chaining and logical assignment",
      `
"use strict";
const configuration = { nested: { answer: 42 } };
const state = {};
state.answer ??= configuration?.nested?.answer ?? 0;
state.answer &&= state.answer;
module.exports = Promise.resolve(state.answer);
`,
      42,
    ],
    [
      "symbol keys and custom primitive coercion",
      `
"use strict";
const key = Symbol("answer");
const values = {
  [key]: {
    [Symbol.toPrimitive](hint) {
      return hint + ":42";
    }
  }
};
module.exports = Promise.resolve(\`\${values[key]}\`);
`,
      "string:42",
    ],
    [
      "try, catch, finally, and Error causes",
      `
"use strict";
const events = [];
try {
  throw new Error("boom", { cause: "root" });
} catch (error) {
  events.push(error.message, error.cause);
} finally {
  events.push("finally");
}
module.exports = Promise.resolve(events.join(","));
`,
      "boom,root,finally",
    ],
    [
      "ArrayBuffer, DataView, and typed arrays",
      `
"use strict";
const buffer = new ArrayBuffer(8);
const view = new DataView(buffer);
view.setUint32(0, 40);
const values = new Uint8Array(buffer);
values[7] = 2;
module.exports = Promise.resolve(view.getUint32(0) + values[7]);
`,
      42,
    ],
    [
      "lookbehind and named regular-expression captures",
      `
"use strict";
const match = /(?<word>[a-z]+)-(?<digits>(?<=-)\\d+)/.exec("value-42");
module.exports = Promise.resolve(
  match.groups.word + ":" + match.groups.digits
);
`,
      "value:42",
    ],
    [
      "Unicode identifiers and non-BMP source text",
      `
"use strict";
const café = "🔐";
const 変数 = "漢字";
module.exports = Promise.resolve(\`\${café}:\${変数}\`);
`,
      "🔐:漢字",
    ],
    [
      "CommonJS this and arguments bindings",
      `
"use strict";
module.exports = Promise.resolve(
  [this === exports, arguments[2] === module].join(",")
);
`,
      "true,true",
    ],
    [
      "lexical this and arguments in arrow functions",
      `
"use strict";
function read(argument) {
  const arrow = () => this.prefix + ":" + arguments[0];
  return arrow();
}
module.exports = Promise.resolve(read.call({ prefix: "context" }, "argument"));
`,
      "context:argument",
    ],
    [
      "private-brand checks",
      `
"use strict";
class Box {
  #value = 42;
  static containsPrivateState(value) {
    return #value in value;
  }
  read() {
    return this.#value;
  }
}
const box = new Box();
module.exports = Promise.resolve(
  Box.containsPrivateState(box) + ":" + box.read()
);
`,
      "true:42",
    ],
    [
      "object accessors and property descriptors",
      `
"use strict";
let stored = 20;
const value = {
  get answer() {
    return stored;
  },
  set answer(next) {
    stored = next;
  }
};
Object.defineProperty(value, "offset", {
  configurable: true,
  enumerable: false,
  value: 2
});
value.answer = 40;
module.exports = Promise.resolve(value.answer + value.offset);
`,
      42,
    ],
    [
      "Map, Set, and iterator protocols",
      `
"use strict";
const values = new Map([
  ["first", 20],
  ["second", 10]
]);
const offsets = new Set([5, 7]);
module.exports = Promise.resolve(
  [...values.values(), ...offsets.values()].reduce(
    (total, value) => total + value,
    0
  )
);
`,
      42,
    ],
    [
      "labeled loops and control flow",
      `
"use strict";
let result = 0;
outer: for (let outerIndex = 0; outerIndex < 7; outerIndex++) {
  for (let innerIndex = 0; innerIndex < 3; innerIndex++) {
    if (innerIndex === 1) {
      continue outer;
    }
    result += 6;
  }
}
module.exports = Promise.resolve(result);
`,
      42,
    ],
    [
      "Promise combinators and microtasks",
      `
"use strict";
const deferred = new Promise((resolve) => {
  queueMicrotask(() => resolve(2));
});
module.exports = Promise.all([Promise.resolve(40), deferred]).then(
  (values) => values.reduce((total, value) => total + value, 0)
);
`,
      42,
    ],
    [
      "Node.js Buffer operations",
      `
"use strict";
const encoded = Buffer.from("bytecode", "utf8");
module.exports = Promise.resolve(encoded.subarray(0, 4).toString("utf8"));
`,
      "byte",
    ],
    [
      "EventEmitter listeners",
      `
"use strict";
const { EventEmitter } = require("node:events");
const emitter = new EventEmitter();
let result = 0;
emitter.once("first", (value) => {
  result += value;
});
emitter.on("second", (value) => {
  result += value;
});
emitter.emit("first", 20);
emitter.emit("first", 100);
emitter.emit("second", 22);
module.exports = Promise.resolve(result);
`,
      42,
    ],
    [
      "SharedArrayBuffer and Atomics",
      `
"use strict";
const shared = new SharedArrayBuffer(4);
const values = new Int32Array(shared);
Atomics.store(values, 0, 40);
Atomics.add(values, 0, 2);
module.exports = Promise.resolve(Atomics.load(values, 0));
`,
      42,
    ],
    [
      "runtime-generated functions",
      `
"use strict";
const multiply = new Function("left", "right", "return left * right;");
module.exports = Promise.resolve(multiply(6, 7));
`,
      42,
    ],
    [
      "WebAssembly instantiation",
      `
"use strict";
const bytes = Uint8Array.from([
  0, 97, 115, 109, 1, 0, 0, 0,
  1, 5, 1, 96, 0, 1, 127,
  3, 2, 1, 0,
  7, 10, 1, 6, 97, 110, 115, 119, 101, 114, 0, 0,
  10, 6, 1, 4, 0, 65, 42, 11
]);
module.exports = WebAssembly.instantiate(bytes).then(
  ({ instance }) => instance.exports.answer()
);
`,
      42,
    ],
    [
      "WeakRef and FinalizationRegistry registration",
      `
"use strict";
const target = { answer: 42 };
const reference = new WeakRef(target);
const unregisterToken = {};
const registry = new FinalizationRegistry(() => {});
registry.register(target, "held value", unregisterToken);
module.exports = Promise.resolve(
  reference.deref().answer + ":" + registry.unregister(unregisterToken)
);
`,
      "42:true",
    ],
    [
      "nested node:vm contexts and compiled functions",
      `
"use strict";
const vm = require("node:vm");
const context = vm.createContext({ input: 40 });
const script = new vm.Script("input + 2");
const add = vm.compileFunction("return left + right;", ["left", "right"]);
module.exports = Promise.resolve(
  script.runInContext(context) + ":" + add(20, 22)
);
`,
      "42:42",
    ],
    [
      "MessageChannel structured cloning",
      `
"use strict";
const { MessageChannel } = require("node:worker_threads");
const { port1, port2 } = new MessageChannel();
module.exports = new Promise((resolve) => {
  port1.once("message", (message) => {
    port1.close();
    port2.close();
    resolve(
      message.values.get("answer") + ":" +
      message.bytes.join(",")
    );
  });
  port2.postMessage({
    values: new Map([["answer", 42]]),
    bytes: new Uint8Array([1, 2, 3])
  });
});
`,
      "42:1,2,3",
    ],
    [
      "worker threads",
      `
"use strict";
const { Worker } = require("node:worker_threads");
const worker = new Worker(
  "const { parentPort } = require('node:worker_threads');" +
  "parentPort.postMessage(40 + 2);",
  { eval: true }
);
module.exports = new Promise((resolve, reject) => {
  worker.once("message", (value) => {
    resolve(value);
    void worker.terminate();
  });
  worker.once("error", reject);
});
`,
      42,
    ],
    [
      "custom sync and async iterator protocols",
      `
"use strict";
const syncValues = {
  [Symbol.iterator]() {
    let value = 0;
    return {
      next() {
        value += 1;
        return value <= 2
          ? { done: false, value }
          : { done: true, value: undefined };
      }
    };
  }
};
const asyncValues = {
  [Symbol.asyncIterator]() {
    let value = 2;
    return {
      async next() {
        value += 1;
        return value <= 4
          ? { done: false, value }
          : { done: true, value: undefined };
      }
    };
  }
};
module.exports = Array.fromAsync(asyncValues).then(
  (values) => [...syncValues].join(",") + ":" + values.join(",")
);
`,
      "1,2:3,4",
    ],
    [
      "advanced Symbol customization hooks",
      `
"use strict";
class DerivedArray extends Array {
  static get [Symbol.species]() {
    return Array;
  }
}
class Even {
  static [Symbol.hasInstance](value) {
    return typeof value === "number" && value % 2 === 0;
  }
}
const primitive = {
  [Symbol.toPrimitive]() {
    return 40;
  }
};
const matcher = {
  [Symbol.match](value) {
    return ["matched:" + value];
  }
};
const mapped = new DerivedArray(1, 2).map((value) => value * 2);
module.exports = Promise.resolve(
  (Number(primitive) + 2) + ":" +
  (42 instanceof Even) + ":" +
  (mapped instanceof DerivedArray) + ":" +
  "value".match(matcher)[0]
);
`,
      "42:true:false:matched:value",
    ],
    [
      "resizable and growable buffers with BigInt typed arrays",
      `
"use strict";
const resizable = new ArrayBuffer(4, { maxByteLength: 8 });
const resizableValues = new Uint8Array(resizable);
resizableValues[0] = 20;
resizable.resize(8);

const growable = new SharedArrayBuffer(4, { maxByteLength: 8 });
const growableValues = new Uint8Array(growable);
growableValues[0] = 22;
growable.grow(8);

const bigInts = new BigInt64Array(1);
bigInts[0] = 42n;
module.exports = Promise.resolve(
  (resizableValues[0] + growableValues[0]) + ":" + bigInts[0].toString()
);
`,
      "42:42",
    ],
    [
      "AsyncLocalStorage propagation",
      `
"use strict";
const { AsyncLocalStorage } = require("node:async_hooks");
const storage = new AsyncLocalStorage();
module.exports = storage.run({ answer: 42 }, async () => {
  await Promise.resolve();
  return storage.getStore().answer;
});
`,
      42,
    ],
    [
      "custom thenable assimilation",
      `
"use strict";
const thenable = {
  then(resolve) {
    queueMicrotask(() => resolve(42));
  }
};
module.exports = Promise.resolve(thenable);
`,
      42,
    ],
    [
      "native-addon-backed package loading",
      `
"use strict";
const { parseAst } = require("rollup/parseAst");
const ast = parseAst("const answer = 42;");
module.exports = Promise.resolve(ast.type + ":" + ast.body[0].type);
`,
      "Program:VariableDeclaration",
    ],
    [
      "iterator helpers and Set composition",
      `
"use strict";
const iteratorTotal = Iterator.from([10, 11])
  .map((value) => value * 2)
  .reduce((total, value) => total + value, 0);
const setTotal = [...new Set([10, 12]).union(new Set([20]))]
  .reduce((total, value) => total + value, 0);
module.exports = Promise.resolve(iteratorTotal + ":" + setTotal);
`,
      "42:42",
    ],
    [
      "generator delegation, throw, return, and cleanup",
      `
"use strict";
const events = [];
function* inner() {
  try {
    yield 1;
    yield 2;
  } finally {
    events.push("inner-finally");
  }
}
function* outer() {
  try {
    yield* inner();
  } finally {
    events.push("outer-finally");
  }
}
function* catcher() {
  try {
    yield "ready";
  } catch (error) {
    return error.message;
  }
}
const delegated = outer();
const first = delegated.next();
const returned = delegated.return(42);
const catching = catcher();
catching.next();
const thrown = catching.throw(new Error("boom"));
module.exports = Promise.resolve(
  first.value + ":" +
  returned.value + ":" +
  returned.done + ":" +
  thrown.value + ":" +
  events.join(",")
);
`,
      "1:42:true:boom:inner-finally,outer-finally",
    ],
    [
      "static private members and initialization order",
      `
"use strict";
const events = [];
class Counter {
  static #value = (events.push("field"), 40);
  static get #answer() {
    events.push("getter");
    return this.#value;
  }
  static #add(value) {
    events.push("method");
    return this.#answer + value;
  }
  static {
    events.push("block");
    this.result = this.#add(2);
  }
}
module.exports = Promise.resolve(events.join(",") + ":" + Counter.result);
`,
      "field,block,method,getter:42",
    ],
    [
      "new.target and Reflect.construct",
      `
"use strict";
function Base(value) {
  this.value = value;
  this.targetName = new.target.name;
}
function Derived() {}
Derived.prototype = Object.create(Base.prototype, {
  constructor: {
    configurable: true,
    value: Derived,
    writable: true
  }
});
const instance = Reflect.construct(Base, [42], Derived);
module.exports = Promise.resolve(
  instance.value + ":" +
  instance.targetName + ":" +
  (instance instanceof Derived)
);
`,
      "42:Derived:true",
    ],
    [
      "revocable proxies and advanced traps",
      `
"use strict";
function Target(value) {
  this.value = value;
}
const calls = [];
const { proxy, revoke } = Proxy.revocable(Target, {
  apply(target, thisValue, argumentsList) {
    calls.push("apply");
    return argumentsList.reduce((total, value) => total + value, 0);
  },
  construct(target, argumentsList, newTarget) {
    calls.push("construct");
    return Reflect.construct(target, argumentsList, newTarget);
  },
  ownKeys(target) {
    calls.push("ownKeys");
    return [...Reflect.ownKeys(target), "virtual"];
  },
  getOwnPropertyDescriptor(target, property) {
    if (property === "virtual") {
      return {
        configurable: true,
        enumerable: true,
        value: 42,
        writable: false
      };
    }
    return Reflect.getOwnPropertyDescriptor(target, property);
  }
});
const applied = proxy(20, 22);
const constructed = new proxy(42);
const hasVirtualKey = Object.keys(proxy).includes("virtual");
revoke();
let revoked = false;
try {
  proxy();
} catch (error) {
  revoked = error instanceof TypeError;
}
module.exports = Promise.resolve(
  applied + ":" +
  constructed.value + ":" +
  hasVirtualKey + ":" +
  revoked + ":" +
  calls.join(",")
);
`,
      "42:42:true:true:apply,construct,ownKeys",
    ],
    [
      "WeakMap and WeakSet",
      `
"use strict";
const first = {};
const second = {};
const values = new WeakMap([
  [first, 20],
  [second, 22]
]);
const members = new WeakSet([first, second]);
module.exports = Promise.resolve(
  (values.get(first) + values.get(second)) + ":" +
  members.has(first) + ":" +
  members.delete(second) + ":" +
  members.has(second)
);
`,
      "42:true:true:false",
    ],
    [
      "Promise variants and AggregateError",
      `
"use strict";
module.exports = (async function () {
  const { promise, resolve } = Promise.withResolvers();
  queueMicrotask(() => resolve(40));
  const first = await promise;
  const second = await Promise.any([
    Promise.reject(new Error("ignored")),
    Promise.resolve(2)
  ]);
  const settled = await Promise.allSettled([
    Promise.resolve("ok"),
    Promise.reject(new Error("expected"))
  ]);
  let aggregate;
  try {
    await Promise.any([
      Promise.reject("first"),
      Promise.reject("second")
    ]);
  } catch (error) {
    aggregate = error;
  }
  return (
    (first + second) + ":" +
    settled.map((entry) => entry.status).join(",") + ":" +
    (aggregate instanceof AggregateError) + ":" +
    aggregate.errors.length
  );
})();
`,
      "42:fulfilled,rejected:true:2",
    ],
    [
      "Atomics.waitAsync",
      `
"use strict";
const shared = new SharedArrayBuffer(4);
const values = new Int32Array(shared);
const waiter = Atomics.waitAsync(values, 0, 0, 1000);
queueMicrotask(() => {
  Atomics.store(values, 0, 42);
  Atomics.notify(values, 0, 1);
});
module.exports = Promise.resolve(waiter.value).then(
  (status) => status + ":" + Atomics.load(values, 0)
);
`,
      "ok:42",
    ],
    [
      "ArrayBuffer transfer and detachment",
      `
"use strict";
const original = new ArrayBuffer(2, { maxByteLength: 8 });
new Uint8Array(original).set([40, 2]);
const transferred = original.transfer(4);
const fixed = transferred.transferToFixedLength(2);
module.exports = Promise.resolve(
  original.byteLength + ":" +
  transferred.byteLength + ":" +
  (new Uint8Array(fixed)[0] + new Uint8Array(fixed)[1]) + ":" +
  fixed.resizable
);
`,
      "0:0:42:false",
    ],
    [
      "regular-expression indices, sticky matching, and Unicode properties",
      `
"use strict";
const expression = /(?<word>\\p{Letter}+)-(?<digits>\\d+)/duy;
const match = expression.exec("café-42");
module.exports = Promise.resolve(
  match.groups.word + ":" +
  match.groups.digits + ":" +
  match.indices.groups.word.join("-") + ":" +
  match.indices.groups.digits.join("-") + ":" +
  expression.lastIndex
);
`,
      "café:42:0-4:5-7:7",
    ],
    [
      "replace, search, split, and concat Symbol protocols",
      `
"use strict";
const protocols = {
  [Symbol.replace](value, replacement) {
    return replacement + ":" + value;
  },
  [Symbol.search](value) {
    return value.length;
  },
  [Symbol.split](value) {
    return [value.slice(0, 2), value.slice(2)];
  }
};
const spreadable = {
  0: "x",
  1: "y",
  length: 2,
  [Symbol.isConcatSpreadable]: true
};
module.exports = Promise.resolve(
  "value".replace(protocols, "replacement") + ":" +
  "value".search(protocols) + ":" +
  "value".split(protocols).join(",") + ":" +
  [].concat(spreadable).join("")
);
`,
      "replacement:value:5:va,lue:xy",
    ],
    [
      "immutable Array methods",
      `
"use strict";
const original = [3, 1, 2];
const sorted = original.toSorted();
const spliced = original.toSpliced(1, 1, 4);
const reversed = original.toReversed();
const replaced = original.with(0, 5);
module.exports = Promise.resolve(
  original.join("") + ":" +
  sorted.join("") + ":" +
  spliced.join("") + ":" +
  reversed.join("") + ":" +
  replaced.join("")
);
`,
      "312:123:342:213:512",
    ],
    [
      "Object.groupBy and Map.groupBy",
      `
"use strict";
const values = [1, 2, 3, 4];
const objectGroups = Object.groupBy(
  values,
  (value) => value % 2 === 0 ? "even" : "odd"
);
const mapGroups = Map.groupBy(
  values,
  (value) => value <= 2 ? "low" : "high"
);
module.exports = Promise.resolve(
  objectGroups.even.join(",") + ":" +
  objectGroups.odd.join(",") + ":" +
  mapGroups.get("low").join(",") + ":" +
  mapGroups.get("high").join(",")
);
`,
      "2,4:1,3:1,2:3,4",
    ],
    [
      "cross-realm identity and prototypes",
      `
"use strict";
const vm = require("node:vm");
const context = vm.createContext({});
const foreign = vm.runInContext(
  "({ array: [1, 2], object: { answer: 42 } })",
  context
);
module.exports = Promise.resolve(
  Array.isArray(foreign.array) + ":" +
  (foreign.array instanceof Array) + ":" +
  (foreign.object instanceof Object) + ":" +
  foreign.object.answer
);
`,
      "true:false:false:42",
    ],
    [
      "async cleanup and exception propagation",
      `
"use strict";
const events = [];
async function leaf() {
  try {
    await Promise.resolve();
    throw new Error("boom");
  } finally {
    events.push("leaf-finally");
  }
}
async function middle() {
  try {
    await leaf();
  } finally {
    events.push("middle-finally");
  }
}
module.exports = middle().then(
  () => "unexpected",
  (error) => error.message + ":" + events.join(",")
);
`,
      "boom:leaf-finally,middle-finally",
    ],
    [
      "Intl and ECMA-402 behavior",
      `
"use strict";
const segments = [
  ...new Intl.Segmenter("en", { granularity: "grapheme" })
    .segment("👨‍👩‍👧‍👦a")
];
const number = new Intl.NumberFormat("en-US", {
  useGrouping: false
}).format(1234.5);
const plural = new Intl.PluralRules("en").select(1);
const language = new Intl.Locale("en-US").maximize().language;
module.exports = Promise.resolve(
  segments.length + ":" +
  (segments[0].segment === "👨‍👩‍👧‍👦") + ":" +
  number + ":" +
  plural + ":" +
  language
);
`,
      "2:true:1234.5:one:en",
    ],
  ])(
    "preserves %s through transformed bytecode execution",
    (_feature, moduleCode, expected) => {
      writeTransformedBytecodeFixture("compatibility.jsc", moduleCode);
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
`
      );

      expect(runNode(entryFile)).toContain("compatibility case preserved");
    }
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
`
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
`
    );

    expect(runNode(entryFile)).toContain("native dynamic import preserved");
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
`
    );

    expect(() => runNode(entryFile)).not.toThrow();
  });
});
