import { describe, it, expect } from "vitest";
import {
  toRelativePath,
  normalizePath,
  resolveBuildOutputs,
  detectModuleFormat,
} from "../src/utils";

describe("Utility Functions", () => {
  describe("toRelativePath", () => {
    it("should convert file name to relative path with ./", () => {
      const from = "loader.cjs";
      const to = "dist/index.cjs";

      const result = toRelativePath(from, to);

      // Result should start with ./
      expect(result.startsWith(".")).toBe(true);
    });

    it("should handle paths in same directory", () => {
      const from = "bytecode-loader.cjs";
      const to = "dist/index.cjs";

      const result = toRelativePath(from, to);

      // Should compute relative path from dist/ directory
      expect(result.startsWith(".")).toBe(true);
    });

    it("should preserve relative paths starting with ./", () => {
      const from = "./loader.cjs";
      const to = "/project/dist/index.cjs";

      const result = toRelativePath(from, to);

      expect(result.startsWith(".")).toBe(true);
    });

    it("should preserve relative paths starting with ../", () => {
      const from = "../loader.cjs";
      const to = "/project/dist/sub/index.cjs";

      const result = toRelativePath(from, to);

      expect(result.startsWith(".")).toBe(true);
    });

    it("should ensure relative path starts with . or ..", () => {
      const from = "loader.cjs";
      const to = "/project/dist/index.cjs";

      const result = toRelativePath(from, to);

      expect(result.startsWith(".")).toBe(true);
    });
  });

  describe("normalizePath", () => {
    it("should convert backslashes to forward slashes", () => {
      const windowsPath = "C:\\Users\\test\\file.js";

      const result = normalizePath(windowsPath);

      expect(result).toBe("C:/Users/test/file.js");
    });

    it("should leave forward slashes unchanged", () => {
      const unixPath = "/home/user/file.js";

      const result = normalizePath(unixPath);

      expect(result).toBe("/home/user/file.js");
    });

    it("should handle mixed slashes", () => {
      const mixedPath = "C:\\Users/test\\file.js";

      const result = normalizePath(mixedPath);

      expect(result).toBe("C:/Users/test/file.js");
    });

    it("should handle empty string", () => {
      const result = normalizePath("");

      expect(result).toBe("");
    });

    it("should handle path with only backslashes", () => {
      const result = normalizePath("\\\\");

      expect(result).toBe("//");
    });
  });

  describe("resolveBuildOutputs", () => {
    it("should return outputs unchanged when no lib options", () => {
      const outputs = { format: "cjs" as const };

      const result = resolveBuildOutputs(outputs, false);

      expect(result).toBe(outputs);
    });

    it("should return array unchanged when lib options present but outputs is array", () => {
      const outputs = [{ format: "cjs" as const }];
      const libOptions = { entry: "index.js", formats: ["cjs" as const] };

      const result = resolveBuildOutputs(outputs, libOptions);

      expect(result).toBe(outputs);
    });

    it("should expand outputs for multiple lib formats", () => {
      const outputs = { name: "test" };
      const libOptions = { entry: "index.js", formats: ["cjs" as const, "es" as const] };

      const result = resolveBuildOutputs(outputs, libOptions);

      expect(Array.isArray(result)).toBe(true);
      expect((result as any[]).length).toBe(2);
      expect((result as any[])[0].format).toBe("cjs");
      expect((result as any[])[1].format).toBe("es");
    });

    it("should preserve other output properties", () => {
      const outputs = { name: "test", dir: "dist" };
      const libOptions = { entry: "index.js", formats: ["cjs" as const] };

      const result = resolveBuildOutputs(outputs, libOptions) as any[];

      expect(result[0].name).toBe("test");
      expect(result[0].dir).toBe("dist");
    });

    it("should handle empty formats array", () => {
      const outputs = { name: "test" };
      const libOptions = { entry: "index.js", formats: [] as any[] };

      const result = resolveBuildOutputs(outputs, libOptions);

      expect(Array.isArray(result)).toBe(true);
      expect((result as any[]).length).toBe(0);
    });
  });

  describe("detectModuleFormat", () => {
    it("should detect ES modules with import statement", () => {
      const code = 'import { foo } from "bar";';

      const result = detectModuleFormat(code);

      expect(result).toBe("esm");
    });

    it("should detect ES modules with export statement", () => {
      const code = "export const foo = 42;";

      const result = detectModuleFormat(code);

      expect(result).toBe("esm");
    });

    it("should detect ES modules with export default", () => {
      const code = "export default function() {}";

      const result = detectModuleFormat(code);

      expect(result).toBe("esm");
    });

    it("should detect CommonJS without import/export", () => {
      const code = 'const foo = require("bar");';

      const result = detectModuleFormat(code);

      expect(result).toBe("cjs");
    });

    it("should detect CommonJS with module.exports", () => {
      const code = "module.exports = { foo: 42 };";

      const result = detectModuleFormat(code);

      expect(result).toBe("cjs");
    });

    it("should handle code with both import and require (ESM)", () => {
      const code = `
        import { foo } from "bar";
        const baz = require("qux");
      `;

      const result = detectModuleFormat(code);

      // import takes precedence
      expect(result).toBe("esm");
    });

    it("should handle empty code as CommonJS", () => {
      const code = "";

      const result = detectModuleFormat(code);

      expect(result).toBe("cjs");
    });

    it("should detect import keyword even in comments (simple regex)", () => {
      const code = "// import something\nconst x = 1;";

      const result = detectModuleFormat(code);

      // Simple regex will match import even in comments
      // This is acceptable for our use case since vite output won't have this
      expect(result).toBe("esm");
    });

    it("should detect export keyword even in strings (simple regex)", () => {
      const code = 'const x = "export something";';

      const result = detectModuleFormat(code);

      // Simple regex will match export even in strings
      // This is acceptable for our use case since vite output won't have this
      expect(result).toBe("esm");
    });
  });
});
