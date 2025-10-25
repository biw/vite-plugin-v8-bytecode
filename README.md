# vite-plugin-v8-bytecode

[![npm version](https://badgen.net/npm/v/vite-plugin-v8-bytecode)](https://www.npmjs.com/package/vite-plugin-v8-bytecode)
[![npm downloads](https://badgen.net/npm/dt/vite-plugin-v8-bytecode)](https://www.npmjs.com/package/vite-plugin-v8-bytecode)

A Vite plugin that compiles JavaScript to V8 bytecode for Node.js and Electron applications, protecting your source code while maintaining performance.

## Features

- 🔒 **Source Code Protection** - Compiles JavaScript to V8 bytecode, making reverse engineering significantly harder
- ⚡ **Native Performance** - Uses Node.js's built-in `vm.Script` API for bytecode generation
- 🎯 **Selective Compilation** - Choose specific chunks to compile or compile everything
- 🔐 **String Obfuscation** - Extra protection layer for sensitive strings (API keys, tokens)
- 🚀 **Zero Runtime Overhead** - Bytecode executes directly in V8
- 📦 **Works with Node.js & Electron** - Compatible with both runtimes
- 🛠️ **Production Only** - Automatically disabled in development for faster builds

## Requirements

- Node.js 22 or newer
- Vite 3.0+
- CommonJS output format (CJS)

## Installation

```bash
# npm
npm install vite-plugin-v8-bytecode --save-dev

# yarn
yarn add vite-plugin-v8-bytecode --dev

# pnpm
pnpm add vite-plugin-v8-bytecode -D
```

## Usage

### Basic Setup

Add the plugin to your `vite.config.ts`:

```typescript
import { defineConfig } from "vite";
import { bytecodePlugin } from "vite-plugin-v8-bytecode";

export default defineConfig({
  plugins: [bytecodePlugin()],
  build: {
    rollupOptions: {
      output: {
        format: "cjs", // Required: bytecode only works with CommonJS
      },
    },
  },
});
```

### Selective Compilation

Compile only specific chunks:

```typescript
bytecodePlugin({
  chunkAlias: ["index", "main"], // Only compile these chunks
});
```

### String Protection

Obfuscate sensitive strings for additional security:

```typescript
bytecodePlugin({
  protectedStrings: [
    "YOUR_API_KEY",
    "SECRET_TOKEN",
    "mongodb://connection-string",
  ],
});
```

Strings in `protectedStrings` will be converted to `String.fromCharCode()` calls before bytecode compilation, making them harder to extract even from bytecode.

### Keep Original JS Files

By default, original `.js` files are removed. To keep them for debugging:

```typescript
bytecodePlugin({
  removeBundleJS: false, // Keep original JS files (prefixed with _)
});
```

### Complete Example

```typescript
import { defineConfig } from "vite";
import { bytecodePlugin } from "vite-plugin-v8-bytecode";

export default defineConfig({
  plugins: [
    bytecodePlugin({
      chunkAlias: ["index"], // Compile only the index chunk
      protectedStrings: ["MY_API_KEY"], // Protect sensitive strings
      removeBundleJS: true, // Remove original JS after compilation
    }),
  ],
  build: {
    rollupOptions: {
      output: {
        format: "cjs",
      },
    },
  },
});
```

## API Reference

### `bytecodePlugin(options?)`

Creates a Vite plugin that compiles JavaScript to V8 bytecode.

#### Options

```typescript
interface BytecodeOptions {
  /**
   * Specify which chunks to compile to bytecode.
   * If not specified or empty array, all chunks will be compiled.
   * @default []
   */
  chunkAlias?: string | string[];

  /**
   * Whether to remove the original .js files after compilation.
   * If false, original files are kept with an underscore prefix.
   * @default true
   */
  removeBundleJS?: boolean;

  /**
   * Array of strings to protect by obfuscating them with String.fromCharCode.
   * Useful for sensitive strings like API keys or tokens.
   * @default []
   */
  protectedStrings?: string[];
}
```

## How It Works

1. **Build Process**: During Vite's build process, the plugin intercepts your JavaScript output
2. **String Protection** (optional): Transforms protected strings into `String.fromCharCode()` calls using Babel
3. **Bytecode Compilation**: Compiles the JavaScript to V8 bytecode using Node.js's `vm.Script` API
4. **Loader Injection**: Injects a bytecode loader that registers `.jsc` file handlers
5. **Output**: Generates `.jsc` (JavaScript Compiled) files instead of or alongside `.js` files

### File Structure

After building, you'll see:

```
dist/
├── index.js          # Entry point that loads bytecode
├── index.jsc         # Compiled bytecode
├── bytecode-loader.cjs # Bytecode loader runtime
└── _index.js         # Original JS (if removeBundleJS: false)
```

The entry point (`index.js`) contains minimal code:

```javascript
"use strict";
require("./bytecode-loader.cjs");
require("./index.jsc");
```

## Bytecode Loader

The plugin automatically injects a bytecode loader (`bytecode-loader.cjs`) that:

- Registers handlers for `.jsc` and `.cjsc` file extensions
- Sets proper V8 flags (`--no-lazy`, `--no-flush-bytecode`)
- Validates and loads bytecode into the V8 engine
- Handles module exports and requires correctly

## Limitations

- **CommonJS Only**: The plugin only supports CommonJS output format. ES modules are not supported for bytecode compilation.
- **Production Only**: Automatically disabled in development mode (when `NODE_ENV !== 'production'`)
- **Not for Renderer**: Cannot be used with Vite's renderer configuration in Electron apps
- **V8 Version Compatibility**: Bytecode is V8 version-specific. Bytecode compiled with Node.js 22 may not work with older versions.

## Security Considerations

While bytecode compilation makes reverse engineering significantly harder, it's not a silver bullet:

- **Not Encryption**: Bytecode can still be analyzed with specialized tools
- **V8 Internals**: Anyone with deep V8 knowledge could potentially reverse engineer
- **Additional Layers**: Combine with other security measures (obfuscation, minification, server-side logic)
- **String Protection**: Use `protectedStrings` for an extra layer on sensitive data

## Inspiration

This plugin is inspired by:

- [bytenode](https://github.com/bytenode/bytenode) - The original bytecode compiler for Node.js
- [electron-vite bytecode plugin](https://github.com/alex8088/electron-vite) - Electron-specific implementation
- [v8-compile-cache](https://www.npmjs.com/package/v8-compile-cache) - V8 bytecode caching approach

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Support

For issues, questions, or feature requests, please [open an issue](https://github.com/biw/vite-plugin-v8-bytecode/issues) on GitHub.
