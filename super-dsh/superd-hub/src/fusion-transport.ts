/**
 * Fusion transport (native UI fusion, plan Task 3) — the ctx0 page-level head
 * script plus its injection component.
 *
 * The script installs, BEFORE any application bundle materializes:
 *   - the page-level state atom `__SUPERD_UI_STATE__`
 *     ({ get activeAgent(): 'native'|string, setAgent(label), subscribe(fn) }),
 *     initial `'native'`, never persisted (no localStorage);
 *   - five CALL-TIME patches (the atom is read at request time, never baked
 *     into a closure — after setAgent the same request expression retargets):
 *       1. `globalThis.fetch` — while a FOREIGN agent is active, a same-origin
 *          request whose path starts with `/api` is re-rooted under `/hub`
 *          and gains exactly one `agent=<label>` param (a pre-existing agent
 *          key is replaced, never duplicated — the server demuxes repeated
 *          params to the FIRST value; other query bytes + hash preserved);
 *       2. `WebSocket` / `EventSource` Proxy constructors + `XMLHttpRequest.open`
 *          — the same rule (the mux WS lands on `/hub/api/remote.mux`);
 *       3. `__DSH_FILE_UPLOAD__ = { fetch }` — uploads ride patch 1 (the
 *          file-upload service reads the hook at construction, so the hook
 *          must exist before app boot);
 *       4. `HTMLAnchorElement.prototype.click` — ONLY download anchors with a
 *          same-origin `/api` href rewrite (the narrow client-shim r2 rule);
 *          the rewrite is transient — saved around the native click and
 *          restored after, so an agent switch re-targets the same anchor;
 *       5. `Storage.prototype` get/set/removeItem — namespace read at call
 *          time: native = no prefix, foreign = `'<label>:'`.
 *   - one control-plane exemption: `/api/agent-runtime` is NEVER rewritten —
 *     the roster always talks to ctx0, so the user can always switch back.
 * Native mode is zero-interference: every patched face passes its exact
 * arguments through untouched.
 *
 * The component's gated listener ALSO bakes `__SUPERD_UI_FUSION__ = true`
 * into the ctx0 index (Task 4): the client half's fusion-branch
 * discriminator, emitted by the same gate as the script so the halves never
 * disagree (world pages never carry it and keep real hyperlinks — spec §5).
 *
 * Quoting discipline: the generated script contains NO double-quoted string —
 * index-pass rewrites every DOUBLE-quoted root-absolute literal in served
 * HTML, so all literals stay single-quoted (the client-shim precedent). The
 * install is idempotent (per-leg guards) and best-effort (every leg is
 * individually guarded; a failure disables that leg only).
 *
 * Injection (the web-trust emission path, ordered AFTER it — spec §3.4 hard
 * constraint): the row is a `webserver/index-inject` head script pushed by the
 * `superd-fusion-transport` component, composed through the composite row
 * `super-dsh/fusion-transport` positioned after `super-dsh/web-trust`. Both
 * components defer their listener registration behind `inject(['webServer'])`,
 * so cordis's FIFO effect order guarantees trust pushes first and fusion
 * pushes last — the non-merging `if(!window.__DSH_TRANSPORT__)` verdict in the
 * trust script is always evaluated before anything could own that global.
 * Flag gate (minimal, Task 5 formalizes the config face): row config
 * `enabled`, defaulting OFF from the `SUPERD_UI_FUSION` env — while the flag
 * is off the component stays dormant and injects no row at all.
 *
 * @module @pgmi-builds/superd-hub/fusion-transport
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: pulls the `webserver/index-inject` Events merge and the
// IndexInjection shape from the host webserver's Context declaration.
import type {} from '@deepseek-ai/dsh-host-webserver'

/**
 * Render the page-level fusion transport as a classic script (head injection).
 * Pure and constant: the active label is state, never a baked literal, so the
 * script takes no arguments. All string literals are single-quoted (see the
 * module doc block).
 * @returns JavaScript source.
 */
