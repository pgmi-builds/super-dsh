/**
 * The SuperD Hub tool (mesh P3 Task 4, spec §9 / D13): ONE model-facing
 * surface — `superd-hub` — that makes A2A callable from a DSH session.
 * Sub-capabilities ride a call-shape dispatch (the `remote` tool's
 * better-dash discipline: one attention entry, empty/`agents` as the
 * roster probe, everything else a `{action}` leg).
 *
 * This module is the PURE factory: no cordis, no filesystem — the service,
 * delivery face, roster view, initiator factory, and watch ownership are all
 * injected (`{@link HubToolDeps}`), so the full dispatch is unit-testable
 * against fakes. The row wiring lives in `a2a-row.ts`.
 *
 * Upstream anchors (`upstream/deepseek-harness` @ dsh-v0.1.7-rc.1):
 *   - tool registration: `@deepseek-ai/dsh-tools` `defineTool` — parameters
 *     as the implicit property map, `output {schema, render}` with the
 *     successful value validated against the declared schema; the registry
 *     scopes `tools.register` to the calling fiber (better-dsh `plugin.ts`
 *     precedent: zero static injects, dormant without a `tools` service).
 *   - initiator identity: `ToolExecutionInput.agent?: Agent`
 *     (dsh-tools/src/index.ts:365) and `Agent.id: SessionId`
 *     (dsh-agent/src/types.ts:16) — the session-backed Agent identity IS the
 *     live session id, so `exec.agent.id` threads straight into Task 3's
 *     `localA2aInitiator` (unread-buffer key + delivery routing key).
 *
 * Semantics rulings baked in (spec §7.2/§7.3, D9/D13):
 *   - NEVER poll: after `send` the hub subscribes the peer conversation's
 *     completion (`wireCompletionToDelivery`) and the reply auto-delivers
 *     into the calling session; `read` only sweeps what was buffered while
 *     the initiator was not live. The description states this in caps.
 *   - `delivery` mirrors upstream `SessionPromptRequest.mode`: 'queue'
 *     (default) is queued peer input delivered as a waking turn, never interrupting; 'steer' is
 *     explicit steering for the peer's nearest step boundary.
 *   - `stop` is a hard stop of the peer's ACTIVE TURN; scope 'session'
 *     degrades to turn-only (upstream has no session-close RPC) and the
 *     conversation stays resumable — send again resumes it.
 *   - `exec` is the P4 placeholder leg: `"not yet implemented: exec (P4)"`.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { A2aDeliveryCtx } from './a2a-delivery.js' // (wireCompletionToDelivery retired in R4 — replies ride reply/notice envelopes through the ingest)
import type { AgentLink } from './agent-roster.js'
import type { AgentStatusFile } from './agent-status.js'
import { parseOneShotExecBody, EXEC_TAIL_WINDOW, type OneShotExecInput, type OneShotExecResult } from './exec.js'
import { tailWindow } from './exec-pty-framing.js'

/** P4 exec face (spec §8.1): the executing side + the wire leg, closed over the hub home by a2a-row. */
export interface HubToolExecFace {
  /** This machine's m4 (the default exec target). */
  selfM4(): string
  /** Run one command on THIS machine. */
  run(input: OneShotExecInput): Promise<OneShotExecResult>
  /** Run one command on a paired machine over the wire. Throws typed Errors: unknown machine / exec disabled / peer unreachable. */
  post(machineId: string, input: OneShotExecInput): Promise<OneShotExecResult>
  /**
   * P4 §8.2 persistent PTY: dispatch one command into a per-(session,
   * machine) shell that KEEPS its cwd/env across dispatches. Throws typed
   * Errors: unknown machine / exec disabled / transport failure.
   */
  pty(sessionKey: string, machine: string, cmd: string, opts?: { timeoutSec?: number; stdin?: string }): Promise<import('./exec-pty-session.js').PtyDispatchResult>
}
import type {
  A2aAddress,
  A2aBufferedMessage,
  A2aInitiator,
  A2aService,
} from './a2a-service.js'
// F2 (0.1.7-n, PC 0.1.7-m first-person): the wire/registry sentinel stays
// '[undefined]', but the DISPLAY surface must not show it to a human — D17
// already sanctions display-layer beautification.
import { A2A_UNTITLED } from './a2a-service.js'
import { A2A_TITLE_PLACEHOLDER } from './a2a-wire.js'

/** The service face the tool consumes (structural subset of T2/T3's A2aService). */
export type HubToolService = Pick<
  A2aService,
  'send' | 'subscribeCompletion' | 'stop' | 'read' | 'listConversations'
