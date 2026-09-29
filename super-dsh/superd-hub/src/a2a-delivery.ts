/**
 * A2A reply-delivery face (mesh P3 Task 3): how a peer agent's reply arrives
 * back in the INITIATING agent's conversation — the two producer source kinds
 * for `@deepseek-ai/dsh-llm`'s MessageSourceMap, the peer-routing rules over
 * `ctx.agents`, and the subscribe→deliver glue.
 *
 * Upstream anchors (`upstream/deepseek-harness` @ dsh-v0.1.7-rc.1):
 *   - the continuation-message pattern: `packages/subagent/subagent/src/
 *     continuation-messages.ts` — each producer declares its own kinds into
 *     MessageSourceMap via `declare module '@deepseek-ai/dsh-llm'` with a
 *     type-only import of the target package, and builds user-role messages
 *     through `createUserMessage` (fresh identity, detached, deep-frozen).
 *     That constructor is not re-exported by any package the hub may consume,
 *     so this module constructs the SAME structural shape locally
 *     ({@link A2aDeliveredMessage}) and keeps a zero-dependency runtime —
 *     the type-only import below anchors the augmentation exactly like the
 *     upstream precedent.
 *   - the delivery routing template: `continuation-activation.ts`
 *     notifySettlement (:871-888) — idle→queue, busy→steer, closing
 *     teardown→inject, missing→nothing. That is the PARENT/child contract.
 *     A2A peers are not parents (spec §7.3 ruling): a peer reply is ordinary
 *     queued input, so idle AND busy both deliver via `followup` — never
 *     interrupting the initiator's active turn — and `steer` exists ONLY for
 *     explicit `delivery:'steer'` requests; a missing initiator (not live,
 *     torn down) lands in Task 2's bounded unread buffer instead of being
 *     injected or dropped.
 *   - notice summaries are bounded like upstream `boundContextSummary`
 *     (CONTEXT_SUMMARY_MAX_CHARS = 120): 119 chars + '…'.
 */
import { randomUUID } from 'node:crypto'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { A2A_NOTICE_SUMMARY_MAX, type A2aNoticeReason } from './a2a-wire.js'
// compat re-exports (postoffice R1 / 0.1.7-h R2): both moved to the protocol
// layer (a2a-wire.ts) — the bound so the envelope guard enforces the same
// number this module bounds with, the reason type because it now crosses the
// wire; existing importers keep compiling.
export { A2A_NOTICE_SUMMARY_MAX, type A2aNoticeReason }
import type { A2aBufferInput, A2aConversationRef, A2aInitiator, A2aService } from './a2a-service.js'

/** Durable attribution for one peer reply relayed into the initiator's conversation. */
export interface A2aRelaySource {
  readonly kind: 'a2a-relay'
  /** A message another agent addressed to this one (`relay` context form). */
  readonly form: 'relay'
  /** Machine id (m4) of the replying peer. */
  readonly senderMachine: string
  /** Agent id (a6) of the replying peer. */
  readonly senderAgent: string
  /** Conversation shortId the reply belongs to. */
  readonly conversationId: string
  /** Durable identity of this relay (minted at delivery, one per fired completion). */
  readonly messageId: string
}

/** Why a runtime-owned notice was produced — the taxonomy now lives on the
 * protocol layer (a2a-wire.ts, imported + re-exported above): 0.1.7-h R2
 * made it a wire fact, and the model-facing notice line renders it. */

/**
 * Durable attribution for the hub's own account of an A2A conversation event
 * (a failed send, a dead completion stream, a stop) — deliberately a notice,
 * not a relay: the hub states what became of the conversation and never
 * credits the peer with words it did not write.
 */
export interface A2aNoticeSource {
  readonly kind: 'a2a-notice'
  /** A runtime account shown without expanding the row (`notice` context form). */
  readonly form: 'notice'
  /** One-line account of what happened, bounded to {@link A2A_NOTICE_SUMMARY_MAX}. */
  readonly summary: string
  /** Conversation shortId the notice is about, when one is known. */
  readonly conversationId?: string
  /** Which failure this notice reports. */
  readonly reason: A2aNoticeReason
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'a2a-relay': A2aRelaySource
    'a2a-notice': A2aNoticeSource
  }
}

/** Bound for a notice summary — owned by a2a-wire.ts since R1 (see the re-export above). */