export function renderFusionTransport(): string {
  return `(() => {
try {
  const g = globalThis

  // ---- the __SUPERD_UI_STATE__ atom (created once; re-runs keep live state) ----
  if (g.__SUPERD_UI_STATE__ === undefined || g.__SUPERD_UI_STATE__ === null) {
    let current = 'native'
    const subscribers = []
    g.__SUPERD_UI_STATE__ = {
      get activeAgent() { return current },
      setAgent(label) {
        if (typeof label !== 'string' || label === '') return
        if (label === current) return
        current = label
        for (const fn of subscribers.slice()) {
          try { fn(current) } catch { /* a broken subscriber never breaks the atom */ }
        }
      },
      subscribe(fn) {
        if (typeof fn !== 'function') return () => {}
        subscribers.push(fn)
        return () => {
          const at = subscribers.indexOf(fn)
          if (at !== -1) subscribers.splice(at, 1)
        }
      },
    }
  }
  const state = g.__SUPERD_UI_STATE__

  // ---- the one rewrite rule: '/api...' becomes '/hub/api...' + '?agent=<label>' ----
  const HUB = '/hub'
  const CONTROL = '/api/agent-runtime'
  const origin = () => {
    const loc = g.location
    if (loc !== undefined && typeof loc.origin === 'string' && loc.origin !== 'null') return loc.origin
    return 'http://dsh.internal'
  }
  // Same authority as the page (scheme-agnostic: ws/wss/http/https share host).
  const sameAuthority = (url) => {
    try {
      return url.host === new URL(origin()).host
    } catch {
      return false
    }
  }
  const isApiPath = (path) => path === '/api' || path.startsWith('/api/')
  // Control-plane exemption: the roster control plane always hits ctx0.
  const isExempt = (path) => path === CONTROL || path.startsWith(CONTROL + '/')
  // Key compare matches the server demux shape: searchParams.get('agent')
  // looks up PERCENT-DECODED keys, so '%61gent=x' demuxes as agent=x and the
  // surgery must strip those spellings too (+' ' wins the '+' spelling).
  const decodedKey = (k) => {
    try { return decodeURIComponent(k.replace(/\\+/g, ' ')) } catch { return k }
  }
  const isAgentKey = (k) => k === 'agent' || decodedKey(k) === 'agent'
  // Pure string surgery on (path, search, hash): the '/hub' prefix grows on
  // the path, the hash survives byte-for-byte, and EXACTLY ONE agent param
  // carries the active label. A pre-existing agent key is stripped before the
  // fresh one lands — appending blindly would leave two agent params and the
  // server demuxes to the FIRST value (searchParams.get), i.e. the wrong
  // world with no trace. Non-agent query pairs keep their exact bytes and
  // order; a bare '?' (no pairs) collapses instead of doubling the question
  // mark, which would swallow the demux key.
  const retarget = (path, search, hash) => {
    if (isExempt(path) || !isApiPath(path)) return null
    let kept = ''
    if (search.length > 1) {
      const survivors = []
      for (const pair of (search.charAt(0) === '?' ? search.slice(1) : search).split('&')) {
        if (pair === '') continue
        const eq = pair.indexOf('=')
        if (!isAgentKey(eq === -1 ? pair : pair.slice(0, eq))) survivors.push(pair)
      }
      kept = survivors.join('&')
    }
    return HUB + path + (kept === '' ? '?' : '?' + kept + '&') + 'agent=' + encodeURIComponent(String(state.activeAgent)) + hash
  }
  const rewriteUrlString = (s) => {
    if (typeof s !== 'string' || s === '') return s
    if (s.startsWith('/')) {
      if (s.startsWith('//')) return s // protocol-relative: another authority
      const hashAt = s.indexOf('#')
      const hash = hashAt === -1 ? '' : s.slice(hashAt)
      const rest = hashAt === -1 ? s : s.slice(0, hashAt)
      const queryAt = rest.indexOf('?')
      const search = queryAt === -1 ? '' : rest.slice(queryAt)
      const path = queryAt === -1 ? rest : rest.slice(0, queryAt)
      const next = retarget(path, search, hash)
      return next === null ? s : next
    }
    try {
      const url = new URL(s, origin())
      if (!sameAuthority(url)) return s
      const next = retarget(url.pathname, url.search, url.hash)
      return next === null ? s : url.origin + next
    } catch {
      return s
    }
  }
  const rewriteApiUrl = (input) => {
    if (typeof input === 'string') return rewriteUrlString(input)
    if (input !== null && typeof input === 'object' && typeof input.href === 'string') {
      const next = rewriteUrlString(input.href)
      return next === input.href ? input : next
    }
    return input
  }
  // Foreign means a non-native STRING label; anything else behaves native.
  const foreign = () => typeof state.activeAgent === 'string' && state.activeAgent !== 'native'
  // Never-throw wrapper: a failed rewrite falls back to the exact input.
  const rewriteSafe = (input) => {
    try {
      return foreign() ? rewriteApiUrl(input) : input
    } catch {
      return input
    }
  }

  // ---- patches 1 + 3: globalThis.fetch, and the file-upload hook riding it ----
  if (g.__SUPERD_UI_FUSION_FETCH__ !== true) {
    g.__SUPERD_UI_FUSION_FETCH__ = true
    try {
      const nativeFetch = g.fetch
      if (typeof nativeFetch === 'function') {
        const shimFetch = (input, init) => {
          if (!foreign()) return nativeFetch(input, init)
          let target = input
          try {
            if (typeof Request === 'function' && input instanceof Request) {
              const url = rewriteApiUrl(input.url)
              target = url === input.url ? input : new Request(url, input)
            } else {
              target = rewriteApiUrl(input)
            }
          } catch {
            target = input
          }
          return nativeFetch(target, init)
        }
        g.fetch = shimFetch
        // Read by the file-upload service at construction time: present means
        // the page fetch carries uploads (no blob worker), and the hook IS the
        // rewriting fetch, so uploads follow the active agent like patch 1.
        g.__DSH_FILE_UPLOAD__ = { fetch: shimFetch }
      }
    } catch { /* best-effort: this leg dies alone */ }
  }

  // ---- patch 2: WebSocket / EventSource Proxy constructors + XMLHttpRequest.open ----
  // Construct through a Proxy, never a hand-rolled wrapper: statics, prototype
  // and instanceof must survive (the mux client compares readyState constants).
  if (g.__SUPERD_UI_FUSION_SOCKETS__ !== true) {
    g.__SUPERD_UI_FUSION_SOCKETS__ = true
    try {
      const NativeWebSocket = g.WebSocket
      if (typeof NativeWebSocket === 'function') {
        g.WebSocket = new Proxy(NativeWebSocket, {
          construct: (Target, args) => {
            const url = rewriteSafe(args[0])
            if (url !== args[0]) return new Target(url, ...args.slice(1))
            return Reflect.construct(Target, args)
          },
        })
      }
    } catch { /* best-effort */ }
    try {
      const NativeEventSource = g.EventSource
      if (typeof NativeEventSource === 'function') {
        g.EventSource = new Proxy(NativeEventSource, {
          construct: (Target, args) => {
            const url = rewriteSafe(args[0])
            if (url !== args[0]) return new Target(url, ...args.slice(1))
            return Reflect.construct(Target, args)
          },
        })
      }
    } catch { /* best-effort */ }
    try {
      const NativeXhr = g.XMLHttpRequest
      if (typeof NativeXhr === 'function' && NativeXhr.prototype !== undefined && typeof NativeXhr.prototype.open === 'function') {
        const nativeOpen = NativeXhr.prototype.open
        NativeXhr.prototype.open = function (method, url) {
          const target = rewriteSafe(url)
          if (target === url) return nativeOpen.apply(this, arguments)
          return nativeOpen.apply(this, [method, target].concat(Array.prototype.slice.call(arguments, 2)))
        }
      }
    } catch { /* best-effort */ }
  }

  // ---- patch 4: download anchors (the narrow rule, client-shim r2 shape) ----
  // ONLY anchors carrying a download attribute AND a same-origin /api href
  // rewrite; every other anchor (navigation links included) passes through.
  try {
    if (g.HTMLAnchorElement !== undefined && g.HTMLAnchorElement.prototype !== undefined
      && typeof g.HTMLAnchorElement.prototype.click === 'function'
      && g.__SUPERD_UI_FUSION_ANCHOR__ !== true) {
      g.__SUPERD_UI_FUSION_ANCHOR__ = true
      const nativeAnchorClick = g.HTMLAnchorElement.prototype.click
      g.HTMLAnchorElement.prototype.click = function (...args) {
        let original = null
        try {
          if (foreign() && this.hasAttribute('download')) {
            const current = this.getAttribute('href')
            if (typeof current === 'string' && current !== '') {
              const next = rewriteSafe(current)
              if (typeof next === 'string' && next !== current) {
                this.setAttribute('href', next)
                original = current
              }
            }
          }
        } catch { /* best-effort: never break the click itself */ }
        try {
          return nativeAnchorClick.apply(this, args)
        } finally {
          // The rewrite is TRANSIENT: restored right after the native click,
          // so the rewritten /hub/api href never outlives it. A persisted
          // rewrite would survive an agent switch and the next click would
          // browse the stale /hub/api form — no /api match, no re-rewrite,
          // wrong-agent download.
          if (original !== null) {
            try { this.setAttribute('href', original) } catch { /* best-effort */ }
          }
        }
      }
    }
  } catch { /* best-effort */ }

  // ---- patch 5: storage namespace, derived at CALL time ----
  // Native mode prefixes nothing (bare keys, byte-identical behavior); a
  // foreign agent reads and writes only its own '<label>:' tree.
  try {
    const StorageProto = g.Storage && g.Storage.prototype
    if (StorageProto !== undefined && g.localStorage !== undefined
      && g.__SUPERD_UI_FUSION_STORAGE__ !== true
      && typeof StorageProto.getItem === 'function'
      && typeof StorageProto.setItem === 'function'
      && typeof StorageProto.removeItem === 'function') {
      g.__SUPERD_UI_FUSION_STORAGE__ = true
      const nativeGetItem = StorageProto.getItem
      const nativeSetItem = StorageProto.setItem
      const nativeRemoveItem = StorageProto.removeItem
      const ns = () => {
        const active = state.activeAgent
        return typeof active === 'string' && active !== 'native' ? active + ':' : ''
      }
      StorageProto.getItem = function (name) { return nativeGetItem.call(this, ns() + name) }
      StorageProto.setItem = function (name, value) { return nativeSetItem.call(this, ns() + name, value) }
      StorageProto.removeItem = function (name) { return nativeRemoveItem.call(this, ns() + name) }
    }
  } catch { /* storage namespace is best-effort: never break the page */ }
} catch { /* the whole install is best-effort: a partial page is still a page */ }
})()`
}

