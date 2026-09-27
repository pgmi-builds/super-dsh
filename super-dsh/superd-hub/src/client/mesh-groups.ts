/**
 * Machine-section grouping for the Hub switch surfaces (mesh P2, Task 4):
 * the pure core that turns a roster plus the machines API's label map into
 * the menu/row sections — the LOCAL group first under the fixed
 * {@link LOCAL_MACHINE_LABEL} heading, then one section per remote machine
 * sorted by display label (key as the tiebreak). This is the client-half
 * mirror of the host's wire ordering (agent-roster.ts sorts federated rows
 * by machine label server-side); the client re-derives it so the sections
 * stay correct even when the wire order changes or the roster is seeded
 * from a stale baked global.
 *
 * The label map comes from `fetchMachines()` (mesh-api.ts): machine label,
 * falling back to the name, falling back to the raw m4 —
 * {@link machineLabelsFrom} builds it, and a machine the registry no longer
 * knows simply keeps its raw m4 as the section label (never a crash).
 *
 * Node-safe by construction — no DOM, no react, no @deepseek-ai imports —
 * so the host tsc emits it to `dist/client/mesh-groups.js` and
 * test/client-mesh-groups.test.mjs runs the pure halves under `node --test`
 * without jsdom: the mesh-api precedent. No fetch happens at import time.
 *
 * @module superd-hub/client/mesh-groups
 */
import type { MeshList } from './mesh-api.js'
import type { AgentLink } from './roster.js'

/** The machine key every LOCAL roster row carries (older host shapes may omit the field — grouping treats absent as local). */
export const LOCAL_MACHINE_KEY = 'local'

/** The LOCAL section's fixed display label — this machine needs no registry row to be named. */
export const LOCAL_MACHINE_LABEL = 'This machine'

/** One machine's section: its grouping key, its display label, and its rows in roster order. */
export interface MachineAgentGroup {
  /** The grouping key: {@link LOCAL_MACHINE_KEY} or the owning machine's m4. */
  readonly key: string
  /** The section heading: the machine's display label ({@link LOCAL_MACHINE_LABEL} for local, the raw key when no label is known). */
  readonly label: string
  /** This machine's roster rows, keeping the roster's own order. */
  readonly agents: readonly AgentLink[]
}

/** Whether a row's machine field parks it in the local section: `'local'` or absent (the coercion drops unknown values). */
function isLocalMachine(machine: string | undefined): boolean {
  return machine === undefined || machine === LOCAL_MACHINE_KEY
}

/**
 * Group a roster into machine sections for the switch menu and the Hub
 * roster rows: the LOCAL group first (label {@link LOCAL_MACHINE_LABEL};
 * rows whose `machine` is `'local'` or absent), then one group per remote
 * machine sorted by display label (code-unit order) with the machine key as
 * the tiebreak. Members keep the roster's given order inside their group;
 * groups only exist for machines actually present in the roster (no empty
 * local section when every row is federated). An unknown label map entry —
 * missing, or an empty string — falls back to the raw machine key.
 *
 * @param links - the roster rows (any order; the section order is derived, not inherited).
 * @param machineLabels - machine key (m4) → display label; the machines API answer via {@link machineLabelsFrom}.
 * @returns the sections, local first.
 */
export function groupByMachine(
  links: readonly AgentLink[],
  machineLabels: Readonly<Record<string, string>>,
): MachineAgentGroup[] {
  const local: AgentLink[] = []
  const byKey = new Map<string, AgentLink[]>()
  for (const link of links) {
    if (isLocalMachine(link.machine)) {
      local.push(link)
      continue
    }
    const machine = link.machine as string
    const bucket = byKey.get(machine)
    if (bucket === undefined) byKey.set(machine, [link])
    else bucket.push(link)
  }
  const labelOf = (key: string): string => {
    const label = machineLabels[key]
    return typeof label === 'string' && label !== '' ? label : key
  }
  const remote: MachineAgentGroup[] = [...byKey.entries()]
    .map(([key, agents]) => ({ key, label: labelOf(key), agents }))
    .sort((a, b) => (a.label !== b.label ? (a.label < b.label ? -1 : 1) : (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)))
  return local.length > 0 ? [{ key: LOCAL_MACHINE_KEY, label: LOCAL_MACHINE_LABEL, agents: local }, ...remote] : remote
}

/**
 * The machines API answer → the grouping label map: every remote row's
 * `id → label` (mesh-api's coercion already collapsed an empty label to the
 * machine name) plus the self block's own `m4 → label`. An absent list is
 * the empty map — the caller's degrade-to-flat trigger, never a throw.
 *
 * @param list - the coerced `fetchMachines()` answer, when it succeeded.
 * @returns machine key → display label (the raw key stays absent, not mapped).
 */
export function machineLabelsFrom(list: MeshList | undefined): Record<string, string> {
  const labels: Record<string, string> = {}
  if (list === undefined) return labels
  for (const machine of list.machines) {
    labels[machine.id] = machine.label !== '' ? machine.label : machine.name
  }
  if (list.self !== undefined) labels[list.self.id] = list.self.label
  return labels
}
