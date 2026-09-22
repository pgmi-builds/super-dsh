/**
 * `dashr-remote` — the composition row for the remote `ssh` tool (plan
 * docs/10_plans/2026-09-22-dashr-remote-tool-rm0.md Task 9). Mirrors
 * `src/mobile/plugin.ts`: one bundle-patch row (`- id: dashr-remote` in
 * `cordis.patch.yml`) that, when a `tools` service is composed, builds the
 * target registry from the row config (+ `~/.ssh/config` seed), boots one
 * {@link RemoteEngine} and registers the model-facing `ssh` tool face. The
 * engine (pooled sessions, idle timers) is disposed with the row's fiber.
 *
 * Zero static injects: the row loads dormant in compositions without tools,
 * and `buildRegistry` failing loud at mount is deliberate — a bad override
 * must never half-mount.
 *
 * @module dashr/remote/plugin
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { join } from 'node:path'
import { createFileHostKeyStore } from './hostkeys.ts'
import { RemoteEngine } from './engine.ts'
import { buildRegistry } from './registry.ts'
import { createSshTool } from './tool.ts'

/** Cordis plugin name. */
export const name = 'dashr-remote'

/** No static injects: `tools` is composed conditionally inside {@link apply}. */
export const inject: string[] = []

/** One target override; every field optional (merged onto the ssh-config seed field-wise). */
export interface TargetOverrideConfig {
  host?: string
  user?: string
  port?: number
  identityFile?: string
  defaultCwd?: string
  env?: Record<string, string>
}

/** The `dashr-remote` row config. */
export interface RemoteRowConfig {
  /** Target overrides keyed by logical target name. */
  targets: Record<string, TargetOverrideConfig>
  /** Per-command execution timeout in seconds (engine default 120). */
  execTimeoutSec: number
  /** Idle pooled-session TTL in seconds (engine default 300). */
  idleTtlSec: number
  /** Per-command output cap in characters (engine default 30000). */
  maxOutputChars: number
}

/**
 * Row config schema — per-field defaults, so the patch row carries no config
 * at all (the real deployment path: cordis validates `undefined` into the
 * default object).
 */
export const Config: z<RemoteRowConfig> = z
  .object({
    targets: z
      .dict(
        z.object({
          host: z.string(),
          user: z.string(),
          port: z.natural(),
          identityFile: z.string(),
          defaultCwd: z.string(),
          env: z.dict(z.string()),
        }),
      )
      .default({}),
    execTimeoutSec: z.natural().min(1).default(120),
    idleTtlSec: z.natural().min(1).default(300),
    maxOutputChars: z.natural().min(1).default(30_000),
  })
  .default({ targets: {}, execTimeoutSec: 120, idleTtlSec: 300, maxOutputChars: 30_000 }) as unknown as z<RemoteRowConfig>

/** Central store path for per-target host-key pins: `$DSH_HOME/storages/better-dsh/`. */
export function remoteHostKeyStorePath(): string {
  return join(resolveDshHome(), 'storages', 'better-dsh', 'remote-hostkeys.json')
}

/**
 * Mount the row: registry → engine → `ssh` tool registration, engine disposed
 * with the fiber. Runs inside `ctx.inject(['tools'], …)` so compositions
 * without a tools service keep the row dormant.
 *
 * MUST stay an arrow (not a `function` declaration): cordis's `isConstructor`
 * treats any `.prototype`-bearing callback as a class and invokes it via `new`,
 * which swallows the returned disposer (an object return becomes the instance;
 * the fiber then reads `instance[init]` and drops it). Arrow applies take the
 * plain call path and their return is collected as the fiber disposer.
 *
 * @param ctx - host plugin context.
 * @param config - the row config (cordis has already resolved it through {@link Config}).
 */
export const apply = (ctx: Context, config: RemoteRowConfig): (() => void) => {
  // Registry build is config-derived and must fail the mount LOUDLY (synchronous
  // apply throw → the plugin fiber rejects): a bad override must never half-mount.
  const { targets } = buildRegistry({ overrides: config.targets })
  // Engine construction is inert (no dials; sessions/backends materialize lazily
  // on first exec), so it exists even while the row waits for a tools service.
  const engine = new RemoteEngine({
    registry: targets,
    hostKeyStore: createFileHostKeyStore(remoteHostKeyStorePath()),
    execTimeoutSec: config.execTimeoutSec,
    idleTtlSec: config.idleTtlSec,
    maxOutputChars: config.maxOutputChars,
  })
  ctx.inject(['tools'], (toolsCtx: Context) => {
    // The row itself stays inject-free (loads dormant without tools); service
    // property access is only legal through the inject callback's ctx — same
    // shape as the dashr-repl row's runtimeCtx.tools.register.
    toolsCtx.tools.register(
      createSshTool(engine, {
        // Session key = agent id; agent-less calls share one fallback key.
        getSessionKey: (exec) => exec.agent?.id ?? 'dashr-remote:no-session',
      }),
    )
  })
  // Engine teardown rides the ROW fiber's disposer list: cordis collects the
  // apply-returned function and calls it on fiber.dispose() (this fork has no
  // literal 'dispose' event). Clears idle timers, closes sessions + backends.
  return () => void engine.dispose()
}

/** The cordis plugin row (default export = the composition unit). */
export default { name, inject, Config, apply }
