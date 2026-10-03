// Package contract: agent-claude must not depend on @anthropic-ai/claude-agent-sdk
// anywhere in its dependency face, and no emitted bundle or TypeScript source may
// name it as a module specifier. The SDK is fetched at runtime into the world home
// (src/sdk-runtime.ts); a source-level import would make `tsc` need the package,
// which is exactly what the zero-dep decision forbids. The string constant
// SDK_PACKAGE in sdk-runtime.ts is data, not a specifier, and is intentionally allowed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const SDK = "@anthropic-ai/claude-agent-sdk";

// Bare specifier: static `from "…"`, side-effect `import "…"`, dynamic
// `import("…")` or `require("…")` — including subpaths.
const SDK_SPECIFIER =
  /(?:from\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']@anthropic-ai\/claude-agent-sdk(?:\/[^"']*)?["']/;

/** Every file under `dir` (recursively) whose path passes `predicate`. */
function filesUnder(dir, predicate) {
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (predicate(full)) out.push(full);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

test("package.json declares no claude-agent-sdk anywhere", () => {
  const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
  for (const section of ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"]) {
    assert.equal(pkg[section]?.[SDK], undefined, section);
  }
});

test("emitted dist never names the SDK as a module specifier", () => {
  const dist = join(pkgRoot, "dist");
  assert.ok(existsSync(dist), "dist/ is missing — build before testing");
  const files = filesUnder(dist, (f) => f.endsWith(".js"));
  assert.ok(files.length > 0, "dist/ contains no .js files");
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    assert.ok(!SDK_SPECIFIER.test(src), f);
  }
});

test("src never names the SDK as a module specifier", () => {
  const src = join(pkgRoot, "src");
  assert.ok(existsSync(src), "src/ is missing");
  const files = filesUnder(src, (f) => f.endsWith(".ts"));
  assert.ok(files.length > 0, "src/ contains no .ts files");
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    assert.ok(!SDK_SPECIFIER.test(text), f);
  }
});