>

/** Per-agent recent-conversation bound (spec §7.2: alive-first, ≤5). */
/** R6: retired from the agents listing (the strip); kept exported for compat — agent_status windows AGENT_STATUS_WINDOW_MAX rows instead. */
export const RECENT_CONVERSATIONS_MAX = 5

/** The exec placeholder note (P4 owns the leg; spec §9 placeholder discipline). */
export const EXEC_PLACEHOLDER_NOTE = 'not yet implemented: exec (P4)'

/** One addressable agent row in the listing (R6: THIN — the conversations embedding is retired; per-agent session state lives on the agent_status leg). */
export type HubAgentEntry = {
  /** Agent id (a6). */
  id: string
  /** Chip label (`DSH`, `Codex · dev3`, …). */
  label: string
  /** Full tool address `<m4>-<a6>` — what the `agent` parameter wants. */
  address: string
  /** Whether the agent's data plane is up. */
  ready: boolean
  /** Whether the agent's spawn rejected (row stays for diagnosis). */
  failed: boolean
}

/** One machine block: its agents grouped under it. */
export type HubMachineEntry = {
  /** Machine id (m4). */
  machine: string
  /** Machine display label. */
  label: string
  /** Agents running on this machine (self's machine first, roster order). */
  agents: HubAgentEntry[]
}

/**
 * The roster view the `agents` listing renders — the `/api/agent-runtime`
 * family of facts (rpc.ts + agent-roster.ts), injected so the factory stays
 * filesystem-free.
 */
export interface HubRosterView {
  /** THIS machine: owner-minted m4 + display label (machines.ts `ensureSelf`). */
  self: { id: string; label: string }
  /** Paired remote machines in pairing order (machines.ts `listRemotes`). */
  remotes: { id: string; label: string }[]
  /** `agentLinks(home)` output: local rows carry `machine: 'local'`, federated rows the owning m4. */
  agents: AgentLink[]
}

/** Everything the factory needs, all injected (pure module — see header). */
export interface HubToolDeps {
  /** Explicit compatibility opt-in, never applied to receiving peer executors. */
  localExec?: boolean
  /** The A2A conversation service (T2 core behind T3's host assembly). */
  service: HubToolService
  /** T3's delivery face: live-agent routing + the bounded unread buffer. */
  delivery: A2aDeliveryCtx
  /** Roster snapshot for the `agents` listing (row: the real hub home view). */
  roster(): HubRosterView
  /**
   * P4 exec face (spec §8.1): the local executing side + the cross-machine
   * wire leg, closed over the hub home by a2a-row (self id, remote rows,
   * pairing cookies, journal). `post` throws typed Errors (unknown machine,
   * exec disabled on the row, peer unreachable).
   */
  exec: HubToolExecFace
  /**
   * Initiator identity for the calling session — the row closes this over
   * T3's `localA2aInitiator(home, 'native', sessionId)`. Called exactly once
   * per session-bound action, with `exec.agent.id`.
   */
  initiatorOf(sessionId: string): A2aInitiator
  /**
   * Owns one completion-watch disposer per successful send (the row parks it
   * in a fiber `ctx.effect`; requestId-armed watches self-dispose after
   * their turn fires). Absent = disposers dropped (happy path still leaks
   * nothing — the subscription auto-disposes on fire).
   */
  onWatch?(dispose: () => void): void
  /**
   * R6: the R5 information-status cache reader (the row wires
   * `() => loadAgentStatus(home)`); absent = agent_status answers honestly
   * empty with collectedAt 0.
   */
  status?(): AgentStatusFile
}

/** agent-roster.ts's LOCAL_MACHINE literal ('local') — local rows' grouping key, not a real m4. */
const LOCAL_MACHINE = 'local'

/** `<m4>-<a6>`: exactly 4 then 6 chars over the mint alphabet (machines.ts `ID_ALPHABET`). */
const AGENT_ADDRESS_PATTERN = /^[a-z0-9]{4}-[a-z0-9]{6}$/

/**
 * Parse the `agent` parameter: `<m4>-<a6>`. Both halves are minted over
 * `[a-z0-9]` (machines.ts `ID_ALPHABET`) at fixed lengths (m4 = 4, a6 = 6), so
 * a malformed address is refused HERE (0.1.8 T4) instead of being mis-split
 * into a bogus machine and reported downstream as "unknown machine" — the
 * `no-such-agent-zzz` → machine `no` is not paired trap the 0.1.7 surface
 * analysis flagged.
 * @param agent - the raw `agent` parameter.
 * @returns the address the service consumes.
 * @throws `[E_BAD_ADDRESS]` when the value is not a well-formed `<m4>-<a6>`.
 */
