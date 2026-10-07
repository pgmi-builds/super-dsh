// Refuse a pack unless its bundled dependency exactly matches the local artifact.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
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
    return expected.length
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
