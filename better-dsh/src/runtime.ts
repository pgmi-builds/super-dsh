/**
 * Stateful Python REPL backed by one owned OMP child per principal.
 * Whole per-principal transactions serialize boot, restore, cells, queries,
 * assignments and reset. Completed cells and assignments save best-effort
 * object graphs; recovery never replays user code or external effects.
 */

import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import z from '#schemastery'
import { snapshotJsonValue } from './snapshot-json.ts'
import {
  DUNDER_MEMBER,
  PORTABLE_RESERVED_WORDS,
  RESERVED_BINDING_GLOBALS,
  RESERVED_ERROR_MEMBERS,
  ReplRuntime,
} from './vendored/repl-runtime.ts'
import type {
  CodeBindingNamespace,
  CodeJsonValue,
  CodeRunFailure,
  CodeRunRequest,
  CodeRunResult,
} from './vendored/repl-runtime.ts'
import { IpyKernelBridge } from './kernel.ts'
import type { CellOutcome, HostRequestOutcome, QueryVarOutcome, SetVarOutcome, SnapshotOutcome, SnapshotSpec } from './kernel.ts'
import { buildRunCell } from './python.ts'
import type { NamespaceSpecs } from './python.ts'
import { MIN_OUTPUT_BYTES, extractStream, finalizeOutput, plainTraceback } from './output.ts'
import { resolveKernelEnv } from './kernel-env.ts'
import type { KernelEnv } from './kernel-env.ts'
import type { ReplVarQuery } from './runtime-surface.ts'

/** Plugin config: every tunable, changeable from `cordis.yml` (no hardcoded tunables). */
export interface Config {
  /** Python >=3.9 interpreter. The bare sentinel `python3` (or absent) selects a managed venv under {@link Config.kernelEnvDir}. */
  python?: string
  /** Budget for kernel spawn → ready, in milliseconds. */
  startupTimeoutMs?: number
  /** Wall budget per run; expiry interrupts the kernel then force-settles. */
  runTimeoutMs?: number
  /** Grace between a timeout/abort interrupt and the force-settle, in milliseconds. */
  interruptGraceMs?: number
  /**
   * Confirm window before repeating SIGINT, in milliseconds; must stay below {@link Config.interruptGraceMs}.
   * See the bridge's two-phase interrupt for why the escalation is deferred.
   */
  interruptConfirmMs?: number
  /** Budget for graceful kernel teardown (shutdown_request → SIGKILL), in milliseconds. */
  disposeTimeoutMs?: number
  /** Budget for internal snapshot/restore cells (dill dump/load), in milliseconds. */
  snapshotTimeoutMs?: number
  /** Hard cap for serialized log-array, completion-value, and failure-message payloads. */
  maxOutputBytes?: number
  /** Per-session immutable checkpoints. Defaults to the official profile home; empty string disables, standalone callers opt in. */
  snapshotDir?: string
  /** Serialized graph cap in bytes; each over-cap attempt reports the last successful checkpoint. */
  snapshotSizeCapBytes?: number
  /** Managed venv directory (used when `python` is absent/`python3`); defaults to `<package>/.venv-kernel`. */
  kernelEnvDir?: string
  /** Preferred CPython version for a managed venv. */
  kernelPythonVersion?: string
  /** Provision a stdlib-only managed venv on first use; default true. */
  kernelAutoInstall?: boolean
  username?: string
}

/** {@link Config} after schemastery fills the defaults. */
type ResolvedConfig = Required<Omit<Config, 'snapshotDir' | 'kernelEnvDir' | 'kernelPythonVersion'>> & Pick<Config, 'snapshotDir' | 'kernelEnvDir' | 'kernelPythonVersion'>

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Runner internals and legacy reserved shim prefix are never injectable variables. */
const KERNEL_OWNED_NAME = /^(?:_+dashr|__omp_)/i

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Key under which the per-session kernel map stores agentless runs. */
const AGENTLESS_KEY = '(agentless)'

/**
 * Encode one principal as a single path segment for its per-key snapshot
 * subdirectory: `encodeURIComponent` neutralizes separators and traversal,
 * and a leading run of dots (which would encode to itself, addressing `.` or
 * `..`) is re-escaped so every key lands strictly inside `snapshotDir`.
 */
function keyDirectoryName(principal: string): string {
  return encodeURIComponent(principal).replace(/^\.+/, dots => dots.replace(/\./g, '%2E'))
}