export function parseAgentAddress(agent: unknown): A2aAddress {
  if (typeof agent !== 'string' || !AGENT_ADDRESS_PATTERN.test(agent)) {
    throw new Error(`[E_BAD_ADDRESS] superd-hub: agent must be a "<m4>-<a6>" address — 4 chars, a hyphen, 6 chars, all [a-z0-9] (got ${JSON.stringify(agent)}); call the agents action to list the valid ids`)
  }
  const dash = agent.indexOf('-')
  return { machine: agent.slice(0, dash), id: agent.slice(dash + 1) }
}

/** The initiator for one exec — fail-loud without a live session (D9: replies NEED one to land in). */
function initiatorOfExec(deps: HubToolDeps, exec: ToolRunContext): A2aInitiator {
  const sessionId = exec.agent?.id
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new Error('[E_NO_SESSION] superd-hub: this tool call carries no agent session — A2A replies deliver into the calling session and cannot be routed without one')
  }
  return deps.initiatorOf(sessionId)
}

/** The `agents` listing: machines → agents, thin rows (R6 strip — session state lives on agent_status). */
function agentsListing(deps: HubToolDeps): { action: 'agents'; machines: HubMachineEntry[] } {
  const view = deps.roster()
  const agentsByMachine = new Map<string, HubAgentEntry[]>()
  for (const link of view.agents) {
    const machine = link.machine === LOCAL_MACHINE ? view.self.id : link.machine
    const list = agentsByMachine.get(machine) ?? []
    list.push({
      id: link.id,
      label: link.label,
      address: `${machine}-${link.id}`,
      ready: link.ready === true,
      failed: link.failed === true,
    })
    agentsByMachine.set(machine, list)
  }
  // Machine order: self first, then paired remotes in pairing order, then
  // any m4 that still has agents but no machines.json row (degraded pairing
  // state) — the listing never hides addressable agents.
  const machines: HubMachineEntry[] = [
    { machine: view.self.id, label: view.self.label, agents: agentsByMachine.get(view.self.id) ?? [] },
  ]
  const seen = new Set([view.self.id])
  for (const remote of view.remotes) {
    seen.add(remote.id)
    machines.push({ machine: remote.id, label: remote.label, agents: agentsByMachine.get(remote.id) ?? [] })
  }
  for (const machine of [...agentsByMachine.keys()].sort()) {
    if (!seen.has(machine)) machines.push({ machine, label: machine, agents: agentsByMachine.get(machine) ?? [] })
  }
  return { action: 'agents', machines }
}

/** The agent_status window size (Orchestra semantics — not-in-window implies nothing). */
export const AGENT_STATUS_WINDOW_MAX = 5

/** D18 marker appended to registry-joined titles. */
export const HUB_A2A_TITLE_MARKER = '[hub A2A]'

/** The honest fallback when neither the registry nor a workspace names the session. */
export const UNHOSTED_TITLE = '[unhosted]'

/** Display truncation: strip the `session-` prefix, take the uuid head (6 chars); the cache keeps full ids. */
function displaySessionId(sessionId: string): string {
  const base = sessionId.startsWith('session-') ? sessionId.slice('session-'.length) : sessionId
  return base.slice(0, 6)
}

/** One shaped agent_status row. */
export interface AgentStatusEntryRow {
  conversationId?: string
  /** Display-truncated session id (uuid head; the full id stays in the cache). */
  sessionId: string
  title: string
  status: 'busy' | 'idle' | 'unknown'
  agentAvailable: boolean
  mtime: number
  /** D30: the peer's last delivered output — present ONLY when the caller is this conversation's initiator (ownership gate). */
  lastOutput?: string
  /** D30: epoch ms of lastOutput. */
  lastOutputAt?: number
}

/**
 * Shape one agent's window from the R5 cache (D18): alive-first (a session
 * owning a live Agent first), mtime desc within each group, ≤5 rows —
 * not-in-window implies nothing. Title: registry join (full session id) →
 * `{conversationTitle} [hub A2A]`; else the owning workspace's title
 * verbatim; else '[unhosted]'. conversationId rides only on a registry hit.
 */
