/**
 * `ssh` — the model-facing remote tool (plan
 * docs/10_plans/2026-09-22-dashr-remote-tool-rm0.md Task 9, Ruling 9 entry
 * principle: this tool is an entry + prep face only; file reading/editing on
 * the remote stays shell work for the model's own local tools).
 *
 * One tool, four dispatches on the `{target, cmd}` matrix:
 * - neither      → target list (`formatTargets` render, no dialing)
 * - target only  → status report; `bind: true` makes it the session default first
 * - cmd only     → exec on the session's bound target (R5 zero-routing),
 *                  E_NO_BINDING with a bind hint when none is set
 * - both         → exec that target (binding not required, never mutated)
 *
 * The tool layer owns the Ruling-10 session audit (`dashr/remote-exec`) for
 * resolved AND errored exec attempts — the engine's onAudit only fires on
 * resolved outcomes. Appends are wrapped: a session hiccup must never break
 * the command path.
 *
 * `stdin` is passed through to the engine uncomposed. On the PTY path the
 * session writes it raw right after the compound command (the compound occupies
 * the PTY input buffer first; a process it starts reads the stdin lines —
 * REPL-style, best effort). On the degraded exec path the engine keeps the
 * pre-existing wire composition (`cmd + "\n" + stdin` inside the bash -lc
 * string) — the disclosed RM0 limitation.
 *
 * @module dashr/remote/tool
 */

import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
// Type-only: pulls the `dashr/remote-exec` SessionEventMap merge below into
// this program (same pattern the mobile row uses for webserver events).
import type {} from '@deepseek-ai/dsh-session/types'
import { formatTargets } from './preparation.ts'
import type { ExecOutcome } from './backend.ts'
import type { RemoteEngine } from './engine.ts'

/** Session audit record appended by the {@link createSshTool} exec path. */
export interface SshExecAudit {
  /** Target the command ran on (absent when binding itself failed). */
  target?: string
  /** The model's `cmd` as sent — stdin is threaded separately, never composed into it. */
  cmd?: string
  /** Working directory after the command (`cwdAfter`, when known). */
  cwd?: string
  /** Exit code; `null` when the channel died mid-command. */
  exit?: number | null
  durationMs?: number
  /** Error message for failed attempts (audit for resolved execs alone is not enough). */
  error?: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Ruling-10 remote exec audit (success and failure), appended by the `ssh` tool. */
    'dashr/remote-exec': SshExecAudit
  }
}

/** The canonical value shape declared by the tool's output schema. */
interface SshToolValue {
  kind: 'exec' | 'status' | 'targets'
  /** Model-facing text: command output / formatted status / formatted targets. */
  text: string
  exit?: number | null
  durationMs?: number
  stderr?: string
  interrupted?: boolean
  truncated?: number
  cwd?: string
}

/** Fallback session key when the dispatch carries no agent (direct tests, API calls). */
const NO_SESSION_KEY = 'dashr-remote:no-session'

/** Where the output ends and the footer begins. */
function execFooter(value: Pick<SshToolValue, 'exit' | 'durationMs' | 'interrupted' | 'truncated'>): string {
  const seconds = ((value.durationMs ?? 0) / 1000).toFixed(1)
  const markers: string[] = []
  if (value.interrupted) markers.push('interrupted')
  if (value.truncated !== undefined) markers.push(`truncated, original ${value.truncated} chars`)
  const suffix = markers.length > 0 ? ` · ${markers.join(' · ')}` : ''
  return `[exit ${value.exit} · ${seconds}s${suffix}]`
}

/**
 * Build the model-facing `ssh` tool around one engine. The session key
 * defaults to the dispatching agent's id (falling back to one shared constant
 * for agent-less calls), so concurrent agents never see each other's bound
 * target.
 */
