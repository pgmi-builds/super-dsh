// sync-dsh-farm.mjs — re-point super-dsh/node_modules/@deepseek-ai/* at the
// current upstream checkout layout (repo compile/test resolution source).
//
// The checkout (upstream/deepseek-harness) is a moving tree: every upstream
// alignment round renames/splits/moves packages, which leaves the farm with
// dangling or mis-targeted links. This script makes the farm match the
// checkout exactly:
//   - every packages/*/*/package.json + vendor/*/package.json becomes a link
//   - stale links (dangling or pointing outside the current checkout) go
//
// Idempotent; run after every upstream checkout change, BEFORE tsc/tests.
// (2026-09-24 alignment: created because 0.1.7 split dsh-agent-presets into
// dsh-agent-preset + dsh-agent-preset-registry and moved 10 other packages.)
import { readdirSync, readFileSync, existsSync, symlinkSync, unlinkSync, realpathSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const LINE = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = dirname(LINE)
const CHECKOUT = join(REPO, 'upstream', 'deepseek-harness')
const FARM = join(LINE, 'node_modules', '@deepseek-ai')

// 1. harvest name -> dir from the checkout manifests
const wanted = new Map()
const roots = [join(CHECKOUT, 'packages'), join(CHECKOUT, 'vendor')]
for (const root of roots) {
  if (!existsSync(root)) continue
  for (const group of readdirSync(root)) {
    const groupDir = join(root, group)
    let entries
    try { entries = readdirSync(groupDir) } catch { continue }
    // Flat package (vendor/cordis) vs group of packages (packages/core/agent).
    const flat = existsSync(join(groupDir, 'package.json'))
    const candidates = flat ? [groupDir] : entries.map((name) => join(groupDir, name))
    for (const pkgDir of candidates) {
      const manifest = join(pkgDir, 'package.json')
      if (!existsSync(manifest)) continue
      let pkgName
      try { pkgName = JSON.parse(readFileSync(manifest, 'utf8')).name } catch { continue }
      if (typeof pkgName !== 'string' || !pkgName.startsWith('@deepseek-ai/')) continue
      // PHYSICAL path, not `join(CHECKOUT, …)`: a checkout reached through a
      // symlink (dev worktrees symlink `upstream/` into the main tree) would
      // otherwise bake a worktree-specific prefix into every link — deleting
      // that worktree then dangles the whole farm and the next tsc fails with
      // "Cannot find module '@deepseek-ai/*'" (2026-10-02: 325 links went dead
      // when `.worktrees/mesh-p1` was removed).
      wanted.set(pkgName.slice('@deepseek-ai/'.length), realpathSync(pkgDir))
    }
  }
}

// 2. sweep the farm: drop anything not exactly matching the wanted table
if (!existsSync(FARM)) mkdirSync(FARM, { recursive: true })
let removed = 0, linked = 0, kept = 0
for (const entry of readdirSync(FARM)) {
  const link = join(FARM, entry)
  const target = wanted.get(entry)
  let current
  try { current = realpathSync(link) } catch { current = null }
  if (target !== undefined && current === target) { kept++; continue }
  unlinkSync(link)
  removed++
  if (target !== undefined) { symlinkSync(target, link, 'dir'); linked++ }
}
// 3. add brands-new entries
for (const [name, dir] of wanted) {
  if (existsSync(join(FARM, name))) continue
  symlinkSync(dir, join(FARM, name), 'dir')
  linked++
}
console.log(`[farm] kept=${kept} relinked=${linked} removed=${removed} total=${wanted.size}`)
