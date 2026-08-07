import { defineConfig } from "vite-plus";

export default defineConfig({
  // The established integration suite exercises the plugin's Rollup-facing
  // Vite 3–7 contract. Keep its bare `vite` imports on the Vite 7 alias;
  // `test/vite-versions.test.ts` loads the Vite+ core directly for Vite 8.
  resolve: {
    alias: {
      vite: "vite7",
    },
  },
  ssr: {
    // electron-vite is externalized by default, which would make Node resolve
    // its peer to Vite+ core before the alias above can apply.
    noExternal: ["electron-vite"],
  },
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
