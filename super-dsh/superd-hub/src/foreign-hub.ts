/** Session-bound facility bridge. Host-owned transport; drafts perform no I/O. */
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { A2aAgentHandle } from './a2a-delivery.js'
import { createSuperdHubTool, type HubToolDeps } from './hub-tool.js'
import { localA2aInitiator } from './a2a-host.js'

export interface ForeignToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface ForeignHubBinding {
  definition(): ForeignToolDefinition | undefined
  execute(args: unknown, signal?: AbortSignal): Promise<unknown>
  transport(): Promise<ForeignHubTransport | undefined>
  enqueue(text: string): Promise<string>
  onTurnStarted(listener: (id: string) => void): () => void
  extensionPath(): Promise<string | undefined>
  dispose(): void
}

export interface ForeignHubTransport {
  url: string
  token: string
  definition: ForeignToolDefinition
}

interface BoundSession {
  sessionId: string
  runtime: string
  getAgent(): A2aAgentHandle | undefined
  execute(args: unknown, signal?: AbortSignal): Promise<unknown>
  inbox: Array<{ id: string; text: string }>
  unstarted: Set<string>
  started: Set<string>
  onTurnStarted(id: string): void
}

interface Host {
  home: string
  deps: Omit<HubToolDeps, 'initiatorOf'>
  sessions: Map<string, BoundSession>
  server?: Server
  listening?: Promise<string>
  closed: boolean
}

const hosts = new Map<string, Host>()
// Delivery is a separate in-memory registration: passive resume must be
// reachable before runtime/tool materialization, without minting capabilities.
const deliveryBindings = new Map<symbol, { home: string; sessionId: string; getAgent(): A2aAgentHandle | undefined }>()

export function foreignAgentHandle(home: string, sessionId: string): A2aAgentHandle | undefined {
  const key = resolve(home)
  if (!hosts.has(key)) return undefined
  for (const session of deliveryBindings.values()) {
    if (session.home === key && session.sessionId === sessionId) return session.getAgent()
  }
  return undefined
}

/** Register exactly the assembly used by the DSH-native Hub tool. */
export function registerForeignHubHost(home: string, deps: Omit<HubToolDeps, 'initiatorOf'>): () => Promise<void> {
  const key = resolve(home)
  const host: Host = { home: key, deps, sessions: new Map(), closed: false }
  hosts.set(key, host)
  return async () => {
    host.closed = true
    host.sessions.clear()
    if (hosts.get(key) === host) hosts.delete(key)
    if (host.server !== undefined) {
      host.server.closeAllConnections()
      await new Promise<void>((done) => host.server!.close(() => done()))
    }
  }
}

async function listen(host: Host): Promise<string> {
  if (host.closed) throw new Error('[E_HUB_CLOSED] Super D Hub binding is closed')
  if (host.listening !== undefined) return host.listening
  const server = createServer(async (request, response) => {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify(body))
    }
    const token = request.headers.authorization?.replace(/^Bearer /, '')
    if (token === undefined) {
      send(403, { error: '[E_HUB_ADDRESS_REQUIRED] This native session has no Substrate Hub address. Open or resume the conversation through Super D; a plugin alone does not register a mailbox.' })
      return
    }
    const bound = token === undefined ? undefined : host.sessions.get(token)
    if (host.closed || bound === undefined) { send(401, { error: '[E_HUB_BINDING] Unknown or expired Super D Hub session binding' }); return }
    if (request.method === 'GET' && request.url === '/inbox') { send(200, { message: bound.inbox[0] ?? null }); return }
    if (request.method !== 'POST' || !['/tool', '/inbox'].includes(request.url ?? '')) { send(405, { error: 'Use POST /tool, GET /inbox or POST /inbox' }); return }
    const controller = new AbortController()
    response.on('close', () => { if (!response.writableEnded) controller.abort() })
    try {
      let body = ''
      for await (const chunk of request) {
        body += chunk.toString()
        if (Buffer.byteLength(body) > 65_536) { send(413, { error: 'Super D Hub arguments exceed 64 KiB' }); return }
      }
      const args = JSON.parse(body)
      if (request.url === '/inbox') {
        if (typeof args?.started === 'string') {
          if (!bound.unstarted.has(args.started) && !bound.started.has(args.started)) { send(409, { error: '[E_HUB_INBOX_START] Unknown message' }); return }
          if (bound.unstarted.has(args.started)) {
            bound.onTurnStarted(args.started)
            bound.unstarted.delete(args.started)
            bound.started.add(args.started)
            if (bound.started.size > 128) bound.started.delete(bound.started.values().next().value!)
          }
          send(200, { started: true })
          return
        }
        if (typeof args?.ack !== 'string' || args.ack !== bound.inbox[0]?.id) { send(409, { error: '[E_HUB_INBOX_ACK] Message is not the current inbox item' }); return }
        bound.inbox.shift()
        send(200, { acknowledged: true })
      } else send(200, { result: await bound.execute(args, controller.signal) })
    } catch (error) {
      if (!response.writableEnded) send(400, { error: error instanceof Error ? error.message : String(error) })
    }
  })
  host.server = server
  host.listening = new Promise<string>((accept, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') { reject(new Error('Super D Hub loopback listener has no address')); return }
      server.unref()
      accept(`http://127.0.0.1:${address.port}/tool`)
    })
  })
  return host.listening
}

