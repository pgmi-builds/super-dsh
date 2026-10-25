import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { RemoteDriver } from './driver.ts'

const NO_SESSION_KEY = 'remote:no-session'

/**
 * The model-visible surface of the `remote_transfer` tool (split out of
 * `remote`, 2026-10-25). ONE template literal — no backticks, no "${".
 */
const TRANSFER_TOOL_DESCRIPTION = `File transfer between any two supported endpoints. Every call declares its mode:
  mode:"copy"   → tree copy. Native CLI per endpoint (scp for ssh, docker cp, incus file push/pull), a plain tree copy when both ends are local, and the Hub binary lane when a Hub machine is involved. Directories copy recursively; exit codes are authoritative.
  mode:"rsync"  → rsync over SSH only: at least one endpoint remote SSH, the other local or SSH (both remote legs tunnel through this machine; identities never leave it). Hub and container endpoints are rejected — no silent copy fallback. Trailing slashes keep rsync semantics.

Endpoints are "[target:]absolute path". No target = the machine running this Agent. Targets are the same unified pool remote uses: a bare pool name, ssh:<name>, docker:<name>, incus:<name>, hub:<m4>. Examples: "/srv/app", "ssh:dev4:/srv/app", "docker:corti:/var/lib/x", "hub:m4:/srv". A path is never guessed: both operands must be absolute.

Native CLI options travel through argv verbatim — one element = one token, appended before src/dst, no shell parsing and no whitelist: rsync ["-a","--partial"], scp ["-p","-r"], docker cp ["-a","-L"], incus file push ["--recursive"]. Cross-endpoint copies that need two commands (SSH↔Docker, SSH↔Incus, Docker↔Incus) take pullArgv plus pushArgv instead of argv. rsync is a single SSH command, so it takes argv only; an explicit -e/--rsh overrides the wiring.

Options: verify (copy only) — the Hub↔local staged lane computes independent SHA-256 digests by default and verify:false skips them; native CLI routes have no independent hash tier, so verify is rejected there (self-verify through a oneshot digest command). mkdir (copy only, default true) — one best-effort pre-hop creates the destination PARENT directory; the operand itself is never pre-created, so each CLI's own layout semantics stay byte-identical.

Failures are loud: a non-zero native exit throws with the receipt instead of returning a normal-looking result. The receipt stays in the receipt field (route, exits, verification, bytes/entries, cleanup); text is one formatted line. For checksum-grade verification of a native route, run a digest command through remote oneshot or PTY instead of trusting the copy receipt.`

interface TransferToolValue {
  kind: 'copy' | 'rsync'
  receipt?: import('@deepseek-ai/dsh-util-values').JsonValue
  text: string
  exit: number | null
  durationMs: number
}

/**
 * execute 实现放独立函数 + 结构类型：与 tool.ts 同一理由（defineTool 字面量
 * 与 typert 生成类型的组合会触发 dsh-tools 双实例身份冲突，TS2719）。
 */
interface TransferArgs {
  mode?: 'copy' | 'rsync'
  src?: string
  dst?: string
  argv?: string[]
  pullArgv?: string[]
  pushArgv?: string[]
  verify?: boolean
  mkdir?: boolean
}

type ExecLike = { signal: AbortSignal; agent?: { id: string; ctx: { get(key: 'jobs'): unknown } } }

// No legacy aliases and no silent no-ops: dsh-tools passes unknown root
// parameters through, so this surface rejects every key it does not declare
// (native options go through argv).
const KNOWN_PARAMS = new Set(['mode', 'src', 'dst', 'argv', 'pullArgv', 'pushArgv', 'verify', 'mkdir'])

