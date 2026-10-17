/**
 * The `ctx.subagents` / `ctx.workflowEngine` seam surfaces, as this
 * presentation plugin consumes them — STRUCTURAL MIRRORS of the host-plane
 * Service Definitions (`@deepseek-ai/dsh-subagent` and
 * `@deepseek-ai/dsh-workflow`, 0.1.0-rc.6), which are deliberately NOT in
 * this package's dependency graph: both are host-plane root-realm singletons
 * (the preset delegates their registration to the host composition), and
 * importing either package here would pull a host-plane capability into an
 * agent-plane plugin for typing alone.
 *
 * The delegation bridges (`agent`, `agent_message`, `agent_workflow`) read
 * these surfaces with the untyped `ctx.get('subagents')` /
 * `ctx.get('workflowEngine')` escape hatch (the same optional-capability
 * pattern upstream's child-agent.ts uses for `agentPresets`/`sandboxPolicy`),
 * and this file types exactly the operations those bridges call — no more.
 *
 * Host-plane note (v0.1.8): the row mounts on the HOST plane (the bundle
 * patch's `insert`), so `ctx.subagents` / `ctx.workflowEngine` — host-plane
 * root-realm singletons — are reachable from the presentation layer without
 * any preset realm. The bridge callbacks therefore live in THIS presentation
 * layer: the one place that can simultaneously reach the services (outward),
 * the calling `Agent` (`exec.agent`), and the run's abort signal.
 *
 * Wave5 (v0.1.8e+): the bridges now call the SERVICE layer directly — the
 * upstream delegation tools are masked from the model surface, and the
 * service's own authorization (authorizeLineage / admissions) is the
 * deployment enforcement, preserved verbatim. The earlier "downlink goes
 * through the TOOL layer" split (ADR-0001) is gone for spawn/sendMessage/
 * @module dashr-repl/subagents-surface
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

/**
 * The subset of upstream `SubagentSendMessageOptions` the bridge constructs
 * (0.1.5 unified seam: one `sendMessage` covers both directions — down to a
 * continuable child, and up to the parent when `targetId` is the sender's
 * `parentSession`). The old `source`/`delivery` knobs are gone: the runtime
 * stamps its own durable attribution and parent scheduling policy.
 */
export interface DASHRSubagentSendMessageOptions {
  /** Caller cancellation, owning the operation only until inbox acceptance. */
  readonly signal: AbortSignal
}

/**
 * The interrupt authority the bridge constructs, verbatim from the native
 * `interrupt_agent` tool: the exact live calling agent IS the ancestor whose
 * recorded lineage must contain the target (`kind: 'ancestor'`).
 */
export interface DASHRSubagentInterruptAuthority {
  readonly kind: 'ancestor'
  readonly agent: Agent
}

/**
 * The activation request body the `agent` bridge builds, verbatim in field
 * shape from the native managed-activation spec (0.2.1): model input
 * (`prompt`), the spawning `parent`, and `maxDepth` fixed at the native
 * default (`3`). The label travels top-level on the spec, not in the request.
 * Deployment-only fields (`cwd`, `agentPreset`, `agentOptions`, `persona`,
 * `toolFilter`) stay omitted — the bridge exposes none of them to the model,
 * and the native default for each is "absent".
 */
export interface DASHRActivationRequest {
  /** Content delivered as the child's user message. */
  readonly prompt: ContentBlock[]
  /** The spawning agent (workspace/lineage/depth source). */
  readonly parent: Agent
  /** Absolute delegation-depth cap (native default `3`). */
  readonly maxDepth: number
}

/** The terminal outcome of a managed child execution, as the bridge reads it. */
export interface DASHRSubagentResult {
  /** The child's final assistant output content blocks. */
  readonly output: readonly ContentBlock[]
  /** Why the run ended (`'completed'` means `output` is complete). */
  readonly stopReason: string
}

/**
 * Legacy request (pre-0.2.1 hosts): the activation request plus its label and
 * caller cancellation — the shape the removed `start`/`startContinuable`
 * seams accepted. Kept only so the fallback path types against old hosts.
 */
export interface DASHRSubagentStartRequest {
  /** Short display label (the child's persisted creation label). */
  readonly label: string
  /** Content delivered as the child's user message. */
  readonly prompt: ContentBlock[]
  /** The spawning agent (workspace/lineage/depth source). */
  readonly parent: Agent
  /** Absolute delegation-depth cap (native default `3`). */
  readonly maxDepth: number
  /** Cancellation signal from the spawning context. */
  readonly signal: AbortSignal
}

/** Legacy ONE-SHOT child handle (pre-0.2.1 hosts): await result, then dispose. */
export interface DASHRSubagentRun {
  /** Parent-scoped run id. */
  readonly id: SessionId
  /** Resolves with the child's terminal result (never rejects on child failure). */
  readonly result: Promise<DASHRSubagentResult>
  /** Cancel remaining work and release resources. */
  dispose(): Promise<void>
}

/** What the legacy `startContinuable` seam asked for (pre-0.2.1 hosts). */
export interface DASHRContinuableStartSpec {
  /** The `ctx.subagents` provider name (`spawn` for delegate, `fork` for fork). */
  readonly provider: string
  /** The delegation (label travels inside the request on this seam). */
  readonly request: DASHRSubagentStartRequest
}

