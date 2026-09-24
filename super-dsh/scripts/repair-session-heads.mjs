#!/usr/bin/env node
/**
 * repair-session-heads.mjs — data repair for v4 session logs written before
 * the protected-head + step-context fix (2026-09-24).
 *
 * dsh 0.1.7's v4 reader constrains every system/message twice: it must sit
 * inside an open matching turn+step, and it must be the surface's first node
 * (the protected head) or replace one. Bridge-era logs wrote the user message
 * at turn level and appended the system prompt mid-surface later — every such
 * session fails history validation after a restart. The writer fix
 * (agent-hub `withSystemHead`) covers NEW sessions; this script rewrites
 * EXISTING ones into the native shape by reordering three events:
 *
 *   before: turn/start … user/message … [maybe session/title] … step/start … system/message
 *   after:  turn/start … step/start … system/message … user/message … [title follows]
 *
 * (insertion point = min(first user index, first step/start index); the moved
 * events keep their own data, with the system head realigned to the step it
 * now rides in).
 *
 * Additional repairs applied where needed: provider-kind session/title events
 * with empty messageSeqs cite the first user message (v4 requires exactly
 * that), and a step still open at turn/end is closed just before it (torn
 * logs from killed processes).
 *
 * Idempotent: logs already in native shape, and logs needing nothing, are
 * left untouched. The original is kept beside the log as
 * session.v4.jsonl.zstd.corrupt-backup. Native framing is preserved: the
 * first zstd frame carries exactly the one header line, and event seq =
 * position after the header row.
 *
 * Usage: node repair-session-heads.mjs <dshHome>   (repairs <home>/agents/<label>/sessions trees)
 */
