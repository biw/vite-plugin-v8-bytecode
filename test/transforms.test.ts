import { describe, it, expect } from "vitest";
import { transformCode } from "../src/transforms";

describe("String Protection Transform", () => {
  describe("transformCode", () => {
    it("should still transform template literals even with no protected strings", () => {
      const code = "const x = `test`;";
      const result = transformCode(code, []);

      expect(result).not.toBeNull();
      expect(result!.code).toContain('const x = "test"');
      expect(result!.code).not.toContain("`");
    });

    it("should transform protected string literals", () => {
      const code = 'const secret = "MY_SECRET_KEY";';
      const result = transformCode(code, ["MY_SECRET_KEY"]);

      expect(result).not.toBeNull();
      expect(result!.code).not.toContain('"MY_SECRET_KEY"');
      expect(result!.code).toContain("String.fromCharCode");
      expect(result!.code).toContain("function");
    });

    it("should transform protected template literals", () => {
      const code = "const secret = `MY_SECRET_KEY`;";
      const result = transformCode(code, ["MY_SECRET_KEY"]);

      expect(result).not.toBeNull();
      expect(result!.code).not.toContain("`MY_SECRET_KEY`");
      expect(result!.code).toContain("String.fromCharCode");
    });

    it("should not transform non-protected strings", () => {
      const code = 'const x = "normal"; const y = "MY_SECRET_KEY";';
      const result = transformCode(code, ["MY_SECRET_KEY"]);

      expect(result).not.toBeNull();
      expect(result!.code).toContain('"normal"');
      expect(result!.code).not.toContain('"MY_SECRET_KEY"');
    });

    it("should skip object keys", () => {
      const code = 'const obj = { "MY_SECRET_KEY": "value" };';
      const result = transformCode(code, ["MY_SECRET_KEY"]);

      expect(result).not.toBeNull();
      // Object key should not be transformed
      expect(result!.code).toContain('"MY_SECRET_KEY"');
    });

    it("should skip require() paths", () => {
      const code = 'const x = require("MY_SECRET_KEY");';
      const result = transformCode(code, ["MY_SECRET_KEY"]);

      expect(result).not.toBeNull();
      // Require path should not be transformed
      expect(result!.code).toContain('"MY_SECRET_KEY"');
    });

    it("should skip computed member expressions", () => {
      const code = 'const x = obj["MY_SECRET_KEY"];';
      const result = transformCode(code, ["MY_SECRET_KEY"]);

      expect(result).not.toBeNull();
      // Member expression should not be transformed
      expect(result!.code).toContain('"MY_SECRET_KEY"');
    });

    it("should transform multiple protected strings", () => {
      const code = 'const a = "SECRET1"; const b = "SECRET2";';
      const result = transformCode(code, ["SECRET1", "SECRET2"]);

      expect(result).not.toBeNull();
      expect(result!.code).not.toContain('"SECRET1"');
      expect(result!.code).not.toContain('"SECRET2"');
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

    it("should preserve non-BMP characters in protected strings", () => {
      const code = 'const result = "A🔐Z";';
      const transformed = transformCode(code, ["A🔐Z"]);

      expect(transformed).not.toBeNull();
      const result = new Function(`${transformed!.code}; return result;`)();
      expect(result).toBe("A🔐Z");
    });

    it("should protect large strings without exceeding runtime argument limits", () => {
      const protectedValue = "x".repeat(150_000);
      const code = `const result = ${JSON.stringify(protectedValue)};`;
      const transformed = transformCode(code, [protectedValue]);

      expect(transformed).not.toBeNull();
      const result = new Function(`${transformed!.code}; return result;`)();
      expect(result).toBe(protectedValue);
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
        'const value = { "MY_SECRET_KEY"() { return "ok"; } };',
      ],
      [
        "class method",
        'const value = class { "MY_SECRET_KEY"() { return "ok"; } };',
      ],
      [
        "class field",
        'const value = class { "MY_SECRET_KEY" = "ok"; };',
      ],
      [
        "object getter",
        'const value = { get "MY_SECRET_KEY"() { return "ok"; } };',
      ],
      [
        "object setter",
        'const value = { set "MY_SECRET_KEY"(next) {} };',
      ],
      [
        "class getter",
        'const value = class { get "MY_SECRET_KEY"() { return "ok"; } };',
      ],
      [
        "class setter",
        'const value = class { set "MY_SECRET_KEY"(next) {} };',
      ],
      [
        "static class method",
        'const value = class { static "MY_SECRET_KEY"() { return "ok"; } };',
      ],
      [
        "static class field",
        'const value = class { static "MY_SECRET_KEY" = "ok"; };',
      ],
    ])("should preserve protected %s keys", (_kind, code) => {
      const transformed = transformCode(code, ["MY_SECRET_KEY"]);

      expect(transformed).not.toBeNull();
      expect(transformed!.code).toContain('"MY_SECRET_KEY"');
    });

    it("should protect strings when String is shadowed", () => {
      const code = `
        function read(String) {
          return "MY_SECRET_KEY";
        }
        const result = read({});
      `;
      const transformed = transformCode(code, ["MY_SECRET_KEY"]);

      expect(transformed).not.toBeNull();
      const result = new Function(`${transformed!.code}; return result;`)();
      expect(result).toBe("MY_SECRET_KEY");
    });

    it.each([
      [
        "hoisted var binding",
        `
          var result = "MY_SECRET_KEY";
          var String = {};
        `,
      ],
      [
        "lexical temporal dead zone",
        `
          const result = "MY_SECRET_KEY";
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
            result = "MY_SECRET_KEY";
          }
        `,
      ],
      [
        "class name binding",
        `
          class String {
            value = "MY_SECRET_KEY";
          }
          const result = new String().value;
        `,
      ],
    ])("should protect strings with a %s named String", (_kind, code) => {
      const transformed = transformCode(code, ["MY_SECRET_KEY"]);

      expect(transformed).not.toBeNull();
      const result = new Function(`${transformed!.code}; return result;`)();
      expect(result).toBe("MY_SECRET_KEY");
    });

    it("should not depend on mutable String.fromCharCode", () => {
      const code = `
        const originalFromCharCode = String.fromCharCode;
        String.fromCharCode = function () {
          return "tampered";
        };
        const result = "MY_SECRET_KEY";
        String.fromCharCode = originalFromCharCode;
      `;
      const transformed = transformCode(code, ["MY_SECRET_KEY"]);

      expect(transformed).not.toBeNull();
      const result = new Function(`${transformed!.code}; return result;`)();
      expect(result).toBe("MY_SECRET_KEY");
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

    it("should preserve protected static tagged template literals", () => {
      const code = "const query = sql`MY_SECRET_KEY`;";
      const result = transformCode(code, ["MY_SECRET_KEY"]);

      expect(result).not.toBeNull();
      expect(result!.code).toContain("sql`MY_SECRET_KEY`");
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
      const code = 'const secret = "MY_SECRET_KEY";';
      const result = transformCode(code, ["MY_SECRET_KEY"], true);

      expect(result).not.toBeNull();
      expect(result!.map).toBeDefined();
    });

    it("should not include source maps by default", () => {
      const code = 'const secret = "MY_SECRET_KEY";';
      const result = transformCode(code, ["MY_SECRET_KEY"]);

      expect(result).not.toBeNull();
      expect(result!.map).toBeUndefined();
    });
  });
});
