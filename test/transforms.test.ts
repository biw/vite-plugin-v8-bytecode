import { describe, expect, it } from "vite-plus/test";
import { parseAst } from "vite";
import {
  rewriteRequireSpecifiers,
  transformCode as transformCodeWithParser,
} from "../src/transforms";

function transformCode(
  code: string,
  obfuscatedStrings: string[],
  sourceMaps: boolean = false,
): ReturnType<typeof transformCodeWithParser> {
  return transformCodeWithParser(code, obfuscatedStrings, parseAst, sourceMaps);
}

function rewriteRequires(
  code: string,
  replacements: Readonly<Record<string, string>>,
): ReturnType<typeof rewriteRequireSpecifiers> {
  return rewriteRequireSpecifiers(code, (specifier) => replacements[specifier], parseAst);
}

describe("String obfuscation transform", () => {
  it("does not transform code when no strings are selected", () => {
    const code = "const result = `value:${42}`;";

    expect(transformCode(code, [])).toBeNull();
  });

  it("obfuscates a selected string literal and preserves its value", () => {
    const code = 'const result = "OBFUSCATED_VALUE";';
    const transformed = transformCode(code, ["OBFUSCATED_VALUE"]);

    expect(transformed).not.toBeNull();
    expect(transformed!.code).not.toContain('"OBFUSCATED_VALUE"');
    expect(transformed!.code).toContain("globalThis.String.fromCharCode.bind(globalThis.String)");
    expect(new Function(`${transformed!.code}; return result;`)()).toBe("OBFUSCATED_VALUE");
  });

  it("obfuscates a selected static template literal", () => {
    const code = "const result = `OBFUSCATED_VALUE`;";
    const transformed = transformCode(code, ["OBFUSCATED_VALUE"]);

    expect(transformed).not.toBeNull();
    expect(transformed!.code).not.toContain("`OBFUSCATED_VALUE`");
    expect(new Function(`${transformed!.code}; return result;`)()).toBe("OBFUSCATED_VALUE");
  });

  it("matches decoded string values while retaining unmatched literals", () => {
    const code =
      'const normal = "normal"; const selected = "Test\\nLine"; ' +
      "const result = [normal, selected];";
    const transformed = transformCode(code, ["Test\nLine"]);

    expect(transformed).not.toBeNull();
    expect(transformed!.code).toContain('"normal"');
    expect(transformed!.code).not.toContain('"Test\\nLine"');
    expect(new Function(`${transformed!.code}; return result;`)()).toEqual([
      "normal",
      "Test\nLine",
    ]);
  });

  it("obfuscates every selected occurrence with one shared helper", () => {
    const code =
      'const first = "VALUE_ONE"; const second = "VALUE_TWO"; ' + "const result = first + second;";
    const transformed = transformCode(code, ["VALUE_ONE", "VALUE_TWO"]);

    expect(transformed).not.toBeNull();
    expect(transformed!.code).not.toContain('"VALUE_ONE"');
    expect(transformed!.code).not.toContain('"VALUE_TWO"');
    expect(transformed!.code.match(/globalThis\.String\.fromCharCode/g)).toHaveLength(1);
    expect(new Function(`${transformed!.code}; return result;`)()).toBe("VALUE_ONEVALUE_TWO");
  });

  it.each([
    ["object property key", 'const value = { "OBFUSCATED_VALUE": "ok" };'],
    ["object method key", 'const value = { "OBFUSCATED_VALUE"() { return "ok"; } };'],
    ["class method key", 'const value = class { "OBFUSCATED_VALUE"() { return "ok"; } };'],
    ["class field key", 'const value = class { "OBFUSCATED_VALUE" = "ok"; };'],
    ["object accessor key", 'const value = { get "OBFUSCATED_VALUE"() { return "ok"; } };'],
    ["class accessor key", 'const value = class { set "OBFUSCATED_VALUE"(next) {} };'],
    ["computed member property", 'const value = object["OBFUSCATED_VALUE"];'],
    ["require specifier", 'const value = require("OBFUSCATED_VALUE");'],
    ["require.resolve specifier", 'const value = require.resolve("OBFUSCATED_VALUE");'],
    ["dynamic import specifier", 'const value = import("OBFUSCATED_VALUE");'],
    ["tagged template", "const value = tag`OBFUSCATED_VALUE`;"],
  ])("leaves a matching %s unchanged", (_kind, code) => {
    expect(transformCode(code, ["OBFUSCATED_VALUE"])).toBeNull();
  });

  it("does not rewrite a template literal containing expressions", () => {
    const code = "const value = 42; const result = `OBFUSCATED_VALUE:${value}`;";

    expect(transformCode(code, ["OBFUSCATED_VALUE"])).toBeNull();
  });

  it("preserves non-BMP characters", () => {
    const code = 'const result = "A🔐Z";';
    const transformed = transformCode(code, ["A🔐Z"]);

    expect(transformed).not.toBeNull();
    expect(new Function(`${transformed!.code}; return result;`)()).toBe("A🔐Z");
  });

  it("handles the empty string", () => {
    const code = 'const result = "";';
    const transformed = transformCode(code, [""]);

    expect(transformed).not.toBeNull();
    expect(new Function(`${transformed!.code}; return result;`)()).toBe("");
  });

  it("chunks large strings below runtime argument limits", () => {
    const value = "x".repeat(150_000);
    const transformed = transformCode(`const result = ${JSON.stringify(value)};`, [value]);

    expect(transformed).not.toBeNull();
    expect(new Function(`${transformed!.code}; return result;`)()).toBe(value);
  });

  it.each([
    [
      "function parameter",
      `
        function read(String) {
          return "OBFUSCATED_VALUE";
        }
        const result = read({});
      `,
    ],
    [
      "hoisted var binding",
      `
        var result = "OBFUSCATED_VALUE";
        var String = {};
      `,
    ],
    [
      "lexical temporal dead zone",
      `
        const result = "OBFUSCATED_VALUE";
        const String = {};
      `,
    ],
    [
      "catch binding",
      `
        let result;
        try {
          throw {};
        } catch (String) {
          result = "OBFUSCATED_VALUE";
        }
      `,
    ],
    [
      "class name binding",
      `
        class String {
          value = "OBFUSCATED_VALUE";
        }
        const result = new String().value;
      `,
    ],
  ])("works when String is shadowed by a %s", (_kind, code) => {
    const transformed = transformCode(code, ["OBFUSCATED_VALUE"]);

    expect(transformed).not.toBeNull();
    expect(new Function(`${transformed!.code}; return result;`)()).toBe("OBFUSCATED_VALUE");
  });

  it("captures String.fromCharCode before user code mutates it", () => {
    const code = `
      const originalFromCharCode = String.fromCharCode;
      String.fromCharCode = function () {
        return "tampered";
      };
      const result = "OBFUSCATED_VALUE";
      String.fromCharCode = originalFromCharCode;
    `;
    const transformed = transformCode(code, ["OBFUSCATED_VALUE"]);

    expect(transformed).not.toBeNull();
    expect(new Function(`${transformed!.code}; return result;`)()).toBe("OBFUSCATED_VALUE");
  });

  it("avoids collisions with identifiers in generated chunks", () => {
    const code = `
      const _viteBytecodeFromCharCode = "existing";
      const result = [_viteBytecodeFromCharCode, "OBFUSCATED_VALUE"];
    `;
    const transformed = transformCode(code, ["OBFUSCATED_VALUE"]);

    expect(transformed).not.toBeNull();
    expect(transformed!.code).toContain("const _viteBytecodeFromCharCode$1 =");
    expect(new Function(`${transformed!.code}; return result;`)()).toEqual([
      "existing",
      "OBFUSCATED_VALUE",
    ]);
  });

  it("preserves directives when their value is also selected", () => {
    const code = `
      function readThis() {
        "use strict";
        return {
          thisValue: this,
          value: "use strict"
        };
      }
      const result = readThis();
    `;
    const transformed = transformCode(code, ["use strict"]);

    expect(transformed).not.toBeNull();
    expect(transformed!.code).toContain('"use strict"');
    expect(new Function(`${transformed!.code}; return result;`)()).toEqual({
      thisValue: undefined,
      value: "use strict",
    });
  });

  it("inserts its helper after the top-level directive prologue", () => {
    const code = `
      "use strict";
      const result = (function () { return this; })();
      const marker = "OBFUSCATED_VALUE";
    `;
    const transformed = transformCode(code, ["OBFUSCATED_VALUE"]);

    expect(transformed).not.toBeNull();
    expect(transformed!.code.indexOf('"use strict"')).toBeLessThan(
      transformed!.code.indexOf("const _viteBytecodeFromCharCode"),
    );
    expect(new Function(`${transformed!.code}; return result;`)()).toBe(undefined);
  });

  it("inserts its helper after a hashbang", () => {
    const transformed = transformCode('#!/usr/bin/env node\nconst marker = "OBFUSCATED_VALUE";', [
      "OBFUSCATED_VALUE",
    ]);

    expect(transformed).not.toBeNull();
    expect(transformed!.code).toMatch(/^#!\/usr\/bin\/env node\n\nconst _viteBytecodeFromCharCode/);
  });

  it("includes a source map when requested", () => {
    const transformed = transformCode(
      'const marker = "OBFUSCATED_VALUE";',
      ["OBFUSCATED_VALUE"],
      true,
    );

    expect(transformed?.map).toMatchObject({
      names: [],
      sources: ["chunk.js"],
      version: 3,
    });
    expect(
      typeof transformed?.map === "object" && transformed.map
        ? transformed.map.mappings
        : undefined,
    ).not.toBe("");
  });

  it("does not include a source map by default", () => {
    const transformed = transformCode('const marker = "OBFUSCATED_VALUE";', ["OBFUSCATED_VALUE"]);

    expect(transformed?.map).toBeUndefined();
  });
});

describe("require specifier rewriting", () => {
  it("rewrites an unbound require call", () => {
    const rewritten = rewriteRequires('require("./chunk.js");', {
      "./chunk.js": "./chunk.jsc",
    });

    expect(rewritten).toEqual({
      code: 'require("./chunk.jsc");',
      rewritten: true,
    });
  });

  it("rewrites unbound requires in nested scopes", () => {
    const code = `
      function load() {
        return require("./chunk.js");
      }
    `;
    const rewritten = rewriteRequires(code, {
      "./chunk.js": "./chunk.jsc",
    });

    expect(rewritten.rewritten).toBe(true);
    expect(rewritten.code).toContain('require("./chunk.jsc")');
  });

  it("does not rewrite require-like text or member calls", () => {
    const code = `
      const text = 'require("./chunk.js")';
      // require("./chunk.js")
      object.require("./chunk.js");
    `;

    expect(rewriteRequires(code, { "./chunk.js": "./chunk.jsc" })).toEqual({
      code,
      rewritten: false,
    });
  });

  it("does not rewrite dynamic or malformed require calls", () => {
    const code = `
      require(path);
      require();
      require("./chunk.js", options);
    `;

    expect(rewriteRequires(code, { "./chunk.js": "./chunk.jsc" })).toEqual({
      code,
      rewritten: false,
    });
  });

  it.each([
    ["function parameter", 'function load(require) { return require("./chunk.js"); }'],
    [
      "destructured function parameter",
      'function load({ require }) { return require("./chunk.js"); }',
    ],
    ["catch binding", 'try {} catch (require) { require("./chunk.js"); }'],
    ["function expression name", '(function require() { require("./chunk.js"); });'],
    [
      "class expression name",
      'const Value = class require { static load() { require("./chunk.js"); } };',
    ],
  ])("does not rewrite a require shadowed by a %s", (_kind, code) => {
    expect(rewriteRequires(code, { "./chunk.js": "./chunk.jsc" })).toEqual({
      code,
      rewritten: false,
    });
  });

  it("treats var declarations as function-scoped and hoisted", () => {
    const code = `
      require("./chunk.js");
      if (condition) {
        var require = load;
      }
    `;

    expect(rewriteRequires(code, { "./chunk.js": "./chunk.jsc" })).toEqual({
      code,
      rewritten: false,
    });
  });

  it("limits lexical shadowing to its block", () => {
    const code = `
      {
        const require = load;
        require("./chunk.js");
      }
      require("./chunk.js");
    `;
    const rewritten = rewriteRequires(code, {
      "./chunk.js": "./chunk.jsc",
    });

    expect(rewritten.rewritten).toBe(true);
    expect(rewritten.code).toContain('require("./chunk.js");');
    expect(rewritten.code).toContain('require("./chunk.jsc");');
  });

  it("treats top-level declarations as bindings regardless of order", () => {
    const code = `
      require("./chunk.js");
      function require() {}
    `;

    expect(rewriteRequires(code, { "./chunk.js": "./chunk.jsc" })).toEqual({
      code,
      rewritten: false,
    });
  });

  it("uses a valid JavaScript string literal for replacement paths", () => {
    const rewritten = rewriteRequires('require("./chunk.js");', {
      "./chunk.js": './quoted-"chunk".jsc',
    });

    expect(rewritten.code).toBe('require("./quoted-\\"chunk\\".jsc");');
  });

  it("does nothing when the replacement callback declines a specifier", () => {
    const code = 'require("node:path");';

    expect(rewriteRequires(code, {})).toEqual({
      code,
      rewritten: false,
    });
  });
});
