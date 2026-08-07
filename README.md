# vite-plugin-v8-bytecode

[![CI](https://badgen.net/github/checks/biw/vite-plugin-v8-bytecode)](https://github.com/biw/vite-plugin-v8-bytecode/actions)
[![npm version](https://badgen.net/npm/v/vite-plugin-v8-bytecode)](https://www.npmjs.com/package/vite-plugin-v8-bytecode)
[![npm downloads](https://badgen.net/npm/dt/vite-plugin-v8-bytecode)](https://www.npmjs.com/package/vite-plugin-v8-bytecode)

Compile selected Vite CommonJS chunks into runnable V8 cached data for Node.js
and Electron. The plugin uses the target runtime and generates the loader and
entry shims required to execute the result.

## Features

- **No readable copy by default:** Remove the original JavaScript and source
  maps for compiled chunks, or keep them when needed for debugging.
- **Automatic loading:** Generate the bytecode loader and entry shims needed to
  run compiled chunks.
- **Node.js and Electron support:** Compile cached data with the runtime that
  will execute it.
- **Selective compilation:** Compile every generated chunk or select chunks by
  alias.
- **Optional string obfuscation:** Prevent selected literals from appearing in
  basic plaintext scans.
- **Unchanged development workflow:** Skip bytecode compilation outside
  production builds.
- **No package dependencies:** Reuse Vite's parser instead of installing
  separate parsing and source-editing libraries.

## Installation

```bash
npm install --save-dev vite-plugin-v8-bytecode
```

## Node Usage

Add the plugin to your `vite.config.ts`:

```typescript
import { defineConfig } from "vite";
import { bytecodePlugin } from "vite-plugin-v8-bytecode";

export default defineConfig({
  plugins: [bytecodePlugin()],
});
```

For a standard single-output build, the plugin selects CommonJS automatically
when no output format is configured.

## Electron Usage

Add the plugin to your `vite.config.ts`:

```typescript
import { defineConfig } from "electron-vite";
import { bytecodePlugin } from "vite-plugin-v8-bytecode";

export default defineConfig({
  main: {
    plugins: [bytecodePlugin({ runtime: "electron" })],
  },
});
```

`electron-vite` supplies the required main-process build defaults
automatically.

<details>
<summary>Without <code>electron-vite</code></summary>

When calling Vite directly, configure it for an Electron main-process build:

```typescript
import { builtinModules } from "node:module";
import { defineConfig } from "vite";
import { bytecodePlugin } from "vite-plugin-v8-bytecode";

export default defineConfig({
  plugins: [bytecodePlugin({ runtime: "electron" })],
  // Raw Vite builds use browser-oriented defaults. Preserve runtime access to
  // environment variables instead of replacing process.env with an empty object.
  define: {
    "process.env": "process.env",
    "global.process.env": "global.process.env",
    "globalThis.process.env": "globalThis.process.env",
  },
  build: {
    rollupOptions: {
      // Leave Electron and Node builtins for the main process to resolve.
      external: (id) =>
        id === "electron" ||
        id.startsWith("electron/") ||
        id.startsWith("node:") ||
        builtinModules.includes(id),
    },
  },
});
```

The `define` and `external` settings preserve runtime `process.env` access and
leave Electron and Node builtins for the main process to resolve. Without them,
a client-oriented Vite build [externalizes Node builtins for browser
compatibility][vite-node-builtins]. The resulting failure occurs inside the
compiled `.cjsc`, which can make a bundler configuration problem look like a
bytecode problem. Do not replace `process.env` with
`JSON.stringify(process.env)`, which would embed the build machine's
environment and potentially its secrets in the bundle.

</details>

Keep these Electron constraints in mind:

- **Build for each target:** Generate bytecode separately for every target
  platform and CPU architecture, using the same Electron version as the
  packaged application. V8 cached data is not reliably portable between them.
- **Main process only:** Bytecode cannot be used for renderer or preload code:
  - The plugin detects Vite's renderer configuration and disables itself,
    leaving renderer bundles as ordinary JavaScript.
  - Preload scripts cannot load bytecode. Sandboxed preloads cannot reach the
    generated loader, while unsandboxed preloads run in the renderer process,
    where V8 rejects cached data produced by the main process.

## Configuration

### Selective Compilation

Compile only specific chunks:

```typescript
bytecodePlugin({
  chunkAlias: ["index", "main"], // Only compile these chunks
});
```

### String Obfuscation

Prevent selected ordinary string literals from appearing verbatim in generated
bytecode:

```typescript
bytecodePlugin({
  obfuscatedStrings: ["internal-protocol-v1", "diagnostic-marker"],
});
```

Eligible exact matches in `obfuscatedStrings` are converted to
`String.fromCharCode()` calls before bytecode compilation. This defeats a
casual plaintext scan of the bytecode file, but it is reversible obfuscation,
not encryption or secret storage. Anyone who can inspect or execute the
application can recover the value.

Never use this option for API keys, access tokens, passwords, private keys,
connection strings, or other credentials. Supply server-side secrets at
runtime through environment variables or a secrets manager. A distributed
Electron application cannot safely contain a secret that its users must not
recover.

String obfuscation also has deliberate limits:

- It handles matching ordinary string literals and static untagged template
  literals. Module paths, property and method keys, computed member properties,
  and tagged templates are left unchanged where rewriting could affect program
  behavior.
- Other strings, identifiers, and metadata can remain visible in the bytecode.
- Reconstruction happens whenever the transformed expression is evaluated.
  A few module-level values are inexpensive, but large values or literals in
  hot functions add bytecode size, allocations, and runtime work.

## Limitations

- **CommonJS only:** The plugin only supports CommonJS output. ES modules cannot
  be compiled to bytecode.
- **Production only:** The plugin is disabled when
  `NODE_ENV !== "production"`.
- **Function source is unavailable:** `Function.prototype.toString()` cannot
  recover the original source of functions loaded from bytecode. Libraries
  that inspect or recompile functions from their source may not work.
- **Runtime-specific bytecode:** Node and Electron bytecode are not
  interchangeable. Electron applications use `runtime: "electron"` and do not
  need a separate Node bytecode build. Node applications use the default
  runtime and must be built with the Node version that will execute the output.

## Security Limits

Bytecode distribution can discourage casual source inspection, but it does not
create a security boundary:

- **Not encryption:** V8 cached data can be inspected and analyzed with
  V8-aware tooling.
- **Assume host control:** A user who controls the machine running a Node or
  Electron application can inspect its files and instrument its runtime
  behavior.

## License

MIT