export function createSshTool(
  engine: RemoteEngine,
  opts: { getSessionKey?: (exec: ToolRunContext) => string } = {},
): ToolDefinition {
  const getSessionKey = opts.getSessionKey ?? ((exec: ToolRunContext) => exec.agent?.id ?? NO_SESSION_KEY)

  return defineTool({
    name: 'ssh',
    description:
      'Run commands on a prepared remote target over SSH. The environment persists across calls: a login shell ' +
      '(bash -lc) keeps its cwd and environment between calls, so `cd` once and later calls land in the same ' +
      'place. Dispatch: `ssh({})` lists known targets; `ssh({ target })` reports that target\'s status (user, ' +
      'cwd, toolchain versions, sudo capability, RTT) without running anything; `ssh({ target, cmd })` runs one ' +
      'raw shell string parsed by the remote bash (multi-line allowed — it runs as a single compound and the ' +
      'exit code is the last command\'s); `ssh({ cmd })` rides this session\'s ' +
      'bound default target — bind one first with `ssh({ target, bind: true })`. `timeout` (seconds) caps a ' +
      'single command; `stdin` is fed as raw input right after the command on the persistent session (REPL-style ' +
      '— only works when cmd actually reads stdin; treated as best effort). This tool is an entry point, not a file ' +
      'API: read and edit remote files through shell (`cat -n`, `sed -i`, `rg`) — searching and editing are ' +
      'your own skills. Hosts, keys and ports stay in the server-side registry and never appear here.',
    parameters: {
      target: {
        type: 'string',
        description: 'Logical remote target name from `ssh({})` (never a hostname). Omit to use the bound default.',
      },
      cmd: {
        type: 'string',
        description: 'One raw shell string, parsed by the remote bash; persists cwd/env changes for later calls.',
      },
      bind: {
        type: 'boolean',
        description: 'With target: make it this session\'s default for later cmd-only calls.',
      },
      timeout: {
        type: 'number',
        description: 'Command timeout in seconds (default: the server\'s configured budget).',
      },
      stdin: {
        type: 'string',
        description: 'Fed as raw input right after the command on the persistent session; requires cmd. Best effort: ' +
          'only meaningful when cmd actually reads its stdin.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, enum: ['exec', 'status', 'targets'] },
          text: { type: 'string', required: true },
          exit: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          durationMs: { type: 'integer' },
          stderr: { type: 'string' },
          interrupted: { type: 'boolean' },
          truncated: { type: 'integer' },
          cwd: { type: 'string' },
        },
      },
      render: (_args, value): ContentBlock[] => {
        const v = value as SshToolValue
        return [{ type: 'text', text: renderValue(v) }]
      },
    },
    async execute(args, exec): Promise<SshToolValue> {
      const sessionKey = getSessionKey(exec)
      const target = args.target
      const hasTarget = target !== undefined && target.length > 0
      const hasCmd = args.cmd !== undefined && args.cmd.length > 0
      const stdin = args.stdin

      if (stdin !== undefined && !hasCmd) {
        throw new Error(
          '[E_STDIN_WITHOUT_CMD] ssh: stdin requires cmd — pass the command that consumes the input, ' +
            'e.g. ssh({ target, cmd: "python3", stdin: "..." })',
        )
      }

      // Timeout 必须是正的有限秒数（Minor 11：0/负数/Infinity 此前会一路透传成
      // 0ms/neg ms/Infinity ms 的看门狗，行为不可预期）。dispatch 前拒绝，
      // 未拨号未执行。
      if (args.timeout !== undefined && (!Number.isFinite(args.timeout) || args.timeout <= 0)) {
        throw new Error(
          `[E_BAD_TIMEOUT] ssh: timeout must be a positive number of seconds (got ${JSON.stringify(args.timeout)})`,
        )
      }

      // Neither target nor cmd → the targets list (no dialing).
      if (!hasTarget && !hasCmd) {
        return { kind: 'targets', text: formatTargets(engine.summary()) }
      }

      // R5: bind:true with a target always (re)binds — before status or exec.
      if (target !== undefined && target.length > 0 && args.bind === true) engine.bind(sessionKey, target)

      // Target only → status report (never opens a session).
      if (args.cmd === undefined || args.cmd.length === 0) {
        // The combined guard above already returned when neither target nor cmd
        // was present, so target is defined whenever this branch runs.
        return { kind: 'status', text: await engine.status(target as string) }
      }
      const cmd = args.cmd

      const execTarget = target !== undefined && target.length > 0 ? target : engine.boundTarget(sessionKey)
      try {
        if (execTarget === undefined) {
          throw new Error(
            '[E_NO_BINDING] no default remote target bound for this session; call ssh({ target, bind: true }) ' +
              'first to bind one, or pass target explicitly — ssh({}) lists known targets',
          )
        }
        // stdin 原样透传（不再在工具层拼进 cmd）：PTY 路径由会话层紧随复合命令裸写，
        // 降级路径由 engine 保留既有的 wire 拼接（披露过的 best-effort 语义）。
        const outcome = await engine.exec(execTarget, cmd, {
          timeoutMs: args.timeout !== undefined ? args.timeout * 1_000 : undefined,
          signal: exec.signal,
          stdin,
        })
        appendAudit(exec, {
          target: execTarget,
          cmd,
          cwd: outcome.cwdAfter,
          exit: outcome.exitCode,
          durationMs: outcome.durationMs,
        })
        const value: SshToolValue = {
          kind: 'exec',
          text: outcome.output,
          exit: outcome.exitCode,
          durationMs: outcome.durationMs,
        }
        if (outcome.stderr !== undefined && outcome.stderr.length > 0) value.stderr = outcome.stderr
        if (outcome.interrupted === true) value.interrupted = true
        if (outcome.truncated !== undefined) value.truncated = outcome.truncated
        if (outcome.cwdAfter !== undefined) value.cwd = outcome.cwdAfter
        return value
      } catch (error) {
        appendAudit(exec, {
          ...(execTarget !== undefined ? { target: execTarget } : {}),
          cmd,
          error: error instanceof Error ? error.message : String(error),
        })
        throw error
      }
    },
  })
}

/** Pure render: exec output + `[exit N · Xs]` footer (+ stderr block); status/targets verbatim. */
function renderValue(value: SshToolValue): string {
  if (value.kind !== 'exec') return value.text
  const parts = [value.text, execFooter(value)]
  if (value.stderr !== undefined) parts.push('[stderr]', value.stderr)
  return parts.join('\n')
}

/** Ruling 10: append once per exec attempt; a session hiccup never breaks the command path. */
function appendAudit(exec: ToolRunContext, data: SshExecAudit): void {
  try {
    exec.agent?.session.append('dashr/remote-exec', data)
  } catch {
    // Audit is best-effort by contract.
  }
}
