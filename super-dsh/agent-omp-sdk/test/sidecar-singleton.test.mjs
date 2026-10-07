import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Regression guard for the shared-sidecar singleton inside the pool.
 *
 * History: the omp-web base built one child per acquire cycle, then a re-copy of
 * the adapter from dsh-omp master HEAD applied the OMP_HOME pin as an INSERTION
 * instead of a replacement. Both constructions stayed, so every acquire started
 * a second child (with OMP_HOME unset) and abandoned the first — started,
 * unreferenced, never stopped. That leaked a live ~200 MB bun sidecar per
 * session/settings call (350 spawns in one instance's log, with a 11h orphan).
 *
 * The invariant is deliberately asserted on source, not on a live spawn: the
 * leak was a duplicated construction, and a source check catches exactly that
 * class of edit without booting a 200 MB process per test run. The behavioral
 * half (two sessions ⇒ one child) lives in `sdk-lazy.test.mjs`.
 */
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "src", "sdk-client.ts"), "utf8");

/**
 * The pool body — from `createOmpSdkSidecarPool` to the end of that function.
 * The tail is the `worldHome` field of the returned object literal, which is the
 * last `}` before the next top-level declaration.
 */
function poolBody(text) {
  const start = text.indexOf("export function createOmpSdkSidecarPool(");
  assert.notStrictEqual(start, -1, "sdk-client.ts must still declare the pool factory");
  const end = text.indexOf("\n}\n", text.indexOf("worldHome: options.worldHome", start));
  assert.notStrictEqual(end, -1, "the pool factory must close at column 0");
  return text.slice(start, end + 2);
}

test("the pool constructs the sidecar exactly once", () => {
  const body = poolBody(source);
  const constructions = body.match(/new OmpSdkSidecar\(/g) ?? [];
  assert.strictEqual(
    constructions.length,
    1,
    `the pool must build one child per cycle; found ${constructions.length}:\n${body}`,
  );
});

test("the shared sidecar is pinned to the OMP app home and the world home", () => {
  const body = poolBody(source);
  assert.match(
    body,
    /new OmpSdkSidecar\(\{[\s\S]*?worldHome: options\.worldHome[\s\S]*?env: \{ \.\.\.\(options\.env \?\? \{\}\) \}/,
    "the single construction must carry the world home AND the env pin (OMP_HOME)",
  );
});

test("the pool starts the child it keeps", () => {
  const body = poolBody(source);
  const starts = body.match(/shared\.start\(\)/g) ?? [];
  assert.strictEqual(starts.length, 1, "exactly one start() per construction — no second, abandoned child");
  const observed = body.match(/sharedStart = start;/g) ?? [];
  assert.strictEqual(observed.length, 1, "the pool keeps the ONE start promise (a failure must not leak)");
});
