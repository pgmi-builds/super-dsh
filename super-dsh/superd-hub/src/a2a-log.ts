// Operational journal for the A2A/mesh surface (0.1.7-b headliner; the
// 2026-09-29 first-person field pass found the hub emits ZERO journal lines
// — every field question forced registry forensics). One line per machine
// event, greppable `a2a.<event>` vocabulary, no secrets (messageIds and
// session/conversation ids only — never envelope bodies, never cookies).
//
// The pure modules (a2a-service/a2a-ingest) stay runtime-agnostic: they take
// an optional A2aLogFn and only FORMAT lines; the cordis host (a2a-row.ts)
// wires it onto ctx.logger so lines land in the unit journal (4999 rig /
// dev3 dsh.service). Tests inject a collector.

export type A2aLogLevel = 'info' | 'warn' | 'error'

/** Field values: scalars only; `undefined` fields are dropped. */
export type A2aLogFields = Record<string, string | number | boolean | undefined>

export type A2aLogFn = (level: A2aLogLevel, event: string, fields?: A2aLogFields) => void

/**
 * Render one journal-friendly line: `superd-hub: a2a.<event> k=v k=v`.
 * Values are quoted (JSON) only when they contain whitespace, so the common
 * case stays grep-friendly: `a2a.completion.transcript conversation=abc123 bytes=42`.
 */
export function formatA2aLogLine(event: string, fields: A2aLogFields = {}): string {
  const parts: string[] = [`superd-hub: a2a.${event}`]
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue
    const text = String(value)
    parts.push(`${key}=${/\s/.test(text) ? JSON.stringify(text) : text}`)
  }
  return parts.join(' ')
}
