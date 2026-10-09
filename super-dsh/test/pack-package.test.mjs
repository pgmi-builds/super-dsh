import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
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


test('package-pair verification rejects Better dependency edges and physical payload, preserving browser artifacts', async () => {
 const {packPackage}=await import('../scripts/pack-package.mjs')
 const {verifyPackagePair}=await import('../scripts/verify-package-pair.mjs')
 const root=mkdtempSync(join(tmpdir(),'superd dependency probe '))
 try {
  const source=join(root,'super'),local=join(root,'better'),out=join(root,'out');mkdirSync(source);mkdirSync(local)
  const b={name:'better-dsh',version:'1.0.0',files:['value.txt']};writeFileSync(join(local,'package.json'),JSON.stringify(b));writeFileSync(join(local,'value.txt'),'local');const better=join(out,packPackage(local,out).filename)
  const a={name:'super-dsh',version:'1.0.0',files:['cordis.patch.yml','bundles','agent-omp'],dsh:{bundle:{patch:'./cordis.patch.yml'}},dependencies:{}}
  writeFileSync(join(source,'package.json'),JSON.stringify(a));writeFileSync(join(source,'cordis.patch.yml'),'[]\n');const pack=()=>join(out,packPackage(source,out).filename)
  assert.equal(verifyPackagePair(pack(),better),true)
  for(const field of ['dependencies','optionalDependencies','peerDependencies']){a[field]={'better-dsh':'1.0.0'};writeFileSync(join(source,'package.json'),JSON.stringify(a));assert.throws(()=>verifyPackagePair(pack(),better),/dependency/);delete a[field]}
  a.bundledDependencies=['better-dsh'];writeFileSync(join(source,'package.json'),JSON.stringify(a));assert.throws(()=>verifyPackagePair(pack(),better),/physical|bundl/)
  delete a.bundledDependencies;writeFileSync(join(source,'package.json'),JSON.stringify(a));mkdirSync(join(source,'bundles'));writeFileSync(join(source,'bundles/better-dsh.tgz'),'archive');assert.throws(()=>verifyPackagePair(pack(),better),/Physical/);rmSync(join(source,'bundles'),{recursive:true})
  const client=join(source,'agent-omp');mkdirSync(client);writeFileSync(join(client,'package.json'),JSON.stringify({name:'agent-omp',dsh:{client:{}},exports:{'./client':'./client.js'}}));assert.throws(()=>verifyPackagePair(pack(),better),/Missing declared client/)
  writeFileSync(join(client,'client.js'),'export {}');assert.equal(verifyPackagePair(pack(),better),true)
 } finally {rmSync(root,{recursive:true,force:true})}
})
