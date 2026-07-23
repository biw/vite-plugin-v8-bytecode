import path from "node:path";
import { describe, it, expect, vi } from "vitest";
import {
  toRelativePath,
  normalizePath,
  resolveBuildOutputs,
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

    it("should emit portable require specifiers on Windows", () => {
      const dirname = vi
        .spyOn(path, "dirname")
        .mockImplementation(path.win32.dirname);
      const relative = vi
        .spyOn(path, "relative")
        .mockImplementation(path.win32.relative);

      try {
        expect(
          toRelativePath("bytecode-loader.cjs", "nested/entry.cjs")
        ).toBe("../bytecode-loader.cjs");
      } finally {
        dirname.mockRestore();
        relative.mockRestore();
      }
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

    it("should preserve the configured output when library formats are empty", () => {
      const outputs = { name: "test" };
      const libOptions = { entry: "index.js", formats: [] as any[] };

      const result = resolveBuildOutputs(outputs, libOptions);

      expect(result).toBe(outputs);
    });

    it("should preserve the configured output when library formats are omitted", () => {
      const outputs = { format: "cjs" as const };
      const libOptions = { entry: "index.js" };

      const result = resolveBuildOutputs(outputs, libOptions);

      expect(result).toBe(outputs);
    });
  });
});
