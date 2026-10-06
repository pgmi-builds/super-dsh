/** Native plugin delivery. No prompt hooks; all identity lives in the Hub binding. */
import { mkdir, readFile, readdir, writeFile, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ForeignHubBinding } from './foreign-hub.js'

const owner = 'super-dsh:foreign-hub:v1\n'
const preparing = new Map<string, Promise<unknown>>()

async function serialized<T>(home: string, work: () => Promise<T>): Promise<T> {
  const key = resolve(home)
  const previous = preparing.get(key)
  const current = (previous ?? Promise.resolve()).catch(() => {}).then(work)
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

/** Called by the Hub host at mount, independently of any agent/tool use. */
export async function refreshHermesNativeEndpoint(
  endpoint: () => Promise<string | undefined>,
  nativeHome: string,
): Promise<void> {
  await serialized(nativeHome, async () => {
    const directory = join(nativeHome, 'plugins', 'superd-hub')
    if (await readFile(join(directory, '.superd-owner'), 'utf8').catch(() => '') !== owner) return
    const config = JSON.parse(await readFile(join(directory, 'connection.json'), 'utf8')) as { definition: unknown }
    const url = await endpoint()
    if (url !== undefined) await atomicWrite(join(directory, 'connection.json'), JSON.stringify({ url, definition: config.definition }) + '\n')
  })
}

// A normal Hermes backend plugin, using only its documented registration seam.
// Public connection.json lets native sessions reach the post office's address
// error; the capability exists ONLY in the Super D child's environment.
const hermesModule = String.raw`import json
import os
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError


def _public():
    return json.loads((Path(__file__).parent / "connection.json").read_text())


def _call(args, **kwargs):
    try:
        private = os.environ.get("SUPERD_HUB_SESSION")
        config = json.loads(private) if private else _public()
        url = config["url"]
        if not url.startswith("http://127.0.0.1:"):
            raise ValueError("Super D Hub requires a same-machine loopback URL")
        headers = {"Content-Type": "application/json"}
        if private:
            headers["Authorization"] = "Bearer " + config["token"]
        request = Request(url, data=json.dumps(args).encode(), headers=headers, method="POST")
        try:
            with urlopen(request, timeout=120) as response:
                envelope = json.loads(response.read())
        except HTTPError as error:
            envelope = json.loads(error.read())
        if "error" in envelope:
            return json.dumps({"error": envelope["error"]}, ensure_ascii=False)
        return json.dumps(envelope["result"], ensure_ascii=False)
    except (OSError, URLError, ValueError, KeyError) as error:
        return json.dumps({"error": "[E_HUB_UNAVAILABLE] " + str(error) + ". Open or resume this conversation through Super D."})


def register(ctx):
    definition = _public()["definition"]
    ctx.register_tool(
        name=definition["name"], toolset="superd_hub",
        schema={"name": definition["name"], "description": definition["description"], "parameters": definition["inputSchema"]},
        handler=_call,
    )
`

export async function prepareHermesNativePlugin(
  binding: Pick<ForeignHubBinding, 'transport'>,
  nativeHome: string,
  enable: (key: string) => Promise<unknown>,
): Promise<string | undefined> {
  const transport = await binding.transport()
  if (transport === undefined) return undefined
  return serialized(nativeHome, async () => {
  const directory = join(nativeHome, 'plugins', 'superd-hub')
  let entries: string[]
  try { entries = await readdir(directory) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    entries = []
  }
  if (entries.length > 0) {
    const marker = await readFile(join(directory, '.superd-owner'), 'utf8').catch(() => '')
    if (marker !== owner) throw new Error(`Refusing to overwrite unowned native plugin directory: ${directory}`)
  }
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await atomicWrite(join(directory, 'connection.json'), JSON.stringify({ url: transport.url, definition: transport.definition }) + '\n')
  await atomicWrite(join(directory, '__init__.py'), hermesModule)
  await atomicWrite(join(directory, 'plugin.yaml'), 'name: superd-hub\nversion: 1.0.0\ndescription: Substrate Hub facility for Super D conversations\nkind: backend\nprovides_tools:\n  - superd-hub\n')
  await atomicWrite(join(directory, '.superd-owner'), owner)
  await enable('superd-hub')
  return JSON.stringify(transport)
  })
}
