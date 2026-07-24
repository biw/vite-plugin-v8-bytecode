import { createRequire } from "node:module";

/**
 * Resolve Electron once before Vitest starts parallel workers. Electron's
 * package can lazily restore a missing binary; concurrent first imports race
 * while extracting the same application directory.
 */
export default function setup(): void {
  const projectRequire = createRequire(import.meta.url);
  projectRequire("electron");
}
