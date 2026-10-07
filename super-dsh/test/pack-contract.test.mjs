#!/usr/bin/env node
/**
 * pack-contract.test.mjs — the PACK-LEVEL clean-install guard (2026-10-06).
 *
 * `super-dsh` is the single thing registry consumers install, so it is the
 * place an install-time binary download can hide: a dependency that ships
 * native binaries (or any lifecycle hook anywhere in the embedded plugin
 * manifests) drags megabytes in at `install` time and can even surface
 * pnpm's build-script approval prompts. 0.1.11 regressed exactly this way —
 * `"@openai/codex": "0.160.0"` rode the root `dependencies` and every consumer
 * downloaded six platform binaries (linux-x64/arm64, darwin-x64/arm64,
 * win32-x64/arm64). This guard makes that class of regression a test failure:
 *
 *   - NO manifest in the pack (root + every component and agent-* package + superd-hub/) carries
 *     an install lifecycle hook (postinstall / preinstall / install /
 *     prepare / allow-build style scripts).
 *   - NO dependency map anywhere declares `@openai/codex` or
 *     `@openai/codex-sdk` (or any platform-aliased variant) — those are
 *     runtime-fetch territory (`agent-codex/src/codex-runtime-fetch.ts`,
 *     `agent-codex-sdk/src/sdk-runtime.ts`).
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const INSTALL_HOOKS = ["preinstall", "install", "postinstall", "prepare"];
const FORBIDDEN_RUNTIME_DEPS = /@openai\/codex(-sdk)?($|@|\/|-)/;
const DEPENDENCY_MAPS = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "devDependencies",
];

function packManifests() {
  const paths = [join(packRoot, "package.json")];
  for (const entry of readdirSync(packRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    // Installed trees and scratch output are consumers, not the delivery.
    if (entry.name === "node_modules" || entry.name === ".scratch" || entry.name.startsWith(".")) continue;
    const candidate = join(packRoot, entry.name, "package.json");
    if (existsSync(candidate)) paths.push(candidate);
  }
  return paths;
}

test("no manifest in the pack carries an install lifecycle hook", () => {
  for (const path of packManifests()) {
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    for (const hook of INSTALL_HOOKS) {
      assert.equal(
        manifest.scripts?.[hook],
        undefined,
        `${hook} must not exist in ${path} — installs stay clean, binaries are fetched at runtime`,
      );
    }
  }
});

test("no dependency map in the pack declares a codex binary/SDK package", () => {
  for (const path of packManifests()) {
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    for (const map of DEPENDENCY_MAPS) {
      for (const name of Object.keys(manifest[map] ?? {})) {
        assert.doesNotMatch(
          name,
          FORBIDDEN_RUNTIME_DEPS,
          `${map}.${name} in ${path} must not be declared — fetch it at runtime into the world home`,
        );
      }
    }
  }
});

test("the pack root carries only pure-JS runtime dependencies", () => {
  const manifest = JSON.parse(readFileSync(join(packRoot, "package.json"), "utf8"));
  // The 0.1.11 incident list: everything here ships a native binary through
  // aliased optionalDependencies. Any new entry must be pure JavaScript.
  assert.equal(manifest.dependencies?.["@openai/codex"], undefined);
  assert.equal(manifest.dependencies?.["@openai/codex-sdk"], undefined);
  assert.equal(manifest.optionalDependencies, undefined, "no optionalDependencies at the pack root");
});
