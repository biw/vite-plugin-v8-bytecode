import { describe, it, expect } from "vitest";
import { transformCode } from "../src/transforms";

describe("String Obfuscation Transform", () => {
  describe("transformCode", () => {
    it("should still transform template literals even with no obfuscated strings", () => {
      const code = "const x = `test`;";
      const result = transformCode(code, []);

      expect(result).not.toBeNull();
      expect(result!.code).toContain('const x = "test"');
      expect(result!.code).not.toContain("`");
    });

    it("should transform obfuscated string literals", () => {
      const code = 'const marker = "OBFUSCATED_VALUE";';
      const result = transformCode(code, ["OBFUSCATED_VALUE"]);

      expect(result).not.toBeNull();
      expect(result!.code).not.toContain('"OBFUSCATED_VALUE"');
      expect(result!.code).toContain("String.fromCharCode");
      expect(result!.code).toContain("function");
    });

    it("should transform obfuscated template literals", () => {
      const code = "const marker = `OBFUSCATED_VALUE`;";
      const result = transformCode(code, ["OBFUSCATED_VALUE"]);

      expect(result).not.toBeNull();
      expect(result!.code).not.toContain("`OBFUSCATED_VALUE`");
      expect(result!.code).toContain("String.fromCharCode");
    });

    it("should not transform non-obfuscated strings", () => {
      const code = 'const x = "normal"; const y = "OBFUSCATED_VALUE";';
      const result = transformCode(code, ["OBFUSCATED_VALUE"]);

      expect(result).not.toBeNull();
      expect(result!.code).toContain('"normal"');
      expect(result!.code).not.toContain('"OBFUSCATED_VALUE"');
    });

    it("should skip object keys", () => {
      const code = 'const obj = { "OBFUSCATED_VALUE": "value" };';
      const result = transformCode(code, ["OBFUSCATED_VALUE"]);

      expect(result).not.toBeNull();
      // Object key should not be transformed
      expect(result!.code).toContain('"OBFUSCATED_VALUE"');
    });

    it("should skip require() paths", () => {
      const code = 'const x = require("OBFUSCATED_VALUE");';
      const result = transformCode(code, ["OBFUSCATED_VALUE"]);

      expect(result).not.toBeNull();
      // Require path should not be transformed
      expect(result!.code).toContain('"OBFUSCATED_VALUE"');
    });

    it("should skip computed member expressions", () => {
      const code = 'const x = obj["OBFUSCATED_VALUE"];';
      const result = transformCode(code, ["OBFUSCATED_VALUE"]);

      expect(result).not.toBeNull();
      // Member expression should not be transformed
      expect(result!.code).toContain('"OBFUSCATED_VALUE"');
    });

    it("should transform multiple obfuscated strings", () => {
      const code = 'const a = "VALUE_ONE"; const b = "VALUE_TWO";';
      const result = transformCode(code, ["VALUE_ONE", "VALUE_TWO"]);

      expect(result).not.toBeNull();
      expect(result!.code).not.toContain('"VALUE_ONE"');
      expect(result!.code).not.toContain('"VALUE_TWO"');
      // Should have two fromCharCode calls
      expect((result!.code.match(/String\.fromCharCode/g) || []).length).toBe(
        2
      );
    });

    it("should handle strings with special characters", () => {
      const code = 'const x = "Test\\nLine";';
      const result = transformCode(code, ["Test\nLine"]);

      expect(result).not.toBeNull();
      expect(result!.code).toContain("String.fromCharCode");
    });

    it("should preserve non-BMP characters in obfuscated strings", () => {
      const code = 'const result = "A🔐Z";';
      const transformed = transformCode(code, ["A🔐Z"]);

      expect(transformed).not.toBeNull();
      const result = new Function(`${transformed!.code}; return result;`)();
      expect(result).toBe("A🔐Z");
    });

    it("should obfuscate large strings without exceeding runtime argument limits", () => {
      const obfuscatedValue = "x".repeat(150_000);
      const code = `const result = ${JSON.stringify(obfuscatedValue)};`;
      const transformed = transformCode(code, [obfuscatedValue]);

      expect(transformed).not.toBeNull();
      const result = new Function(`${transformed!.code}; return result;`)();
      expect(result).toBe(obfuscatedValue);
    });

    it("should generate correct character codes", () => {
      const code = 'const x = "ABC";';
      const result = transformCode(code, ["ABC"]);

      expect(result).not.toBeNull();
      // Should contain character codes for A(65), B(66), C(67)
      expect(result!.code).toContain("65");
      expect(result!.code).toContain("66");
      expect(result!.code).toContain("67");
    });

    it.each([
      [
        "object method",
        'const value = { "OBFUSCATED_VALUE"() { return "ok"; } };',
      ],
      [
        "class method",
        'const value = class { "OBFUSCATED_VALUE"() { return "ok"; } };',
      ],
      [
        "class field",
        'const value = class { "OBFUSCATED_VALUE" = "ok"; };',
      ],
      [
        "object getter",
        'const value = { get "OBFUSCATED_VALUE"() { return "ok"; } };',
      ],
      [
        "object setter",
        'const value = { set "OBFUSCATED_VALUE"(next) {} };',
      ],
      [
        "class getter",
        'const value = class { get "OBFUSCATED_VALUE"() { return "ok"; } };',
      ],
      [
        "class setter",
        'const value = class { set "OBFUSCATED_VALUE"(next) {} };',
      ],
      [
        "static class method",
        'const value = class { static "OBFUSCATED_VALUE"() { return "ok"; } };',
      ],
      [
        "static class field",
        'const value = class { static "OBFUSCATED_VALUE" = "ok"; };',
      ],
    ])("should preserve matching %s keys", (_kind, code) => {
      const transformed = transformCode(code, ["OBFUSCATED_VALUE"]);

      expect(transformed).not.toBeNull();
      expect(transformed!.code).toContain('"OBFUSCATED_VALUE"');
    });

    it("should obfuscate strings when String is shadowed", () => {
      const code = `
        function read(String) {
          return "OBFUSCATED_VALUE";
        }
        const result = read({});
      `;
      const transformed = transformCode(code, ["OBFUSCATED_VALUE"]);

      expect(transformed).not.toBeNull();
      const result = new Function(`${transformed!.code}; return result;`)();
      expect(result).toBe("OBFUSCATED_VALUE");
    });

    it.each([
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
    ])("should obfuscate strings with a %s named String", (_kind, code) => {
      const transformed = transformCode(code, ["OBFUSCATED_VALUE"]);

      expect(transformed).not.toBeNull();
      const result = new Function(`${transformed!.code}; return result;`)();
      expect(result).toBe("OBFUSCATED_VALUE");
    });

    it("should not depend on mutable String.fromCharCode", () => {
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
      const result = new Function(`${transformed!.code}; return result;`)();
      expect(result).toBe("OBFUSCATED_VALUE");
    });

    it("should transform template literals with expressions", () => {
      const code = "const x = `${y}`;";
      const result = transformCode(code, ["test"]);

      expect(result).not.toBeNull();
      expect(result!.code).not.toContain("`");
      expect(result!.code).toContain('""');
      expect(result!.code).toContain(".concat(y");
    });

    it("should preserve tagged template literals", () => {
      const code = "const query = sql`SELECT * FROM users WHERE id = ${userId}`;";
      const result = transformCode(code, []);

      expect(result).not.toBeNull();
      expect(result!.code).toContain(
        "sql`SELECT * FROM users WHERE id = ${userId}`"
      );
    });

    it("should preserve matching static tagged template literals", () => {
      const code = "const query = sql`OBFUSCATED_VALUE`;";
      const result = transformCode(code, ["OBFUSCATED_VALUE"]);

      expect(result).not.toBeNull();
      expect(result!.code).toContain("sql`OBFUSCATED_VALUE`");
      expect(result!.code).not.toContain("String.fromCharCode");
    });

    it("should coerce a single template expression to a string", () => {
      const code = "const value = 42; const result = `${value}`;";
      const transformed = transformCode(code, []);

      expect(transformed).not.toBeNull();
      const result = new Function(`${transformed!.code}; return result;`)();
      expect(result).toBe("42");
      expect(typeof result).toBe("string");
    });

    it("should not add adjacent numeric template expressions", () => {
      const code = "const result = `${1}${2}`;";
      const transformed = transformCode(code, []);

      expect(transformed).not.toBeNull();
      const result = new Function(`${transformed!.code}; return result;`)();
      expect(result).toBe("12");
    });

    it("should use string-hint coercion for template expressions", () => {
      const code = `
        const hints = [];
        const value = {
          [Symbol.toPrimitive](hint) {
            hints.push(hint);
            return hint;
          }
        };
        const result = \`\${value}\`;
      `;
      const transformed = transformCode(code, []);

      expect(transformed).not.toBeNull();
      const result = new Function(
        `${transformed!.code}; return { result, hints };`
      )();
      expect(result).toEqual({ result: "string", hints: ["string"] });
    });

    it("should coerce each expression before evaluating the next one", () => {
      const code = `
        const events = [];
        const first = {
          [Symbol.toPrimitive]() {
            events.push("coerce first");
            return "first";
          }
        };
        function second() {
          events.push("evaluate second");
          return "second";
        }
        const result = \`\${first}\${second()}\`;
      `;
      const transformed = transformCode(code, []);

      expect(transformed).not.toBeNull();
      const result = new Function(
        `${transformed!.code}; return { result, events };`
      )();
      expect(result).toEqual({
        result: "firstsecond",
        events: ["coerce first", "evaluate second"],
      });
    });

    it("should not depend on a mutable String.prototype.concat", () => {
      const code = `
        const originalConcat = String.prototype.concat;
        String.prototype.concat = function () {
          return "tampered";
        };
        const result = \`value:\${42}\`;
        String.prototype.concat = originalConcat;
      `;
      const transformed = transformCode(code, []);

      expect(transformed).not.toBeNull();
      const result = new Function(`${transformed!.code}; return result;`)();
      expect(result).toBe("value:42");
    });

    it.each([
      [
        "top-level return",
        "if (false) return; module.exports = 1;",
        1,
      ],
      [
        "top-level new.target",
        "module.exports = new.target;",
        undefined,
      ],
      [
        "with statement",
        "var result; with ({ value: 42 }) { result = value; } module.exports = result;",
        42,
      ],
      [
        "Symbol.unscopables behavior",
        `
          var hidden = 2;
          var scope = { visible: 40, hidden: 100 };
          scope[Symbol.unscopables] = { hidden: true };
          var result;
          with (scope) {
            result = visible + hidden;
          }
          module.exports = result;
        `,
        42,
      ],
      [
        "legacy octal literal",
        "module.exports = 010;",
        8,
      ],
      [
        "legacy octal string escape",
        'module.exports = "\\141";',
        "a",
      ],
      [
        "await binding",
        "var await = 42; module.exports = await;",
        42,
      ],
      [
        "yield binding",
        "var yield = 42; module.exports = yield;",
        42,
      ],
      [
        "strict-reserved binding",
        "var implements = 42; module.exports = implements;",
        42,
      ],
      [
        "let var binding",
        "var let = 42; module.exports = let;",
        42,
      ],
      [
        "duplicate parameters",
        "function select(value, value) { return value; } module.exports = select(1, 2);",
        2,
      ],
      [
        "eval parameter",
        "function select(eval) { return eval; } module.exports = select(42);",
        42,
      ],
      [
        "delete of an identifier",
        "var value = 1; module.exports = delete value;",
        false,
      ],
      [
        "Annex B function declaration",
        "if (true) function read() { return 42; } module.exports = read();",
        42,
      ],
      [
        "legacy HTML comment",
        "<!-- generated compatibility comment\nmodule.exports = 42;",
        42,
      ],
      [
        "legacy HTML close comment",
        "--> generated compatibility comment\nmodule.exports = 42;",
        42,
      ],
    ])(
      "should parse valid sloppy-mode CommonJS with a %s",
      (_kind, code, expected) => {
        const transformed = transformCode(code, []);
        const commonJsModule: { exports: unknown } = { exports: undefined };

        expect(transformed).not.toBeNull();
        new Function("module", transformed!.code)(commonJsModule);
        expect(commonJsModule.exports).toBe(expected);
      }
    );

    it("should transform every level of nested template literals", () => {
      const code = `
        const value = "inside";
        const result = \`outer:\${\`inner:\${value}\`}\`;
      `;
      const transformed = transformCode(code, []);

      expect(transformed).not.toBeNull();
      expect(transformed!.code).not.toContain("`");
      const result = new Function(`${transformed!.code}; return result;`)();
      expect(result).toBe("outer:inner:inside");
    });

    it("should preserve directives while protecting an identical string value", () => {
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
      const result = new Function(`${transformed!.code}; return result;`)();
      expect(result).toEqual({
        thisValue: undefined,
        value: "use strict",
      });
    });

    it("should preserve modern JavaScript syntax around transformed templates", () => {
      const code = `
        class Example {
          #value = 40;
          static {
            this.offset = 2;
          }
          read(input) {
            return \`\${input?.value ?? this.#value + Example.offset}\`;
          }
        }
        const result = new Example().read(null);
      `;
      const transformed = transformCode(code, []);

      expect(transformed).not.toBeNull();
      const result = new Function(`${transformed!.code}; return result;`)();
      expect(result).toBe("42");
    });

    it("should include source maps when requested", () => {
      const code = 'const marker = "OBFUSCATED_VALUE";';
      const result = transformCode(code, ["OBFUSCATED_VALUE"], true);

      expect(result).not.toBeNull();
      expect(result!.map).toBeDefined();
    });

    it("should not include source maps by default", () => {
      const code = 'const marker = "OBFUSCATED_VALUE";';
      const result = transformCode(code, ["OBFUSCATED_VALUE"]);

      expect(result).not.toBeNull();
      expect(result!.map).toBeUndefined();
    });
  });
});
