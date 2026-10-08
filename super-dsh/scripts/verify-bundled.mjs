// Refuse a pack unless its bundled dependency exactly matches the local artifact.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function verifyBundledPackage(tarball, dependencyTarball, name) {
  const scratch = mkdtempSync(join(tmpdir(), 'superd-bundle-'))
  try {
    for (const [dir, archive] of [['outer', tarball], ['local', dependencyTarball]]) {
      mkdirSync(join(scratch, dir))
      execFileSync('tar', ['-xf', archive, '-C', join(scratch, dir)])
    }
    const outer = join(scratch, 'outer/package')
    const local = join(scratch, 'local/package')
    const embedded = join(outer, 'node_modules', name)
    const a = JSON.parse(readFileSync(join(outer, 'package.json'), 'utf8'))
    const b = JSON.parse(readFileSync(join(local, 'package.json'), 'utf8'))
    if (b.name !== name || a.dependencies?.[name] !== b.version || !a.bundledDependencies?.includes(name)) {
      throw new Error(`Bundle declaration does not match local ${name}@${b.version}`)
    }
    if (a.dsh?.bundle?.patch !== './cordis.patch.yml' || a.superd?.delivery !== './bundles/manifest.json') throw new Error('Super bundle must activate independently of its companion')
    const descriptor = JSON.parse(readFileSync(join(outer, 'bundles/manifest.json'), 'utf8'))
    const item = descriptor.companions?.[0]
    const bytes = readFileSync(join(outer, 'bundles/better-dsh.tgz'))
    if (descriptor.companions.length !== 1 || item?.name !== name || item.version !== b.version || item.tarball !== './better-dsh.tgz'
      || createHash('sha256').update(bytes).digest('hex') !== item.sha256 || !bytes.equals(readFileSync(dependencyTarball))) throw new Error('Archived companion differs from the local Better tarball')
    const files = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      if (entry.isDirectory()) return files(join(dir, entry.name)).map(path => `${entry.name}/${path}`)
      if (!entry.isFile()) throw new Error(`Unexpected non-file in local bundle: ${entry.name}`)
      return [entry.name]
    }).sort()
    const expected = files(local), actual = files(embedded)
    if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error(`Bundled ${name} file list differs from local tarball`)
    for (const file of expected) {
      if (!readFileSync(join(local, file)).equals(readFileSync(join(embedded, file)))) throw new Error(`Bundled ${name}/${file} differs from local tarball`)
    }
    // A consumer loads client halves from these package exports, not from the
    // source tree. Refuse missing browser artifacts even if host builds passed.
    const componentDirs = [outer, embedded, ...readdirSync(outer, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name !== 'node_modules')
      .map(entry => join(outer, entry.name))]
    for (const directory of componentDirs) {
      const path = join(directory, 'package.json')
      if (!existsSync(path)) continue
      const component = JSON.parse(readFileSync(path, 'utf8'))
      if (component.dsh?.client === undefined) continue
      const declaration = component.exports?.['./client']
      const file = typeof declaration === 'string' ? declaration : declaration?.default
      if (typeof file !== 'string' || !existsSync(join(directory, file))) throw new Error(`Missing declared client export: ${component.name}`)
    }
    return expected.length
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
