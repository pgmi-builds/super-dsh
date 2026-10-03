#!/usr/bin/env node
/**
 * package-contract.test.mjs — the delivery-manifest guard for the opt-in SDK row.
 *
 * This package is the reason the RPC round saved ~838 MB: it must stay
 * installable with ZERO runtime dependency. The user ruling (spec §2.5) is
 * blunt — no `@oh-my-pi/*`, no `bun`, no postinstall, no optionalDependencies.
 * Everything is checked on the manifest AND on the built tree, because a stray
 * `import` from a shipped file is how the dependency would really come back.
 *
 * The one deliberate exception is our OWN `sidecar/main.ts`: it imports
 * `@oh-my-pi/pi-coding-agent`, but that file is never executed from this
 * package — the runtime bootstrap copies it into the fetched runtime dir, where
 * the package finally exists. So the assertion below is scoped to dependency
 * maps and to the non-sidecar compiled sources.
 */
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
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

test("no dependency map carries an SDK/bun package", () => {
  for (const key of DEPENDENCY_MAPS) {
    const map = manifest[key];
    if (map === undefined) continue;
    for (const name of Object.keys(map)) {
      assert.doesNotMatch(name, /@oh-my-pi|\bbun\b/, `${key}.${name} must not be declared`);
    }
  }
});

test("dependencies is empty and there is no optionalDependencies", () => {
  assert.deepEqual(manifest.dependencies, {}, "dependencies must stay empty");
  assert.equal(manifest.optionalDependencies, undefined, "no optionalDependencies");
});

test("no install hook exists (no postinstall / preinstall / install)", () => {
  for (const hook of ["postinstall", "preinstall", "install", "prepare"]) {
    assert.equal(manifest.scripts?.[hook], undefined, `scripts.${hook} must not exist`);
  }
});

test("the whole manifest mentions no @oh-my-pi or bun", () => {
  const text = readFileSync(join(root, "package.json"), "utf8");
  // The description may name the runtime; the dependency surface may not.
  assert.doesNotMatch(text, /"@oh-my-pi\//, "no @oh-my-pi package id in the manifest");
  assert.doesNotMatch(text, /"bun"/, "no bun package id in the manifest");
});

test("the package ships the sidecar and the world entry, and no client half", () => {
  assert.deepEqual(manifest.exports, {
    ".": "./dist/index.js",
    "./world": "./dist/world-plugin.js",
  });
  assert.ok(manifest.files.includes("sidecar"), "`sidecar` is part of the tarball");
  assert.ok(manifest.files.includes("dist"), "`dist` is part of the tarball");
  assert.equal(manifest.dsh?.client, undefined, "a pure data-plane world ships no client half");
  assert.equal(existsSync(join(root, "tsconfig.client.json")), false, "no client tsconfig");
});

test("sidecar/ holds only the sidecar entrypoint", () => {
  const entries = readdirSync(join(root, "sidecar"));
  assert.deepEqual(entries, ["main.ts"], "the pack manifest ships exactly agent-omp-sdk/sidecar");
});

test("the built tree has no client subtree and imports no SDK package outside sidecar/", () => {
  assert.equal(existsSync(join(root, "dist", "client")), false, "dist/ must carry no client tree");
  assert.equal(existsSync(join(root, "dist", "mobile", "client")), false, "dist/mobile must carry no client tree");

  const sdkImport = /from\s+"@oh-my-pi\/|require\("@oh-my-pi\//;
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
