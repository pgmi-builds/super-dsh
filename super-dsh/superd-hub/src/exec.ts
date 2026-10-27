// One-shot remote execution (spec §8.1, P4): `bash -lc <cmd>` exactly once,
// per-stream tail windows in the response, hard ring retention behind them,
// two-stage group kill on timeout. This module is the EXECUTING side (used by
// the /api/superd/exec endpoint) and the WIRE leg (used by the initiator-side
// tool); it never decides policy — auth is the shared /api fence's, and the
// initiator-side per-machine knob lives on the caller's registry row.
//
// Output discipline (0.3.2-e): return output IN FULL up to the 4MiB retention ring;
// each stream, retain at most 4M per stream while running (the tail of a
// capped ring is still the tail of the stream), mark `truncated` whenever a
// stream's total exceeded what is returned. Kill discipline: SIGTERM to the
// process GROUP, 2s grace, SIGKILL to the group — `bash -lc` children must
// not outlive their parent's timeout.
import { spawn } from 'node:child_process'
import { ByteTailRing, type StreamOutputStats } from '../../remote/plugin.js'
import type { A2aLogFn } from './a2a-log.js'

/** Shared-channel Fetch route path this API owns. */
export const EXEC_API_BASE = '/api/superd/exec'

export interface OneShotExecInput {
  cmd: string
  stdin?: string
  cwd?: string
  timeoutSec?: number
}

export interface OneShotExecResult {
  exit: number | null
  stdout: string
  stderr: string
  durationMs: number
  truncated: boolean
  outputStats?: StreamOutputStats
  timedOut: boolean
  /**
   * Why the process ended (0.1.7-e, first-person finding F1/F2: `exit:null`
   * alone conflated spawn failure with signal death):
   * `exited` — normal exit (exit carries the code);
   * `signaled` — died by a signal we did not send (exit null);
   * `timeout` — OUR two-stage kill fired (timedOut true);
   * `spawn-error` — the process never started (bad cwd / ENOENT); the
   *   diagnostic rides stderr as `exec: spawn failed — <reason>`.
   */
  outcome: 'exited' | 'signaled' | 'timeout' | 'spawn-error'
}

/** 0.3.2-e: the 30K returned-tail window is REMOVED — output returns in full up to
 * retention and model-context sizing is the native agent runtime's job (spill policy
 * or its foreign equivalent). Retention below stays the memory-safety bound. */
/** Hub oneshot per-stream raw-byte retention: 4MiB, distinct from native/PTy UTF16 caps. */
export const EXEC_RING_HARD_CAP = 4 * 1024 * 1024
export const EXEC_DEFAULT_TIMEOUT_SEC = 120
export const EXEC_MAX_TIMEOUT_SEC = 600
const CMD_MAX_CHARS = 4096
const KILL_GRACE_MS = 2_000

export type OneShotExecParsed =
  | { ok: true, value: OneShotExecInput }
  | { ok: false, error: string }

/**
 * Validate an exec request body (endpoint and tool share the exact rules):
 * non-empty `cmd` (≤4096 chars), optional absolute `cwd`, optional integer
 * `timeoutSec` in [1, 600].
 */
export function parseOneShotExecBody(body: unknown): OneShotExecParsed {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'exec: request body must be a JSON object' }
  }
  const raw = body as Record<string, unknown>
  if (typeof raw.cmd !== 'string' || raw.cmd.trim() === '') {
    return { ok: false, error: 'exec: cmd must be a non-empty string' }
  }
  if (raw.cmd.length > CMD_MAX_CHARS) {
    return { ok: false, error: `exec: cmd exceeds ${CMD_MAX_CHARS} characters` }
  }
  if (raw.cwd !== undefined && (typeof raw.cwd !== 'string' || !raw.cwd.startsWith('/') || raw.cwd.includes('\0'))) {
    return { ok: false, error: 'exec: cwd must be an absolute path' }
  }
  if (raw.timeoutSec !== undefined && (typeof raw.timeoutSec !== 'number' || !Number.isInteger(raw.timeoutSec) || raw.timeoutSec < 1 || raw.timeoutSec > EXEC_MAX_TIMEOUT_SEC)) {
    return { ok: false, error: `exec: timeoutSec must be an integer in [1, ${EXEC_MAX_TIMEOUT_SEC}]` }
  }
  if (raw.stdin !== undefined && typeof raw.stdin !== 'string') return { ok: false, error: 'exec: stdin must be a string' }
  const known = new Set(['cmd', 'cwd', 'timeoutSec', 'stdin'])
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) return { ok: false, error: `exec: unknown field "${key}"` }
  }
  return {
    ok: true,
    value: {
      cmd: raw.cmd,
      ...(raw.stdin === undefined ? {} : { stdin: raw.stdin }),
      ...(raw.cwd === undefined ? {} : { cwd: raw.cwd }),
      ...(raw.timeoutSec === undefined ? {} : { timeoutSec: raw.timeoutSec }),
    },
  }
}

/**
 * Execute one command locally: `bash -lc <cmd>`, detached into its own
 * process group so the timeout's group kill cannot leak to the hub process.
 */
