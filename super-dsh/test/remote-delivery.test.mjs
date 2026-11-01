import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { load, DEFAULT_SCHEMA, Type } from '../../upstream/deepseek-harness/node_modules/js-yaml/dist/js-yaml.mjs'
import { createHash } from 'node:crypto'

const schema = DEFAULT_SCHEMA.extend([new Type('tag:yaml.org,2002:js', { kind: 'scalar' })])
const parseYaml = value => load(value, { schema })
const repo = join(dirname(fileURLToPath(import.meta.url)), '../..')
test('Super ships a self-contained remote closure from the canonical Better source', () => {
  execFileSync(process.execPath, ['super-dsh/scripts/build-remote.mjs'], { cwd: repo, stdio: 'pipe' })
  const pkg = JSON.parse(readFileSync(join(repo, 'super-dsh/package.json')))
  // ADR 0016: the closure is a PRIVATE hub-internal dependency — no public
  // export and no companion setup export; the model-facing remote tools ship
  // only in Better Dash. The closure leaves still ride the tarball (files).
  assert.equal(pkg.exports['./remote'], undefined)
  assert.equal(pkg.exports['./setup'], undefined)
  assert.ok(pkg.files.includes('remote'))
  const manifest = JSON.parse(readFileSync(join(repo, 'super-dsh/remote/provenance.json')))
  for (const [path, hash] of Object.entries(manifest.sources)) {
    assert.equal(createHash('sha256').update(readFileSync(join(repo, path))).digest('hex'), hash)
    assert.equal(path.startsWith('/'), false)
  }
  for (const entry of readdirSync(join(repo, 'super-dsh/remote'), { withFileTypes: true })) {
    if (!entry.isFile()) continue // helper-bin/ leaves are provenance-checked by verifyRemoteClosure
    const content = readFileSync(join(repo, 'super-dsh/remote', entry.name), 'utf8')
    assert.doesNotMatch(content, /(?:from\s*|import\s*\()["'](?:better-dsh|#schemastery)/)
    assert.equal(content.includes(repo), false)
  }
  const scratch = mkdtempSync(join(tmpdir(), 'remote-delivery-'))
  try {
    const pack = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: join(repo, 'super-dsh'), encoding: 'utf8', stdio: ['ignore','pipe','pipe'], maxBuffer: 16 * 1024 * 1024 })
    const result = JSON.parse(pack)
    const files = (Array.isArray(result) ? result[0] : result['super-dsh']).files.map(file => file.path)
    assert.ok(files.includes('remote/plugin.js'))
    assert.ok(files.includes('remote/file-worker.js'))
    assert.ok(files.includes('remote/plugin.d.ts'))
    assert.ok(files.includes('remote/provenance.json'))
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})

test('remote tools compose only in Better; Super carries no remote row', () => {
  const better = parseYaml(readFileSync(join(repo, 'better-dsh/cordis.patch.yml'), 'utf8'))
  const superPatch = parseYaml(readFileSync(join(repo, 'super-dsh/cordis.patch.yml'), 'utf8'))
  const rows = patch => patch.flatMap(row => row.insert || [])
  assert.deepEqual(rows(better).filter(row => row.name === 'better-dsh/remote').map(row => [row.id, !!row.disabled]), [['dashr-remote', false]])
  assert.deepEqual(rows(superPatch).filter(row => row.name === 'super-dsh/remote'), [])
  assert.equal(superPatch.some(row => row.id === 'dashr-remote'), false)
})

test('remote provenance rejects changed output, stale source, and Better shared chunks', async () => {
  const { verifyRemoteClosure } = await import('../scripts/verify-package-pair.mjs')
  const { cpSync, writeFileSync } = await import('node:fs')
  const scratch = mkdtempSync(join(tmpdir(), 'remote-provenance-'))
  try {
    cpSync(join(repo, 'super-dsh/remote'), join(scratch, 'remote'), { recursive: true })
    assert.equal(verifyRemoteClosure(scratch, repo), true)
    const leaf = join(scratch, 'remote/file-worker.js'), leafOriginal = readFileSync(leaf)
    const manifestPath = join(scratch, 'remote/provenance.json'), manifestOriginal = readFileSync(manifestPath)
    writeFileSync(leaf, "import 'host-peer';\n")
    const changed = JSON.parse(manifestOriginal); changed.outputs['file-worker.js'] = createHash('sha256').update(readFileSync(leaf)).digest('hex')
    writeFileSync(manifestPath, JSON.stringify(changed))
    assert.throws(() => verifyRemoteClosure(scratch, repo), /Node builtins only/)
    writeFileSync(leaf, leafOriginal); writeFileSync(manifestPath, manifestOriginal)
    const entry = join(scratch, 'remote/plugin.js'), original = readFileSync(entry)
    writeFileSync(entry, Buffer.concat([original, Buffer.from('\n// changed\n')]))
    assert.throws(() => verifyRemoteClosure(scratch, repo), /output hash mismatch/)
    writeFileSync(entry, original)
    const receiptFile = join(scratch, 'remote/provenance.json'), receipt = JSON.parse(readFileSync(receiptFile))
    receipt.sources['better-dsh/src/remote/plugin.ts'] = '0'.repeat(64)
    writeFileSync(receiptFile, JSON.stringify(receipt))
    assert.throws(() => verifyRemoteClosure(scratch, repo), /Stale remote source/)
    writeFileSync(join(scratch, 'remote/other-tool.js'), 'export const unrelated = true')
    assert.throws(() => verifyRemoteClosure(scratch, repo), /must not copy Better shared chunks/)
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})

test('private generated file worker runs real digest outside any host peer installation', async () => {
  const { cpSync, writeFileSync } = await import('node:fs')
  const { spawnSync } = await import('node:child_process')
  const { pathToFileURL } = await import('node:url')
  const root = mkdtempSync(join(tmpdir(), 'remote-worker-consumer-'))
  try {
    const worker = join(root, 'file-worker.mjs')
    cpSync(join(repo, 'super-dsh/remote/file-worker.js'), worker)
    const bytes = Buffer.from([0, 255, 128, 10, 0, 42]), path = join(root, 'payload')
    writeFileSync(path, bytes)
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import { runFileWorker } from ${JSON.stringify(pathToFileURL(worker).href)}; await runFileWorker(JSON.parse(process.argv[1]));`, JSON.stringify({ action: 'digest', path, root: join(root, 'owned'), selected: false })], { cwd: root, input: '', encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    const record = Buffer.from(JSON.stringify(['', 'f', bytes.length, createHash('sha256').update(bytes).digest('hex')]))
    const size = Buffer.alloc(4); size.writeUInt32BE(record.length)
    assert.deepEqual(JSON.parse(result.stdout), { sha256: createHash('sha256').update(size).update(record).digest('hex'), bytes: bytes.length, entries: 1 })
    assert.doesNotMatch(readFileSync(worker, 'utf8'), /(?:from\s*|import\s*\(|import\s+|require\s*\()\s*["'](?!node:)/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
