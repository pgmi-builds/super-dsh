#!/usr/bin/env node
// Hub PTY pump — the DUMB child of the canonical PTY session over a Hub
// machine (0.3.2-c). The session (better-dsh/src/remote/pty-session.ts)
// spawns `script -qfec 'stty -echo; … exec node <this file>' /dev/null`, so
// this process's stdin/stdout ride a host-side PTY; we forward those bytes
// over one WebSocket to the peer hub's dumb PTY executor
// (/api/superd/exec/pty: one WS = one `script -qfec bash /dev/null`, text
// frames = stream bytes, {"op":…} JSON frames = transport control, WS close
// = peer group-kill). All session intelligence (nonce framing, init
// handshake, env E-frames, two-stage interrupt, idle TTL) is in-band bytes
// produced by the SESSION — this pump never parses the stream, only the
// peer's control frames.
//
// Connection facts arrive via environment (never argv — credentials must not
// show up in `ps`):
//   SUPERD_HUB_PTY_URL     wss://…/api/superd/exec/pty (peer executor)
//   SUPERD_HUB_PTY_COOKIE  pairing cookie for the upgrade request
//   SUPERD_HUB_PTY_WS      ABSOLUTE path to a usable `ws` module (resolved by
//                          the caller before spawning; no resolution gamble
//                          here — a missing module is a creation-time error)
//
// Verbatim-asset discipline (helper-bin precedent): this file is copied
// byte-for-byte into lib/remote/ and the Super closure; no build step
// transforms it. Crash-proof by construction (mesh-gateway lesson): the
// 'error' listener is registered before anything can reject, and post-close
// sends are swallowed — the session's death path owns the teardown.
const PUMP_ENV_PREFIX = 'SUPERD_HUB_PTY_'
const [url, cookie, wsPath] = ['URL', 'COOKIE', 'WS'].map((k) => process.env[`SUPERD_HUB_PTY_${k}`])

// cookie may be legitimately empty (an unauthenticated test lane sends no header);
// the endpoint URL and the ws module path are the hard requirements.
if (url === undefined || url === '' || wsPath === undefined || wsPath === '') {
  process.stderr.write(`hub-pty-pump: missing environment (${PUMP_ENV_PREFIX}URL/WS)\n`)
  process.exit(1)
}

let WebSocket
try {
  const require = (await import('node:module')).createRequire(import.meta.url)
  const mod = require(wsPath)
  WebSocket = typeof mod === 'function' ? mod : mod.default
} catch (err) {
  process.stderr.write(`hub-pty-pump: cannot load ws module at ${wsPath} — ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
}
if (typeof WebSocket !== 'function') {
  process.stderr.write('hub-pty-pump: the ws module did not yield a WebSocket constructor\n')
  process.exit(1)
}

const socket = new WebSocket(url, { headers: cookie ? { cookie } : {} })
let opened = false
let forward = true

socket.on('error', (err) => {
  // Always-on listener: an ECONNREFUSED or a rejected 401 upgrade must be a
  // reported death, never an uncaught exception.
  process.stderr.write(`hub-pty-pump: ${opened ? 'socket error' : 'connect failed'} — ${err instanceof Error ? err.message : String(err)}\n`)
})
socket.on('open', () => { opened = true; pumpStdin() })
socket.on('message', (data) => {
  if (!forward) return
  const text = typeof data === 'string' ? data : Array.isArray(data) ? Buffer.concat(data).toString('utf8') : Buffer.from(data).toString('utf8')
  // Transport control frames (peer: {"op":"exit"} / {"op":"spawn-error"}) are
  // addressed to THIS pump, not to the shell stream — the exit frame is
  // followed by a socket close, which settles us below.
  if (text.startsWith('{"op":')) {
    try {
      const parsed = JSON.parse(text)
      if (typeof parsed.op === 'string') {
        if (parsed.op === 'spawn-error' && typeof parsed.error === 'string') process.stderr.write(`hub-pty-pump: peer could not spawn the terminal — ${parsed.error}\n`)
        return
      }
    } catch { /* not JSON after all: fall through and forward */ }
  }
  process.stdout.write(text)
})
socket.on('close', () => {
  forward = false
  // Before open this is a failed connection (diag already on stderr); after
  // open it is the peer session ending — either way the child exiting is the
  // session's dead signal.
  process.exit(opened ? 0 : 1)
})

function pumpStdin() {
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    if (!opened) return
    try { socket.send(chunk) } catch { /* closing: the close handler exits us */ }
  })
  // The session's kill path tears down the process group; a plain stdin end
  // (no kill) still means nobody will type more — close politely so the peer
  // reaps its side.
  process.stdin.on('end', () => { try { socket.close() } catch { /* already closing */ } })
  process.stdin.on('error', () => { /* EPIPE on teardown: the close path owns the exit */ })
}