/** The env name the minimal Task-3 gate reads; Task 5 builds the config face on it. */
export const FUSION_FLAG_ENV = 'SUPERD_UI_FUSION'

/**
 * The page global the ctx0 index carries when the gate is on: the client
 * half's fusion-branch discriminator (RuntimeSeat reads its presence to
 * intercept agent clicks into the switch orchestration instead of letting
 * the hyperlinks navigate; world pages never carry it, so they keep the real
 * navigation half — spec §5 双半边). Baked by the SAME gated listener as the
 * transport script, so the two halves can never disagree.
 */
export const FUSION_FLAG_GLOBAL = '__SUPERD_UI_FUSION__'

/**
 * The minimal flag derivation: truthy spellings only (`1` / `true` / `yes` /
 * `on`, case-insensitive, trimmed). Anything else — unset included — is OFF,
 * so between Task 3 and Task 5 the runtime behavior is unchanged.
 */
export function deriveFusionFlag(env: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((env ?? '').trim().toLowerCase())
}

/** Row config schema face. */
export interface FusionConfig {
  /** Master gate: inject the transport script on ctx0's index. Default off. */
  enabled?: boolean
}

/** Row config (schema-level default derives from the {@link FUSION_FLAG_ENV} env). */
export const Config = z.object({
  enabled: z.boolean().default(deriveFusionFlag(process.env[FUSION_FLAG_ENV])),
})

