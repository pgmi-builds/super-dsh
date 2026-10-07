/**
 * Session-plane wire vocabulary (mesh P3 Task 1).
 *
 * The hub CALLS the native session-plane RPCs through a GatewayFace
 * (`CarrierGatewayFace.dispatchRpc` / `.openWireStream`, P2 machinery — local
 * in-process or remote wire). These endpoint strings are exactly the ones the
 * official browser UI reaches the Host through: the generated
 * `ctx.remote.session` namespace emits `connection.rpc.call('/api', endpoint,
 * { args }, signal)` with `endpoint = '<namespace>/<method>'`, and the native
 * gateway dispatches that same string.
 *
 * Every constant below is extracted from the upstream checkout
 * (`upstream/deepseek-harness` @ `dsh-v0.1.7-rc.1`, read-only). Each JSDoc
 * block carries the primary anchor (the `@Remote` declaration on the Host
 * controller) plus the payload-type anchor. Missing methods are `undefined`
 * with a comment — names are NEVER invented here.
 *
 * Wire-arg convention (how a GatewayFace payload is built):
 *   payload = { args: { <parameterWireName>: <value> } }
 * The client gateway builds it at
 * `packages/api/gateway/src/client/index.ts:445` (`{ args: prepared.args }`,
 * with `args[parameter.wire] = value` at :525); the Host gateway unpacks it at
 * `packages/api/gateway/src/index.ts:692–704` (`assertExactArguments` +
 * `resolveParameter` per declared parameter). For every session-plane method
 * the single business parameter is named `request` — EXCEPT `session/list`,
 * whose parameter is declared `_request` (the controller ignores it), so its
 * args key is `_request`. The trailing `signal` parameter never travels in
 * `args` (it is carried by the envelope/stream carrier, not the payload).
 *
 * Namespace binding: `super(ctx, 'sessionController', { namespace: 'session' })`
 * — packages/api/session-controller/src/index.ts:136 (Cordis service key
 * `sessionController`, wire namespace `session`).
 */

/**
 * `session/list` — cold Session list (the sidebar's session rows).
 *
 * Upstream anchors:
 * - `@Remote('list')`: packages/api/session-controller/src/index.ts:251
 *   (method `list(_request: SessionListRequest, signal)` at :252)
 * - payload type: packages/api/session-controller/src/types.ts:262
 *   (`SessionListRequest`), value at :267 (`SessionListValue`)
 * - generated client string: packages/api/session-controller/lib/typert.remote-client.d.ts:47
 * - wire-arg key quirk: `_request` (declared name, ignored by the Host) —
 *   typert.remote-client.js `session/list` descriptor, parameter wire `_request`
 *
 * Wire payload: `{ args: { _request: SessionListRequestMirror } }`.
 */
export const WIRE_SESSION_LIST = 'session/list'

/**
 * `session/create` — create a Session (or adopt an explicit id).
 *
 * Upstream anchors:
 * - `@Remote('create')`: packages/api/session-controller/src/index.ts:272
 *   (method `create(request: SessionCreateRequest)` at :273)
 * - payload type: packages/api/session-controller/src/types.ts:283
 *   (`SessionCreateRequest`), value at :291 (`SessionCreateValue`)
 * - generated client string: .../typert.remote-client.d.ts:44
 *
 * Wire payload: `{ args: { request: SessionCreateRequestMirror } }`.
 */
export const WIRE_SESSION_CREATE = 'session/create'

/**
 * `session/rename` — set a Session's title (the dedicated title-set RPC).
 *
 * Upstream anchors:
 * - `@Remote('rename')`: packages/api/session-controller/src/index.ts:384
 *   (method `rename(request: SessionRenameRequest)` at :385)
 * - payload type: packages/api/session-controller/src/types.ts:307
 *   (`SessionRenameRequest`), value at :313 (`SessionRenameValue`)
 * - generated client string: .../typert.remote-client.d.ts:53
 * - invalid title → typed error `session/title-invalid`
 *   (types.ts:223, thrown at commands.ts:204)
 *
 * Wire payload: `{ args: { request: SessionRenameRequestMirror } }`.
 */
export const WIRE_SESSION_TITLE = 'session/rename'