export async function runOneShotExec(input: OneShotExecInput, log?: A2aLogFn): Promise<OneShotExecResult> {
  const started = Date.now()
  const stdout = new ByteTailRing(EXEC_RING_HARD_CAP)
  const stderr = new ByteTailRing(EXEC_RING_HARD_CAP)
  const timeoutSec = input.timeoutSec ?? EXEC_DEFAULT_TIMEOUT_SEC
  let terminationRequested = false
  const child = spawn('bash', ['-lc', input.cmd], {
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdin.on('error', () => { /* EPIPE on early exit: process outcome is authoritative. */ })
  child.stdin.end(input.stdin)
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
  let graceTimer: NodeJS.Timeout | undefined
  const killTimer = setTimeout(() => {
    terminationRequested = true
    try {
      if (child.pid !== undefined) process.kill(-child.pid, 'SIGTERM')
    } catch { /* already gone */ }
    graceTimer = setTimeout(() => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
      } catch { /* already gone */ }
    }, KILL_GRACE_MS)
    if (graceTimer.unref) graceTimer.unref()
  }, timeoutSec * 1000)
  if (killTimer.unref) killTimer.unref()

  let spawnError: string | undefined
  const exit: number | null = await new Promise((resolve) => {
    child.once('close', (code) => resolve(code))
    child.once('error', (err) => { spawnError = err.message; resolve(null) })
  })
  clearTimeout(killTimer)
  if (graceTimer !== undefined) clearTimeout(graceTimer)
  const outTail = stdout.tail(), errTail = stderr.tail()
  const outText = outTail.toString('utf8')
  const errText = spawnError !== undefined
    ? `exec: spawn failed — ${spawnError}${input.cwd === undefined ? '' : ` (cwd: ${input.cwd})`}`
    : errTail.toString('utf8')
  const timedOut = terminationRequested
  const outcome: OneShotExecResult['outcome'] = spawnError !== undefined
    ? 'spawn-error'
    : timedOut
      ? 'timeout'
      : exit === null
        ? 'signaled'
        : 'exited'
  const result: OneShotExecResult = {
    exit,
    stdout: outText,
    stderr: errText,
    durationMs: Date.now() - started,
    truncated: stdout.total > outTail.length || stderr.total > errTail.length, // 0.3.2-e: true 仅当 retention 驱逐（>4MiB）
    outputStats: { stdout: stdout.stats(outTail.length), stderr: stderr.stats(errTail.length) },
    timedOut,
    outcome,
  }
  log?.('info', 'exec.run', {
    cmd: input.cmd,
    exit: result.exit ?? 'none',
    durationMs: result.durationMs,
    ...(outcome === 'exited' ? {} : { outcome }),
    ...(result.timedOut ? { timedOut: true } : {}),
    ...(result.truncated ? { truncated: true } : {}),
  })
  return result
}

/** Cross-machine wire leg: POST the exec request to a paired hub (cookie rides, a2a envelope pattern). */
export async function postOneShotExec(
  origin: string,
  input: OneShotExecInput,
  opts: { cookie?: string, fetchImpl?: typeof fetch, timeoutMs?: number } = {},
): Promise<OneShotExecResult> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const cookie = opts.cookie ?? ''
  const budgetMs = (input.timeoutSec ?? EXEC_DEFAULT_TIMEOUT_SEC) * 1000 + 15_000
  let res: Response
  try {
    res = await fetchImpl(`${origin}${EXEC_API_BASE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie === '' ? {} : { cookie }) },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(opts.timeoutMs ?? budgetMs),
    })
  } catch (err) {
    throw new Error(`exec: peer unreachable — ${err instanceof Error ? err.message : String(err)}`)
  }
  const body = await res.json().catch(() => undefined as unknown)
  if (res.status !== 200) {
    const message = typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : `exec: peer answered status ${res.status}`
    throw new Error(message)
  }
  if (typeof body !== 'object' || body === null) throw new Error('exec: peer answered a non-object body')
  const raw = body as Record<string, unknown>
  const exit: number | null = typeof raw.exit === 'number' || raw.exit === null ? (raw.exit as number | null) : null
  const timedOut = raw.timedOut === true
  const parsedOutcome = raw.outcome
  const outcome: OneShotExecResult['outcome'] =
    parsedOutcome === 'exited' || parsedOutcome === 'signaled' || parsedOutcome === 'timeout' || parsedOutcome === 'spawn-error'
      ? parsedOutcome
      // a pre-0.1.7-e peer carries no outcome — derive the closest honest read
      : timedOut ? 'timeout' : exit === null ? 'signaled' : 'exited'
  return {
    exit,
    stdout: typeof raw.stdout === 'string' ? raw.stdout : '',
    stderr: typeof raw.stderr === 'string' ? raw.stderr : '',
    durationMs: typeof raw.durationMs === 'number' ? raw.durationMs : 0,
    truncated: raw.truncated === true,
    timedOut,
    outcome,
    ...(parseOutputStats(raw.outputStats) === undefined ? {} : { outputStats: parseOutputStats(raw.outputStats) }),
  }
}


/** Older peers omit metrics: do not derive exact totals from their returned tail. */
function parseOutputStats(value: unknown): StreamOutputStats | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const valid = (stats: unknown): stats is StreamOutputStats['stdout'] => {
    if (typeof stats !== 'object' || stats === null) return false
    const s = stats as StreamOutputStats['stdout']
    return (s.unit === 'bytes' || s.unit === 'utf16') && [s.total, s.retained, s.dropped, s.returned, s.retentionLimit].every(n => Number.isSafeInteger(n) && n >= 0)
      && s.total === s.retained + s.dropped && s.retained <= s.retentionLimit && s.returned <= s.retained
  }
  if (!valid(raw.stdout) || (raw.stderr !== undefined && !valid(raw.stderr))) return undefined
  return { stdout: raw.stdout, ...(raw.stderr === undefined ? {} : { stderr: raw.stderr as StreamOutputStats['stdout'] }) }
}
