import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { setupRuntime } from './helpers.ts'

function checkpointDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'better-omp-checkpoint-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

describe('OMP checkpoint object graph and operation ordering', () => {
  it('restores aliases, closures and class methods into the live fresh namespace', async () => {
    const snapshotDir = checkpointDirectory()
    const first = await setupRuntime({ snapshotDir })
    const saved = await first.runtime.run({ principal: 'graph', bindings: [], program: [
      'x = [1, 2]', 'alias = x', 'f = lambda n: x[0] + n',
      'def make_closure(value):', '    return lambda n: value + n',
      'closure = make_closure(10)',
      'class Counter:', '    def current(self):', '        return x[0]',
      'instance = Counter()', 'cycle = []', 'cycle.append(cycle)',
    ].join('\n') })
    expect(saved.error).toBeUndefined()
    await first.fiber.dispose()
    const second = await setupRuntime({ snapshotDir })
    const restored = await second.runtime.run({ principal: 'graph', bindings: [], program: [
      'assert x is alias and cycle[0] is cycle',
      'assert f(4) == 5 and closure(2) == 12 and instance.current() == 1',
      'x = [9]',
      'assert f.__globals__ is globals()',
      'assert Counter.current.__globals__ is globals()',
      '[f(4), instance.current(), closure(2)]',
    ].join('\n') })
    expect(restored.error).toBeUndefined()
    expect(restored.value).toEqual([13, 9, 12])
    expect(restored.logs.join('\n')).toContain('restored')
  })

  it('reports partial coverage for bad values and nested live handles while retaining good aliases', async () => {
    const snapshotDir = checkpointDirectory()
    const first = await setupRuntime({ snapshotDir })
    const saved = await first.runtime.run({ principal: 'partial', bindings: [], program: [
      'import threading', 'import os',
      'good = [42]', 'good_alias = good',
      'class Bad:', '    def __reduce__(self):', '        raise TypeError("cannot checkpoint this value")',
      'bad = Bad()', 'nested_handle = {"file": open(os.devnull, "r")}',
      'nested_lock = [threading.Lock()]',
    ].join('\n') })
    expect(saved.error).toBeUndefined()
    expect(saved.logs.join('\n')).toMatch(/partial|omitted|skipped/i)
    await first.fiber.dispose()
    const second = await setupRuntime({ snapshotDir })
    const restored = await second.runtime.run({ principal: 'partial', bindings: [], program: [
      'assert good is good_alias',
      '[good[0], "bad" in globals(), "nested_handle" in globals(), "nested_lock" in globals()]',
    ].join('\n') })
    expect(restored.error).toBeUndefined()
    expect(restored.value).toEqual([42, false, false, false])
    expect(restored.logs.join('\n')).toMatch(/partial|omitted|skipped/i)
  })

  it('serializes cold same-session runs and commits the matching completed-cell sequence', async () => {
    const snapshotDir = checkpointDirectory()
    const { runtime } = await setupRuntime({ snapshotDir })
    const [first, second] = await Promise.all([
      runtime.run({ principal: 'cold', bindings: [], program: 'counter = 1' }),
      runtime.run({ principal: 'cold', bindings: [], program: 'counter += 1\ncounter' }),
    ])
    expect(first.error).toBeUndefined()
    expect(second.error).toBeUndefined()
    expect(second.value).toBe(2)
    expect(runtime.kernelPids).toHaveLength(1)
    const manifest = JSON.parse(readFileSync(join(snapshotDir, 'cold', 'manifest.json'), 'utf8'))
    expect(manifest.turn).toBe(2)
  })

  it('checkpoints mutations before a user exception and subsequent setVar assignments', async () => {
    const snapshotDir = checkpointDirectory()
    const first = await setupRuntime({ snapshotDir })
    const errored = await first.runtime.run({ principal: 'exception', bindings: [], program: 'before_error = 73\nraise ValueError("expected")' })
    expect(errored.error?.kind).toBe('exception')
    await first.runtime.setVar('from_host', { value: 42 }, 'exception')
    // Deliberately kill rather than dispose: dispose itself must not be the only save trigger.
    process.kill(first.runtime.kernelPids[0]!, 'SIGKILL')
    const second = await setupRuntime({ snapshotDir })
    const restored = await second.runtime.run({ principal: 'exception', bindings: [], program: '[before_error, from_host["value"]]' })
    expect(restored.error).toBeUndefined()
    expect(restored.value).toEqual([73, 42])
  })
})