/** One session's kernel plus the bookkeeping its lifecycle needs. */
interface KeyedKernel {
  /** The map key (the run principal, or {@link AGENTLESS_KEY}). */
  key: string
  /** The kernel's working directory (the session's workspace), fixed at first spawn. */
  cwd?: string
  /** The subprocess bridge; replaced, never restarted, once dead. */
  bridge: IpyKernelBridge
  /**
   * Whether any cell has completed on this kernel — i.e. whether it may hold
   * user state a consumer could mistakenly assume still exists. Gates the
   * explicit namespace-lost error on respawn.
   */
  ranCells: boolean
  /** How many cells completed on this kernel — the snapshot "turn" counter. */
  turn: number
  /** Turn number of the last successfully written snapshot, when one exists. */
  lastSnapshotTurn?: number
  /** Whether restore-from-snapshot has been attempted for this entry (once per boot). */
  restoreAttempted?: boolean
  /** One-run notice (restore/degrade outcome) to surface on the next completed run. */
  pendingNotice?: string
}

/** What `restoreEntry` found and did, for the first-run notice and revive messaging. */
type RestoreOutcome =
  | { kind: 'none' }
  | { kind: 'restored', turn: number, omitted: Record<string, string> }
  | { kind: 'degraded', reason: string }

/**
 * The {@link ReplRuntime} backend this package registers (`ctx.replRuntime`)
 * — the standing-mount layer of the v0.1.5 architecture, the de facto daemon
 * while the profile-level DashrDaemon stays an empty shell. One service
 * instance per mount holds one lazily-spawned kernel per session principal;
 * each kernel's lifecycle — snapshot and shutdown on session end, snapshot
 * and shutdown of every key on plugin disposal — is effect-owned.
 */
export class DashrRuntime extends ReplRuntime {
  static Config: z<Config> = z.object({
    python: z.string().default('python3'),
    startupTimeoutMs: z.number().default(30_000),
    runTimeoutMs: z.number().default(120_000),
    interruptGraceMs: z.number().default(2_000),
    interruptConfirmMs: z.number().default(250),
    disposeTimeoutMs: z.number().default(5_000),
    snapshotTimeoutMs: z.number().default(30_000),
    maxOutputBytes: z.number().default(67_108_864),
    snapshotDir: z.string(),
    snapshotSizeCapBytes: z.number().default(268_435_456),
    kernelEnvDir: z.string(),
    kernelPythonVersion: z.string(),
    kernelAutoInstall: z.boolean().default(true),
    username: z.string().default('dashr'),
  })

  readonly language = 'python'
  readonly isolation = 'process'

