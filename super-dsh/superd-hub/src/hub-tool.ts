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
 *     (default) is ordinary peer input, never interrupting; 'steer' is
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
import type {
  A2aAddress,
  A2aBufferedMessage,
  A2aInitiator,
  A2aService,
} from './a2a-service.js'

/** The service face the tool consumes (structural subset of T2/T3's A2aService). */
export type HubToolService = Pick<
  A2aService,
  'newConversation' | 'send' | 'subscribeCompletion' | 'stop' | 'read' | 'listConversations'
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
  /** The A2A conversation service (T2 core behind T3's host assembly). */
  service: HubToolService
  /** T3's delivery face: live-agent routing + the bounded unread buffer. */
  delivery: A2aDeliveryCtx
  /** Roster snapshot for the `agents` listing (row: the real hub home view). */
  roster(): HubRosterView
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

/**
 * Parse the `agent` parameter: `<m4>-<a6>`. Both halves are minted over
 * `[a-z0-9]` (machines.ts `ID_ALPHABET`), so the FIRST hyphen is the
 * unambiguous split — an id alphabet that ever grows hyphens keeps m4 intact.
 * @param agent - the raw `agent` parameter.
 * @returns the address the service consumes.
 * @throws `[E_BAD_ADDRESS]` when the value is not a `<m4>-<a6>` address.
 */
