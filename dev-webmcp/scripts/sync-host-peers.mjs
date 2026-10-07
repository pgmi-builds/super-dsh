// Compile against the same real host used by the launcher, with no type stubs.
import { createRequire } from 'node:module'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, rmSync, symlinkSync } from 'node:fs'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const anchor = process.argv[2] ? resolve(process.argv[2]) : resolve(root, '../upstream/deepseek-harness/apps/cli/package.json')
const host = createRequire(anchor)
for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-host-webserver']) {
  const target = dirname(host.resolve(`${name}/package.json`))
  const link = join(root, 'node_modules', name)
  mkdirSync(dirname(link), { recursive: true })
  rmSync(link, { recursive: true, force: true })
  symlinkSync(target, link, 'dir')
}
