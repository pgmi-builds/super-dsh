import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { KERNEL_PYTHON, setupRuntime } from './helpers.ts'

function directory() {
  const dir = mkdtempSync(join(tmpdir(), 'better-checkpoint-review-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
const request = (program: string) => ({ program, principal: 's', bindings: [] })
const files = (dir: string) => readdirSync(join(dir, 's')).sort()
const manifest = (dir: string) => JSON.parse(readFileSync(join(dir, 's', 'manifest.json'), 'utf8'))
// Fault injection stays inside the owned child/helper module, out of user globals.
function moduleCode(code: string) { return `exec(${JSON.stringify(code)}, __import__('better_snapshot').__dict__)` }

describe('checkpoint review regressions', () => {
  it('restores legal startup binding replacements alongside valuable state', async () => {
    const snapshotDir = directory()
    const first = await setupRuntime({ snapshotDir })
    expect((await first.runtime.run(request('display = 42\nvaluable = [1, 2]\nvalue = lambda: display'))).error).toBeUndefined()
    expect(manifest(snapshotDir).names).toContain('display')
    await first.fiber.dispose()
    const second = await setupRuntime({ snapshotDir })
    const result = await second.runtime.run(request('[display, valuable, value()]'))
    expect(result.error).toBeUndefined()
    expect(result.value).toEqual([42, [1, 2], 42])
  })

  it('prunes partial and inherited slot callbacks with missing globals transitively', async () => {
    const snapshotDir = directory()
    const first = await setupRuntime({ snapshotDir })
    const result = await first.runtime.run(request([
      'import functools', 'good = [7]',
      'class Bad:', '    def __reduce__(self): raise TypeError("bad value")', 'bad = Bad()',
      'class Base:', '    __slots__ = ("callback",)',
      'class Child(Base):', '    __slots__ = ()',
      'slot = Child()', 'slot.callback = lambda: bad',
      'wrapped = functools.partial(lambda: bad)',
      'indirect = lambda: wrapped()', 'via_slot = lambda: slot.callback()',
      'safe_slot = Child()', 'safe_slot.callback = lambda: good[0]',
      'safe_partial = functools.partial(lambda n: good[0] + n, 2)',
    ].join('\n')))
    expect(result.error).toBeUndefined()
    for (const name of ['bad', 'slot', 'wrapped', 'indirect', 'via_slot']) expect(manifest(snapshotDir).omitted).toHaveProperty(name)
    await first.fiber.dispose()
    const second = await setupRuntime({ snapshotDir })
    const restored = await second.runtime.run(request('good = [9]\n[safe_slot.callback(), safe_partial(), "slot" in globals(), "wrapped" in globals(), "indirect" in globals(), "via_slot" in globals()]'))
    expect(restored.error).toBeUndefined()
    expect(restored.value).toEqual([9, 11, false, false, false, false])
  })

  it('cleans every uncommitted pointer-failure attempt while preserving current and previous payloads', async () => {
    const snapshotDir = directory()
    const { runtime } = await setupRuntime({ snapshotDir })
    await runtime.run(request('kept = 1'))
    await runtime.run(request('kept = 2'))
    const before = files(snapshotDir)
    const pointer = readFileSync(join(snapshotDir, 's', 'manifest.json'), 'utf8')
    const setup = moduleCode('def _test_replace(*args):\n    raise OSError("injected pointer failure")\nos.replace = _test_replace')
    for (let n = 0; n < 3; n++) {
      const result = await runtime.run(request(n === 0 ? setup : 'kept += 1'))
      expect(result.logs.join(' ')).toMatch(/snapshot failed.*injected pointer failure/)
      expect(files(snapshotDir)).toEqual(before)
      expect(readFileSync(join(snapshotDir, 's', 'manifest.json'), 'utf8')).toBe(pointer)
    }
  })

  it('cleans files written by an attempt whose deadline expires before commit', async () => {
    const snapshotDir = directory()
    const { runtime } = await setupRuntime({ snapshotDir, snapshotTimeoutMs: 300 })
    await runtime.run(request('kept = 1'))
    const before = files(snapshotDir)
    const result = await runtime.run(request(moduleCode([
      '_test_original_write = _write_new',
      'def _test_slow_write(path, data):',
      '    _test_original_write(path, data)',
      '    if path.endswith(".tmp"):',
      '        try: time.sleep(0.5)',
      '        except KeyboardInterrupt: pass',
      '_write_new = _test_slow_write',
    ].join('\n'))))
    expect(result.logs.join(' ')).toMatch(/snapshot failed/)
    expect(files(snapshotDir)).toEqual(before)
    expect(manifest(snapshotDir).turn).toBe(1)
  })

  it('scavenges recognized crash orphans before a subsequent capped attempt', async () => {
    const snapshotDir = directory()
    const { runtime } = await setupRuntime({ snapshotDir, snapshotSizeCapBytes: 5000 })
    await runtime.run(request('kept = 1'))
    await runtime.run(request('kept = 2'))
    const before = files(snapshotDir)
    writeFileSync(join(snapshotDir, 's', `state-${'a'.repeat(32)}.dill`), 'abandoned payload')
    writeFileSync(join(snapshotDir, 's', `.checkpoint-${'b'.repeat(32)}.tmp`), 'abandoned manifest')
    writeFileSync(join(snapshotDir, 's', 'unrelated.txt'), 'leave this')
    const result = await runtime.run(request('huge = "x" * 20000'))
    expect(result.logs.join(' ')).toMatch(/snapshot skipped/)
    expect(files(snapshotDir)).toEqual([...before, 'unrelated.txt'].sort())
    expect(manifest(snapshotDir).turn).toBe(2)
  })

  it('keeps a committed payload and reports a postcommit directory fsync failure truthfully', async () => {
    const snapshotDir = directory()
    const first = await setupRuntime({ snapshotDir })
    await first.runtime.run(request('kept = 1'))
    const result = await first.runtime.run(request(moduleCode([
      'import stat as _test_stat', '_test_original_fsync = os.fsync',
      'def _test_fsync(fd):',
      '    if _test_stat.S_ISDIR(os.fstat(fd).st_mode): raise OSError("injected directory fsync failure")',
      '    return _test_original_fsync(fd)', 'os.fsync = _test_fsync',
    ].join('\n')) + '\nkept = 2'))
    expect(result.logs.join(' ')).toMatch(/committed.*fsync/)
    const saved = manifest(snapshotDir)
    expect(saved.turn).toBe(2)
    expect(existsSync(join(snapshotDir, 's', saved.payload))).toBe(true)
    await first.fiber.dispose()
    const second = await setupRuntime({ snapshotDir })
    expect((await second.runtime.run(request('kept'))).value).toBe(2)
  })

  it('keeps the pointed-to payload when replacement succeeds and its wrapper then throws', async () => {
    const snapshotDir = directory()
    const first = await setupRuntime({ snapshotDir })
    await first.runtime.run(request('kept = 1'))
    const result = await first.runtime.run(request(moduleCode([
      '_test_original_replace = os.replace',
      'def _test_replace_after(source, target):',
      '    _test_original_replace(source, target)',
      '    raise OSError("injected after pointer commit")',
      'os.replace = _test_replace_after',
    ].join('\n')) + '\nkept = 3'))
    expect(result.logs.join(' ')).toMatch(/committed.*after pointer commit/)
    const saved = manifest(snapshotDir)
    expect(saved.turn).toBe(2)
    expect(existsSync(join(snapshotDir, 's', saved.payload))).toBe(true)
    await first.fiber.dispose()
    const second = await setupRuntime({ snapshotDir })
    expect((await second.runtime.run(request('kept'))).value).toBe(3)
  })

  it('retains partial-execution wording when a side-effecting cell cannot respawn', async () => {
    const dir = directory()
    const marker = join(dir, 'side-effect')
    const python = join(dir, 'python-wrapper')
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
    writeFileSync(python, `#!/bin/sh\nif [ -f ${quote(marker)} ]; then exit 7; fi\nexec ${quote(KERNEL_PYTHON)} "$@"\n`, { mode: 0o700 })
    const { runtime } = await setupRuntime({ python, snapshotDir: join(dir, 'snapshots') })
    await runtime.run(request('kept = 1'))
    const result = await runtime.run(request(`import os\nwith open(${JSON.stringify(marker)}, "w") as f:\n    f.write("once")\nos._exit(1)`))
    expect(result.error?.message).toMatch(/respawn failed/)
    expect(result.error?.message).toMatch(/may have executed partially/)
    expect(result.error?.message).toMatch(/No user code was replayed/)
    expect(readFileSync(marker, 'utf8')).toBe('once')
  })
})
