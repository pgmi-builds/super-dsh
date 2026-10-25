import { createRemoteFileEndpoint } from './remote-file-rpc.js'
import { startRemoteProcess } from './remote-job-client.js'
/** Hub transport implementation. HTTP/WS/pool mechanics stay in the existing exec modules. */
import { type HubRemoteTransport, type PreparedRemoteInput, type RemoteProcess, PtySession, buildHubPtyArgv, hubPtyAssets } from '../../remote/plugin.js'

// ws 模块绝对路径：在 superd-hub 上下文解析（分叉的 proven 链——闭包/泵子树解析不到，
// 0.3.2-c 定稿：按名解析只在 transport 侧做一次，经 ptyEndpoint/argv 下传）。
const wsModulePath = (): string => {
  try {
    return createRequire(import.meta.url).resolve('ws')
  } catch (error) {
    throw new Error(`[E_HUB_PTY_SETUP] superd-hub: the ws module could not be resolved from the hub tree — hub PTY spawns a local pump child that opens the peer WebSocket with ws; ${error instanceof Error ? error.message : String(error)}`)
  }
}
import type { HubToolExecFace } from './hub-tool.js'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { ensureSelf, listRemotes } from './machines.js'
import { cookieOf } from './mesh-link.js'
import { runOneShotExec, postOneShotExec, parseOneShotExecBody } from './exec.js'
import { PTY_EXEC_PATH } from './exec-pty-rpc.js'
import type { A2aLogFn } from './a2a-log.js'

/** One shared initiator implementation for legacy tool and the optional remote service. */
export function createHubExec(home: string, log?: A2aLogFn) {
  // 0.3.2-c（Q2）：分叉 exec-pty-session 已删——本 face 与 remote 工具共用 canonical
  // PtySession（闭包导出）。per-owner 每机器一个持久 shell（A2A 语义保持：cwd/env 跨调用存活；
  // dead → dispatch 内部重连 = 旧 markDead/重启；disposed → 下次调用重建）。
  const owners = new Map<string, Map<string, PtySession>>()
  let closed = false
  const assertOpen = () => { if (closed) throw new Error('Hub transport unavailable — provider has been disposed') }
  const remote = (machine: string) => {
    assertOpen()
    const row = listRemotes(home).find(r => r.id === machine)
    if (!row) throw new Error(`unknown machine "${machine}" — call roster for remote machines`)
    if (!row.enabled || row.execEnabled === false) throw new Error(`exec is disabled for machine "${machine}" on this registry row (enabled/execEnabled=false)`)
    return row
  }
  const genCommandId = (): string => `remote-${randomUUID().replace(/-/g, '').slice(0, 16)}`
  const createPtySession = (machine: string, row: ReturnType<typeof remote> | undefined, owner: string): PtySession => new PtySession({
    key: `${owner}|hub-pty:${machine}`,
    argv: row === undefined
      ? ['script', '-qfec', 'bash', '/dev/null']
      : buildHubPtyArgv({ url: `${row.origin.replace(/^http/, 'ws')}${PTY_EXEC_PATH}`, cookie: cookieOf(row.id, home) ?? '', wsPath: wsModulePath() }, hubPtyAssets()),
    id: `p-${randomUUID().slice(0, 8)}`,
    connection: row === undefined ? 'local' : `hub:${machine}`,
    idleTtlSec: 900,
  })
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
      if (!pool) owners.set(owner, pool = new Map())
      const attempt = async (session: PtySession) => {
        const r = await session.dispatch(cmd, { stdin: opts.stdin, timeoutSec: opts.timeoutSec, commandId: genCommandId() })
        // P4 handoff（超时不杀）对 A2A 面保持旧语义：显式两段 ^C 后等帧结算——分叉自动中断的等价物。
        if (r.running === true && r.job !== undefined) {
          r.job.interrupt()
          const settled = await r.job.done
          return { output: settled.output, outputStats: settled.outputStats, exit: settled.exit, cwd: settled.cwd, timedOut: true, reconnected: r.reconnected, durationMs: r.durationMs, commandId: r.commandId }
        }
        return r
      }
      const settle = (result: Awaited<ReturnType<typeof attempt>>) => {
        log?.('info', 'exec.pty.run', { machine, cmd: cmd.slice(0, 120), exit: result.exit ?? 'none', durationMs: result.durationMs })
        return result
      }
      const existing = pool.get(machine)
      if (existing !== undefined && existing.sessionState !== 'disposed') return settle(await attempt(existing))
      const session = createPtySession(machine, row, owner)
      pool.set(machine, session)
      try {
        return settle(await attempt(session))
      } catch (err) {
        if (session.sessionState === 'disposed' && pool.get(machine) === session) pool.delete(machine) // init 失败/auto-dispose 不留死项
        throw err
      }
    },
  }
  return {
    face,
    async releaseOwner(owner: string) {
      const pool = owners.get(owner)
      if (pool) { await Promise.all([...pool.values()].map(s => s.dispose())); owners.delete(owner) }
    },
    async dispose() { closed = true; await Promise.all([...owners.values()].flatMap(p => [...p.values()].map(s => s.dispose()))); owners.clear() },
  }
}

export function createHubRemoteTransport(home: string, log?: A2aLogFn): HubRemoteTransport & { dispose(): Promise<void> } {
  const exec = createHubExec(home, log)
  let closed = false
  const released = new Set<string>()
  const fileAbort = new AbortController()
  const files = new Set<Promise<void>>()
  const processes = new Map<string, Set<RemoteProcess>>()
  const requireRemote = (machine: string) => {
    if (!machine || machine === exec.face.selfM4()) throw new Error('Select a remote machine from the Hub roster; local execution is not available through remote')
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
    ptyEndpoint(machine) {
      requireRemote(machine)
      if (closed) throw new Error('Hub remote provider disposed')
      const row = listRemotes(home).find(r => r.id === machine)
      if (!row) throw new Error(`unknown machine "${machine}"`)
      if (!row.enabled || row.execEnabled === false) throw new Error(`exec is disabled for machine "${machine}"`)
      // P10：创建与每次 dispatch 都重取本端点（driver 侧调用）——pairing 复用不豁免。
      return { url: `${row.origin.replace(/^http/, 'ws')}${PTY_EXEC_PATH}`, cookie: cookieOf(row.id, home) ?? '', wsPath: wsModulePath() }
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
      await Promise.all([exec.releaseOwner(owner), ...owned.map(p => p.done)])
    },
    async dispose() {
      closed = true
      fileAbort.abort(new Error('Hub file provider disposed'))
      await Promise.allSettled([...files])
      const owned = [...processes.values()].flatMap(s => [...s])
      for (const process of owned) process.cancel('provider disposed')
      await exec.dispose()
      await Promise.allSettled([...owned.map(p => p.done)])
    },
  }
}