export function shapeAgentStatusWindow(
  entry: { rows: AgentStatusEntrySrcRow[]; workspaces?: Array<{ title: string; sessionIds: string[] }> },
  conversations: ReadonlyArray<{ shortId: string; sessionId: string; title?: string; initiatorSession?: string; lastOutput?: string; lastOutputAt?: number }>,
  /** D30 ownership gate: the caller's session — lastOutput is surfaced only to the conversation's initiator. */
  callerSessionId?: string,
): AgentStatusEntryRow[] {
  const bySession = new Map<string, { shortId: string; title?: string; initiatorSession?: string; lastOutput?: string; lastOutputAt?: number }>()
  for (const row of conversations) bySession.set(row.sessionId, row)
  const workspaceTitleOf = new Map<string, string>()
  for (const workspace of entry.workspaces ?? []) {
    for (const sessionId of workspace.sessionIds) workspaceTitleOf.set(sessionId, workspace.title)
  }
  const sorted = [...entry.rows].sort((a, b) => {
    const alive = Number(b.agentAvailable) - Number(a.agentAvailable)
    return alive !== 0 ? alive : b.mtime - a.mtime
  })
  return sorted.slice(0, AGENT_STATUS_WINDOW_MAX).map((row) => {
    const conversation = bySession.get(row.sessionId)
    const registryTitle = conversation?.title
    // F2: the sentinel (absent/empty/'[undefined]') renders as '(untitled)' here —
    // never '[undefined] [hub A2A]' in front of a human.
    const displayTitle = registryTitle === undefined || registryTitle === '' || registryTitle === A2A_TITLE_PLACEHOLDER
      ? A2A_UNTITLED
      : registryTitle
    const title = conversation !== undefined
      ? `${displayTitle} ${HUB_A2A_TITLE_MARKER}`
      : workspaceTitleOf.get(row.sessionId) ?? UNHOSTED_TITLE
    // D30: the peer's last output is the conversation's private business —
    // only its INITIATOR may read it through this facility.
    const ownedOutput = conversation !== undefined && callerSessionId !== undefined &&
      conversation.initiatorSession === callerSessionId && conversation.lastOutput !== undefined
      ? { lastOutput: conversation.lastOutput, ...(conversation.lastOutputAt === undefined ? {} : { lastOutputAt: conversation.lastOutputAt }) }
      : {}
    return {
      ...(conversation === undefined ? {} : { conversationId: conversation.shortId }),
      sessionId: displaySessionId(row.sessionId),
      title,
      status: row.status,
      agentAvailable: row.agentAvailable,
      mtime: row.mtime,
      ...ownedOutput,
    }
  })
}

/** The cache row face the shaper consumes (structural subset of AgentStatusRow). */
export interface AgentStatusEntrySrcRow {
  sessionId: string
  mtime: number
  status: 'busy' | 'idle' | 'unknown'
  agentAvailable: boolean
}

/** Render one buffered message for the `read` sweep: the sender as a full address. */
function readEntry(message: A2aBufferedMessage): {
  messageId: string
  from: string
  conversationId: string
  text: string
  bufferedAt: number
} {
  return {
    messageId: message.messageId,
    from: `${message.from.machine}-${message.from.id}`,
    conversationId: message.conversationId,
    text: message.text,
    bufferedAt: message.bufferedAt,
  }
}

