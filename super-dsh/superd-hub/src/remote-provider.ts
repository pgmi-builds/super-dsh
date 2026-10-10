import { createRemoteFileEndpoint } from './remote-file-rpc.js'
import { startRemoteProcess } from './remote-job-client.js'
/** Hub transport implementation. HTTP/WS/pool mechanics stay in the existing exec modules. */
import { type HubRemoteTransport, type PreparedRemoteInput, type RemoteProcess } from '../../remote/plugin.js'
import type { HubToolExecFace } from './hub-tool.js'
import { ensureSelf, listRemotes } from './machines.js'
import { cookieOf } from './mesh-link.js'
import { runOneShotExec, postOneShotExec, parseOneShotExecBody } from './exec.js'
import { PtyPool } from './exec-pty-session.js'
import { LocalScriptChannel, WsPtyChannel } from './exec-pty-channel.js'
import { PTY_EXEC_PATH } from './exec-pty-rpc.js'
import type { A2aLogFn } from './a2a-log.js'

/** One shared initiator implementation for legacy tool and the optional remote service. */
export function createHubExec(home: string, log?: A2aLogFn) {
  const owners = new Map<string, PtyPool>()
  let closed = false
  const assertOpen = () => { if (closed) throw new Error('Hub transport unavailable — provider has been disposed') }
  const remote = (machine: string) => {
    assertOpen()
    const row = listRemotes(home).find(r => r.id === machine)
    if (!row) throw new Error(`unknown machine "${machine}" — call roster for remote machines`)
    if (!row.enabled || row.execEnabled === false) throw new Error(`exec is disabled for machine "${machine}" on this registry row (enabled/execEnabled=false)`)
    return row
  }
  const face: HubToolExecFace = {
    selfM4: () => ensureSelf(home, 'local').id,
    run: input => { assertOpen(); return runOneShotExec(input, log) },
    post: async (machine, input) => {
      const row = remote(machine)
      log?.('info', 'exec.remote', { machine, cmd: input.cmd, timeoutSec: input.timeoutSec ?? 120 })
      const result = await postOneShotExec(row.origin, input, { cookie: cookieOf(row.id, home) })
      log?.('info', 'exec.remote.done', { machine, exit: result.exit ?? 'none', durationMs: result.durationMs, outcome: result.outcome })
      return result
    },
    pty: async (owner, machine, cmd, opts = {}) => {
      assertOpen()
      // Validate on EVERY dispatch, including a warm shell. Pairing may have changed.
      const row = machine === face.selfM4() ? undefined : remote(machine)
      let pool = owners.get(owner)
      if (!pool) owners.set(owner, pool = new PtyPool({ idleTtlSec: 600 }))
      const key = `${machine}|${row?.origin ?? 'local'}`
      const session = pool.getOrCreate(key, () => row
        ? new WsPtyChannel(`${row.origin.replace(/^http/, 'ws')}${PTY_EXEC_PATH}`, { cookie: cookieOf(row.id, home) })
        : new LocalScriptChannel())
      const result = await session.dispatch(cmd, opts)
      log?.('info', 'exec.pty.run', { machine, cmd: cmd.slice(0, 120), exit: result.exit ?? 'none', durationMs: result.durationMs })
      return result
    },
  }
  return {
    face,
    async releaseOwner(owner: string) {
      const pool = owners.get(owner)
      if (pool) { await pool.disposeAll(); if (owners.get(owner) === pool) owners.delete(owner) }
    },
    async dispose() { closed = true; await Promise.all([...owners.values()].map(p => p.disposeAll())); owners.clear() },
  }
}

export function createHubRemoteTransport(home: string, log?: A2aLogFn): HubRemoteTransport & { dispose(): Promise<void> } {
  const exec = createHubExec(home, log)
  let closed = false
  const released = new Set<string>()
  const fileAbort = new AbortController()
  const files = new Set<Promise<void>>()
  const processes = new Map<string, Set<RemoteProcess>>()
  const pending = new Map<string, Set<Promise<unknown>>>()
  const requireRemote = (machine: string) => {
    if (!machine || machine === exec.face.selfM4()) throw new Error('Select a remote machine from the Hub roster; local execution is not available through remote')
  }
  const track = async <T>(owner: string, work: Promise<T>): Promise<T> => {
    let set = pending.get(owner)
    if (!set) pending.set(owner, set = new Set())
    set.add(work)
    try { return await work } finally { set.delete(work); if (!set.size) pending.delete(owner) }
  }
  return {
    protocol: 1,
    listTargets: () => listRemotes(home).filter(r => r.id !== exec.face.selfM4()).map(r => ({ id: r.id, label: r.name, execEnabled: r.enabled && r.execEnabled !== false })),
    async start(machine: string, input: PreparedRemoteInput, owner: string): Promise<RemoteProcess> {
      requireRemote(machine)
      const parsed = parseOneShotExecBody({ cmd: input.cmd, ...(input.stdin === undefined ? {} : { stdin: input.stdin }), ...(input.timeout === undefined ? {} : { timeoutSec: input.timeout }) })
      if (!parsed.ok) throw new Error(parsed.error)
      if (closed || released.has(owner)) throw new Error('Hub remote owner disposed')
      const row = listRemotes(home).find(r => r.id === machine)
      if (!row) throw new Error(`unknown machine "${machine}"`)
      if (!row.enabled || row.execEnabled === false) throw new Error(`exec is disabled for machine "${machine}"`)
      const process = startRemoteProcess(row.origin, cookieOf(row.id, home) ?? '', input, owner)
      let set = processes.get(owner)
      if (!set) processes.set(owner, set = new Set())
      set.add(process)
      void process.done.then(() => { set!.delete(process); if (!set!.size) processes.delete(owner) })
      return process
    },
    async pty(machine, cmd, owner, options) {
      requireRemote(machine)
      if (closed || released.has(owner)) throw new Error('Hub remote owner disposed')
      const { output, ...result } = await track(owner, exec.face.pty(owner, machine, cmd, { timeoutSec: options.timeout, stdin: options.stdin }))
      return { mode: 'pty', target: `hub:${machine}`, ...result, stdout: output }
    },
    fileEndpoint(machine) {
      requireRemote(machine)
      return createRemoteFileEndpoint(() => {
        if (closed) throw new Error('Hub remote provider disposed')
        const row = listRemotes(home).find(r => r.id === machine)
        if (!row) throw new Error(`unknown machine "${machine}"`)
        if (!row.enabled || row.execEnabled === false) throw new Error(`exec is disabled for machine "${machine}"`)
        return { origin: row.origin, cookie: cookieOf(row.id, home) ?? '' }
      }, fileAbort.signal, done => { files.add(done); void done.finally(() => files.delete(done)) })
    },
    async releaseOwner(owner) {
      released.add(owner)
      const owned = [...processes.get(owner) ?? []]
      for (const process of owned) process.cancel('owner released')
      await Promise.all([exec.releaseOwner(owner), ...owned.map(p => p.done), ...pending.get(owner) ?? []])
    },
    async dispose() {
      closed = true
      fileAbort.abort(new Error('Hub file provider disposed'))
      await Promise.allSettled([...files])
      const owned = [...processes.values()].flatMap(s => [...s])
      for (const process of owned) process.cancel('provider disposed')
      await exec.dispose()
      await Promise.allSettled([...owned.map(p => p.done), ...[...pending.values()].flatMap(s => [...s])])
    },
  }
}