/** Legacy identities returned once a continuable child accepted its initial prompt. */
export interface DASHRContinuableStart {
  /** The durable child session id, stable across activations. */
  readonly childId: SessionId
}

/** One managed child execution the `agent` bridge starts (0.2.1 seam). */
export interface DASHRActivationSpec {
  /** The `ctx.subagents` provider name (`spawn` for delegate, `fork` for fork). */
  readonly provider: string
  /** Short task label retained in the child's cataloged membership. */
  readonly label: string
  /** Task, parent, and execution options (the delegation body, label-less). */
  readonly request: DASHRActivationRequest
  /** Cancellation before publication; callers own later cancellation through dispose. */
  readonly signal: AbortSignal
  /** Parent delivery notifies the model; caller delivery only returns the result. */
  readonly delivery: 'parent' | 'caller'
}

/** A managed execution; disposal addresses this exact activation, never a later resume. */
export interface DASHRActivation {
  /** The durable child session id, stable across activations. */
  readonly childId: SessionId
  /** Accepted inbox message, when the backend has a local inbox. */
  readonly messageId?: MessageId
  /** Resolves with the child's terminal result (never rejects on child failure). */
  readonly result: Promise<DASHRSubagentResult>
  /** Stop and release this activation and its owned descendants. */
  dispose(): Promise<void>
}

/**
 * The `ctx.subagents` service surface the delegation bridges call. Hosts
 * from 0.2.1 provide `startActivation` (managed activations: continuable
 * children via parent delivery, awaited one-shots via caller delivery) and
 * removed the older `start`/`startContinuable` pair, which every pre-0.2.1
 * host still exposes — both seams are optional here, and the bridge picks
 * whichever the running host provides, so the declared peer range stays
 * honest on old and new hosts alike. The `sendMessage` adjacency downlink
 * (child) and uplink (parent), and the `interrupt` stop request, are common
 * to both eras. Each is the same call the native delegation/control tools
 * make, so the service's own authorization is preserved verbatim.
 */
export interface DASHRSubagentsSurface {
  /** Establish a managed child execution under a delivery policy (0.2.1+). */
  startActivation?(spec: DASHRActivationSpec): Promise<DASHRActivation>
  /** Legacy one-shot start (pre-0.2.1 hosts): delegation plus cancellation. */
  start?(provider: string, request: DASHRSubagentStartRequest): Promise<DASHRSubagentRun>
  /** Legacy continuable start (pre-0.2.1 hosts): durable child, initial prompt. */
  startContinuable?(spec: DASHRContinuableStartSpec): Promise<DASHRContinuableStart>
  /** Deliver one message to an adjacent agent: next FIFO turn for a continuable
   *  child target, or the report-up path when the target is the sender's parent. */
  sendMessage(sender: Agent, targetId: SessionId, content: ContentBlock[], options: DASHRSubagentSendMessageOptions): Promise<MessageId>
  /** Interrupt one live continuable child's current turn under the live ancestor. */
  interrupt(targetSessionId: SessionId, authority: DASHRSubagentInterruptAuthority): void
}

/** The workflow identity block (`meta`) the `agent_workflow` bridge passes through. */
export interface DASHRWorkflowMeta {
  readonly name: string
  readonly description: string
  readonly [key: string]: unknown
}

/** What the `agent_workflow` bridge asks for when starting a workflow run. */
export interface DASHRWorkflowStartRequest {
  /** The plain-JS script body (top-level await allowed; ends with `return <json-value>`). */
  readonly script: string
  /** The workflow's identity block, as plain JSON data. */
  readonly meta: DASHRWorkflowMeta
  /** Optional input exposed verbatim to the script as the `args` global. */
  readonly args?: unknown
  /** Optional engine-wide child-provider override for this run. */
  readonly subagentProvider?: string
  /** Optional per-run total-child ceiling. */
  readonly maxTotalAgents?: number
  /** The agent on whose behalf the run executes (parent of every child). */
  readonly parent: Agent
  /** Cancels the run when aborted. */
  readonly signal?: AbortSignal
}

/** The outcome resolved by a live workflow run. */
export interface DASHRWorkflowResult {
  /** The script's return value (host JSON data; `null` for no return). */
  readonly value: unknown
  /** Why the run settled. */
  readonly stopReason: 'completed' | 'cancelled' | 'error'
  /** The failure message (present iff `stopReason` is not `completed`). */
  readonly error?: string
  /** How many `agent()` calls the run accepted over its whole lifetime. */
  readonly agentsStarted: number
}

/** Holder-owned live workflow the bridge consumes. */
export interface DASHRWorkflowRun {
  readonly id: string
  readonly result: Promise<DASHRWorkflowResult>
  /** Cancel the run and its children. */
  cancel(reason?: string): void
  /** Cancel if needed and await bounded settlement and cleanup. */
  dispose(): Promise<void>
}

/** The `ctx.workflowEngine` service surface the `agent_workflow` bridge calls. */
export interface DASHRWorkflowEngine {
  start(request: DASHRWorkflowStartRequest): DASHRWorkflowRun
}