const DESCRIPTION =
  'SuperD Hub — agent-to-agent messaging across the Super D machine mesh.\n' +
  'Lifecycle: OPEN once (send with no conversationId) → then only `send` with its conversationId → replies auto-deliver; sweep `read` at wake boundaries → `stop` only when a turn is off track. Families: facility/status (`agents`, `agent_status`), messaging (`send`, `read`, `stop`), shell (`exec`).\n' +
  'Call shapes:\n' +
  '  {} | {action:"agents"} → the thin roster: machines → agents (id, label, address, ready).\n' +
  '  {action:"agent_status", agent} → that agent\'s session window from the sweep cache: {collectedAt, sessions:[{conversationId?, sessionId, title, status, mtime, lastOutput?, lastOutputAt?}], note?}. lastOutput (the peer\'s last delivered output) rides ONLY when you are that conversation\'s initiator; `note` says why the window is empty when empty is not a fact (the last collection failed, or none has happened yet).\n' +
  '  {action:"send", agent?, conversationId?, title?, message, delivery?} → open-or-resume: omit conversationId to OPEN (then agent = the recipient, REQUIRED; title optional; message is the first turn); pass conversationId to RESUME (agent optional — the hub derives the route; a wrong agent is refused). Receipt {outcome: delivered|accepted|failed, messageId, conversationId, sessionId, created, error?, note?}: `delivered` = end-to-end complete; `accepted` = the hub took it and the SAME in-flight request keeps running (its `delivered`/`undelivered` outcome arrives as a notice — do not resend); `failed` = immediate rejection.\n' +
  '  {action:"read"} → sweep messages buffered for this session while it was not live.\n' +
  '  {action:"stop", conversationId, agent?, scope?} → cancel the conversation\'s ACTIVE turn (the session owner is derived from the conversation id; agent is optional). `stopped:true` means this call cancelled a live turn; a turn that finished on its own is IDLE, never `stopped` — so stop answers stopped:false with a note when nothing was running.\n' +
  '  {action:"exec", cmd, machine?, cwd?, stdin?, timeoutSec?, mode?} → run one shell command on a remote machine (machine required; self/local execution disabled unless localExec is explicitly enabled). mode "oneshot" (default): {exit, stdout (last 30k), stderr, durationMs, truncated, timedOut, outcome}; cwd sets its working directory. String stdin is piped and closed in oneshot; in PTY it is written immediately after cmd (REPL input, not script mode). Hub oneshot hard retention is 4MiB bytes per stream, PTY is 4,000,000 UTF-16 code units. outputStats reports real total/retained/dropped/returned and units; discarded head cannot be recovered by restarting. mode "pty": a PERSISTENT shell per (your session, machine) — the shell OWNS its cwd and env and they SURVIVE across dispatches (cd once inside the command, then keep working); {output (tail 30k), exit, cwd, timedOut, reconnected, durationMs}. cwd is oneshot-only: passing it with mode "pty" is refused (use `cd <dir> && …` inside the command). Prefer oneshot for independent commands; pty when shell state matters.\n' +
  'Addresses are "<m4>-<a6>" (machine-agent); call agents first to list valid ids. delivery: "queue" (default) is injected into the peer\'s session as a waking turn — it never interrupts an active turn, it queues behind it; "steer" submits steering for the peer\'s nearest step boundary — use it only when urgency demands. NEVER poll for a reply: the peer\'s reply arrives in this conversation as a new message WHEN THE PEER SENDS one (peers that never use the channel get their last output at turn end delivered as their reply instead, form=transcript); a turn that ends with no channel artifact yields one notice whose reason= distinguishes peer-silent (ended, said nothing) / peer-error (stream died or turn aborted) / stopped-by-initiator (you stopped it). read only sweeps what was buffered while this session was down. stop is a hard stop of the peer\'s active turn (the UI stop button); scope "session" degrades to turn-only — no session-close exists upstream — and the conversation stays resumable: send again to resume it. agent_status reads a cache refreshed by the 5-minute sweep (collectedAt says when); the window is alive-first, ≤5 rows, newest first, and not being in it implies nothing; a `note` says why when the window has no collection behind it (the last collection failed, or none has happened yet). MESSAGING HAS NO STATUS QUERY: to check whether a peer is idle or running, call agent_status (a 5-minute cache — never a delivery receipt); if that is not enough and you cannot wait, send another message.'

/**
 * Build the one SuperD Hub tool.
 * @param deps - service, delivery, roster view, initiator factory, watch owner.
 * @returns the registry-ready `superd-hub` ToolDefinition.
 */
