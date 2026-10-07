// Test-only ESM loader hook.
//
// `resolveOmpExecutable()` probes two absolute candidates that cannot be steered
// through the environment (`~/.local/bin/omp`, `/usr/local/bin/omp`). This hook
// lets a test child process observe a *pretend* filesystem for `existsSync`,
// so those branches are pinned deterministically without requiring the host to
// have anything installed at a machine-specific system path.
//
// It is inert unless FS_ISOLATION is set in the child's environment, so it can
// never affect a normal test run.
import { createRequire } from "node:module";

const REQUIRE_FROM = new URL("./fs-isolation-hook.mjs", import.meta.url).href;
const MOCK_URL = "mock-fs:fs";

export async function resolve(specifier, context, next) {
  if (specifier === "node:fs" && process.env.FS_ISOLATION === "1") {
    return { url: MOCK_URL, shortCircuit: true, format: "module" };
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url === MOCK_URL) {
    return {
      format: "module",
      shortCircuit: true,
      source: [
        `import { createRequire } from "node:module";`,
        `const require = createRequire(${JSON.stringify(REQUIRE_FROM)});`,
        `const real = require("node:fs");`,
        `const hits = new Set(JSON.parse(process.env.FS_ISOLATION_HITS ?? "[]"));`,
        `const patched = Object.create(real);`,
        `patched.existsSync = (p) => hits.has(String(p));`,
        `export const existsSync = patched.existsSync;`,
        `export default patched;`,
      ].join("\n"),
    };
  }
  return next(url, context);
}
