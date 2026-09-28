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
import { wireCompletionToDelivery } from './a2a-delivery.js'
import type { A2aDeliveryCtx } from './a2a-delivery.js'
import type { AgentLink } from './agent-roster.js'
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
export const RECENT_CONVERSATIONS_MAX = 5

/** The exec placeholder note (P4 owns the leg; spec §9 placeholder discipline). */
export const EXEC_PLACEHOLDER_NOTE = 'not yet implemented: exec (P4)'

/** One recent conversation of an agent, from the registry (liveness proxy = lastActivityAt). */
export type HubConversationEntry = {
  /** Conversation shortId (the tool-facing alias). */
  conversationId: string
  /** Operator-facing title; omitted when the conversation has none. */
  title?: string
  /** Epoch ms of the last successful send (alive-first sort key, newest first). */
  lastActivityAt: number
}

/** One addressable agent row in the listing. */
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
  /** Recent conversations with this agent as the TARGET, newest first. */
  conversations: HubConversationEntry[]
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

/** The `agents` listing: machines → agents → recent conversations (one JSON value). */
function agentsListing(deps: HubToolDeps): { action: 'agents'; machines: HubMachineEntry[] } {
  const view = deps.roster()
  const conversations = deps.service.listConversations()
  const agentsByMachine = new Map<string, HubAgentEntry[]>()
  for (const link of view.agents) {
    const machine = link.machine === LOCAL_MACHINE ? view.self.id : link.machine
    const recent = conversations
      .filter((row) => row.machine === machine && row.agent === link.id)
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
      .slice(0, RECENT_CONVERSATIONS_MAX)
      .map((row) => ({
        conversationId: row.shortId,
        ...(row.title === undefined ? {} : { title: row.title }),
        lastActivityAt: row.lastActivityAt,
      }))
    const list = agentsByMachine.get(machine) ?? []
    list.push({
      id: link.id,
      label: link.label,
      address: `${machine}-${link.id}`,
      ready: link.ready === true,
      failed: link.failed === true,
      conversations: recent,
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
  '  {} | {action:"agents"} → the roster: machines → agents → each agent\'s recent conversations.\n' +
  '  {action:"new_conversation", agent, title?} → open a conversation → {conversationId, sessionId, agent, machine}.\n' +
  '  {action:"send", agent, conversationId?, title?, message, delivery?} → inject one user turn (omit conversationId to open a new conversation). Receipt {outcome, messageId, conversationId, sessionId, error?}.\n' +
  '  {action:"read"} → sweep messages buffered for this session while it was not live.\n' +
  '  {action:"stop", agent, conversationId, scope?} → cancel the peer\'s active turn (answers stopped:false with a note when no turn was active).\n' +
  '  {action:"exec"} → not yet implemented (P4).\n' +
  'Addresses are "<m4>-<a6>" (machine-agent); call agents first to list valid ids. delivery: "queue" (default) lands like an ordinary user message and never interrupts the peer; "steer" submits steering for the peer\'s nearest step boundary — use it only when urgency demands. NEVER poll for a reply: after send the hub watches the peer\'s turn and the reply arrives in this conversation automatically as a new message (read only sweeps what was buffered while this session was down). stop is a hard stop of the peer\'s active turn (the UI stop button); scope "session" degrades to turn-only — no session-close exists upstream — and the conversation stays resumable: send again to resume it.'

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
        enum: ['agents', 'new_conversation', 'send', 'read', 'stop', 'exec'],
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
        description: 'Message body injected as one user turn (the A2A reply-address envelope is added automatically).',
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
          machines: { type: 'json', description: 'agents listing: machines → agents → recent conversations' },
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
          const created = await deps.service.newConversation(addr, args.title)
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
          // D9: the receipt answers inbox acceptance; the reply arrives LATER
          // as an auto-delivered message. Watch only what was accepted — a
          // failed send has no turn to wait for.
          if (receipt.outcome === 'injected' && receipt.conversationId !== undefined) {
            const dispose = wireCompletionToDelivery(
              deps.delivery,
              deps.service,
              initiator,
              { to: addr, conversationId: receipt.conversationId },
              { requestId: receipt.messageId },
            )
            deps.onWatch?.(dispose)
          }
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

        case 'exec':
          return { action, note: EXEC_PLACEHOLDER_NOTE }

        default:
          throw new Error(`[E_BAD_ACTION] superd-hub: unknown action ${JSON.stringify(action)}`)
      }
    },
  })
}
