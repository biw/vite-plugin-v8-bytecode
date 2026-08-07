import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build as viteBuild } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { resolveElectronPath } from "../../src/compiler";
import { bytecodePlugin } from "../../src/index";

/**
 * Everything else in this suite runs the unpackaged Electron binary against a
 * directory or a bare archive. That is not what consumers ship. This packages
 * a real app with electron-builder and runs the result, which is the first
 * time `app.isPackaged` is true and the first time asar integrity metadata
 * exists at all.
 */

const packagerSpecifier = "electron-builder";

/** Just the surface this file uses, so the packager needs no type dependency. */
type ElectronBuilder = {
  Platform: { current: () => { createTarget: (name: string) => unknown } };
  build: (options: {
    config: Record<string, unknown>;
    targets: unknown;
  }) => Promise<unknown>;
};

const projectRequire = createRequire(import.meta.url);
const packagerAvailable = (() => {
  try {
    projectRequire.resolve(packagerSpecifier);
    return true;
  } catch {
    return false;
  }
})();

// Skipping locally is fine; skipping in the job that exists to run these is
// how coverage disappears without anyone noticing.
if (process.env.REQUIRE_PACKAGED_TESTS && !packagerAvailable) {
  throw new Error(
    "electron-builder is not installed but REQUIRE_PACKAGED_TESTS is set."
  );
}

/**
 * Reports through userData rather than an environment variable, because this
 * entry is bundled by Vite, which statically replaces `process.env` reads.
 */
const entrySource = `
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

const answer = [20, 22].reduce((total, value) => total + value, 0);

app.whenReady().then(() => {
  fs.writeFileSync(
    path.join(app.getPath("userData"), "result.json"),
    JSON.stringify({
      answer: answer,
      directory: __dirname,
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
    })
  );
  app.exit(0);
});
`;

type PackagedResult = {
  answer: number;
  directory: string;
  isPackaged: boolean;
  resourcesPath: string;
};

/** Locates the executable inside whatever layout the host platform produced. */
async function findExecutable(outputDirectory: string): Promise<string> {
  const entries = await readdir(outputDirectory, { withFileTypes: true });

  if (process.platform === "darwin") {
    const bundleParent = entries.find((entry) => entry.isDirectory());
    if (!bundleParent) {
      throw new Error(`No output directory in ${outputDirectory}`);
    }
    const bundleDirectory = path.join(outputDirectory, bundleParent.name);
    const bundle = (await readdir(bundleDirectory)).find((name) =>
      name.endsWith(".app")
    );
    if (!bundle) {
      throw new Error(`No .app bundle in ${bundleDirectory}`);
    }
    return path.join(
      bundleDirectory,
      bundle,
      "Contents",
      "MacOS",
      path.basename(bundle, ".app")
    );
  }

  const unpacked = entries.find(
    (entry) => entry.isDirectory() && entry.name.endsWith("unpacked")
  );
  if (!unpacked) {
    throw new Error(`No unpacked directory in ${outputDirectory}`);
  }
  const directory = path.join(outputDirectory, unpacked.name);
  const executable = (await readdir(directory)).find((name) =>
    process.platform === "win32" ? name.endsWith(".exe") : name === "bytecode-fixture"
  );
  if (!executable) {
    throw new Error(`No executable in ${directory}`);
  }
  return path.join(directory, executable);
}

function runPackagedApplication(
  executablePath: string,
  userDataDirectory: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const environment: NodeJS.ProcessEnv = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;

    const args = [`--user-data-dir=${userDataDirectory}`];
    if (process.platform === "linux") {
      // The packaged binary is not setuid, so the sandbox cannot initialize.
      args.push("--no-sandbox");
    }

    const child = spawn(executablePath, args, {
      env: environment,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const stderr: Buffer[] = [];
    let settled = false;

    const settleOnce = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settleOnce(
        new Error(
          `Packaged app did not exit within 60s: ${Buffer.concat(stderr)
            .toString("utf8")
            .trim()}`
        )
      );
    }, 60_000);

    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", settleOnce);
    child.on("close", (exitCode, signal) => {
      if (exitCode !== 0 || signal) {
        settleOnce(
          new Error(
            `Packaged app exited with ${signal ?? `code ${String(exitCode)}`}: ${Buffer.concat(
              stderr
            )
              .toString("utf8")
              .trim()}`
          )
        );
        return;
      }
      settleOnce();
    });
  });
}

/**
 * A default package, and one hardened the way a security-conscious app ships.
 * The hardened case is the interesting one: `EnableEmbeddedAsarIntegrityValidation`
 * makes Electron verify the archive against a hash embedded at package time,
 * and the bytecode lives inside that archive.
 */