/**
 * Bound one notice summary to {@link A2A_NOTICE_SUMMARY_MAX} — the same
 * ellipsizing as upstream `boundContextSummary` (dsh-llm message.ts).
 * @param summary - the producer's one-line account, of any length.
 * @returns the account, ellipsized when it exceeds the bound.
 */
export function boundNoticeSummary(summary: string): string {
  return summary.length <= A2A_NOTICE_SUMMARY_MAX
    ? summary
    : `${summary.slice(0, A2A_NOTICE_SUMMARY_MAX - 1)}…`
}

/** Reply-routing choice over `ctx.agents`; peer semantics default to followup (spec §7.3). */
export type A2aReplyDelivery = 'followup' | 'steer'

/** One delivered (or buffered) reply/notice outcome. */
export type A2aDeliveryOutcome =
  | { delivered: 'followup' }
  | { delivered: 'steer' }
  | { delivered: 'buffered' }
  | { delivered: 'dropped'; reason: 'no-conversation' }

/** Structural mirror of upstream `createUserMessage` output (dsh-llm message.ts) —
 * fresh identity, role 'user', content blocks, producer source; detached and
 * deep-frozen before publication. The id mirrors upstream's branded MessageId
 * as a plain string (brands are compile-time only; the hub keeps zero dsh-llm
 * runtime dependencies). */
export interface A2aDeliveredMessage {
  readonly id: string
  readonly role: 'user'
  readonly content: readonly ContentBlock[]
  readonly source: A2aRelaySource | A2aNoticeSource
}

/** Recursive freeze, mirroring upstream `deepFreeze(structuredClone(...))` publication. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    if (Array.isArray(value)) {
      for (const item of value) deepFreeze(item)
    } else {
      for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key])
    }
    Object.freeze(value)
  }
  return value
}

/**
 * Build one identified, immutable user-role message — the local equivalent of
 * upstream `createUserMessage`: fresh uuid identity, structuredClone-detached,
 * deep-frozen before publication.
 * @param content - model-visible message blocks.
 * @param source - the producer attribution (our declared kinds).
 * @returns the frozen user message handed to the initiator's inbox.
 */
function createA2aUserMessage(
  content: readonly ContentBlock[],
  source: A2aRelaySource | A2aNoticeSource,
): A2aDeliveredMessage {
  return deepFreeze(structuredClone({
    id: randomUUID(),
    role: 'user' as const,
    content,
    source,
  }))
}

/**
 * The agent-handle face this layer consumes — structural subset of upstream
 * `Agent` (packages/core/agent/src/runtime-types.ts): lifecycle status plus
 * the three inbox boundaries followup / steer / inject.
 */
export interface A2aAgentHandle {
  /** Lifecycle state ('idle' | 'running' upstream); peer routing does NOT branch on it. */
  readonly status: string
  followup(message: A2aDeliveredMessage): void
  steer(message: A2aDeliveredMessage): void
  inject(message: A2aDeliveredMessage): void
}

/**
 * The delivery context: the live-agent registry face plus Task 2's bounded
 * unread-buffer leg (the persistence policy for initiators that are not live).
 */
export interface A2aDeliveryCtx {
  /** Structural subset of `ctx.agents` (AgentRegistry): `get` → live handle or undefined. */
  readonly agents: { get(sessionId: string): A2aAgentHandle | undefined }
  /** Task 2's `A2aService.buffer` leg — where undeliverable messages wait. */
  readonly buffer: A2aService['buffer']
}

/** Producer attribution for one relayed peer reply. */
export interface A2aReplyMeta {
  senderMachine: string
  senderAgent: string
  /** Conversation shortId the reply belongs to. */
  conversationId: string
  /** Durable identity of this relay (one per fired completion). */
  messageId: string
  /** Conversation title for the relay prefix (untitled placeholder when absent). */
  title?: string
  /** D20: true = the runtime's transcription of the peer's turn-end last output (the peer never sent it through the channel) — renders the provenance prefix instead of "replied". */
  transcribed?: boolean
}
/** Producer attribution for one runtime notice. */
export interface A2aNoticeMeta {
  senderMachine: string
  senderAgent: string
  /** Conversation shortId the notice is about; absent notices cannot buffer. */
  conversationId?: string
  reason: A2aNoticeReason
}

