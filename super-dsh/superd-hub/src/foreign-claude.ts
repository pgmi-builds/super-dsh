/** Claude's native Mods API: one tool and an addressed, background inbox. */
import { mkdir, readFile, readdir, writeFile, rename, rm } from 'node:fs/promises'
import { join, resolve, delimiter } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ForeignHubBinding } from './foreign-hub.js'

const owner = 'super-dsh:claude-hub-mod:v1\n'
const preparing = new Map<string, Promise<unknown>>()

async function serialized<T>(home: string, work: () => Promise<T>): Promise<T> {
  const key = resolve(home)
  const current = (preparing.get(key) ?? Promise.resolve()).catch(() => {}).then(work)
  preparing.set(key, current)
  try { return await current } finally { if (preparing.get(key) === current) preparing.delete(key) }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
  } finally { await rm(temporary, { force: true }) }
}

// Runs inside Claude's Mod sandbox. No Node imports, MCP process, prompt
// injection or turn hooks. Native unaddressed sessions register the tool but
// do not poll; the post office itself reports E_HUB_ADDRESS_REQUIRED.
const moduleSource = String.raw`async function connection($) {
    const privateConfig = await $.env.get("SUPERD_HUB_SESSION");
    const config = JSON.parse(privateConfig || await $.fs.read($.plugin.root + "/connection.json"));
    if (!config.url.startsWith("http://127.0.0.1:")) throw new Error("Super D Hub requires same-machine loopback HTTP");
    return { config, addressed: Boolean(privateConfig) };
  }
  function headers(config, addressed) {
    return { "Content-Type": "application/json", ...(addressed ? { Authorization: "Bearer " + config.token } : {}) };
  }
export function register(on) {
  let timer;
  let receiving = false;
  let submitted;
  const queued = new Map();
  on("session.start", async ($, e, next) => {
    timer?.cancel();
    const { config, addressed } = await connection($);
    await $.tool.register(config.definition);
    if (addressed) timer = $.clock.every(250, async () => {
      if (receiving) return;
      receiving = true;
      try {
        for (const [id, pending] of queued) if (pending.aborted) { queued.delete(id); submitted = undefined; }
        const url = config.url.replace(/\/tool$/, "/inbox");
        const response = await $.http.fetch(url, { method: "GET", headers: headers(config, true) });
        if (response.status === 401 || response.status === 403) { timer?.cancel(); return; }
        if (!response.ok) return;
        const message = JSON.parse(response.text).message;
        if (!message) return;
        if (submitted !== message.id) {
          const marker = "[superd-hub:inbox message=" + message.id + "]";
          queued.set(message.id, { marker, url, config, confirmed: false, aborted: false });
          const outcome = await $.prompt.submit({ text: marker + "\n" + message.text });
          if (outcome && "drop" in outcome) { queued.delete(message.id); return; }
          submitted = message.id;
        }
        // An unconfirmed turn is cancelled before its model runs and remains
        // in the inbox to retry; never ACK it or send a late start receipt.
        if (!queued.get(message.id)?.confirmed) return;
        // Ack only after the runtime has accepted the plugin's prompt. If the
        // ack fails, retry it without submitting the same prompt twice.
        const ack = await $.http.fetch(url, { method: "POST", headers: headers(config, true), body: JSON.stringify({ ack: message.id }) });
        if (ack.ok) { submitted = undefined; queued.delete(message.id); }
      } catch (_) {
        // A temporary offline post office leaves the message queued there.
      } finally { receiving = false; }
    });
    return next(e);
  });
  // This receipt binds the Hub's source message to its actual native turn;
  // a different user/plugin turn cannot claim it by happening to run first.
  on("turn.start", async ($, e, next) => {
    for (const [id, pending] of queued) {
      if (!e.text.includes(pending.marker)) continue;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await $.http.fetch(pending.url, { method: "POST", headers: headers(pending.config, true), body: JSON.stringify({ started: id }) });
          if (response.ok) { pending.confirmed = true; break; }
          if (response.status === 401 || response.status === 403) break;
        } catch (_) {}
      }
      if (!pending.confirmed) {
        pending.aborted = true;
        await $.turn.abort({ turnId: e.turnId });
      }
      break;
    }
    return next(e);
  });
  on("tool.call", { tool: "mcp__superd-hub__superd-hub" }, async ($, e) => {
    try {
      const { config, addressed } = await connection($);
      const { tool, tool_use_id, agentId, consent, ...args } = e;
      const response = await $.http.fetch(config.url, { method: "POST", headers: headers(config, addressed), body: JSON.stringify(args) });
      const envelope = JSON.parse(response.text);
      return { result: JSON.stringify(envelope.error ? { error: envelope.error } : envelope.result) };
    } catch (error) {
      return { result: JSON.stringify({ error: "[E_HUB_UNAVAILABLE] " + String(error) + ". Open or resume this conversation through Super D." }) };
    }
  });
}
`

export async function refreshClaudeNativeEndpoint(endpoint: () => Promise<string | undefined>, nativeHome: string): Promise<void> {
  await serialized(nativeHome, async () => {
    const directory = join(nativeHome, 'plugins', 'superd-hub')
    if (await readFile(join(directory, '.superd-owner'), 'utf8').catch(() => '') !== owner) return
    const config = JSON.parse(await readFile(join(directory, 'connection.json'), 'utf8')) as { definition: unknown }
    const url = await endpoint()
    if (url !== undefined) await atomicWrite(join(directory, 'connection.json'), JSON.stringify({ url, definition: config.definition }) + '\n')
  })
}

/** Incrementally enable our owned native plugin; never persist a session capability. */
export async function prepareClaudeNativePlugin(binding: Pick<ForeignHubBinding, 'transport'>, nativeHome: string): Promise<string | undefined> {
  const transport = await binding.transport()
  if (transport === undefined) return undefined
  return serialized(nativeHome, async () => {
    const directory = join(nativeHome, 'plugins', 'superd-hub')
    const entries = await readdir(directory).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return []
    })
    if (entries.length > 0 && await readFile(join(directory, '.superd-owner'), 'utf8').catch(() => '') !== owner) {
      throw new Error(`Refusing to overwrite unowned native plugin directory: ${directory}`)
    }
    const settingsPath = join(nativeHome, 'settings.json')
    const settings = JSON.parse(await readFile(settingsPath, 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return '{}'
    })) as { env?: Record<string, string> }
    const paths = (settings.env?.['CLAUDE_CODE_PLUGIN_DIRS'] ?? '').split(delimiter).filter(Boolean)
    if (!paths.includes(directory)) paths.push(directory)
    await mkdir(join(directory, '.claude-plugin'), { recursive: true, mode: 0o700 })
    await mkdir(join(directory, 'hooks'), { recursive: true, mode: 0o700 })
    await atomicWrite(join(directory, '.superd-owner'), owner)
    await atomicWrite(join(directory, 'connection.json'), JSON.stringify({ url: transport.url, definition: transport.definition }) + '\n')
    await atomicWrite(join(directory, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'superd-hub', version: '1.0.0', description: 'Substrate Hub facility for Super D conversations' }) + '\n')
    await atomicWrite(join(directory, 'hooks', 'hooks.json'), JSON.stringify({ modules: ['./register.js'] }) + '\n')
    await atomicWrite(join(directory, 'hooks', 'register.js'), moduleSource)
    settings.env = { ...settings.env, CLAUDE_CODE_PLUGIN_DIRS: paths.join(delimiter) }
    await atomicWrite(settingsPath, JSON.stringify(settings, null, 2) + '\n')
    return JSON.stringify(transport)
  })
}
