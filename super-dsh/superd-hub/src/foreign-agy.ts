/** Antigravity native plugin: tool catalog via stdio, delivery via the owned CLI. */
import { mkdir, readFile, readdir, writeFile, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ForeignHubBinding } from './foreign-hub.js'

const owner = 'super-dsh:agy-hub-plugin:v1\n'
// t and earlier test installers appended a second LF; recognize that exact
// owned legacy form while rewriting the marker canonically below.
const isOwner = (marker: string) => marker === owner || marker === owner + '\n'
const jobs = new Map<string, Promise<unknown>>()
async function serialized<T>(home: string, work: () => Promise<T>): Promise<T> {
  const key = resolve(home)
  const current = (jobs.get(key) ?? Promise.resolve()).catch(() => {}).then(work)
  jobs.set(key, current)
  try { return await current } finally { if (jobs.get(key) === current) jobs.delete(key) }
}
async function atomic(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  try { await writeFile(temporary, content, { flag: 'wx', mode: 0o600 }); await rename(temporary, path) }
  finally { await rm(temporary, { force: true }) }
}

// Only MCP's synchronous catalog/call surface is used. Incoming A2A delivery
// never uses MCP notifications: the Hub already owns the live CLI stdin.
const serverModule = String.raw`const {readFileSync}=require('node:fs');
const {join}=require('node:path');
const {createInterface}=require('node:readline');
const publicConfig=()=>JSON.parse(readFileSync(join(__dirname,'connection.json'),'utf8'));
async function request(m){
 if(m.method==='initialize')return {protocolVersion:m.params?.protocolVersion??'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'superd-hub',version:'1.0.0'}};
 if(m.method==='ping')return {};
 if(m.method==='tools/list')return {tools:[publicConfig().definition]};
 if(m.method==='tools/call'){
  if(m.params?.name!=='superd-hub')throw Object.assign(new Error('Unknown tool'),{code:-32602});
  try {
   const privateSession=process.env.SUPERD_HUB_SESSION;
   const config=privateSession?JSON.parse(privateSession):publicConfig();
   const url=new URL(config.url);
   if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.pathname!=='/tool')throw new Error('Hub requires a same-machine loopback URL');
   const headers={'content-type':'application/json'};
   if(privateSession)headers.authorization='Bearer '+config.token;
   const response=await fetch(url,{method:'POST',headers,body:JSON.stringify(m.params.arguments??{}),signal:AbortSignal.timeout(120000)});
   const envelope=await response.json();
   return {content:[{type:'text',text:JSON.stringify(envelope.error?{error:envelope.error}:envelope.result)}],isError:!response.ok||!!envelope.error};
  }catch(error){return {content:[{type:'text',text:'[E_HUB_UNAVAILABLE] '+error.message+'. Open or resume through Super D.'}],isError:true};}
 }
 throw Object.assign(new Error('Method not found'),{code:-32601});
}
for await (const line of createInterface({input:process.stdin,crlfDelay:Infinity})){
 let m;try{m=JSON.parse(line)}catch{process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}})+'\n');continue;}
 if(m.id===undefined)continue;
 try{const result=await request(m);process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\n');}
 catch(error){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:error.code??-32603,message:error.message}})+'\n');}
}
`

// CJS permits the installed helper to run without a package dependency or loader.
const server = serverModule.replace('for await (const line', ';(async()=>{for await (const line') + '})().catch(()=>process.exitCode=1);\n'

export async function refreshAgyNativeEndpoint(endpoint: () => Promise<string | undefined>, nativeHome: string): Promise<void> {
  await serialized(nativeHome, async () => {
    const directory = join(nativeHome, 'plugins', 'superd-hub')
    if (!isOwner(await readFile(join(directory, '.superd-owner'), 'utf8').catch(() => ''))) return
    const config = JSON.parse(await readFile(join(directory, 'connection.json'), 'utf8')) as { definition: unknown }
    const url = await endpoint()
    if (url !== undefined) await atomic(join(directory, 'connection.json'), JSON.stringify({ url, definition: config.definition }) + '\n')
  })
}

export async function prepareAgyNativePlugin(
  binding: Pick<ForeignHubBinding, 'transport'>,
  nativeHome: string,
  stagingDirectory: string,
  install: (directory: string) => Promise<unknown>,
): Promise<string | undefined> {
  const transport = await binding.transport()
  if (transport === undefined) return undefined
  return serialized(nativeHome, async () => {
    const directory = join(nativeHome, 'plugins', 'superd-hub')
    const entries = await readdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return [] })
    if (entries.length > 0 && !isOwner(await readFile(join(directory, '.superd-owner'), 'utf8').catch(() => ''))) throw new Error(`Refusing to overwrite unowned native plugin directory: ${directory}`)
    await mkdir(stagingDirectory, { recursive: true, mode: 0o700 })
    const files: Record<string, string> = {
      '.superd-owner': owner,
      'plugin.json': JSON.stringify({ name: 'superd-hub', description: 'Substrate Hub facility for Super D conversations' }),
      'connection.json': JSON.stringify({ url: transport.url, definition: transport.definition }),
      'server.cjs': server,
      'mcp_config.json': JSON.stringify({ mcpServers: { 'superd-hub': { command: process.execPath, args: [join(directory, 'server.cjs')] } } }),
    }
    const payload = (name: string, content: string) => name === '.superd-owner' ? content : content + '\n'
    for (const [name, content] of Object.entries(files)) await atomic(join(stagingDirectory, name), payload(name, content))
    await mkdir(directory, { recursive: true, mode: 0o700 })
    for (const [name, content] of Object.entries(files)) await atomic(join(directory, name), payload(name, content))
    await install(stagingDirectory)
    // The official installer may skip non-customization helper files; ensure
    // our own staged payload is present, with no capability written publicly.
    await mkdir(directory, { recursive: true, mode: 0o700 })
    for (const [name, content] of Object.entries(files)) await atomic(join(directory, name), payload(name, content))
    return JSON.stringify(transport)
  })
}