/**
 * The model-facing reply envelope (0.1.7-h R1 — one stable machine-readable
 * vocabulary, replacing the v3 prose prefixes per the operator's §8 ruling:
 * provenance the model had to recover from English sentences is now stated):
 * a header line of `k=v` facts, a blank line, then the reply body. `form`
 * keeps the D20 provenance split — `relay` = the peer chose to send through
 * the channel; `transcript` = the peer never sent, the runtime is delivering
 * its last output at turn end (the note spells out that observable fact per
 * the user's no-jargon redline).
 * @param meta - the reply attribution.
 * @param content - the reply text (channel message or transcribed last output).
 * @returns `[superd-hub:a2a] kind=reply form=… conversation=… from=… message=…[ note="…"]\n\n<body>`.
 */
export function renderA2aRelayText(meta: A2aReplyMeta, content: string): string {
  const header = meta.transcribed === true
    ? `[superd-hub:a2a] kind=reply form=transcript conversation=${meta.conversationId} from=${meta.senderMachine}-${meta.senderAgent} message=${meta.messageId} note="the peer never sent through the channel — this is the runtime delivering the peer's last output at turn end"`
    : `[superd-hub:a2a] kind=reply form=relay conversation=${meta.conversationId} from=${meta.senderMachine}-${meta.senderAgent} message=${meta.messageId}`
  return `${header}\n\n${content}`
}

/** R2: the three model-facing cause values — one wire fact maps to exactly one
 * model value, so the notice line and its summary can never disagree. */
export type A2aModelNoticeReason = 'peer-silent' | 'peer-error' | 'stopped-by-initiator'

/** Map the wire cause taxonomy onto the model-facing one. */
export function modelNoticeReason(reason: A2aNoticeReason): A2aModelNoticeReason {
  switch (reason) {
    case 'stop': return 'stopped-by-initiator'
    case 'peer': return 'peer-silent'
    default: return 'peer-error' // send-failed / stream-dead / aborted — the peer side ended abnormally
  }
}

/**
 * Render the model-visible notice text (0.1.7-h R1/R2): ONE line in the same
 * envelope vocabulary as relays, plus the R2 cause and the bounded summary.
 * Inner double quotes are sanitized to single quotes (legacy peer summaries
 * embed `conversation "x"`) so the k=v line stays parseable; the wire/source
 * summary keeps its verbatim text.
 */
export function renderA2aNoticeText(meta: A2aNoticeMeta, summary: string): string {
  const conv = meta.conversationId === undefined ? '' : ` conversation=${meta.conversationId}`
  return `[superd-hub:a2a] kind=notice${conv} from=${meta.senderMachine}-${meta.senderAgent} reason=${modelNoticeReason(meta.reason)} summary="${summary.replace(/"/g, "'")}"`
}

/**
 * Route one built message to the initiator: live → followup (or steer when
 * explicitly requested); not live → the buffer leg when the input has a
 * conversation to anchor it, else best-effort nothing.
 */
function route(
  ctx: A2aDeliveryCtx,
  initiator: A2aInitiator,
  message: A2aDeliveredMessage,
  delivery: A2aReplyDelivery,
  buffered?: A2aBufferInput,
): A2aDeliveryOutcome {
  const agent = ctx.agents.get(initiator.sessionId)
  if (agent === undefined) {
    if (buffered === undefined) return { delivered: 'dropped', reason: 'no-conversation' }
    ctx.buffer(initiator.sessionId, buffered)
    return { delivered: 'buffered' }
  }
  if (delivery === 'steer') agent.steer(message)
  else agent.followup(message)
  return { delivered: delivery }
}

/**
 * Deliver one peer reply into the initiating agent's conversation.
 * @param ctx - live-agent face + buffer leg.
 * @param initiator - who asked (its sessionId keys the buffer).
 * @param content - the peer's final reply text.
 * @param meta - relay attribution (sender address, conversation, identity, title).
 * @param opts - `delivery:'steer'` overrides the followup default.
 * @returns where the reply landed.
 */
export function deliverReply(
  ctx: A2aDeliveryCtx,
  initiator: A2aInitiator,
  content: string,
  meta: A2aReplyMeta,
  opts: { delivery?: A2aReplyDelivery } = {},
): A2aDeliveryOutcome {
  const text = renderA2aRelayText(meta, content)
  const message = createA2aUserMessage(
    [{ type: 'text', text }],
    {
      kind: 'a2a-relay',
      form: 'relay',
      senderMachine: meta.senderMachine,
      senderAgent: meta.senderAgent,
      conversationId: meta.conversationId,
      messageId: meta.messageId,
    },
  )
  return route(ctx, initiator, message, opts.delivery ?? 'followup', {
    messageId: meta.messageId,
    from: { machine: meta.senderMachine, id: meta.senderAgent },
    conversationId: meta.conversationId,
    text,
  })
}

