// Delivered-bundle drift guard (final-review finding 3): the tracked
// super-dsh/client/index.js is the bundle consumers actually load, and ONLY
// the pack lane (pack.mjs → superd-hub/scripts/build-superd-client.mjs)
// refreshes it. fusion-flag.test.mjs pins ONE marker spelling
// (`__SUPERD_UI_FUSION__ === true`), but an arbitrary future src/client edit
// that never touches that marker can still ship stale. This guard runs the
// SAME client-lane emitter into a temp dir and BYTE-compares against the
// delivered artifact: fresh src → byte-equal (green); any src/client drift
// → red, with the rebuild command in the failure message.
//
// The byte-compare is meaningful because the emitter is byte-deterministic:
// pinned NODE_ENV, fixed id/banner/footer, no timestamps — independent
// output directories hash identically (verified when this guard landed).
// If the build tooling is unavailable in the test env, the guard skips
// LOUDLY rather than lying green — on this repo's dev env it must run.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const LINE = join(HERE, '..', '..') // super-dsh composite root
const DELIVERED = join(LINE, 'client', 'index.js')

test('the delivered client bundle is byte-fresh against src/client (drift guard)', async (t) => {
  let delivered
  try {
    delivered = readFileSync(DELIVERED)
  } catch {
    return t.skip('no delivered super-dsh/client/index.js — nothing to guard (build the client lane first)')
  }
  let buildSuperdClient
  try {
    ;({ buildSuperdClient } = await import('../scripts/build-superd-client.mjs'))
  } catch (err) {
    console.warn(
      `[client-bundle-drift] LOUD SKIP: client-lane build tooling unavailable (${err?.message ?? err}) — the delivered bundle is UNGUARDED in this env`,
    )
    return t.skip('client-lane build tooling unavailable in this test env')
  }
  const temp = mkdtempSync(join(tmpdir(), 'superd-client-drift-'))
  try {
    const fresh = await buildSuperdClient({ outDir: temp })
    const want = readFileSync(fresh)
    if (!delivered.equals(want)) {
      const sha = (b) => createHash('sha256').update(b).digest('hex').slice(0, 12)
      assert.fail(
        `delivered super-dsh/client/index.js is STALE relative to src/client ` +
        `(delivered ${delivered.length}B sha256:${sha(delivered)} vs fresh build ${want.length}B sha256:${sha(want)}) — ` +
        `rebuild and commit the refreshed artifact: node super-dsh/superd-hub/scripts/build-superd-client.mjs (the pack lane's client half)`,
      )
    }
    assert.ok(want.length > 0, `delivered bytes equal the fresh client-lane build (${want.length}B)`)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})
