import { describe, it, expect } from "vitest";
import { getBytecodeLoaderCode } from "../src/loader";

describe("Bytecode Loader", () => {
  describe("getBytecodeLoaderCode", () => {
    it("should generate loader code as a string", () => {
      const loaderCode = getBytecodeLoaderCode();

      expect(typeof loaderCode).toBe("string");
      expect(loaderCode.length).toBeGreaterThan(0);
    });

    it("should include use strict directive", () => {
      const loaderCode = getBytecodeLoaderCode();

      expect(loaderCode).toContain('"use strict"');
    });

    it("should require necessary modules", () => {
      const loaderCode = getBytecodeLoaderCode();

      expect(loaderCode).toContain('require("fs")');
      expect(loaderCode).toContain('require("path")');
      expect(loaderCode).toContain('require("vm")');
      expect(loaderCode).toContain('require("v8")');
      expect(loaderCode).toContain('require("module")');
    });

    it("should set V8 flags", () => {
      const loaderCode = getBytecodeLoaderCode();

      expect(loaderCode).toContain('setFlagsFromString("--no-lazy")');
      expect(loaderCode).toContain('setFlagsFromString("--no-flush-bytecode")');
    });

    it("should define required constants", () => {
      const loaderCode = getBytecodeLoaderCode();

      expect(loaderCode).toContain("FLAG_HASH_OFFSET");
      expect(loaderCode).toContain("SOURCE_HASH_OFFSET");
    });

    it("should define setFlagHashHeader function", () => {
      const loaderCode = getBytecodeLoaderCode();

      expect(loaderCode).toContain("function setFlagHashHeader");
      expect(loaderCode).toContain("produceCachedData: true");
      expect(loaderCode).toContain("script.cachedData");
    });

    it("should define getSourceHashHeader function", () => {
      const loaderCode = getBytecodeLoaderCode();

      expect(loaderCode).toContain("function getSourceHashHeader");
      expect(loaderCode).toContain("bytecodeBuffer.slice");
    });

    it("should define buffer2Number function", () => {
      const loaderCode = getBytecodeLoaderCode();

      expect(loaderCode).toContain("function buffer2Number");
      expect(loaderCode).toContain("buffer[3] << 24");
      expect(loaderCode).toContain("buffer[2] << 16");
      expect(loaderCode).toContain("buffer[1] << 8");
      expect(loaderCode).toContain("buffer[0]");
    });

    it("should register .jsc extension handler", () => {
      const loaderCode = getBytecodeLoaderCode();

      expect(loaderCode).toContain('Module._extensions[".jsc"]');
    });

    it("should register .cjsc extension handler", () => {
      const loaderCode = getBytecodeLoaderCode();

      expect(loaderCode).toContain('Module._extensions[".cjsc"]');
    });

    it("should read bytecode from file", () => {
      const loaderCode = getBytecodeLoaderCode();

      expect(loaderCode).toContain("fs.readFileSync(filename)");
      expect(loaderCode).toContain("Buffer.isBuffer");
    });

    it("should create dummy code with zero-width spaces", () => {
      const loaderCode = getBytecodeLoaderCode();

      expect(loaderCode).toContain("\\u200b");
      expect(loaderCode).toContain("repeat(length - 2)");
    });

    it("should create vm.Script with cached data", () => {
      const loaderCode = getBytecodeLoaderCode();

      expect(loaderCode).toContain("new vm.Script(dummyCode");
      expect(loaderCode).toContain("cachedData: bytecodeBuffer");
    });

    it("should check for cachedDataRejected", () => {
      const loaderCode = getBytecodeLoaderCode();

      expect(loaderCode).toContain("script.cachedDataRejected");
      expect(loaderCode).toContain(
        "Invalid or incompatible cached data (cachedDataRejected)"
      );
    });

    it("should setup module require function", () => {
      const loaderCode = getBytecodeLoaderCode();

      expect(loaderCode).toContain("const require = function (id)");
      expect(loaderCode).toContain("module.require(id)");
    });

    it("should setup require.resolve", () => {
      const loaderCode = getBytecodeLoaderCode();

      expect(loaderCode).toContain("require.resolve");
      expect(loaderCode).toContain("Module._resolveFilename");
    });

    it("should run script in this context", () => {
      const loaderCode = getBytecodeLoaderCode();

      expect(loaderCode).toContain("runInThisContext");
      expect(loaderCode).toContain("displayErrors: true");
    });

    it("should apply compiled wrapper with correct arguments", () => {
      const loaderCode = getBytecodeLoaderCode();

      expect(loaderCode).toContain("compiledWrapper.apply");
      expect(loaderCode).toContain("module.exports");
      expect(loaderCode).toContain("filename"); // parameter name, not __filename
      expect(loaderCode).toContain("dirname"); // from path.dirname
      expect(loaderCode).toContain("process");
      expect(loaderCode).toContain("global");
    });

    it("should be valid JavaScript", () => {
      const loaderCode = getBytecodeLoaderCode();

      // Should not throw when parsing
      expect(() => {
        new Function(loaderCode);
      }).not.toThrow();
    });

    it("should end with newline", () => {
      const loaderCode = getBytecodeLoaderCode();

      expect(loaderCode.endsWith("\n")).toBe(true);
    });
  });
});