/**
 * Deliver one runtime-owned notice (bounded one-line account) into the
 * initiating agent's conversation.
 * @param ctx - live-agent face + buffer leg.
 * @param initiator - who asked (its sessionId keys the buffer).
 * @param summary - the one-line account, any length (bounded here).
 * @param meta - notice attribution; a notice without a conversation cannot buffer.
 * @param opts - `delivery:'steer'` overrides the followup default.
 * @returns where the notice landed.
 */
export function deliverNotice(
  ctx: A2aDeliveryCtx,
  initiator: A2aInitiator,
  summary: string,
  meta: A2aNoticeMeta,
  opts: { delivery?: A2aReplyDelivery } = {},
): A2aDeliveryOutcome {
  const bounded = boundNoticeSummary(summary)
  // R1: a notice is an injected turn like any other — its model-facing text
  // is the envelope line (provenance + cause + summary); the buffered copy
  // carries the same line so a later sweep injects identical text.
  const noticeText = renderA2aNoticeText(meta, bounded)
  const message = createA2aUserMessage(
    [{ type: 'text', text: noticeText }],
    {
      kind: 'a2a-notice',
      form: 'notice',
      summary: bounded,
      ...(meta.conversationId === undefined ? {} : { conversationId: meta.conversationId }),
      reason: meta.reason,
    },
  )
  const buffered = meta.conversationId === undefined ? undefined : {
    messageId: `a2a-notice-${randomUUID()}`,
    from: { machine: meta.senderMachine, id: meta.senderAgent },
    conversationId: meta.conversationId,
    text: noticeText,
  }
  return route(ctx, initiator, message, opts.delivery ?? 'followup', buffered)
}

/** The Task-2 service surface the glue consumes. */
export type A2aCompletionSource = Pick<A2aService, 'subscribeCompletion' | 'listConversations'>

/**
 * Wire one conversation's completion stream to the initiator's delivery face:
 * every fired completion becomes one relayed reply (titled from the registry
 * row); a completion-stream death becomes one bounded stream-dead notice.
 * Wire one conversation's completion stream to the initiator's delivery face:
 * every fired completion becomes one relayed reply (titled from the registry
 * row) — EXCEPT a turn that ended non-completed with NO captured text, which
 * degrades to a bounded 'aborted' notice (D3: a content-free relay is noise
 * and can wake an idle initiator for nothing); a completion-stream death
 * becomes one bounded stream-dead notice.
 */
export function wireCompletionToDelivery(
  ctx: A2aDeliveryCtx,
  service: A2aCompletionSource,
  initiator: A2aInitiator,
  conv: A2aConversationRef,
  opts: { requestId?: string } = {},
): () => void {
  const titleOf = (conversationId: string): string | undefined =>
    service.listConversations().find((r) => r.shortId === conversationId || r.sessionId === conversationId)?.title
  return service.subscribeCompletion(
    conv,
    (completion) => {
      // D3: a terminal turn that produced NO reply must not relay — aborted
      // WITH captured text still relays (the words exist); only the empty
      // non-completed end becomes a bounded notice.
      if (completion.reason !== 'completed' && completion.text === '') {
        deliverNotice(
          ctx,
          initiator,
          `conversation ${completion.conversationId}: turn aborted, no reply`,
          {
            senderMachine: conv.to.machine,
            senderAgent: conv.to.id,
            conversationId: completion.conversationId,
            reason: 'aborted',
          },
        )
        return
      }
      deliverReply(ctx, initiator, completion.text, {
        senderMachine: conv.to.machine,
        senderAgent: conv.to.id,
        conversationId: completion.conversationId,
        messageId: `a2a-relay-${randomUUID()}`,
        title: titleOf(completion.conversationId),
      })
    },
    {
      requestId: opts.requestId,
      onError: (error) => {
        deliverNotice(
          ctx,
          initiator,
          `A2A completion stream from ${conv.to.machine}-${conv.to.id} (conversation "${conv.conversationId}") failed: ${error.message}`,
          {
            senderMachine: conv.to.machine,
            senderAgent: conv.to.id,
            conversationId: conv.conversationId,
            reason: 'stream-dead',
          },
        )
      },
    },
  )
}