export function parseAgentAddress(agent: unknown): A2aAddress {
  if (typeof agent !== 'string' || agent === '') {
    throw new Error(`[E_BAD_ADDRESS] superd-hub: agent must be a "<m4>-<a6>" address — call the agents action to list valid ids (got ${JSON.stringify(agent)})`)
  }
  const dash = agent.indexOf('-')
  if (dash <= 0 || dash === agent.length - 1) {
    throw new Error(`[E_BAD_ADDRESS] superd-hub: agent must be a "<m4>-<a6>" address — call the agents action to list valid ids (got ${JSON.stringify(agent)})`)
  }
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
  conversations: ReadonlyArray<{ shortId: string; sessionId: string; title?: string }>,
): AgentStatusEntryRow[] {
  const bySession = new Map<string, { shortId: string; title?: string }>()
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
    const title = conversation !== undefined
      ? `${conversation.title ?? '[undefined]'} ${HUB_A2A_TITLE_MARKER}`
      : workspaceTitleOf.get(row.sessionId) ?? UNHOSTED_TITLE
    return {
      ...(conversation === undefined ? {} : { conversationId: conversation.shortId }),
      sessionId: displaySessionId(row.sessionId),
      title,
      status: row.status,
      agentAvailable: row.agentAvailable,
      mtime: row.mtime,
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
  'SuperD Hub — agent-to-agent messaging across the Super D machine mesh. Call shapes:\n' +
  '  {} | {action:"agents"} → the thin roster: machines → agents (id, label, address, ready).\n' +
  '  {action:"agent_status", agent} → that agent\'s session window from the sweep cache: {collectedAt, sessions:[{conversationId?, sessionId, title, status, mtime}]}.\n' +
  '  {action:"new_conversation", agent, title?, message?} → open a conversation (message, when given, IS the first turn — opening and content land as ONE injected turn) → {conversationId, sessionId, agent, machine}.\n' +
  '  {action:"send", agent, conversationId?, title?, message, delivery?} → inject one user turn (omit conversationId to open a new conversation). Receipt {outcome, messageId, conversationId, sessionId, error?}.\n' +
  '  {action:"read"} → sweep messages buffered for this session while it was not live.\n' +
  '  {action:"stop", agent, conversationId, scope?} → cancel the peer\'s active turn (answers stopped:false with a note when no turn was active).\n' +
  '  {action:"exec"} → not yet implemented (P4).\n' +
  'Addresses are "<m4>-<a6>" (machine-agent); call agents first to list valid ids. delivery: "queue" (default) lands like an ordinary user message and never interrupts the peer; "steer" submits steering for the peer\'s nearest step boundary — use it only when urgency demands. NEVER poll for a reply: the peer\'s reply arrives in this conversation as a new message WHEN THE PEER SENDS one (peers that never use the channel get their last output at turn end delivered as their reply instead); a turn that ends with no reply yields one notice. read only sweeps what was buffered while this session was down. stop is a hard stop of the peer\'s active turn (the UI stop button); scope "session" degrades to turn-only — no session-close exists upstream — and the conversation stays resumable: send again to resume it. agent_status reads a cache refreshed by the 5-minute sweep (collectedAt says when); the window is alive-first, ≤5 rows, newest first, and not being in it implies nothing.'

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
        enum: ['agents', 'new_conversation', 'send', 'read', 'stop', 'agent_status', 'exec'],
        description: 'Omitted/\"agents\" → the roster. The other legs are self-describing call shapes.',
      },
      agent: {
        type: 'string',
        description: 'Target address "<m4>-<a6>" — call agents first to list valid ids.',
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
        description: 'Message body injected as one user turn (the A2A reply-address envelope is added automatically). For new_conversation: optional — when given, opening + content land as ONE turn.'
      },
      delivery: {
        type: 'string',
        enum: ['queue', 'steer'],
        description: "'queue' (default): ordinary queued input, never interrupts the peer. 'steer': steering input for the peer's nearest step boundary.",
      },
      scope: {
        type: 'string',
        enum: ['turn', 'session'],
        description: "'turn' (default): cancel the active turn. 'session': degrades to turn-only — the conversation stays resumable.",
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
          sessions: { type: 'json', description: 'agent_status: window rows {conversationId?, sessionId (truncated), title, status, agentAvailable, mtime}' },
          conversationId: { type: 'string' },
          sessionId: { type: 'string' },
          agent: { type: 'string' },
          machine: { type: 'string' },
          outcome: { type: 'string' },
          messageId: { type: 'string' },
          error: { type: 'json', description: 'wire error body {code, message, details?} on failed sends' },
          note: { type: 'string', description: 'model-facing reminder riding successful sends' },
          stopped: { type: 'boolean' },
          scope: { type: 'string' },
          reason: { type: 'string', description: 'the turn-only degradation note on session-scope stops' },
          count: { type: 'integer' },
          messages: { type: 'json', description: 'read sweep: buffered messages with from as "<m4>-<a6>"' },
        },
      },
      render: (_args, value): ContentBlock[] => [{ type: 'text', text: JSON.stringify(value) }],
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

        case 'new_conversation': {
          if (args.agent === undefined || args.agent === '') {
            throw new Error('[E_MISSING_AGENT] superd-hub: new_conversation requires agent ("<m4>-<a6>")')
          }
          const addr = parseAgentAddress(args.agent)
          const created = await deps.service.newConversation(addr, args.title, args.message, initiator)
          return {
            action,
            conversationId: created.shortId,
            sessionId: created.sessionId,
            agent: addr.id,
            machine: addr.machine,
            // D1 hardening: a rejected title must not hide the created
            // conversation — the warning rides along with its ids.
            ...(created.warning === undefined ? {} : { warning: created.warning }),
          }
        }

        case 'send': {
          if (args.agent === undefined || args.agent === '') {
            throw new Error('[E_MISSING_AGENT] superd-hub: send requires agent ("<m4>-<a6>")')
          }
          if (typeof args.message !== 'string' || args.message === '') {
            throw new Error('[E_MISSING_MESSAGE] superd-hub: send requires a non-empty message')
          }
          const addr = parseAgentAddress(args.agent)
          const receipt = await deps.service.send(
            {
              to: addr,
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
            // A2aReceiptError carries details?: unknown (T2's verbatim wire body);
            // the body crossed an envelope, so it is JSON by construction —
            // one boundary cast onto the schema's json-typed field.
            ...(receipt.error === undefined ? {} : { error: receipt.error as unknown as import('@deepseek-ai/dsh-util-values').JsonValue }),
            ...(receipt.outcome === 'injected'
              ? { note: 'reply auto-delivers as a new message in this conversation — never poll; read only sweeps buffered leftovers' }
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
          if (args.agent === undefined || args.agent === '') {
            throw new Error('[E_MISSING_AGENT] superd-hub: stop requires agent ("<m4>-<a6>")')
          }
          if (args.conversationId === undefined || args.conversationId === '') {
            throw new Error('[E_MISSING_CONVERSATION] superd-hub: stop requires conversationId')
          }
          const addr = parseAgentAddress(args.agent)
          const result = await deps.service.stop(
            { to: addr, conversationId: args.conversationId },
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
          const sessions = entry === undefined ? [] : shapeAgentStatusWindow(entry, deps.service.listConversations())
          return {
            action,
            agent: addr.id,
            machine: addr.machine,
            collectedAt: bucket?.collectedAt ?? 0,
            // the rows crossed no envelope, so they are JSON by construction —
            // one boundary cast onto the schema's json-typed field (the error leg's pattern)
            sessions: sessions as unknown as import('@deepseek-ai/dsh-util-values').JsonValue,
            ...(bucket === undefined || entry === undefined
              ? { note: 'no collected status for this agent yet — the 5-minute sweep fills the cache; call agents for the roster' }
              : {}),
          }
        }

        case 'exec':
          return { action, note: EXEC_PLACEHOLDER_NOTE }

        default:
          throw new Error(`[E_BAD_ACTION] superd-hub: unknown action ${JSON.stringify(action)}`)
      }
    },
  })
}
