#!/usr/bin/env node
/**
 * fetch-sdk-runtime.mjs — eagerly warm the durable SDK runtime for a world home.
 *
 * The adapter fetches this runtime lazily on the first real prompt
 * (src/sdk-runtime.ts); this script exists for the two cases where waiting for
 * a first turn is unacceptable: pre-provisioning a machine, and recovering from
 * a recorded failure (`<worldHome>/sdk-runtime.error.log`).
 *
 *   node scripts/fetch-sdk-runtime.mjs [<home>]
 *
 * `<home>` is the DSH/SUPERD home (default: `$DSH_HOME`, then
 * `$SUPERD_HOME_DIR`); the world home is `<home>/agents/omp-sdk`, exactly what
 * the world plugin provisions. There is deliberately NO default to `~/.dsh`:
 * this is a dev/test tool and it refuses any home outside this repository's
 * `.tests` tree — the same red line the launcher enforces (repo AGENTS §〇).
 *
 * Idempotent: a complete, matching runtime short-circuits (no network, no bun).
 */
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createSdkRuntimeDeps, ensureSdkRuntime, sdkRuntimeLayout } from "../dist/sdk-runtime.js";
const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = resolve(here, "..");
const repoRoot = resolve(pluginDir, "..", "..");
const testsRoot = resolve(repoRoot, ".tests");

const home = process.argv[2] ?? process.env.DSH_HOME ?? process.env.SUPERD_HOME_DIR;
if (home === undefined || home === "") {
  console.error(
    "refusing: pass a DSH home as argv[2] or set DSH_HOME / SUPERD_HOME_DIR " +
    "(no default — ~/.dsh is a prod home)",
  );
  process.exit(2);
}
const dshHome = resolve(home);
if (dshHome !== testsRoot && !dshHome.startsWith(testsRoot + sep)) {
  console.error(`refusing: DSH home ${dshHome} is outside ${testsRoot} (repo red line)`);
  process.exit(1);
}
const worldHome = resolve(dshHome, "agents", "omp-sdk");


try {
  // ONE implementation shared with the adapter's first-prompt fetch: the
  // builder lives in the module, so this script cannot drift from it.
  const record = await ensureSdkRuntime(
    worldHome,
    createSdkRuntimeDeps(pluginDir),
  );
  console.log(JSON.stringify(record, null, 2));
  if (process.env.VERBOSE === "1") {
    console.log(`layout: ${JSON.stringify(sdkRuntimeLayout(worldHome), null, 2)}`);
  }
} catch (error) {
  // ensureSdkRuntime already wrote the durable trace; add the operator-facing line.
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
}
