import { describe, it, expect } from "vitest";
import { transformCode } from "../src/transforms";

describe("String Protection Transform", () => {
  describe("transformCode", () => {
    it("should still transform template literals even with no protected strings", () => {
      // transformCode now ALWAYS runs template literal transformation
      // This is required for V8 bytecode compatibility
      const code = 'const x = "test";';
      const result = transformCode(code, []);

      expect(result).not.toBeNull();
      expect(result!.code).toContain('const x = "test"');
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

    it("should generate correct character codes", () => {
      const code = 'const x = "ABC";';
      const result = transformCode(code, ["ABC"]);

      expect(result).not.toBeNull();
      // Should contain character codes for A(65), B(66), C(67)
      expect(result!.code).toContain("65");
      expect(result!.code).toContain("66");
      expect(result!.code).toContain("67");
    });

    it("should not skip template literals with expressions", () => {
      const code = "const x = `${y}`;";
      const result = transformCode(code, ["test"]);

      // Template with expression should not be touched even if value matches
      expect(result).not.toBeNull();
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