/** Public native-plugin endpoint; publishing it never grants a caller identity. */
export async function foreignHubEndpoint(home: string): Promise<string | undefined> {
  const host = hosts.get(resolve(home))
  return host === undefined || host.closed ? undefined : listen(host)
}

export function bindForeignHub(
  runtime: string,
  sessionId: string,
  worldHome: string,
  getAgent: () => A2aAgentHandle | undefined,
): ForeignHubBinding {
  const home = resolve(worldHome)
  const hostHome = dirname(home).endsWith('/agents') ? dirname(dirname(home)) : home
  const deliveryKey = Symbol('foreign-hub-delivery')
  deliveryBindings.set(deliveryKey, { home: hostHome, sessionId, getAgent })
  let attached: Host | undefined
  let tool: ToolDefinition | undefined
  let token: string | undefined
  let path: string | undefined
  let preparing: Promise<string | undefined> | undefined
  let disposed = false
  const inbox: BoundSession['inbox'] = []
  const unstarted = new Set<string>()
  const started = new Set<string>()
  const turnListeners = new Set<(id: string) => void>()

  const attach = (): ToolDefinition | undefined => {
    if (disposed) throw new Error('[E_HUB_BINDING] Super D Hub session binding is closed')
    const host = hosts.get(hostHome)
    if (host === undefined || host.closed) return undefined
    if (attached !== host) {
      if (attached !== undefined && token !== undefined) attached.sessions.delete(token)
      attached = host
      token = randomUUID()
      tool = createSuperdHubTool({ ...host.deps, initiatorOf: () => localA2aInitiator(host.home, runtime, sessionId) })
      host.sessions.set(token, { runtime, sessionId, getAgent, execute: binding.execute, inbox, unstarted, started, onTurnStarted: id => { for (const listener of turnListeners) listener(id) } })
    }
    return tool
  }

  const binding: ForeignHubBinding = {
    definition() {
      const current = attach()
      return current === undefined ? undefined : { name: current.name, description: current.description, inputSchema: current.parameters as Record<string, unknown> }
    },
    async execute(args, signal = new AbortController().signal) {
      const current = attach()
      if (current === undefined) throw new Error('[E_HUB_UNAVAILABLE] Super D Hub is not running for this session; reconnect through Super D')
      // A host tool context, with identity supplied by the binding rather than model arguments.
      const exec = {
        callId: randomUUID(), rootCallId: randomUUID(), name: current.name, arguments: args,
        agent: { id: sessionId }, signal, token: Symbol('foreign-hub-call'),
        deferContext() {}, concludeTurn() {},
      } as unknown as ToolRunContext
      return current.execute(args, exec)
    },
    async transport() {
      const definition = binding.definition()
      if (definition === undefined) return undefined
      const host = attached!
      const capability = token!
      const url = await listen(host)
      if (disposed) throw new Error('[E_HUB_BINDING] Super D Hub session binding is closed')
      return { url, token: capability, definition }
    },
    async enqueue(text) {
      if (attach() === undefined) throw new Error('[E_HUB_UNAVAILABLE] Super D Hub is not running for this session')
      if (Buffer.byteLength(text) > 65_536 || inbox.length >= 128 || unstarted.size >= 128) throw new Error('[E_HUB_INBOX_FULL] Hub inbox is full or the message exceeds 64 KiB')
      const id = randomUUID()
      unstarted.add(id)
      inbox.push({ id, text })
      return id
    },
    onTurnStarted(listener) { turnListeners.add(listener); return () => turnListeners.delete(listener) },
    async extensionPath() {
      if (preparing !== undefined) return preparing
      const definition = binding.definition()
      if (definition === undefined) return undefined
      const host = attached!
      const capability = token!
      preparing = (async () => {
        const url = await listen(host)
        if (disposed) throw new Error('[E_HUB_BINDING] Super D Hub session binding is closed')
        const directory = join(home, 'hub-extensions')
        await mkdir(directory, { recursive: true, mode: 0o700 })
        const wrapper = join(directory, `${capability}.mjs`)
        const config = { url, token: capability, name: definition.name, description: definition.description, parameters: definition.inputSchema }
        const entry = new URL('./foreign-extension.js', import.meta.url).href
        await writeFile(wrapper, `import { createForeignExtension } from ${JSON.stringify(entry)};\nexport default createForeignExtension(${JSON.stringify(config)});\n`, { mode: 0o600 })
        if (disposed) { rmSync(wrapper, { force: true }); throw new Error('[E_HUB_BINDING] Super D Hub session binding is closed') }
        path = wrapper
        return wrapper
      })()
      return preparing
    },
    dispose() {
      disposed = true
      inbox.length = 0
      unstarted.clear()
      started.clear()
      turnListeners.clear()
      deliveryBindings.delete(deliveryKey)
      if (attached !== undefined && token !== undefined) attached.sessions.delete(token)
      if (path !== undefined) rmSync(path, { force: true })
    },
  }
  return binding
}
