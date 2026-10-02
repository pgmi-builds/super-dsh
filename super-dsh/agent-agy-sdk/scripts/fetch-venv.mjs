#!/usr/bin/env node
/**
 * fetch-venv.mjs — eagerly build the durable SDK venv for a world home.
 *
 * The adapter fetches this venv lazily on first real use (src/sdk-venv.ts);
 * this script exists for the two cases where waiting for a first turn is
 * unacceptable: pre-provisioning a machine, and recovering from a recorded
 * failure (`<worldHome>/sdk-venv.error.log`).
 *
 *   node scripts/fetch-venv.mjs [worldHome]
 *
 * worldHome defaults to `$DSH_HOME/agents/agy-sdk` (then `~/.dsh/...`), which
 * is exactly what the world plugin provisions — running it with no argument on
 * a machine whose DSH home is the default pre-warms the right directory.
 *
 * Idempotent: a complete venv short-circuits (no network, no pip).
 */
import { ensureSdkVenv, readSdkVenvRecord, sdkVenvLayout } from "../dist/sdk-venv.js";

const explicit = process.argv[2];
const dshHome = process.env.DSH_HOME;
const worldHome = explicit
  ?? (dshHome !== undefined && dshHome !== ""
    ? `${dshHome}/agents/agy-sdk`
    : `${process.env.HOME ?? ""}/.dsh/agents/agy-sdk`);

const trace = (...parts) => process.stderr.write(`[fetch-venv] ${parts.join(" ")}\n`);

try {
  const python = await ensureSdkVenv(worldHome, { trace });
  const record = readSdkVenvRecord(worldHome);
  console.log(python);
  if (record !== undefined) console.log(`(${record.package}, installed ${record.installedAt})`);
  if (process.env.VERBOSE === "1") console.log(`layout: ${JSON.stringify(sdkVenvLayout(worldHome), null, 2)}`);
} catch (error) {
  // ensureSdkVenv already wrote the durable trace; add the operator-facing line.
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
}
