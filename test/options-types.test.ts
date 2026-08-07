import { describe, expect, it } from "vite-plus/test";
import type { BytecodeOptions } from "../src/index";

function acceptOptions(options: BytecodeOptions): BytecodeOptions {
  return options;
}

describe("BytecodeOptions", () => {
  it("allows Electron paths only for the Electron runtime", () => {
    expect(acceptOptions({})).toEqual({});
    expect(acceptOptions({ runtime: "node" })).toEqual({ runtime: "node" });
    expect(
      acceptOptions({ electronPath: "/path/to/electron", runtime: "electron" })
    ).toEqual({ electronPath: "/path/to/electron", runtime: "electron" });

    // @ts-expect-error electronPath is not valid for the Node runtime.
    const invalidNodeOptions = acceptOptions({
      electronPath: "/path/to/electron",
      runtime: "node",
    });
    expect(invalidNodeOptions).toBeDefined();

    // @ts-expect-error electronPath requires an explicit Electron runtime.
    const invalidImplicitOptions = acceptOptions({
      electronPath: "/path/to/electron",
    });
    expect(invalidImplicitOptions).toBeDefined();
  });
});