/** Cordis plugin name. */
export const name = 'superd-fusion-transport'

/**
 * No static injects: `webServer` is composed conditionally inside
 * {@link apply}, so the row loads (dormant) in compositions without one.
 */
export const inject: string[] = []

/**
 * Mount the fusion injection: one `webserver/index-inject` listener pushing
 * the rendered head script row — the same emission path as the web-trust
 * component, composed AFTER it (the composite row order is load order, and
 * both components register their listeners behind `inject(['webServer'])`, so
 * cordis's FIFO effect order pushes the fusion row last; spec §3.4) — plus
 * the {@link FUSION_FLAG_GLOBAL} baked global row (Task 4): one gate, both
 * halves.
 *
 * Flag off → the component registers nothing: no listener, no row, no script,
 * no flag global.
 * @param ctx - host plugin context.
 * @param config - the row config.
 */
export function apply(ctx: Context, config: FusionConfig | undefined): void {
  if (config?.enabled !== true) return
  ctx.inject(['webServer'], () => {
    ctx.on('webserver/index-inject', (table) => {
      table.push({ kind: 'script', placement: 'head', text: renderFusionTransport() })
      table.push({ kind: 'global', name: FUSION_FLAG_GLOBAL, value: true })
    })
  })
}

export default { name, inject, Config, apply }