async function transferExecute(ENV: { driver: RemoteDriver; getSessionKey: (exec: ExecLike) => string }, args: TransferArgs, exec: ExecLike): Promise<TransferToolValue> {
  for (const key of Object.keys(args)) {
    if (!KNOWN_PARAMS.has(key)) throw new Error(`remote_transfer: unknown parameter "${key}" — this surface has no legacy aliases; pass native CLI options through argv instead`)
  }
  if (args.mode !== 'copy' && args.mode !== 'rsync')
    throw new Error(`[E_PARAMS] remote_transfer: mode is required — "copy" (tree copy through each endpoint's native CLI or the Hub lane) or "rsync" (SSH only)`)
  if (typeof args.src !== 'string' || args.src.length === 0 || typeof args.dst !== 'string' || args.dst.length === 0)
    throw new Error(`[E_PARAMS] remote_transfer: ${args.mode} requires src and dst absolute endpoints`)
  const sessionKey = ENV.getSessionKey(exec)
  if (args.mode === 'rsync') {
    if (args.pullArgv !== undefined || args.pushArgv !== undefined) throw new Error('remote_transfer: rsync takes argv only; pullArgv/pushArgv are copy-only fields')
    if (args.verify !== undefined || args.mkdir !== undefined) throw new Error('remote_transfer: rsync cannot be combined with copy verify/mkdir options; the Hub/local staged lane is copy-only')
    const start = Date.now()
    const receipt = await ENV.driver.rsync({ src: args.src, dst: args.dst, ...(args.argv === undefined ? {} : { argv: args.argv }) }, exec.signal, { sessionKey })
    const rsyncReceipt = receipt as { ok?: boolean; exit?: number | null }
    if (rsyncReceipt.ok === false || receipt.exit !== 0) throw new Error(JSON.stringify(receipt))
    const durationMs = Date.now() - start
    return { kind: 'rsync', text: formatTransferLine('rsync', receipt, durationMs), receipt: receipt as unknown as import('@deepseek-ai/dsh-util-values').JsonValue, exit: receipt.exit, durationMs }
  }
  const start = Date.now()
  const receipt = await ENV.driver.copy({ src: args.src, dst: args.dst, ...(args.verify === undefined ? {} : { verify: args.verify }), ...(args.mkdir === undefined ? {} : { mkdir: args.mkdir }), ...(args.argv === undefined ? {} : { argv: args.argv }), ...(args.pullArgv === undefined ? {} : { pullArgv: args.pullArgv }), ...(args.pushArgv === undefined ? {} : { pushArgv: args.pushArgv }) }, exec.signal, { sessionKey })
  // F2 (2026-10-14 user acceptance): copy failures must be fail-loud, same
  // contract as rsync — a native non-zero exit previously came back as a
  // normal-looking result with the error buried in receipt stderr.
  const asReceipt = receipt as { ok?: boolean; exits?: (number | null)[] }
  const exits = asReceipt.exits ?? []
  if (asReceipt.ok === false || exits.some(code => code !== 0)) throw new Error(JSON.stringify(receipt))
  const durationMs = Date.now() - start
  return { kind: 'copy', text: formatTransferLine('copy', receipt, durationMs), receipt: receipt as unknown as import('@deepseek-ai/dsh-util-values').JsonValue, exit: exits.length > 0 ? 0 : null, durationMs }
}