/**
 * `session/prompt` — submit one user turn into a Session.
 *
 * Upstream anchors:
 * - `@Remote('prompt')`: packages/api/session-controller/src/index.ts:407
 *   (method `prompt(request: SessionPromptRequest, signal)` at :408)
 * - payload type: packages/api/session-controller/src/types.ts:331
 *   (`SessionPromptRequest`), value at :342 (`SessionPromptValue`)
 * - generated client string: .../typert.remote-client.d.ts:52
 * - typed rejections: `session/agent-busy` / `session/attachment-invalid` /
 *   `session/not-found` (commands.ts:366–398)
 *
 * Wire payload: `{ args: { request: SessionPromptRequestMirror } }`.
 */
export const WIRE_PROMPT_SUBMIT = 'session/prompt'

/**
 * `session/follow` — open the event/log stream the UI renders (logical stream).
 *
 * Upstream anchors:
 * - `@Remote({ mode: 'stream' })`: packages/api/session-controller/src/index.ts:461
 *   (method `follow(request: SessionFollowRequest, signal): AsyncIterable<SessionFollowFrame>` at :462)
 * - payload type: packages/api/session-controller/src/types.ts:485
 *   (`SessionFollowRequest`), frame union at :550 (`SessionFollowFrame`)
 * - generated client string: .../typert.remote-client.d.ts:45
 * - UI consumption: packages/api/session-controller/src/client/transport.ts:172
 *   (`SessionEventStream.follow` → `remote.session.follow({ address, assistantStream: true, ... })`)
 *
 * Wire payload: `{ args: { request: SessionFollowRequestMirror } }`, opened
 * via `openWireStream` (not `dispatchRpc`). The opening frame is
 * `{ type: 'snapshot', header, cursor, records, hasMore, projections }`; then
 * ordered `{ type: 'event', event }` entries.
 */
export const WIRE_STREAM_OPEN = 'session/follow'

/**
 * `session/cancel` — cancel/interrupt the active Agent turn.
 *
 * Upstream anchors:
 * - `@Remote('cancel')`: packages/api/session-controller/src/index.ts:438
 *   (method `cancel(request: SessionCancelRequest)` at :439)
 * - payload type: packages/api/session-controller/src/types.ts:371
 *   (`SessionCancelRequest`), value at :376 (`SessionCancelValue`)
 * - generated client string: .../typert.remote-client.d.ts:41
 *
 * Wire payload: `{ args: { request: SessionCancelRequestMirror } }`.
 */
export const WIRE_TURN_CANCEL = 'session/cancel'

/**
 * `session/close` / session delete — DOES NOT EXIST upstream.
 *
 * The session namespace (packages/api/session-controller/src/index.ts:251–501,
 * complete `@Remote` set: list, search, create, selectModel, modelCatalog,
 * canOpenWorkspacePath, openWorkspacePath, workspacePathApplications, rename,
 * fork, prompt, attachment, updateQueue, cancel, page, follow, projections,
 * control) has no close/dispose/delete/archive method. Session lifetime is
 * Host-owned (Agent lifecycle + `session/disposed` events); the browser never
 * closes a session over the wire. The nearest upstream analogues live on a
 * DIFFERENT namespace (workspace, not session-plane): `workspace/archiveSession`
 * (packages/api/workspace-controller/src/index.ts:159) and
 * `workspace/unarchiveSession` (:169). Kept `undefined` per the no-invention
 * rule; Task 2 must not route a close through the session plane.
 */
export const WIRE_SESSION_CLOSE: undefined = undefined

/**
 * The session-plane endpoint vocabulary (mesh P3 Task 1 deliverable).
 * Undefined keys = no upstream counterpart (see the constant's JSDoc).
 */
export const WIRE = {
  sessionList: WIRE_SESSION_LIST,
  sessionCreate: WIRE_SESSION_CREATE,
  sessionTitle: WIRE_SESSION_TITLE,
  promptSubmit: WIRE_PROMPT_SUBMIT,
  streamOpen: WIRE_STREAM_OPEN,
  turnCancel: WIRE_TURN_CANCEL,
  sessionClose: WIRE_SESSION_CLOSE,
} as const

/** Opaque branded string ids on the wire are plain JSON strings here. */
export type SessionIdMirror = string
/** Client-minted prompt identity (`Branded<'session-request-id'>` upstream). */
export type SessionRequestIdMirror = string

/**
 * MIRROR of upstream `SessionListRequest`
 * (packages/api/session-controller/src/types.ts:262). Reference data for the
 * wire caller — not an owned contract.
 */
