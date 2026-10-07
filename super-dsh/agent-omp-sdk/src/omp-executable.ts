/**
 * Locate the operator's `omp` binary — the ONE resolution order the adapter's
 * data plane (`omp-cli.ts`) uses.
 *
 * The SDK line does NOT need this to run its sessions (those live in the
 * fetched bun sidecar), but the model catalog and the `modelRoles` bridge are
 * read through the operator's own binary so the two OMP faces agree on config.
 *
 * Ported verbatim from the RPC line (`@pgmi-builds/agent-omp`, rpc-client.ts):
 * a local copy keeps this package standalone — the task ruling is a complete
 * standalone copy, not a shared-code sibling.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** `$OMP_EXECUTABLE` wins; else PATH, else the common native-installer spots. */
export function resolveOmpExecutable(): string {
  const configured = process.env.OMP_EXECUTABLE?.trim();
  if (configured !== undefined && configured !== "") return configured;
  for (const dir of (process.env.PATH ?? "").split(":").filter(Boolean)) {
    if (existsSync(join(dir, "omp"))) return "omp";
  }
  for (const candidate of [join(homedir(), ".local/bin/omp"), "/usr/local/bin/omp"]) {
    if (existsSync(candidate)) return candidate;
  }
  return "omp";
}
