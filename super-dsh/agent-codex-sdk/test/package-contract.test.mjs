#!/usr/bin/env node
/**
 * package-contract.test.mjs — the delivery-manifest guard for the opt-in SDK row.
 *
 * The 2026-10-04 user ruling is blunt: the Codex SDK line declares NO dependency
 * at all — not a dependency, not an optionalDependency and not a peer — and
 * ships NO install hook. The runtime is fetched into the world home on first
 * real use (src/sdk-runtime.ts). The guard therefore checks the manifest AND
 * the built tree, because a stray `import` from a shipped file is how the
 * dependency would really come back (the TS side can look clean while a
 * compiled `dist/*.js` still imports the package).
 *
 * @openai is the package scope under test; "no codex package" is enforced with
 * a substring match so a renamed-but-equivalent entry (codex, codex-sdk, …)
 * cannot slip back in either.
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

test("dependencies is empty and there is no optionalDependencies", () => {
  assert.deepEqual(manifest.dependencies, {}, "dependencies must stay empty");
  assert.equal(manifest.optionalDependencies, undefined, "no optionalDependencies");
});

test("no install hook exists (no postinstall / preinstall / install / prepare)", () => {
  for (const hook of ["postinstall", "preinstall", "install", "prepare"]) {
    assert.equal(manifest.scripts?.[hook], undefined, `scripts.${hook} must not exist`);
  }
});

test("the whole manifest mentions no @openai package id", () => {
  const text = readFileSync(join(root, "package.json"), "utf8");
  // The description may NAME the runtime in prose; a package id may not appear.
  assert.doesNotMatch(text, /"@openai\//, "no @openai package id in the manifest");
});

test("the manifest keeps the SDK fetch command and ships its script", () => {
  assert.equal(manifest.scripts?.["fetch-sdk-runtime"], "node scripts/fetch-sdk-runtime.mjs");
  assert.ok(manifest.files.includes("scripts"), "`scripts` is part of the tarball");
  assert.ok(manifest.files.includes("dist"), "`dist` is part of the tarball");
  assert.equal(manifest.dsh?.bundle?.patch, "./cordis.patch.yml");
});

test("the built tree imports no @openai package from any shipped file", () => {
  const dist = join(root, "dist");
  assert.ok(existsSync(dist), "dist/ must exist — run `npm run build` before the tests");

  // Only a bare-specifier import/require counts: the runtime module legitimately
  // carries the package NAME as a plain string (the npm spec it installs, and
  // the on-disk layout it resolves), while a real import is what would
  // reintroduce the dependency.
  const sdkImport = /from\s+["']@openai\/|require\(\s*["']@openai\/|import\(\s*["']@openai\//;
  const walk = (relative) => {
    const dir = join(root, relative);
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const next = join(relative, entry.name);
      if (entry.isDirectory()) walk(next);
      else if (entry.name.endsWith(".js")) {
        assert.doesNotMatch(readFileSync(join(root, next), "utf8"), sdkImport, `${next} must not import the SDK`);
      }
    }
  };
  walk("dist");
});
