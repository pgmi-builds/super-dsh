// seed-claude-providers.mjs — test rigging (spec §2.4): the two providers the
// 4999 pack line's claude world home is expected to hold for acceptance runs.
//
//   node seed-claude-providers.mjs <worldHome>   (worldHome = <lineHome>/agents/claude)
//
// Keys come from the ENVIRONMENT only — DEEPSEEK_API_KEY (apiKey) and
// ZAI_PLAN_API_KEY (authToken); the launcher feeds them from the line home's
// `.env` copy. Nothing is hardcoded. A missing key SKIPS that provider with a
// stderr note and the script still exits 0: a keyless machine must boot the
// line unchanged (skip, never fail). worldHome always comes from argv — this
// script never reads DSH_HOME and never has a default path.
//
// Idempotent: the store API is imported straight from the adapter's build
// (`../agent-claude/dist/claude-providers.js`), so `upsertProvider` replaces
// the entries in place (never duplicates) and `writeProviderStore` keeps the
// rewrite atomic and 0600. Re-running with the same keys is a byte-identical
// no-op on the document.
import { readProviderStore, upsertProvider, writeProviderStore } from '../agent-claude/dist/claude-providers.js'

const TAG = 'seed-claude-providers'

const worldHome = process.argv[2]
if (worldHome === undefined || worldHome.trim() === '') {
  console.error(`usage: node seed-claude-providers.mjs <worldHome>`)
  process.exit(1)
}

// The acceptance seed list, in store order. `auth.value` is filled from `envKey`
// — the placeholder is never written, because a seed without a key is skipped.
const SEEDS = [
  {
    envKey: 'DEEPSEEK_API_KEY',
    entry: {
      id: 'deepseek',
      label: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/anthropic',
      auth: { kind: 'apiKey', value: '' },
      models: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }],
      origin: 'user',
    },
  },
  {
    envKey: 'ZAI_PLAN_API_KEY',
    entry: {
      id: 'glm',
      label: 'GLM',
      baseUrl: 'https://api.z.ai/api/anthropic',
      auth: { kind: 'authToken', value: '' },
      models: [
        { id: 'glm-5.3', contextWindow: 1000000 },
        { id: 'glm-5.3-flash', contextWindow: 1000000 },
        { id: 'glm-5.2', contextWindow: 1000000 },
      ],
      origin: 'user',
    },
  },
]

let store = readProviderStore(worldHome)
const wrote = []
const skipped = []
for (const { envKey, entry } of SEEDS) {
  const value = process.env[envKey]
  if (value === undefined || value.trim() === '') {
    skipped.push(`${entry.id} (${envKey} unset)`)
    console.error(`${TAG}: ${envKey} is not set — skipping '${entry.id}'`)
    continue
  }
  store = upsertProvider(store, { ...entry, auth: { ...entry.auth, value } })
  wrote.push(`${entry.id} (${entry.models.length} models)`)
}
// Nothing to write when both keys are missing: leave an absent store absent
// rather than creating an empty one (the world's own fail-soft read is fine).
if (wrote.length > 0) writeProviderStore(worldHome, store)

const summary = [
  wrote.length === 0 ? 'wrote nothing' : `wrote ${wrote.join(', ')}`,
  skipped.length === 0 ? 'skipped none' : `skipped ${skipped.join(', ')}`,
]
console.log(`${TAG}: ${worldHome} — ${summary.join('; ')}`)
