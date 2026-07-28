import { defineConfig } from "vitest/config";

/**
 * Packaging tests are opt-in. They need a packager installed and take minutes
 * rather than seconds, so the default config excludes them and this config
 * runs them on their own.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    globalSetup: ["./test/global-setup.ts"],
    include: ["test/packaged/**/*.test.ts"],
    // Packaging dominates; the assertions themselves are instant.
    hookTimeout: 900_000,
    testTimeout: 60_000,
  },
});
