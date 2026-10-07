// One npm pack approach for both local packages. Verify the artifact itself;
// npm's human/JSON output is not part of the delivery contract.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export function packPackage(source, output) {
  const { name, version } = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
  const filename = `${name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`
  const tarball = join(output, filename)
  mkdirSync(output, { recursive: true })
  rmSync(tarball, { force: true })
  execFileSync('npm', ['pack', '--pack-destination', output], { cwd: source, stdio: 'inherit' })
  const packed = JSON.parse(execFileSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' }))
  if (packed.name !== name || packed.version !== version) {
    throw new Error(`Packed manifest does not match ${name}@${version}`)
  }
  return { name, version, filename }
}
