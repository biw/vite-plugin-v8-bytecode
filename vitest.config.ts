import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    globalSetup: ["./test/global-setup.ts"],
    // Packaging is slow and needs a packager installed, so it is opt-in via
    // `pnpm test:packaged` rather than running inside every Node matrix cell.
    exclude: ["**/node_modules/**", "test/packaged/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: ["**/node_modules/**", "**/dist/**", "**/test/**"],
    },
  },
});
