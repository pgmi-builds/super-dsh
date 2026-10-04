// Test rig only: argv selects <lineHome>/agents/codex; never native Codex files.
// The launcher supplies the key from the line home's .env only to this child.
// Store helpers keep updates atomic and 0600. ZAI is omitted until its
// Responses support has been verified by a real turn.
import { readProviderStore, upsertProvider, writeProviderStore } from '../agent-codex/dist/codex-providers.js'

const worldHome = process.argv[2]
if (worldHome === undefined || worldHome.trim() === '') {
  console.error('usage: node seed-codex-providers.mjs <worldHome>')
  process.exit(1)
}

const value = process.env.DEEPSEEK_API_KEY
if (value === undefined || value.trim() === '') {
  console.log('seed-codex-providers: deepseek skipped (DEEPSEEK_API_KEY unset)')
} else {
  const entry = {
    id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1',
    protocol: 'responses', auth: { kind: 'apiKey', value },
    models: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }], origin: 'user',
  }
  writeProviderStore(worldHome, upsertProvider(readProviderStore(worldHome), entry))
  console.log('seed-codex-providers: wrote deepseek (2 models)')
}
