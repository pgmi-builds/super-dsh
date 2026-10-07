// Retained development entry: the main pack entry ALWAYS builds local Better Dash.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
execFileSync(process.execPath, [fileURLToPath(new URL('./pack.mjs', import.meta.url))], { stdio: 'inherit' })
