/**
 * Shared roster projection for the client half: the runtime list every Hub
 * switch surface (the HubPanelIcon chevron menu, the HubPage Agent Runtimes
 * rows — the sole agent-switch surface since the T-B RuntimeSeat retirement)
 * renders. Source of truth = the hub's read-only `/api/agent-runtime` face;
 * the baked `window.__DSH_AGENT_ROSTER__` global only seeds the first paint
 * (a world page's baked copy can be stale, so the wire answer is
 * authoritative).
 *
 * @module superd-hub/client/roster
 */

/** One runtime as the roster hands it over: key, display label, mount path, machine. */
export interface AgentLink {
  readonly key: string
  readonly label: string
  readonly path: string
  /**
   * Machine the runtime comes from. Guaranteed by the parser: the host wire
   * carries it (`machine: 'local'` today) and an older shape defaults to
   * `'local'` right here — the parse boundary is the only defensive default.
   */
  readonly machine: string
  /** Whether the world's data plane is up. Optional: older hosts omit it (parse boundary default). */
  readonly ready?: boolean
  /** Whether the world's spawn REJECTED. Optional: older hosts omit it. */
  readonly failed?: boolean
}

/** The native runtime every composition can fall back to. */
export const NATIVE_LINK: AgentLink = { key: 'native', label: 'DSH', path: '/', machine: 'local', ready: true, failed: false }

/** Labels for the read-only face's bare keys (it reports keys, not labels). */
const FALLBACK_LABELS: Record<string, string> = {
  native: 'DSH',
  omp: 'OMP',
  codex: 'Codex',
  claude: 'Claude',
  pi: 'Pi',
  hermes: 'Hermes',
  agy: 'Antigravity',
}

/** Coerce a wire `agents` array into links; undefined when unusable/empty. */
function coerceAgents(raw: unknown): AgentLink[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const links: AgentLink[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const { key, label, path, machine } = entry as Partial<AgentLink>
    if (typeof key !== 'string' || typeof path !== 'string') continue
    links.push({
      key,
      label: typeof label === 'string' ? label : (FALLBACK_LABELS[key] ?? key),
      path,
      // The parse boundary's one defensive default: older host shapes without
      // machine are local-machine rosters.
      machine: typeof machine === 'string' ? machine : 'local',
      ready: (entry as { ready?: unknown }).ready === true,
      failed: (entry as { failed?: unknown }).failed === true,
    })
  }
  return links.length > 0 ? links : undefined
}

/** Seed from the index-baked roster global, when the page carries one. */
export function rosterFromGlobal(): AgentLink[] | undefined {
  const raw = (globalThis as { __DSH_AGENT_ROSTER__?: { agents?: unknown } }).__DSH_AGENT_ROSTER__
  return coerceAgents(raw?.agents)
}

/** Normalize the current mount root: `/omp` and `/omp/` are the same page. */
export function currentMountPath(): string {
  const pathname = typeof location === 'undefined' ? '/' : location.pathname
  if (pathname === '' || pathname === '/') return '/'
  return pathname.endsWith('/') ? pathname : `${pathname}/`
}

/**
 * Ask the hub for the live roster (preferred `agents` shape with paths; the
 * bare `available` key list falls back to `/<key>/` paths).
 *
 * @returns the runtime links, keyed by runtime.
 * @throws when the face is unreachable or returns no usable roster.
 */
export async function fetchRoster(): Promise<AgentLink[]> {
  const response = await fetch('/api/agent-runtime', { credentials: 'same-origin' })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const json = (await response.json()) as { available?: unknown; agents?: unknown }
  const agents = coerceAgents(json.agents)
  if (agents !== undefined) return agents
  if (Array.isArray(json.available)) {
    const links: AgentLink[] = []
    for (const key of json.available) {
      if (typeof key !== 'string') continue
      links.push(key === 'native'
        ? NATIVE_LINK
        : { key, label: FALLBACK_LABELS[key] ?? key, path: `/${key}/`, machine: 'local', ready: key === 'native' })
    }
    if (links.length > 0) return links
  }
  throw new Error('agent-runtime face returned no roster')
}