import { execFileSync } from 'node:child_process'
import { existsSync, globSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const home = process.argv[2]
if (home === undefined || !existsSync(home)) {
  console.error('usage: node repair-session-heads.mjs <dshHome>')
  process.exit(1)
}

const SURFACE_TYPES = new Set(['system/message', 'user/message', 'assistant/message', 'tool/result'])

/** Compress rows into the native two-frame layout (header line alone, then the body). */
function pack(rows, file) {
  const [header, ...rest] = rows
  const headerFrame = execFileSync('zstd', ['-3', '-'], { input: Buffer.from(JSON.stringify(header) + '\n', 'utf8'), maxBuffer: 64 * 1024 * 1024 })
  const bodyFrame = execFileSync('zstd', ['-3', '-'], { input: Buffer.from(rest.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8'), maxBuffer: 64 * 1024 * 1024 })
  renameSync(file, `${file}.corrupt-backup`)
  writeFileSync(file, Buffer.concat([headerFrame, bodyFrame]))
}

/** Provider-kind titles with empty messageSeqs cite the first user message. */
function titleFixed(rows) {
  const firstUserSeq = rows.find(e => e.type === 'user/message')?.seq
  if (firstUserSeq === undefined) return rows
  const fixed = rows.map(event => (event.type === 'session/title' && Array.isArray(event.data?.messageSeqs)
    && event.data.messageSeqs.length === 0 && event.data?.source?.kind !== 'user')
    ? { ...event, data: { ...event.data, messageSeqs: [firstUserSeq] } }
    : event)
  return fixed.some((event, i) => event !== rows[i]) ? fixed : rows
}

/** Renumber seq = position after the header and shift every reference field. */
function renumber(rows, previous) {
  const newIndex = new Map(rows.map((event, index) => [event, index - 1]))
  const shift = (value) => {
    for (const [event, seq] of newIndex) if (event.seq === value) return seq
    for (const event of previous) if (event.seq === value) {
      const moved = rows.find(row => row === event)
      if (moved !== undefined) return newIndex.get(moved)
    }
    return value
  }
  return rows.map((event, index) => {
    // The header row (first, type session) carries no seq — an injected seq
    // there makes the catalog read it as malformed; every other row (including
    // step/end rows this script inserts) must carry seq = position - 1.
    const next = { ...event, ...(event.type === 'session' && index === 0 ? {} : { seq: newIndex.get(event) }) }
    if (next.surfaceOp !== undefined && typeof next.surfaceOp === 'object') {
      next.surfaceOp = { op: next.surfaceOp.op, startSeq: shift(next.surfaceOp.startSeq), endSeq: shift(next.surfaceOp.endSeq) }
    }
    if (Array.isArray(next.sourceEventSeqs)) next.sourceEventSeqs = next.sourceEventSeqs.map(shift)
    if (Array.isArray(next.data?.messageSeqs)) next.data = { ...next.data, messageSeqs: next.data.messageSeqs.map(shift) }
    return next
  })
}

/** Close any step still open at its turn/end (torn logs). */
function closeTornSteps(rows) {
  const closed = []
  let openTurn = null, openStep = null
  for (const event of rows) {
    const d = event.data ?? {}
    if (event.type === 'turn/start') { openTurn = d.turn; openStep = null }
    else if (event.type === 'step/start') { openStep = d.step }
    else if (event.type === 'step/end') { openStep = null }
    else if (event.type === 'turn/end') {
      if (openStep !== null) {
        closed.push({ __inserted: true, type: 'step/end', time: event.time, data: { turn: openTurn, step: openStep } })
        openStep = null
      }
      openTurn = null
    }
    closed.push(event)
  }
  if (closed.length === rows.length) return rows
  const cleaned = closed.map(event => (event.__inserted === true ? (({ __inserted, ...rest }) => rest)(event) : event))
  return renumber(cleaned, rows)
}

const files = globSync(join(home, 'agents', '*', 'sessions', '*', '*', 'session.v4.jsonl.zstd'))
let repaired = 0
let native = 0
let untouched = 0

for (const file of files) {
  const raw = execFileSync('zstd', ['-dc', file], { maxBuffer: 64 * 1024 * 1024 }).toString()
  const events = raw.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line))
  if (events[0]?.type !== 'session') { console.log(`skip (no header row first): ${file}`); continue }
  const userAt = events.findIndex(e => e.type === 'user/message' && e.surfaceOp !== undefined)
  const stepAt = events.findIndex(e => e.type === 'step/start')
  const systemAt = events.findIndex(e => e.type === 'system/message')
  const firstSurface = events.findIndex(e => SURFACE_TYPES.has(e.type) && e.surfaceOp !== undefined)
  const headNative = firstSurface !== -1 && events[firstSurface]?.type === 'system/message'
    && systemAt !== -1 && stepAt !== -1 && firstSurface > stepAt

  if (headNative) {
    // Only the torn-step / title repairs can still apply.
    let rows = closeTornSteps(events)
    rows = titleFixed(rows)
    if (rows !== events) { pack(rows, file); repaired++; console.log(`repaired (torn/title) ${file}`) }
    else native++
    continue
  }
  if (systemAt === -1) {
    // Headless surface: valid as-is; only the title rule can still apply.
    const rows = titleFixed(events)
    if (rows !== events) { pack(rows, file); repaired++; console.log(`repaired (title) ${file}`) }
    else untouched++
    continue
  }
  if (userAt === -1 || stepAt === -1) { console.log(`skip (no user/step to reorder): ${file}`); continue }

  // Reorder into the native shape: step/start → system head → user message,
  // inserted at min(user, step) position; everything else keeps its order.
  const stepEvent = events[stepAt]
  const realigned = { ...events[systemAt], data: { ...events[systemAt].data, turn: stepEvent.data.turn, step: stepEvent.data.step } }
  const insertAt = Math.min(userAt, stepAt)
  const rewritten = []
  for (let i = 0; i < events.length; i++) {
    if (i === insertAt) rewritten.push(stepEvent, realigned, events[userAt])
    if (i === userAt || i === stepAt || i === systemAt) continue
    rewritten.push(events[i])
  }
  if (rewritten.length !== events.length) { console.log(`skip (internal count mismatch): ${file}`); continue }
  let out = renumber(rewritten, events)
  out = closeTornSteps(out)
  out = titleFixed(out)
  pack(out, file)
  repaired++
  console.log(`repaired ${file}`)
}

console.log(`\n[repair-session-heads] repaired=${repaired} native=${native} untouched=${untouched} total=${files.length}`)