const VARIANTS = [
  { fuses: undefined, name: "default", unsupported: false },
  {
    fuses: {
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
      runAsNode: false,
    },
    name: "hardened",
    // Flipping fuses rewrites the binary after electron-builder signs it,
    // which invalidates the signature. macOS on arm64 refuses to launch the
    // result (`code has no resources but signature indicates they must be
    // present`) and kills it with no output. A real app re-signs after
    // flipping fuses; signing is out of scope here, and Linux and Windows do
    // not enforce it, so this variant runs there instead.
    unsupported: process.platform === "darwin",
  },
] as const;

for (const { fuses, name, unsupported } of VARIANTS) {
describe.skipIf(!packagerAvailable || unsupported)(
  `electron-builder packaged app (${name})`,
  () => {
  let workingDirectory: string;
  let result: PackagedResult;
  let archiveContents: string[];

  // Packaged once per variant. Repackaging per assertion would dominate the
  // runtime of this suite for no additional coverage.
  beforeAll(async () => {
    workingDirectory = await mkdtemp(path.join(tmpdir(), "vite-bytecode-pkg-"));
    const appDirectory = path.join(workingDirectory, "app");
    const outputDirectory = path.join(workingDirectory, "out");
    const userDataDirectory = path.join(workingDirectory, "user-data");
    const entryPath = path.join(appDirectory, "src", "main.js");
    const priorNodeEnv = process.env.NODE_ENV;

    try {
      await mkdir(path.dirname(entryPath), { recursive: true });
      await Promise.all([
        writeFile(entryPath, entrySource),
        writeFile(
          path.join(appDirectory, "package.json"),
          JSON.stringify({
            main: "dist/main.js",
            name: "bytecode-fixture",
            type: "module",
            version: "1.0.0",
          })
        ),
      ]);

      process.env.NODE_ENV = "production";
      await viteBuild({
        configFile: false,
        logLevel: "silent",
        plugins: [
          bytecodePlugin({
            electronPath: resolveElectronPath(),
            runtime: "electron",
          }),
        ],
        root: appDirectory,
        build: {
          outDir: path.join(appDirectory, "dist"),
          rollupOptions: {
            external: ["electron", /^node:/],
            input: entryPath,
            output: { entryFileNames: "main.js" },
          },
        },
      });

      // Imported through a variable specifier on purpose: the packager is
      // installed only in the packaging job, so a literal specifier would make
      // `tsc --noEmit` fail everywhere else.
      const { build: packageApp, Platform } = (await import(
        packagerSpecifier
      )) as ElectronBuilder;
      await packageApp({
        targets: Platform.current().createTarget("dir"),
        config: {
          appId: "dev.vitepluginv8bytecode.fixture",
          asar: true,
          directories: { app: appDirectory, output: outputDirectory },
          electronFuses: fuses,
          electronVersion: projectRequire("electron/package.json").version,
          npmRebuild: false,
          // Unsigned on purpose: signing is the packager's concern, and ad hoc
          // signing has tripped platform malware scanners in this repository.
          mac: { identity: null },
        },
      });

      const executablePath = await findExecutable(outputDirectory);
      await runPackagedApplication(executablePath, userDataDirectory);

      result = JSON.parse(
        await readFile(path.join(userDataDirectory, "result.json"), "utf8")
      ) as PackagedResult;

      const asarPath = path.join(
        path.dirname(executablePath),
        process.platform === "darwin" ? "../Resources/app.asar" : "resources/app.asar"
      );
      const { listPackage } = await import("@electron/asar");
      archiveContents = listPackage(path.resolve(asarPath), { isPack: false });
    } finally {
      if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = priorNodeEnv;
    }
  }, 600_000);

  afterAll(async () => {
    // A packaged Electron app is ~286 MB; leaving these behind fills the
    // runner disk within a few matrix cells.
    if (workingDirectory) {
      await rm(workingDirectory, { force: true, recursive: true });
    }
  });

  it("executes bytecode inside the packaged application", () => {
    expect(result.answer).toBe(42);
  });

  it("reports itself as packaged", () => {
    expect(result.isPackaged).toBe(true);
  });

  it("runs its code from inside app.asar", () => {
    expect(result.directory).toContain("app.asar");
  });

  it("ships the bytecode inside the archive rather than beside it", () => {
    expect(archiveContents).toContain(
      path.sep === "\\" ? "\\dist\\main.jsc" : "/dist/main.jsc"
    );
    expect(archiveContents.some((entry) => entry.endsWith("bytecode-loader.cjs"))).toBe(
      true
    );
    expect(archiveContents).toContain(
      path.sep === "\\" ? "\\dist\\package.json" : "/dist/package.json"
    );
  });
  }
);
}
