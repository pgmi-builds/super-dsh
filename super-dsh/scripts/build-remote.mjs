// Independent remote entry: canonical Better source, never its multipurpose lib tree.
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from '../../better-dsh/node_modules/tsdown/dist/index.mjs'

const repo = join(dirname(fileURLToPath(import.meta.url)), '../..')
const out = join(repo, 'super-dsh/remote')
const hash = data => createHash('sha256').update(data).digest('hex')
export function remoteSources() {
  const inputs = readdirSync(join(repo, 'better-dsh/src/remote')).filter(file => file.endsWith('.ts')).map(file => `better-dsh/src/remote/${file}`)
  function collect(dir) { for (const entry of readdirSync(join(repo, dir), { withFileTypes: true })) { const file = `${dir}/${entry.name}`; if (entry.isDirectory()) collect(file); else if (entry.isFile()) inputs.push(file) } }
  for (const dir of ['better-dsh/third_party/schemastery/lib', 'better-dsh/third_party/schemastery/node_modules/@deepseek-ai/cosmokit/lib', 'better-dsh/third_party/schemastery/node_modules/@standard-schema/spec/dist']) collect(dir)
  return Object.fromEntries(inputs.sort().map(file => [file, hash(readFileSync(join(repo, file)))]))
}
export async function buildRemote() {
  rmSync(out, { recursive: true, force: true })
  const sources = remoteSources()
  await build({
    config: false,
    cwd: join(repo, 'better-dsh'),
    entry: { plugin: 'src/remote/plugin.ts' },
    outDir: out,
    format: 'esm', platform: 'node', dts: { resolve: true },
    noExternal: id => id === '#schemastery' || id === '@deepseek-ai/cosmokit' || id.startsWith('@standard-schema/'),
    external: [/^@deepseek-ai\/(?!cosmokit)/, /^node:/],
    sourcemap: false,
  })
  // Private child-process entry: no host plugin imports or inherited resolver required.
  await build({
    config: false, cwd: join(repo, 'better-dsh'),
    entry: { 'file-worker': 'src/remote/file-worker.ts' }, outDir: out,
    format: 'esm', platform: 'node', dts: false, clean: false,
    external: [/^[^./]/], sourcemap: false,
  })
  const outputs = {}
  for (const file of readdirSync(out).sort()) {
    const data = readFileSync(join(out, file))
    if (/(?:from\s*|import\s*\()["'](?:better-dsh|#schemastery)/.test(data.toString())) throw new Error(`Remote closure has a cross-package import: ${file}`)
    if (data.includes(Buffer.from(repo))) throw new Error(`Remote closure leaks a development path: ${file}`)
    if (file === 'file-worker.js' && /(?:from\s*|import\s*\(|import\s+|require\s*\()\s*["'](?!node:)/.test(data.toString())) throw new Error('Private file worker must import Node builtins only')
    outputs[file] = hash(data)
  }
  if (JSON.stringify(sources) !== JSON.stringify(remoteSources())) throw new Error('Remote sources changed during build')
  writeFileSync(join(out, 'provenance.json'), JSON.stringify({ format: 1, entry: 'better-dsh/src/remote/plugin.ts', workerEntry: 'better-dsh/src/remote/file-worker.ts', sources, outputs }, null, 2) + '\n')
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await buildRemote()
