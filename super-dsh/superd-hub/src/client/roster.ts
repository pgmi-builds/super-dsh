/**
 * Shared roster projection for the client half: the runtime list every Hub
 * switch surface (the HubPanelIcon chevron menu, the HubPage Agent Runtimes
 * rows — the sole agent-switch surface since the T-B RuntimeSeat retirement)
 * renders. Source of truth = the hub's read-only `/api/agent-runtime` face;
 * the baked `window.__DSH_AGENT_ROSTER__` global only seeds the first paint
 * (a world page's baked copy can be stale, so the wire answer is
 * authoritative).
 *
 * Node-safe by construction (no DOM globals, fetch only inside functions) —
 * the host tsc dual-emits this file to `dist/client/roster.js` so
 * test/client-mesh-groups.test.mjs can pin the coercion under `node --test`
 * (the mesh-api/mesh-groups precedent).
 *
 * @module superd-hub/client/roster
 */

/** One runtime as the roster hands it over: key, display label, mount path, machine. */
export interface AgentLink {
  readonly key: string
  readonly label: string
  readonly path: string
  /**
   * Machine the runtime comes from (mesh P2): `'local'` for this machine's
   * rows, the owning machine's m4 id for federated rows. Optional and
   * additive: the coercion drops unknown values to `undefined` and the
   * grouping (mesh-groups.ts) treats absent as local — no parse-boundary
   * default anymore, the wire's machine ids pass through verbatim.
   */
  readonly machine?: string
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
  // The opt-in SDK halves carry their own keys so a host that reports only keys
  // still renders a distinguishable label (the composite rows are `disabled: true`
  // by default, so these appear only once an operator turns one on).
  'omp-sdk': 'OMP (SDK)',
  'agy-sdk': 'Antigravity (SDK)',
  'codex-sdk': 'Codex (SDK)',
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
      // Passthrough (mesh P2 Task 4): a string machine id rides verbatim
      // ('local' for this machine's rows, the m4 for federated rows);
      // anything else is dropped to undefined — the grouping treats absent
      // as local, so an older host shape needs no default here.
      machine: typeof machine === 'string' && machine !== '' ? machine : undefined,
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
  const location = (globalThis as { location?: { pathname: string } }).location
  const pathname = location === undefined ? '/' : location.pathname
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
