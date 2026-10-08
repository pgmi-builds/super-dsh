import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { packPackage } from '../scripts/pack-package.mjs'

test('physical Pi bundle preserves hoisted dependency files and installs without script approval', async () => {
  const entry = new URL('../scripts/build-pi.mjs', import.meta.url)
  assert.ok(existsSync(entry), 'Pi bundling must be part of the repeatable pack pipeline')
  const { embedPiDependencyTree } = await import(entry)
  const root = mkdtempSync(join(tmpdir(), 'superd-pi-bundle-'))
  try {
    const line = join(root, 'line'), tree = join(root, 'tree'), out = join(root, 'out'), consumer = join(root, 'consumer')
    const sdk = join(tree, 'node_modules/@earendil-works/pi-coding-agent'), leaf = join(tree, 'node_modules/pi-hook-leaf')
    for (const dir of [line, sdk, leaf, consumer]) mkdirSync(dir, { recursive: true })
    writeFileSync(join(line, 'package.json'), JSON.stringify({ name: 'superd-pi-consumer-probe', version: '1.0.0', dependencies: { '@earendil-works/pi-coding-agent': '0.84.2' }, bundledDependencies: ['@earendil-works/pi-coding-agent'] }))
    writeFileSync(join(sdk, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '0.84.2', main: 'index.cjs', dependencies: { 'pi-hook-leaf': '1.0.0' } }))
    writeFileSync(join(sdk, 'index.cjs'), 'module.exports = require("pi-hook-leaf")')
    writeFileSync(join(leaf, 'package.json'), JSON.stringify({ name: 'pi-hook-leaf', version: '1.0.0', main: 'index.cjs', scripts: { postinstall: 'node hook.cjs' } }))
    writeFileSync(join(leaf, 'index.cjs'), 'module.exports = "ready-without-hooks"')
    const hook = 'throw new Error("installation must not execute bundled hooks")'
    writeFileSync(join(leaf, 'hook.cjs'), hook)
    embedPiDependencyTree(line, tree)
    const req = createRequire(join(line, 'package.json'))
    assert.equal(req('@earendil-works/pi-coding-agent'), 'ready-without-hooks')
    assert.ok(!existsSync(join(line, 'node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-coding-agent')), 'do not embed a second SDK inside itself')
    const archive = join(out, packPackage(line, out).filename)
    assert.equal(execFileSync('tar', ['-xOf', archive, 'package/node_modules/@earendil-works/pi-coding-agent/node_modules/pi-hook-leaf/hook.cjs'], { encoding: 'utf8' }), hook)
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'superd-pi-install-probe', private: true }))
    writeFileSync(join(consumer, 'pnpm-workspace.yaml'), 'packages:\n  - .\nautoInstallPeers: false\nnodeLinker: hoisted\nstrictDepBuilds: true\n')
    execFileSync('pnpm', ['add', archive, '--reporter=append-only'], { cwd: consumer, stdio: 'pipe' })
    const installed = createRequire(join(consumer, 'node_modules/superd-pi-consumer-probe/package.json'))
    assert.equal(installed('@earendil-works/pi-coding-agent'), 'ready-without-hooks')
    assert.doesNotMatch(readFileSync(join(consumer, 'pnpm-workspace.yaml'), 'utf8'), /allowBuilds|ignoredBuiltDependencies/)
    const manifest = JSON.parse(readFileSync(join(sdk, 'package.json'), 'utf8'))
    manifest.version = '0.84.3'
    writeFileSync(join(sdk, 'package.json'), JSON.stringify(manifest))
    assert.throws(() => embedPiDependencyTree(line, tree), /pin|version/i)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
