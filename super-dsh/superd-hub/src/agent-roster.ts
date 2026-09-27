/**
 * The hub's own agent roster row (AW-B, URL scheme).
 *
 * The selector is pure navigation: every runtime owns a mount path, so the UI
 * needs exactly one fact — which paths exist — and nothing else. The hub bakes
 * that fact into every page it can reach (ctx0's index and every mounted
 * world's index), so no world implements any selector code and no server-side
 * selection value exists anywhere.
 *
 *   /          → native DSH
 *   /omp/      → the OMP world's mount
 *   /codex/    → the Codex world's mount
 */
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { listAgents } from './roster.js'
import { ensureAgentId } from './agent-ids.js'
import { takeHostMount } from './world-host.js'

/** One selectable runtime: its key, its label, the path that addresses it, its machine. */
export interface AgentLink {
  /** Stable short id (a6) minted once per home (`superd/agent-ids.json`). */
  id: string
  /** `native` for ctx0, otherwise the adapter's runtime key. */
  key: string
  /** Chip/menu label (`DSH`, `OMP`, `Codex`, …). */
  label: string
  /** Mount root, always trailing-slashed except the native `/`. */
  path: string
  /** Machine the runtime runs on — the Hub UI's grouping key. */
  machine: string
  /** Whether the world's data plane is up (spawn resolved). Native is always ready. */
  ready: boolean
  /** Whether the world's spawn REJECTED (mount stays for diagnosis). */
  failed: boolean
}

/** Machine of every roster row today — the local constant; the extension point a multi-machine registry replaces. */
const LOCAL_MACHINE = 'local'

/** The native runtime's synthetic base row (no adapter plugin backs it); its
 * id is minted per-home like every other row's. */
const NATIVE_BASE: Omit<AgentLink, 'id'> = { key: 'native', label: 'DSH', path: '/', machine: LOCAL_MACHINE, ready: true, failed: false }

/** The global this module publishes the roster under. */
export const AGENT_ROSTER_GLOBAL = '__DSH_AGENT_ROSTER__'

/**
 * Every runtime that currently owns a mount, native first.
 *
 * A registered agent without a host mount has no addressable path yet (its
 * world is still spawning) and is therefore not selectable. The id store
 * lives under `home` — resolved per call (world-join precedent, zero module
 * state); callers that already hold a home (rpc.ts) pass it through.
 * @param home - the hub home backing the a6 id store; defaults to `resolveDshHome()`.
 */
export function agentLinks(home: string = resolveDshHome()): AgentLink[] {
  const links: AgentLink[] = [{ id: ensureAgentId(home, 'native'), ...NATIVE_BASE }]
  for (const agent of listAgents()) {
    const mount = takeHostMount(agent.key)
    if (mount === undefined) continue
    const path = mount.labelPath.endsWith('/') ? mount.labelPath : `${mount.labelPath}/`
    links.push({ id: ensureAgentId(home, agent.key), key: agent.key, label: agent.label, path, machine: LOCAL_MACHINE, ready: agent.ready === true, failed: agent.failed === true })
  }
  return links
}

/** The structured index row that publishes {@link agentLinks} to the page. */
export function agentRosterRow(home: string = resolveDshHome()): IndexInjection {
  return { kind: 'global', name: AGENT_ROSTER_GLOBAL, value: { agents: agentLinks(home) } }
}
