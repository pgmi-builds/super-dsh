#!/usr/bin/env node
/**
 * package-contract.test.mjs — the delivery-manifest guard for the PRIMARY
 * app-server line.
 *
 * The 2026-10-06 user ruling (amending 2026-10-05): the exact-pin
 * `@openai/codex` package must NEVER ride the installation. 0.1.11 shipped it
 * as a real `dependencies` entry and every registry consumer downloaded the
 * pinned CLI binary package plus its six aliased platform binaries
 * (linux-x64/arm64, darwin-x64/arm64, win32-x64/arm64) at install time. The
 * runtime is discovered (CODEX_BIN → PATH CLI → desktop) and only lazily
 * fetched into the world home when all three miss (src/codex-runtime-fetch.ts).
 *
 * The guard checks the manifest AND the built tree, because a stray `import`
 * from a shipped file is how the dependency would really come back (the TS
 * side can look clean while a compiled `dist/*.js` still imports the package).
 * @openai is matched by substring so a renamed-but-equivalent entry cannot
 * slip back in either.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const DEPENDENCY_MAPS = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "devDependencies",
];

test("no dependency map carries an @openai or codex package", () => {
  for (const key of DEPENDENCY_MAPS) {
    const map = manifest[key];
    if (map === undefined) continue;
    for (const name of Object.keys(map)) {
      assert.doesNotMatch(name, /@openai\/|codex/i, `${key}.${name} must not be declared`);
    }
  }
});

test("no install hook exists (no postinstall / preinstall / install / prepare)", () => {
  for (const hook of ["postinstall", "preinstall", "install", "prepare"]) {
    assert.equal(manifest.scripts?.[hook], undefined, `scripts.${hook} must not exist`);
  }
});

test("the manifest keeps the runtime fetch command and ships its script", () => {
  assert.equal(manifest.scripts?.["fetch-codex-runtime"], "node scripts/fetch-codex-runtime.mjs");
  assert.ok(manifest.files.includes("scripts"), "`scripts` is part of the tarball");
  assert.ok(manifest.files.includes("dist"), "`dist` is part of the tarball");
  assert.equal(manifest.dsh?.bundle?.patch, "./cordis.patch.yml");
});

test("the built tree imports no @openai package from any shipped file", () => {
  const dist = join(root, "dist");
  assert.ok(existsSync(dist), "dist/ must exist — run `npm run build` before the tests");

  // Only a bare-specifier import/require counts: the fetch module legitimately
  // carries the package NAME as a plain string (the npm spec it installs, and
  // the on-disk layout it resolves), while a real import is what would
  // reintroduce the dependency.
  const codexImport = /from\s+["']@openai\/|require\(\s*["']@openai\/|import\(\s*["']@openai\//;
  const walk = (relative) => {
    const dir = join(root, relative);
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const next = join(relative, entry.name);
      if (entry.isDirectory()) walk(next);
      else if (entry.name.endsWith(".js")) {
        assert.doesNotMatch(readFileSync(join(root, next), "utf8"), codexImport, `${next} must not import a codex package`);
      }
    }
  };
  walk("dist");
});