  private readonly config: ResolvedConfig
  private readonly logger: ReturnType<Context['logger']>
  /** One entry per session principal that has run code (lazy — never pre-seeded). */
  private readonly kernels = new Map<string, KeyedKernel>()
  private disposed = false
  private readonly transactions = new Map<string, Promise<unknown>>()
  /** Lazily-resolved (and, when managed, provisioned) kernel interpreter. */
  private kernelEnvPromise: Promise<KernelEnv> | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx)
    const profile: ProfileContext | undefined = ctx.get('profileContext')
    this.config = { ...config, snapshotDir: config.snapshotDir ?? (profile ? join(profile.home, 'better-dsh', 'python-repl', createHash('sha256').update(profile.dir).digest('hex')) : undefined) } as ResolvedConfig
    // Schemastery filled the defaults; the cast records that. Positivity is a
    // semantic check the schema's plain number type does not carry.
    for (const key of ['startupTimeoutMs', 'runTimeoutMs', 'interruptGraceMs', 'disposeTimeoutMs', 'snapshotTimeoutMs'] as const) {
      const value = this.config[key]
      if (!(Number.isFinite(value) && value > 0)) {
        throw new Error(`dashr-repl: config.${key} must be a positive number, got ${String(value)}`)
      }
    }
    // The repeat SIGINT must fire before the hard cancellation deadline.
    if (!(this.config.interruptConfirmMs > 0 && this.config.interruptConfirmMs < this.config.interruptGraceMs)) {
      throw new Error(`dashr-repl: config.interruptConfirmMs must be positive and below interruptGraceMs (${this.config.interruptGraceMs}), got ${String(this.config.interruptConfirmMs)}`)
    }
    if (!Number.isSafeInteger(this.config.maxOutputBytes) || this.config.maxOutputBytes < MIN_OUTPUT_BYTES) {
      throw new Error(`dashr-repl: config.maxOutputBytes must be a safe integer of at least ${MIN_OUTPUT_BYTES}, got ${String(this.config.maxOutputBytes)}`)
    }
    if (!Number.isSafeInteger(this.config.snapshotSizeCapBytes) || this.config.snapshotSizeCapBytes < 1) {
      throw new Error(`dashr-repl: config.snapshotSizeCapBytes must be a positive safe integer, got ${String(this.config.snapshotSizeCapBytes)}`)
    }
    this.logger = ctx.logger('dashr-repl')
    ctx.effect(() => () => this.teardown(), 'eval code-runtime teardown')

    // Session-end teardown, keyed: dsh's agent registry emits `agent/disposed`
    // (payload `{ agent }`, the agent's `id` being the session id our runs
    // carry as `principal`) once an agent's driver has quiesced and its own
    // scope unwound — the moment its kernel has no future caller. Listened
    // through the UNTYPED event service on purpose: this package keeps zero
    // dsh runtime dependencies (blueprint §7.6), and the typed `Events`
    // augmentation lives in `@deepseek-ai/dsh-agent`. Scope filtering still
    // applies — the listener rides this plugin's context, so under a preset
    // mount it receives exactly the agents composed under that mount (the
    // agent's scope key chains to the mount's) and a bare mount hears every
    // agent. Both are safe: destroyKey is a no-op for keys that never ran
    // code through THIS instance.
    ctx.events.on('agent/disposed', (payload: unknown) => {
      const principal = (payload as { agent?: { id?: unknown } } | null)?.agent?.id
      if (typeof principal === 'string' && principal.length > 0) {
        void this.destroyKey(principal).catch(() => undefined)
      }
    })
  }

  /**
   * The agentless-default kernel's pid, for lifecycle diagnostics; absent
   * before the first agentless run. Per-session pids: {@link kernelPids}.
   */
  get kernelPid(): number | undefined {
    return this.kernels.get(AGENTLESS_KEY)?.bridge.pid
  }

  /** Every live kernel subprocess pid, one per session that has run code. */
  get kernelPids(): number[] {
    return [...this.kernels.values()].map(entry => entry.bridge.pid).filter((pid): pid is number => pid !== undefined)
  }

  /**
   * Execute one program as one cell on the persistent kernel. Program
   * outcomes — including kernel startup failure — resolve with
   * `result.error`; the method rejects only for Service Definition contract
   * misuse (a disposed runtime, an invalid binding namespace).
   * @param request - the program, its bindings, and the abort signal.
   * @returns the run's outcome per the seam contract.
   */
  private transaction<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.transactions.get(key) ?? Promise.resolve()).catch(() => undefined).then(operation)
    this.transactions.set(key, result)
    void result.finally(() => { if (this.transactions.get(key) === result) this.transactions.delete(key) }).catch(() => undefined)
    return result
  }

  run(request: CodeRunRequest): Promise<CodeRunResult> {
    return this.transaction(request.principal || AGENTLESS_KEY, () => this.runTransaction(request))
  }

  private async runTransaction(request: CodeRunRequest): Promise<CodeRunResult> {
    if (this.disposed) throw new Error('dashr-repl: run() after disposal')
    const bindings = this.validateBindings(request)
    const bindingNames = request.bindings.flatMap(binding => [binding.global, ...binding.errorClass ? [binding.errorClass.name] : []])
    if (request.signal?.aborted) {
      return { logs: [], error: { kind: 'abort', message: String(request.signal.reason) } }
    }
    const key = request.principal && request.principal.length > 0 ? request.principal : AGENTLESS_KEY
    // reset=true abandons the persistent namespace: dispose the live kernel
    // and clear its on-disk snapshot BEFORE any dead-kernel or reuse logic,
    // so the next ensureKernel spawns a fresh, EMPTY kernel.
    if (request.reset) {
      await this.resetKey(key)
    }

    // A kernel that died since this key's last run is never silently reused:
    // its namespace is gone, and executing the program would surface a
    // misleading NameError instead of the substrate truth. The first run to
    // observe the death resolves with the explicit error (M3-B: after
    // respawning onto the nearest usable checkpoint, so the message can
    // name the turn) and the NEXT run continues on that restored kernel.
    // A kernel that died before ever completing a cell carried no user state
    // and is simply replaced (a prior SESSION's on-disk snapshot, if any, is
    // still restored by the normal first-boot path below).
    const dead = this.kernels.get(key)
    if (dead?.bridge.isDead) {
      this.kernels.delete(key)
      if (dead.ranCells) {
        return await this.reviveAfterDeath(key, dead, false, bindingNames)
      }
    }

    let entry: KeyedKernel
    try {
      entry = await this.ensureKernel(key, request.cwd)
    } catch (error: unknown) {
      return finalizeOutput([], undefined, { kind: 'worker-exit', message: `kernel failed to start: ${messageOf(error)}` }, this.config.maxOutputBytes)
    }
    // First boot of this entry (fresh session OR resume OR revive): restore
    // the on-disk snapshot before any user code, once per boot. The notice is
    // consumed by the next COMPLETED run's logs, so the model learns where its
    // namespace came from (turn-N restored, or degraded-empty).
    if (!entry.restoreAttempted) {
      entry.restoreAttempted = true
      const restore = await this.restoreEntry(entry, bindingNames)
      if (restore.kind === 'restored') {
        entry.pendingNotice = `namespace restored from the turn-${restore.turn} snapshot${this.omissionNotice(restore.omitted)}`
      } else if (restore.kind === 'degraded') {
        entry.pendingNotice = `snapshot not replayable (${restore.reason}); started from an EMPTY namespace — re-create any state you need`
      }
    }
    const kernel = entry.bridge

    const specs: NamespaceSpecs = Object.fromEntries([...bindings.entries()].map(([global, namespace]) => [global, {
      functions: Object.keys(namespace.functions),
      ...namespace.callable ? { callable: true as const } : {},
      ...namespace.errorClass ? { errorClass: namespace.errorClass } : {},
    }]))
    const sentinel = `__dashr_${randomBytes(9).toString('hex')}__`
    const cell = buildRunCell(request.program, JSON.stringify(specs), sentinel)
    const outcome = await kernel.executeCell(cell, {
      timeoutMs: request.timeoutMs ?? this.config.runTimeoutMs,
      interruptGraceMs: this.config.interruptGraceMs,
      interruptConfirmMs: this.config.interruptConfirmMs,
      ...request.signal ? { signal: request.signal } : {},
      hostRequestHandler: data => this.dispatchHostRequest(data, bindings),
    })

    if (outcome.outcome === 'completed') {
      entry.ranCells = true
      entry.turn += 1
    } else if (outcome.outcome === 'forced' && outcome.failure.kind === 'worker-exit' && kernel.isDead && !this.disposed) {
      // The substrate died under this run. M3-B unifies this path with the
      // post-death-arrival branch: a kernel that had completed cells revives
      // onto its nearest snapshot and this run reports the turn-N loss; a
      // first-cell death has no state to lose and the run's own worker-exit
      // failure is the whole story.
      if (this.kernels.get(key) === entry) this.kernels.delete(key)
      const revived = await this.reviveAfterDeath(key, entry, true, bindingNames)
      return finalizeOutput(extractStream(outcome.streamText, sentinel).logs, revived.value, revived.error, this.config.maxOutputBytes)
    }
    let result = this.assembleResult(outcome, sentinel)

    if (outcome.outcome === 'completed') {
      // Save completed cells even after user exceptions. Recovery notices
      // share the same output ledger as user output.
      const snapshot = await this.snapshotTurnEnd(entry)
      const notices: string[] = snapshot ? [snapshot] : []
      if (entry.pendingNotice) {
        notices.push(`[dashr] ${entry.pendingNotice}`)
        entry.pendingNotice = undefined
      }
      if (notices.length > 0) {
        result = finalizeOutput([...result.logs, ...notices], result.value, result.error, this.config.maxOutputBytes)
      }
    }
    return result
  }

  /**
   * Read one user-namespace variable by name on the session's kernel. A
   * bare/empty name lists the namespace's user-variable names; a
   * JSON-serializable value resolves to its JSON text, any other value to its
   * `repr` text, and a missing name to `{ kind: 'missing' }`. When no live
   * kernel holds state for the key the namespace is empty (no spawn — this
   * channel never creates a kernel). Pure additive: the run/execute/snapshot
   * lifecycle is untouched.
   * @param name - the variable name, or empty to list namespace names.
   * @param principal - the session key (absent → the shared default).
   */
  queryVar(name: string, principal?: string): Promise<ReplVarQuery> {
    return this.transaction(principal || AGENTLESS_KEY, () => this.queryTransaction(name, principal))
  }
  private async queryTransaction(name: string, principal?: string): Promise<ReplVarQuery> {
    if (this.disposed) throw new Error('dashr-repl: queryVar() after disposal')
    const key = principal && principal.length > 0 ? principal : AGENTLESS_KEY
    const bridge = this.kernels.get(key)?.bridge
    if (!bridge || !bridge.isRunning) {
      return name.trim().length === 0 ? { kind: 'names', names: [] } : { kind: 'missing' }
    }
    const outcome: QueryVarOutcome = await bridge.queryVar(name.trim().length === 0 ? null : name)
    switch (outcome.kind) {
      case 'json':
        return { kind: 'json', text: outcome.text }
      case 'repr':
        return { kind: 'repr', text: outcome.text }
      case 'names':
        return { kind: 'names', names: outcome.names }
      case 'missing':
        return { kind: 'missing' }
      case 'failed':
        throw new Error(`dashr-repl: queryVar(${JSON.stringify(name)}) failed: ${outcome.reason}`)
    }
  }

  /**
   * Assign one lossless-JSON value into the user namespace under `name` on
   * the session's kernel. `name` must be a usable identifier (and not a
   * kernel-shim name); `value` must be lossless JSON. Requires a live kernel
   * for the key — the channel never spawns one, so a session that has not yet
   * run a cell must `run` first. Pure additive to the existing lifecycle.
   * @param name - the identifier to assign under.
   * @param value - the lossless-JSON value to bind.
   * @param principal - the session key (absent → the shared default).
   */
  setVar(name: string, value: unknown, principal?: string): Promise<void> {
    return this.transaction(principal || AGENTLESS_KEY, () => this.setTransaction(name, value, principal))
  }
  private async setTransaction(name: string, value: unknown, principal?: string): Promise<void> {
    if (this.disposed) throw new Error('dashr-repl: setVar() after disposal')
    const trimmed = name.trim()
    if (trimmed.length === 0) {
      throw new Error('dashr-repl: setVar() requires a non-empty variable name')
    }
    if (!IDENTIFIER.test(trimmed)) {
      throw new Error(`dashr-repl: setVar() name ${JSON.stringify(trimmed)} is not a usable identifier`)
    }
    if (KERNEL_OWNED_NAME.test(trimmed) || RESERVED_BINDING_GLOBALS.has(trimmed) || trimmed === '__doc__') {
      throw new Error(`dashr-repl: setVar() name ${JSON.stringify(trimmed)} is reserved by the kernel`)
    }
    const jsonValue = snapshotJsonValue(value)
    if (jsonValue === undefined) {
      throw new Error('dashr-repl: setVar() value must be lossless JSON')
    }
    const key = principal && principal.length > 0 ? principal : AGENTLESS_KEY
    const bridge = this.kernels.get(key)?.bridge
    if (!bridge || !bridge.isRunning) {
      throw new Error('dashr-repl: setVar() requires a live kernel for this session — run a cell first')
    }
    const outcome: SetVarOutcome = await bridge.setVar(trimmed, JSON.stringify(jsonValue))
    if (outcome.kind === 'failed') {
      throw new Error(`dashr-repl: setVar(${JSON.stringify(trimmed)}) failed: ${outcome.reason}`)
    }
    const entry = this.kernels.get(key)!
    const notice = await this.snapshotTurnEnd(entry)
    if (notice) entry.pendingNotice = [entry.pendingNotice, notice].filter(Boolean).join('; ')
  }

  /** Map one cell outcome onto the seam's result shape under the output ledger. */
  private assembleResult(outcome: CellOutcome, sentinel: string): CodeRunResult {
    const capture = extractStream(outcome.streamText, sentinel)
    const maxBytes = this.config.maxOutputBytes

    if (outcome.outcome === 'forced') {
      return finalizeOutput(capture.logs, undefined, outcome.failure, maxBytes)
    }
    if (outcome.status === 'error') {
      const failure: CodeRunFailure = outcome.cellError
        ? { kind: 'exception', message: plainTraceback(outcome.cellError.ename, outcome.cellError.evalue, outcome.cellError.traceback) }
        : { kind: 'exception', message: 'the program failed without a traceback' }
      return finalizeOutput(capture.logs, undefined, failure, maxBytes)
    }

    // Completed without error: recover the completion envelope printed under
    // the sentinel.
    if (capture.envelope === undefined) {
      return finalizeOutput(capture.logs, undefined, undefined, maxBytes)
    }
    let envelope: unknown
    try {
      envelope = JSON.parse(capture.envelope)
    } catch {
      return finalizeOutput(capture.logs, undefined, { kind: 'invalid-output', message: 'completion envelope was not valid JSON' }, maxBytes)
    }
    if (typeof envelope !== 'object' || envelope === null || (envelope as { ok?: unknown }).ok !== true) {
      return finalizeOutput(capture.logs, undefined, { kind: 'invalid-output', message: 'program completion must be lossless JSON' }, maxBytes)
    }
    const json = (envelope as { json?: unknown }).json
    if (typeof json !== 'string') {
      // A value-less completion (no top-level `return` executed) leaves the
      // value absent rather than substituting a null.
      return finalizeOutput(capture.logs, undefined, undefined, maxBytes)
    }
    // An explicit `return None` crosses the JSON boundary as null — a real
    // completion value, matching the worker-thread backend's treatment.
    return finalizeOutput(capture.logs, JSON.parse(json) as CodeJsonValue, undefined, maxBytes)
  }

  /** Reject malformed binding globals or typed-error declarations as contract misuse. */
  private validateBindings(request: CodeRunRequest): Map<string, CodeBindingNamespace> {
    const bindings = new Map<string, CodeBindingNamespace>()
    for (const namespace of request.bindings) {
      if (!IDENTIFIER.test(namespace.global) || PORTABLE_RESERVED_WORDS.has(namespace.global)) {
        throw new Error(`dashr-repl: binding global ${JSON.stringify(namespace.global)} is not a usable identifier`)
      }
      if (RESERVED_BINDING_GLOBALS.has(namespace.global) || KERNEL_OWNED_NAME.test(namespace.global)) {
        throw new Error(`dashr-repl: reserved binding global ${JSON.stringify(namespace.global)}`)
      }
      if (bindings.has(namespace.global)) {
        throw new Error(`dashr-repl: duplicate binding global ${JSON.stringify(namespace.global)}`)
      }
      // A bare callable global dispatches exactly one host function; any other
      // count is a contract error (the kernel installer has no member to pick).
      if (namespace.callable === true && Object.keys(namespace.functions).length !== 1) {
        throw new Error(`dashr-repl: callable binding global ${JSON.stringify(namespace.global)} must declare exactly one function`)
      }
      bindings.set(namespace.global, namespace)
    }

    // The flat per-tool binding shape (v0.1.5) declares the SAME error class on
    // every tool namespace: one shared ToolCallError must catch failures from
    // all of them. An identical (name + member) re-declaration is therefore
    // legal and materializes once kernel-side; a same-name/different-member
    // clash stays a contract error.
    const errorClasses = new Map<string, string>()
    for (const namespace of request.bindings) {
      const descriptor = namespace.errorClass
      if (!descriptor) continue
      if (!IDENTIFIER.test(descriptor.name) || PORTABLE_RESERVED_WORDS.has(descriptor.name)) {
        throw new Error(`dashr-repl: binding error class ${JSON.stringify(descriptor.name)} is not a usable identifier`)
      }
      if (RESERVED_BINDING_GLOBALS.has(descriptor.name) || KERNEL_OWNED_NAME.test(descriptor.name)) {
        throw new Error(`dashr-repl: reserved binding global ${JSON.stringify(descriptor.name)}`)
      }
      if (bindings.has(descriptor.name)) {
        throw new Error(`dashr-repl: duplicate injected global ${JSON.stringify(descriptor.name)}`)
      }
      const member = descriptor.memberNameProperty
      if (member.length === 0 || RESERVED_ERROR_MEMBERS.has(member) || DUNDER_MEMBER.test(member)) {
        throw new Error(`dashr-repl: binding error member property ${JSON.stringify(descriptor.memberNameProperty)} is not usable`)
      }
      const declared = errorClasses.get(descriptor.name)
      if (declared !== undefined && declared !== member) {
        throw new Error(`dashr-repl: error class ${JSON.stringify(descriptor.name)} declared with conflicting member properties ${JSON.stringify(declared)} and ${JSON.stringify(member)}`)
      }
      errorClasses.set(descriptor.name, member)
    }
    return bindings
  }

  /** Dispatch one kernel-side host request; unknown types and bad payloads become error replies. */
  private async dispatchHostRequest(data: Record<string, unknown>, bindings: Map<string, CodeBindingNamespace>): Promise<HostRequestOutcome> {
    if (data.type !== 'binding.call' || typeof data.global !== 'string' || typeof data.name !== 'string') {
      return { ok: false, message: 'host request must be a binding.call with global and name' }
    }
    // Own-property lookup only: a forged name like 'constructor' must not
    // walk the record's prototype chain.
    const record = bindings.get(data.global)?.functions
    const fn = record && Object.hasOwn(record, data.name) ? record[data.name] : undefined
    if (typeof fn !== 'function') {
      return { ok: false, message: `unknown binding ${JSON.stringify(`${data.global}.${data.name}`)}` }
    }
    const args = snapshotJsonValue(data.args)
    if (args === undefined) {
      return { ok: false, message: 'binding arguments must be lossless JSON' }
    }
    let resolved: unknown
    try {
      resolved = await fn(args)
    } catch (error: unknown) {
      return { ok: false, message: messageOf(error) }
    }
    const value = snapshotJsonValue(resolved)
    if (value === undefined) {
      return { ok: false, message: 'binding resolution must be lossless JSON' }
    }
    return { ok: true, result: value }
  }

  /** Resolve (and provision, when managed) the kernel interpreter once per runtime. */
  private resolveKernelPython(): Promise<KernelEnv> {
    this.kernelEnvPromise ??= resolveKernelEnv({
      python: this.config.python,
      venvDir: this.config.kernelEnvDir,
      pythonVersion: this.config.kernelPythonVersion,
      autoInstall: this.config.kernelAutoInstall,
      log: (level, message) => {
        if (level === 'warn') this.logger.warn(message)
        else this.logger.info(message)
      },
    }).catch((error: unknown) => {
      // A failed provision must not cache a rejected promise forever: the
      // next ensureKernel retries (e.g. after the user installs uv/venv).
      this.kernelEnvPromise = undefined
      throw error
    })
    return this.kernelEnvPromise
  }


  /**
   * Spawn-or-reuse the kernel for one key. The lazy map guarantees one
   * entry is created here and nowhere else, so a key that never runs never
   * holds a subprocess — the subagent fan-out guarantee (blueprint §6:
   * subagent ×N spawns nothing until a child actually executes code).
   * @param key - the run principal (or the agentless default).
   */
  private async ensureKernel(key: string, cwd?: string): Promise<KeyedKernel> {
    let entry = this.kernels.get(key)
    if (!entry) {
      // A session header cwd is a validated absolute path, but a workspace can
      // be deleted before the kernel first spawns (e.g. a resumed session over
      // a removed directory). Spawning with a missing cwd is a hard ENOENT, so
      // degrade to spawn-time inherit rather than fail the whole kernel.
      const kernelCwd = cwd && existsSync(cwd) ? cwd : undefined
      entry = {
        key,
        cwd: kernelCwd,
        bridge: new IpyKernelBridge({
          python: (await this.resolveKernelPython()).python,
          ...kernelCwd ? { cwd: kernelCwd } : {},
          startupTimeoutMs: this.config.startupTimeoutMs,
          disposeTimeoutMs: this.config.disposeTimeoutMs,
          interruptConfirmMs: this.config.interruptConfirmMs,
          snapshotTimeoutMs: this.config.snapshotTimeoutMs,
          username: this.config.username,
          snapshotDirectory: this.config.snapshotDir ? join(this.config.snapshotDir, keyDirectoryName(key)) : undefined,
          snapshotSizeCapBytes: this.config.snapshotSizeCapBytes,
        }),
        ranCells: false,
        turn: 0,
      }
      this.kernels.set(key, entry)
    }
    if (this.disposed) { await entry.bridge.dispose(); throw new Error('runtime disposed during startup') }
    await entry.bridge.start()
    return entry
  }

  /** Restore once before user admission; any degraded load retires that child. */
  private async restoreEntry(entry: KeyedKernel, bindingNames: string[]): Promise<RestoreOutcome> {
    if (!this.config.snapshotDir) return { kind: 'none' }
    const dir = join(this.config.snapshotDir, keyDirectoryName(entry.key))
    const manifestPath = join(dir, 'manifest.json')
    if (!existsSync(manifestPath)) return { kind: 'none' }
    const restored = await entry.bridge.restoreState(join(dir, 'state.dill'), manifestPath, bindingNames)
    if (restored.kind === 'restored') {
      entry.turn = restored.turn
      entry.lastSnapshotTurn = restored.turn
      entry.ranCells = true
      return { kind: 'restored', turn: restored.turn, omitted: restored.omitted }
    }
    // A malicious/failed reducer can mutate globals before failing. Retire the
    // whole attempted interpreter before admitting any user cell.
    await entry.bridge.dispose()
    this.kernels.delete(entry.key)
    const fresh = await this.ensureKernel(entry.key, entry.cwd)
    entry.bridge = fresh.bridge
    this.kernels.set(entry.key, entry)
    return { kind: 'degraded', reason: restored.reason }
  }

  private omissionNotice(omitted: Record<string, string>): string {
    const entries = Object.entries(omitted)
    return entries.length ? `; partial coverage, omitted ${entries.map(([name, reason]) => `${name} (${reason})`).join(', ')}` : ''
  }

  /** Restore a fresh child and report whether the observing call had started. */
  private async reviveAfterDeath(key: string, dead: KeyedKernel, started: boolean, bindingNames: string[]): Promise<CodeRunResult> {
    const execution = started
      ? 'This cell may have executed partially, including external side effects; inspect their state before choosing any retry. No user code was replayed.'
      : 'This observing call did not execute. No user code was replayed.'
    let entry: KeyedKernel
    try {
      entry = await this.ensureKernel(key, dead.cwd)
    } catch (error: unknown) {
      return finalizeOutput([], undefined, {
        kind: 'worker-exit',
        message: `kernel died and respawn failed (${messageOf(error)}); the next run will retry a fresh kernel. ${execution}`,
      }, this.config.maxOutputBytes)
    }
    entry.restoreAttempted = true
    const restore = await this.restoreEntry(entry, bindingNames)
    entry.turn = Math.max(entry.turn, dead.turn)
    if (restore.kind === 'restored') {
      return finalizeOutput([], undefined, {
        kind: 'worker-exit',
        message: `the kernel for this session died; its namespace was restored from the turn-${restore.turn} snapshot${this.omissionNotice(restore.omitted)}. Changes after that checkpoint may be lost. ${execution}`,
      }, this.config.maxOutputBytes)
    }
    const detail = restore.kind === 'degraded' ? ` (${restore.reason})` : ''
    return finalizeOutput([], undefined, {
      kind: 'worker-exit',
      message: `the kernel for this session died and no usable snapshot was available${detail}; the next run uses an EMPTY namespace. ${execution}`,
    }, this.config.maxOutputBytes)
  }

  /** Save completed mutations and expose partial/failed coverage within output limits. */
  private async snapshotTurnEnd(entry: KeyedKernel): Promise<string | undefined> {
    if (!this.config.snapshotDir || !entry.bridge.isRunning || this.disposed) return
    const dir = join(this.config.snapshotDir, keyDirectoryName(entry.key))
    const spec: SnapshotSpec = { turn: entry.turn, skills: [], sizeCapBytes: this.config.snapshotSizeCapBytes }
    let outcome: SnapshotOutcome
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      outcome = await entry.bridge.snapshotState(join(dir, 'state.dill'), join(dir, 'manifest.json'), spec)
    } catch (error: unknown) {
      // Persistence is best-effort: the cell or assignment already completed.
      outcome = { kind: 'failed', reason: messageOf(error) }
    }
    if (outcome.kind === 'ok') {
      entry.lastSnapshotTurn = outcome.turn
      const omission = this.omissionNotice(outcome.omitted)
      const warning = outcome.warning ? `; ${outcome.warning}` : ''
      return omission || warning ? `[dashr] turn-${outcome.turn} checkpoint saved${omission}${warning}` : undefined
    }
    const latest = entry.lastSnapshotTurn === undefined ? 'no successful checkpoint available' : `latest successful checkpoint is turn-${entry.lastSnapshotTurn}`
    return `[dashr] namespace snapshot ${outcome.kind === 'skipped' ? 'skipped' : 'failed'}: ${outcome.reason}; ${latest}`
  }

  /** Cancel active work, drain admitted transactions, and reap every owned child. */
  private async teardown(): Promise<void> {
    this.disposed = true
    // Cancel active children before draining transactions, so disposal never
    // waits for a user cell's full timeout. Completed mutations already save.
    await Promise.all([...this.kernels.values()].map(entry => entry.bridge.dispose()))
    await Promise.allSettled([...this.transactions.values()])
    await Promise.all([...this.kernels.values()].map(entry => entry.bridge.dispose()))
    this.kernels.clear()
  }

  /**
   * Tear one session's kernel down (session end via the `agent/disposed`
   * listener). A no-op for keys that never ran code through this instance —
   * which is what makes hearing every agent's disposal safe.
   */
  private async destroyKey(key: string): Promise<void> {
    await this.kernels.get(key)?.bridge.dispose()
    await this.transaction(key, async () => {
      const entry = this.kernels.get(key)
      this.kernels.delete(key)
      await entry?.bridge.dispose()
    })
  }

  /**
   * Reset one session's kernel to a fresh, empty namespace: dispose the live
   * subprocess WITHOUT a turn-end snapshot and clear its on-disk snapshot, so
   * the next ensureKernel spawns empty (restore finds no checkpoint).
   */
  private async resetKey(key: string): Promise<void> {
    const entry = this.kernels.get(key)
    if (entry) {
      this.kernels.delete(key)
      await entry.bridge.dispose()
    }
    if (this.config.snapshotDir) {
      rmSync(join(this.config.snapshotDir, keyDirectoryName(key)), { recursive: true, force: true })
    }
  }


}

export default DashrRuntime

/**
 * The vendored Service Definition's public contract, re-exported from the
 * package root so consumers (the sibling presentation package, its drift
 * tests, any future backend) can depend on the PUBLISHED shape instead of
 * reaching into `./src/*` (which the published tarball does not carry).
 */
export { ReplRuntime } from './vendored/repl-runtime.ts'
export type {
  CodeBindingErrorClass,
  CodeBindingFunction,
  CodeBindingNamespace,
  CodeJsonValue,
  CodeRunFailure,
  CodeRunRequest,
  CodeRunResult,
} from './vendored/repl-runtime.ts'
