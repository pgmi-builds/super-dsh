/**
 * The hub's own agent roster row (AW-B, URL scheme).
 *
 * The selector is pure navigation: every runtime owns an addressing surface,
 * so the UI needs exactly one fact — which surfaces exist — and nothing else.
 * The hub bakes that fact into every page it can reach (ctx0's index and
 * every mounted world's index), so no world implements any selector code and
 * no server-side selection value exists anywhere.
 *
 *   /                       → native DSH
 *   /omp/                   → the OMP world's mount (local worlds: mount roots)
 *   /hub/?agent=<a6>        → federated rows (mesh P2 Task 3; demux family)
 */
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { listAgents } from './roster.js'
import { ensureAgentId } from './agent-ids.js'
import { takeHostMount } from './world-host.js'
import { listRemotes } from './machines.js'

/** One selectable runtime: its key, its label, the path that addresses it, its machine. */
export interface AgentLink {
  /** Stable short id (a6) minted once per home (`superd/agent-ids.json`); for federated rows the peer-minted a6 adopted verbatim (never re-minted locally). */
  id: string
  /** `native` for ctx0, the adapter's runtime key for local worlds, or the federated row's a6. */
  key: string
  /** Chip/menu label (`DSH`, `OMP`, `Codex · dev3`, …). */
  label: string
  /** Addressing surface, always trailing-slashed except the native `/`: a mount root for local worlds, `/hub/?agent=<a6>` for federated rows (informational chip only — switch traffic rides the `/hub` demux; there is no navigable page since T-C). */
  path: string
  /** Machine the runtime runs on — the Hub UI's grouping key: `local`, or the owning machine's m4 for federated rows. */
  machine: string
  /** Whether the world's data plane is up (spawn resolved / probe reachable). Native is always ready. */
  ready: boolean
  /** Whether the world's spawn REJECTED (mount stays for diagnosis). */
  failed: boolean
}

/** Machine of every LOCAL roster row; federated rows carry their owning m4 (mesh P2 Task 3). */
const LOCAL_MACHINE = 'local'

/** The native runtime's synthetic base row (no adapter plugin backs it); its
 * id is minted per-home like every other LOCAL row's. */
const NATIVE_BASE: Omit<AgentLink, 'id'> = { key: 'native', label: 'DSH', path: '/', machine: LOCAL_MACHINE, ready: true, failed: false }

/** The global this module publishes the roster under. */
export const AGENT_ROSTER_GLOBAL = '__DSH_AGENT_ROSTER__'

/**
 * Every runtime that currently owns an addressable surface — native first,
 * then LOCAL worlds in roster order, then FEDERATED rows sorted by machine
 * label (the paired machine's display label from its `machines.json` row; the
 * m4 itself when no row survives) then agent label (key as the final tiebreak).
 *
 * A LOCAL agent without a host mount has no addressable path yet (its world
 * is still spawning) and is therefore not selectable. A FEDERATED row
 * (`machine` set, mesh P2 Task 3) needs NO mount: it is addressed by its a6
 * through the `/hub` demux family, and the a6 IS the row's stable id —
 * owner-minted at the peer and adopted verbatim, never re-minted locally.
 * The id store lives under `home` — resolved per call (world-join precedent,
 * zero module state); callers that already hold a home (rpc.ts) pass it through.
 * @param home - the hub home backing the a6 id store and machine labels; defaults to `resolveDshHome()`.
 */
export function agentLinks(home: string = resolveDshHome()): AgentLink[] {
  const links: AgentLink[] = [{ id: ensureAgentId(home, 'native'), ...NATIVE_BASE }]
  const locals: AgentLink[] = []
  const federated: AgentLink[] = []
  const machineLabels = new Map(listRemotes(home).map((row) => [row.id, row.label !== '' ? row.label : row.name]))
  for (const agent of listAgents()) {
    if ((agent.machine ?? LOCAL_MACHINE) === LOCAL_MACHINE) {
      const mount = takeHostMount(agent.key)
      if (mount === undefined) continue
      const path = mount.labelPath.endsWith('/') ? mount.labelPath : `${mount.labelPath}/`
      locals.push({ id: ensureAgentId(home, agent.key), key: agent.key, label: agent.label, path, machine: LOCAL_MACHINE, ready: agent.ready === true, failed: agent.failed === true })
    } else {
      federated.push({
        id: agent.key,
        key: agent.key,
        label: agent.label,
        path: `/hub/?agent=${encodeURIComponent(agent.key)}`,
        machine: agent.machine as string,
        ready: agent.ready === true,
        failed: agent.failed === true,
      })
    }
  }
  federated.sort((a, b) => {
    const machineA = machineLabels.get(a.machine) ?? a.machine
    const machineB = machineLabels.get(b.machine) ?? b.machine
    if (machineA !== machineB) return machineA < machineB ? -1 : 1
    if (a.label !== b.label) return a.label < b.label ? -1 : 1
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
  })
  links.push(...locals, ...federated)
  return links
}

/** The structured index row that publishes {@link agentLinks} to the page. */
export function agentRosterRow(home: string = resolveDshHome()): IndexInjection {
  return { kind: 'global', name: AGENT_ROSTER_GLOBAL, value: { agents: agentLinks(home) } }
}