export function createSuperdHubTool(deps: HubToolDeps): ToolDefinition {
  return defineTool({
    name: 'superd-hub',
    description: DESCRIPTION,
    parameters: {
      action: {
        type: 'string',
        enum: ['agents', 'send', 'read', 'stop', 'agent_status', 'exec'],
        description: 'Omitted/\"agents\" → the roster. The other legs are self-describing call shapes.',
      },
      agent: {
        type: 'string',
        description: 'Address "<m4>-<a6>". REQUIRED on send only to OPEN a new conversation (the recipient). On a continuation (conversationId given) send/stop derive the route themselves — omit agent; if you do pass it, a mismatch with the derived route is refused. agent_status: the agent whose session window you want. Call agents first to list valid ids.',
      },
      conversationId: {
        type: 'string',
        description: 'Conversation shortId (from a receipt or the agents listing). Omit on send to open a new conversation.',
      },
      title: {
        type: 'string',
        description: 'Optional operator-facing conversation title (never an identity); given to new conversations.',
      },
      message: {
        type: 'string',
        description: 'Message body injected as one user turn (the A2A reply-address envelope is added automatically). Required: it is the first turn when opening a new conversation, the follow-up turn when resuming.'
      },
      delivery: {
        type: 'string',
        enum: ['queue', 'steer'],
        description: "'queue' (default): injected as a waking turn — queues behind any active turn, never interrupts. 'steer': steering input for the peer's nearest step boundary.",
      },
      scope: {
        type: 'string',
        enum: ['turn', 'session'],
        description: "'turn' (default): cancel the active turn. 'session': degrades to turn-only — the conversation stays resumable.",
      },
      machine: {
        type: 'string',
        description: 'exec target: a remote m4 machine id (required; self disabled unless localExec is enabled). The initiator-side registry row may disable exec per machine (execEnabled).',
      },
      cmd: {
        type: 'string',
        description: 'exec: the shell command run via bash -lc (non-empty, ≤4096 chars).',
      },
      cwd: {
        type: 'string',
        description: 'exec oneshot: optional absolute working directory. Not accepted with mode "pty" (the persistent shell keeps its own session cwd — pass `cd <dir> && …` in the command).',
      },
      stdin: { type: 'string', description: 'exec input: oneshot pipes this string then closes stdin; PTY writes it immediately after cmd. This is not a script carrier; use remote script for local files.' },
      timeoutSec: {
        type: 'integer',
        description: 'exec: timeout in seconds, 1–600 (default 120). SIGTERM then SIGKILL to the process group.',
      },
      mode: {
        type: 'string',
        enum: ['oneshot', 'pty'],
        description: "exec mode: 'oneshot' (default, independent). 'pty' keeps one shell per (session, machine) — cwd/env persist across dispatches.",
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          machines: { type: 'json', description: 'agents listing: machines → agents (thin rows — no conversations; use agent_status)' },
          collectedAt: { type: 'integer', description: 'agent_status: when the machine bucket was last collected (epoch ms; 0 = never)' },
          sessions: { type: 'json', description: 'agent_status: window rows {conversationId?, sessionId (truncated), title, status, agentAvailable, mtime, lastOutput?, lastOutputAt?} — lastOutput rides ONLY when you are that conversation\'s initiator (D30 ownership gate)' },
          conversationId: { type: 'string' },
          sessionId: { type: 'string' },
          created: { type: 'boolean', description: "send receipt: true when conversationId was omitted (this send OPENED the conversation); absent/false on resume" },
          agent: { type: 'string' },
          machine: { type: 'string' },
          outcome: { type: 'string', description: "send receipt: 'delivered' (end-to-end complete) | 'accepted' (hub took it; the same in-flight request keeps running and the outcome arrives as a notice) | 'failed' (immediate rejection); exec: why the process ended — 'exited' | 'signaled' | 'timeout' | 'spawn-error' (diagnostic rides stderr on spawn-error)" },
          output: { type: 'json', description: 'exec pty: the session output, tail-windowed (a truncation banner carries the exact counts)' },
          cwd: { type: 'json', description: 'exec pty: the session working directory after the command (null when unknown)' },
          mode: { type: 'string', description: "exec pty: present with value 'pty' — the result is a persistent-shell dispatch (absent on oneshot). 0.1.7-h D1: the harness output validator rejects undeclared fields, so this MUST stay declared in lockstep with the pty result shape." },
          reconnected: { type: 'boolean', description: 'exec pty: the transport died since the last dispatch and a fresh shell answered' },
          messageId: { type: 'string' },
          error: { type: 'json', description: 'wire error body {code, message, details?} on failed sends' },
          note: { type: 'string', description: "model-facing note explaining what a result cannot say in its fields: stop's idle answer (nothing was running), send's reply guidance, and agent_status's reason for an empty window (the collection failed, or none has happened yet) — an empty window is never a guess" },
          stopped: { type: 'boolean' },
          scope: { type: 'string' },
          reason: { type: 'string', description: 'the turn-only degradation note on session-scope stops' },
          count: { type: 'integer' },
          messages: { type: 'json', description: 'read sweep: buffered messages with from as "<m4>-<a6>"' },
          exit: { type: 'json', description: 'exec: the command exit code (null when killed by timeout/signal)' },
          stdout: { type: 'json', description: 'exec: the last 30k of stdout' },
          stderr: { type: 'json', description: 'exec: the last 30k of stderr' },
          durationMs: { type: 'integer', description: 'exec: wall-clock duration' },
          outputStats: { type: 'json', description: 'exec per-stream counters with explicit bytes/utf16 units; total, retained, dropped head, returned payload (excludes banners), retentionLimit. Absent on older peers: exact metrics unavailable.' },
          truncated: { type: 'boolean', description: 'exec: a stream\'s total output exceeded the returned tail window' },
          timedOut: { type: 'boolean', description: 'exec: the timeout fired (SIGTERM→SIGKILL to the group)' },
        },
      },
      render: (_args, value): ContentBlock[] => [{ type: 'text', text: JSON.stringify(
        value.action === 'exec' && value.outputStats === undefined
          ? { ...value, note: 'Peer output metrics omitted: exact total/retained/dropped unavailable; returned tail only.' }
          : value,
      ) }],
    },
    async execute(args, exec) {
      // One uniform gate first: every leg is session-bound A2A (D9 — replies
      // deliver into the calling session), so a session-less call fails loud
      // before touching the service, whatever the action.
      const initiator = initiatorOfExec(deps, exec)
      const action = args.action ?? 'agents'
      switch (action) {
        case 'agents':
          return agentsListing(deps)

        case 'send': {
          if (typeof args.message !== 'string' || args.message === '') {
            throw new Error('[E_MISSING_MESSAGE] superd-hub: send requires a non-empty message')
          }
          // D24/T3: `agent` is required only to OPEN a conversation; on a
          // continuation the hub derives the route from the conversation id.
          if (args.conversationId === undefined && (args.agent === undefined || args.agent === '')) {
            throw new Error('[E_MISSING_AGENT] superd-hub: send requires agent ("<m4>-<a6>") to open a new conversation')
          }
          const to = args.agent === undefined ? undefined : parseAgentAddress(args.agent)
          const receipt = await deps.service.send(
            {
              ...(to === undefined ? {} : { to }),
              ...(args.conversationId === undefined ? {} : { conversationId: args.conversationId }),
              ...(args.title === undefined ? {} : { title: args.title }),
              message: args.message,
              ...(args.delivery === undefined ? {} : { delivery: args.delivery }),
            },
            initiator,
          )
          // R4: the cross-wire completion watch is RETIRED — replies come back
          // as reply/notice envelopes through the ingest (in-process for
          // self-hosted conversations, POSTed by the peer's hub otherwise).
          // The receipt still answers inbox acceptance; the reply arrives later
          // as an auto-delivered message. The vestigial deps (delivery/onWatch)
          // stay on the interface for wiring compatibility.
          return {
            action,
            outcome: receipt.outcome,
            messageId: receipt.messageId,
            ...(receipt.conversationId === undefined ? {} : { conversationId: receipt.conversationId }),
            sessionId: receipt.sessionId,
            // O2 (0.1.8-b): `created` is a WORLD fact (did a conversation come into
            // being), not a request-shape echo — a failed send created nothing.
            created: receipt.outcome !== 'failed' && args.conversationId === undefined,
            // A2aReceiptError carries details?: unknown (T2's verbatim wire body);
            // the body crossed an envelope, so it is JSON by construction —
            // one boundary cast onto the schema's json-typed field.
            ...(receipt.error === undefined ? {} : { error: receipt.error as unknown as import('@deepseek-ai/dsh-util-values').JsonValue }),
            ...(receipt.outcome === 'delivered'
              ? { note: 'reply auto-delivers as a new message in this conversation — never poll; read only sweeps buffered leftovers' }
              : receipt.outcome === 'accepted' && receipt.note !== undefined
                ? { note: receipt.note }
                : {}),
          }
        }

        case 'read': {
          const swept = deps.service.read(initiator.sessionId)
          return {
            action,
            count: swept.length,
            messages: swept.map(readEntry),
          }
        }

        case 'stop': {
          if (args.conversationId === undefined || args.conversationId === '') {
            throw new Error('[E_MISSING_CONVERSATION] superd-hub: stop requires conversationId')
          }
          // D24/T3: the session owner is derived from the conversation id;
          // `agent`, when supplied, is only a checked assertion.
          const to = args.agent === undefined ? undefined : parseAgentAddress(args.agent)
          const result = await deps.service.stop(
            { conversationId: args.conversationId, ...(to === undefined ? {} : { to }) },
            args.scope ?? 'turn',
          )
          return {
            action,
            stopped: result.cancelled === true,
            scope: result.scope,
            ...(result.scope === 'turn-only' ? { reason: result.reason } : {}),
            // D5: the honest idle answer — the note rides along instead of a bare stopped:false
            ...(result.cancelled === true ? {} : { note: result.note }),
          }
        }

        case 'agent_status': {
          if (args.agent === undefined || args.agent === '') {
            throw new Error('[E_MISSING_AGENT] superd-hub: agent_status requires agent ("<m4>-<a6>")')
          }
          const addr = parseAgentAddress(args.agent)
          const file = deps.status?.() ?? { machines: {} }
          const bucket = file.machines[addr.machine]
          const entry = bucket?.agents.find((a) => a.a6 === addr.id)
          const sessions = entry === undefined ? [] : shapeAgentStatusWindow(entry, deps.service.listConversations(), initiator.sessionId)
          // O1b (0.1.8-e): an empty window must never be passed off as "no
          // sessions" — a per-agent collection failure, a machine-level one,
          // and a collection that has not happened yet each say so here.
          let note: string | undefined
          if (entry !== undefined && entry.error !== undefined) {
            note = `collection failed for this agent — ${entry.error}`
          } else if (bucket !== undefined && bucket.error !== undefined) {
            note = `collection failed for machine "${addr.machine}" — ${bucket.error}`
          } else if (entry === undefined) {
            note = 'no collected status for this agent yet — the 5-minute sweep fills the cache; call agents for the roster'
          }
          return {
            action,
            agent: addr.id,
            machine: addr.machine,
            collectedAt: bucket?.collectedAt ?? 0,
            // the rows crossed no envelope, so they are JSON by construction —
            // one boundary cast onto the schema's json-typed field (the error leg's pattern)
            sessions: sessions as unknown as import('@deepseek-ai/dsh-util-values').JsonValue,
            ...(note === undefined ? {} : { note }),
          }
        }

        case 'exec': {
          if (!deps.localExec && (!args.machine || args.machine === deps.exec.selfM4()))
            throw new Error('[E_LOCAL_EXEC_DISABLED] superd-hub: select a remote machine from agents; local execution is disabled (localExec=false)')
          if (args.mode === 'pty') {
            if (typeof args.cmd !== 'string' || args.cmd.trim() === '') throw new Error('[E_BAD_EXEC] superd-hub: exec: cmd must be a non-empty string')
            // F1 (0.1.7-n, PC 0.1.7-m first-person): cwd was silently ignored on
            // this leg — the persistent shell owns its cwd. Refuse it loudly and
            // teach the workaround instead of a silent parameter no-op.
            if (args.cwd !== undefined) {
              throw new Error('[E_BAD_EXEC] superd-hub: exec: cwd is not supported with mode "pty" — the persistent shell keeps its own cwd; use `cd <dir> && …` inside the command')
            }
            const sessionKey = initiatorOfExec(deps, exec).sessionId
            const machine = args.machine ?? deps.exec.selfM4()
            try {
              const r = await deps.exec.pty(sessionKey, machine, args.cmd, { ...(args.timeoutSec === undefined ? {} : { timeoutSec: args.timeoutSec }), ...(args.stdin === undefined ? {} : { stdin: args.stdin }) })
              const out = tailWindow(r.output, EXEC_TAIL_WINDOW, r.outputStats?.stdout)
              return {
                action,
                mode: 'pty',
                machine,
                output: out.text,
                ...(out.stats ? { outputStats: { stdout: out.stats } } : {}),
                exit: r.exit,
                cwd: r.cwd,
                timedOut: r.timedOut,
                reconnected: r.reconnected,
                durationMs: r.durationMs,
                ...(out.truncated !== undefined ? { truncated: true } : {}), // char counts ride tailWindow's own banner in `output`
              }
            } catch (err) {
              throw new Error(`[E_EXEC_FAILED] superd-hub: ${err instanceof Error ? err.message : String(err)}`)
            }
          }
          const parsed = parseOneShotExecBody({
            cmd: args.cmd,
            ...(args.stdin === undefined ? {} : { stdin: args.stdin }),
            ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
            ...(args.timeoutSec === undefined ? {} : { timeoutSec: args.timeoutSec }),
          })
          if (!parsed.ok) throw new Error(`[E_BAD_EXEC] superd-hub: ${parsed.error}`)
          const machine = args.machine ?? deps.exec.selfM4()
          try {
            const result = machine === deps.exec.selfM4()
              ? await deps.exec.run(parsed.value)
              : await deps.exec.post(machine, parsed.value)
            return { action, machine, ...result }
          } catch (err) {
            throw new Error(`[E_EXEC_FAILED] superd-hub: ${err instanceof Error ? err.message : String(err)}`)
          }
        }

        default:
          // Unreachable through the tool surface (the input schema's action
          // enum rejects unknowns before execute) — kept as the switch's
          // totality guard: if the enum and this dispatch ever drift, this
          // names the gap instead of silently returning undefined.
          throw new Error(`[E_BAD_ACTION] superd-hub: unknown action ${JSON.stringify(action)}`)
      }
    },
  })
}