export function createRemoteTransferTool(
  driver: RemoteDriver,
  opts: { getSessionKey?: (exec: ToolRunContext) => string } = {},
): ToolDefinition {
  const getSessionKey = opts.getSessionKey ?? ((exec: ToolRunContext) => exec.agent?.id ?? NO_SESSION_KEY)
  return defineTool({
    name: 'remote_transfer',
    description: TRANSFER_TOOL_DESCRIPTION,

    parameters: {
      mode: { type: 'string', enum: ['copy', 'rsync'], required: true, description: 'Required. copy = tree copy through each endpoint\'s native CLI, or the Hub binary lane; rsync = SSH only (argv only, no verify/mkdir).' },
      src: { type: 'string', description: 'Source [target:]absolute path. No target = the machine running this Agent.' },
      dst: { type: 'string', description: 'Destination [target:]absolute path. No target = the machine running this Agent.' },
      argv: { type: 'array', items: { type: 'string' }, description: 'Ordered native CLI options and values for one-command routes (e.g. rsync ["-a","--partial","--dry-run"], scp ["-p","-r"], docker cp ["-a","-L"], incus file push/pull). One element = one argv token, appended verbatim before src/dst; no shell parsing, no whitelist, no forced defaults — unknown options fail in the native CLI itself. rsync only (SSH endpoints): explicit -e/--rsh overrides the tool\'s SSH wiring. docker cp: pass -L to follow symlinks (a symlink source like /etc/os-release fails without it). Two-segment cross-endpoint copy uses pullArgv/pushArgv instead.' },
      pullArgv: { type: 'array', items: { type: 'string' }, description: 'Options for the PULL half (source endpoint → origin staging) of a two-command cross-endpoint copy (e.g. SSH↔Docker, SSH↔Incus, Docker↔Incus). Mutually exclusive with argv; must be paired with pushArgv. Only options valid for the pull half\'s CLI.' },
      pushArgv: { type: 'array', items: { type: 'string' }, description: 'Options for the PUSH half (origin staging → destination endpoint) of a two-command cross-endpoint copy. Mutually exclusive with argv; must be paired with pullArgv.' },
      verify: { type: 'boolean', description: 'copy only. Receipts name the verification tier actually performed (D1=A): native CLI routes are "native-exit-only" (no independent check — self-verify via oneshot digest commands when needed); the Hub↔local staged lane computes independent SHA-256 digests by default and verify:false skips them ("not-applicable"). No hash tier exists on native routes.' },
      mkdir: { type: 'boolean', description: 'copy only, all routes. Default true: before transfer, one best-effort exec pre-hop ensures the destination\'s PARENT directory exists (the operand itself is never pre-created — each CLI\'s own layout semantics stay byte-identical). Receipt created field: true (parent created this call) / false (already existed) / "n-a" (skipped or pre-hop unavailable, e.g. docker exec on a stopped container — the native CLI then reports the real error itself). false skips the pre-hop.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, enum: ['copy', 'rsync'] },
          text: { type: 'string', required: true },
          receipt: { type: 'json' },
          exit: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          durationMs: { type: 'integer' },
        },
      },
      render: (_args, value): ContentBlock[] => [{ type: 'text', text: (value as TransferToolValue).text }],
    },
    async execute(args, exec) {
      return transferExecute({ driver, getSessionKey: getSessionKey as unknown as (e: ExecLike) => string }, args as unknown as TransferArgs, exec as unknown as ExecLike)
    },
  })
}

/** S8 (2026-10-17): copy/rsync render as one formatted line; the full receipt
 * stays in the receipt field — raw-JSON dumps are gone from text. */
function formatTransferLine(mode: 'copy' | 'rsync', receipt: unknown, durationMs: number): string {
  const r = receipt as { ok?: boolean; reason?: string; src?: string; dst?: string; route?: string; exits?: (number | null)[]; exit?: number | null; verification?: string; created?: boolean | 'n-a'; cleanup?: string; bytes?: number; entries?: number; note?: string }
  const parts: string[] = []
  if (r.ok === false) parts.push(`✗ ${r.reason ?? 'failed'}`)
  parts.push(`${mode} ${r.src} → ${r.dst}`)
  if (r.route !== undefined && r.route !== '') parts.push(`route ${r.route}`)
  if (r.exits !== undefined) parts.push(`exits [${r.exits.join(',')}]`)
  else if (r.exit !== undefined) parts.push(`exit ${r.exit}`)
  if (r.verification !== undefined) parts.push(`verification ${r.verification}`)
  if (r.created === true) parts.push('created yes')
  else if (r.created === false) parts.push('created pre-existing')
  else if (r.created === 'n-a') parts.push('created n-a')
  if (r.cleanup !== undefined && r.cleanup !== 'none-required') parts.push(`cleanup ${r.cleanup}`)
  if (typeof r.bytes === 'number') parts.push(`${r.bytes} bytes / ${r.entries} entries`)
  parts.push(`${(durationMs / 1_000).toFixed(1)}s`)
  if (r.note !== undefined && r.note.length > 0) parts.push(`(${r.note})`)
  return parts.join(' · ')
}
