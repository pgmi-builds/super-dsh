import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import test from 'node:test'

/**
 * Plan A of the 2026-11-07 desktop picker report (implemented 2026-11-08):
 * the browse backend row is gated OFF on the desktop profile (the Desktop host
 * ships <NativeDirectoryPicker> and the directoryPicker seam allows exactly
 * one backend — a second registration loses the race and warns on every
 * install/enable). The gate must be a Loader `!!js` expression so every mount
 * decision re-evaluates it, and the surface row must stay ungated (a mounted
 * surface keeps the workspace picker's directory-flow hole occupied and
 * auto-hides without the browse capability).
 */
const require = createRequire(import.meta.url)
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const yaml = require(require.resolve('js-yaml', { paths: [`${repoRoot}upstream/deepseek-harness/apps/cli`] }))

// The Loader's own YAML dialect: the global !!js tag carries the raw expression.
const entryListSchema = yaml.JSON_SCHEMA.extend(new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: (data) => ({ __jsExpr: data }),
}))

const patch = yaml.load(readFileSync(`${repoRoot}super-dsh/cordis.patch.yml`, 'utf8'), { schema: entryListSchema })
const rows = patch[0].insert
const backend = rows.find((row) => row.id === 'directory-picker-browse')
const surface = rows.find((row) => row.id === 'directory-picker-browse-surface')

test('super-dsh patch parses in the Loader dialect', () => {
  assert.ok(Array.isArray(rows) && rows.length > 0)
  assert.ok(backend, 'directory-picker-browse row exists')
  assert.ok(surface, 'directory-picker-browse-surface row exists')
})

test('browse backend is gated OFF on the desktop profile via a Loader !!js expression', () => {
  assert.equal(backend.name, '@deepseek-ai/dsh-host-directory-picker-browse')
  const gate = backend.disabled
  assert.ok(gate && typeof gate === 'object' && '__jsExpr' in gate, 'disabled must be a !!js expression, not a literal')
  assert.match(gate.__jsExpr, /profileContext/)
  assert.match(gate.__jsExpr, /desktop/)
  // Evaluate the expression exactly like vendor/loader config/utils.ts does.
  const evaluate = new Function('ctx', 'expr', 'with (ctx) { return eval(expr) }')
  const desktopCtx = { get: (name) => (name === 'profileContext' ? { name: 'desktop' } : undefined) }
  const webCtx = { get: (name) => (name === 'profileContext' ? { name: 'superd-pub' } : undefined) }
  assert.equal(Boolean(evaluate(desktopCtx, gate.__jsExpr)), true, 'desktop profile: row stays down')
  assert.equal(Boolean(evaluate(webCtx, gate.__jsExpr)), false, 'web/remote profile: row mounts')
})

test('browse surface row stays mounted everywhere (hole occupancy, auto-hide)', () => {
  assert.equal(surface.name, '@deepseek-ai/dsh-client-ui-directory-picker-browse')
  assert.equal(surface.disabled, undefined)
})

test('the auto picker row stays disabled (browse is the only web flow)', () => {
  const auto = patch.find((entry) => entry.id === 'directory-picker' && entry.disabled === true)
  assert.ok(auto, 'the - id: directory-picker / disabled: true override stays')
})
