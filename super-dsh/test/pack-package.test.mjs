import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

test('shared pack entry produces a fresh verified tarball without npm JSON parsing', async () => {
  const module = await import('../scripts/pack-package.mjs')
  assert.equal(typeof module.packPackage, 'function', 'shared npm pack entry must exist')
  const root = mkdtempSync(join(tmpdir(), 'superd pack '))
  try {
    const source = join(root, 'source'), output = join(root, 'output')
    mkdirSync(source)
    writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'pair-pack-probe', version: '1.0.0', files: ['value.txt'] }))
    writeFileSync(join(source, 'value.txt'), 'first build')
    module.packPackage(source, output)
    writeFileSync(join(source, 'value.txt'), 'latest build')
    const packed = module.packPackage(source, output)
    assert.equal(packed.filename, 'pair-pack-probe-1.0.0.tgz')
    const archive = join(output, packed.filename)
    assert.equal(execFileSync('tar', ['-xOf', archive, 'package/value.txt'], { encoding: 'utf8' }), 'latest build')
    const manifest = JSON.parse(execFileSync('tar', ['-xOf', archive, 'package/package.json'], { encoding: 'utf8' }))
    assert.equal(manifest.name, 'pair-pack-probe')
    assert.equal(manifest.version, '1.0.0')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})


test('bundle verification rejects missing or stale local dependency files', async () => {
  const { packPackage } = await import('../scripts/pack-package.mjs')
  const { verifyBundledPackage } = await import('../scripts/verify-bundled.mjs')
  const root = mkdtempSync(join(tmpdir(), 'superd bundled probe '))
  try {
    const source = join(root, 'source'), local = join(root, 'local'), output = join(root, 'output')
    mkdirSync(source); mkdirSync(local)
    writeFileSync(join(local, 'package.json'), JSON.stringify({ name: 'local-better-probe', version: '1.0.0', files: ['value.txt'] }))
    writeFileSync(join(local, 'value.txt'), 'fresh local source')
    const dep = packPackage(local, output)
    writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'bundle-probe', version: '1.0.0', files: ['index.js'], dependencies: { 'local-better-probe': '1.0.0' }, bundledDependencies: ['local-better-probe'] }))
    writeFileSync(join(source, 'index.js'), '')
    const outer = packPackage(source, output)
    const archive = join(output, outer.filename), dependency = join(output, dep.filename)
    assert.throws(() => verifyBundledPackage(archive, dependency, 'local-better-probe'))
    const nested = join(source, 'node_modules/local-better-probe'); mkdirSync(nested, { recursive: true })
    execFileSync('tar', ['-xf', dependency, '-C', nested, '--strip-components=1'])
    packPackage(source, output)
    assert.equal(verifyBundledPackage(archive, dependency, 'local-better-probe'), 2)
    writeFileSync(join(nested, 'value.txt'), 'stale registry-like content')
    packPackage(source, output)
    assert.throws(() => verifyBundledPackage(archive, dependency, 'local-better-probe'), /differs from local tarball/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
