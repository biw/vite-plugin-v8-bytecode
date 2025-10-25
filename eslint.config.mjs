// @ts-check
import globals from "globals";

import eslint from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  globalIgnores(["**/dist/**/*"]),
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ["**/*.cjs", "**/*.js", "**/*.ts", "**/*.mjs"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ["**/*.test.ts", "test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  }
);
