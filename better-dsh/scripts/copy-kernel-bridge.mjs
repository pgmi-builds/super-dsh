#!/usr/bin/env node
/** Verify and ship immutable runner plus Better resources after tsdown. */
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
const source = new URL('../src/omp-python/', import.meta.url)
const provenance = JSON.parse(readFileSync(new URL('provenance.json', source), 'utf8'))
const expected = provenance.files['runner.py'].sha256
const actual = createHash('sha256').update(readFileSync(new URL('runner.py', source))).digest('hex')
if (actual !== expected) throw new Error(`Immutable OMP runner hash mismatch: expected ${expected}, found ${actual}`)
const dillProvenance = JSON.parse(readFileSync(new URL('dill-provenance.json', source), 'utf8'))
for (const [path, metadata] of Object.entries(dillProvenance.files)) {
  const hash = createHash('sha256').update(readFileSync(new URL(path, source))).digest('hex')
  if (hash !== metadata.sha256) throw new Error(`Immutable dill source hash mismatch: ${path}`)
}
const target = new URL('../lib/omp-python/', import.meta.url)
rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })
cpSync(source, target, { recursive: true, filter: path => !path.includes('__pycache__') && !path.endsWith('.pyc') && !path.split(/[\\/]/).includes('tests') })
console.log(`copy-kernel-bridge: verified runner ${actual}; packaged omp-python resources`)