export interface SessionListRequestMirror {
  readonly cursor?: string
}

/**
 * MIRROR of upstream `SessionCreateRequest` (types.ts:283). `workspaceId` +
 * `cwd` name the workspace (cwd alone is accepted), `sessionId` adopts an
 * explicit id, `agentPreset` selects the composition.
 */
export interface SessionCreateRequestMirror {
  readonly workspaceId?: SessionIdMirror
  readonly cwd?: string
  readonly sessionId?: SessionIdMirror
  readonly agentPreset?: string
}

/** MIRROR of upstream `SessionRenameRequest` (types.ts:307). */
export interface SessionRenameRequestMirror {
  readonly sessionId: SessionIdMirror
  readonly title: string
}

/**
 * MIRROR of upstream `PromptContentPart` (types.ts:89): browser-submitted
 * prompt content; the Host promotes image bytes to durable references.
 */
export type PromptContentPartMirror =
  | { readonly type: 'text'; readonly text: string }
  | {
    readonly type: 'image'
    readonly mediaType: string
    readonly data: string
    readonly name?: string
  }
  | { readonly type: 'file'; readonly receiptId: string }

/**
 * MIRROR of upstream `SessionPromptRequest` (types.ts:331). `mode` picks
 * delivery: `'queue'` waits for the live turn, `'steer'` steers it.
 */
export interface SessionPromptRequestMirror {
  readonly requestId: SessionRequestIdMirror
  readonly sessionId: SessionIdMirror
  readonly mode: 'queue' | 'steer'
  readonly content: readonly PromptContentPartMirror[]
  readonly clientTimeZone?: string
}

/**
 * MIRROR of upstream `SessionAddress` (types.ts:406): one ordinary Session or
 * one direct subagent child.
 */
export type SessionAddressMirror =
  | { readonly kind: 'session'; readonly sessionId: SessionIdMirror }
  | {
    readonly kind: 'subagent'
    readonly parentSessionId: SessionIdMirror
    readonly childSessionId: SessionIdMirror
    readonly mode: 'one-shot' | 'continuable' | 'unknown'
  }

/**
 * MIRROR of upstream `SessionFollowRequest` (types.ts:485; page-budget fields
 * from `SessionPageRequest` at :469–482). The UI always passes
 * `assistantStream: true` (transport.ts:172–175) to opt into live
 * assistant-stream frames.
 */
export interface SessionFollowRequestMirror {
  readonly address: SessionAddressMirror
  readonly assistantStream?: true
  readonly maxMessages?: number
  readonly turnWindow?: {
    readonly minMessages: number
    readonly minTurns: number
  }
}

/** MIRROR of upstream `SessionCancelRequest` (types.ts:371). */
export interface SessionCancelRequestMirror {
  readonly sessionId: SessionIdMirror
}

/**
 * Wire-arg wrapper keys per endpoint, as the native gateway's
 * `assertExactArguments`/`resolveParameter` expects them
 * (packages/api/gateway/src/index.ts:692–704; client builds
 * `{ args: { [parameter.wire]: value } }` at api/gateway/src/client/index.ts:525).
 * `session/list` alone uses `_request` (its controller parameter is declared
 * `_request` and ignored).
 */
export const WIRE_ARGS = {
  [WIRE_SESSION_LIST]: '_request',
  [WIRE_SESSION_CREATE]: 'request',
  [WIRE_SESSION_TITLE]: 'request',
  [WIRE_PROMPT_SUBMIT]: 'request',
  [WIRE_STREAM_OPEN]: 'request',
  [WIRE_TURN_CANCEL]: 'request',
} as const satisfies Record<string, string>

/**
 * Build the GatewayFace payload (`{ args: { <key>: value } }`) for one
 * session-plane endpoint.
 * @param endpoint - one of the defined `WIRE` constants.
 * @param value - the mirrored request object for that endpoint.
 * @returns the wire payload accepted by `dispatchRpc`/`openWireStream`.
 */
export function wireArgsOf(endpoint: string, value: unknown): { args: Record<string, unknown> } {
  const key = (WIRE_ARGS as Record<string, string | undefined>)[endpoint]
  if (key === undefined) throw new Error(`wire-endpoints: no wire-arg key for ${endpoint}`)
  return { args: { [key]: value } }
}
