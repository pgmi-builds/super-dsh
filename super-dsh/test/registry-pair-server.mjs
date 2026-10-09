// Test-only registry endpoint for an unmodified, SHA256-verified artifact pair.
// No publication API; non-pair packages redirect to the normal configured registry.
import {createServer} from 'node:http'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {pathToFileURL} from 'node:url'
import {readPackPair} from '../../scripts/read-pack-pair.mjs'
export function createPairRegistry(directory,upstream='https://registry.npmjs.org/') {
 const pair=readPackPair(directory),entries=new Map()
 for(const item of [pair.betterDash,pair.superDash]){
  const bytes=readFileSync(item.tarball)
  // Manifest is read from the verified consumer archive, never the source tree.
  entries.set(item.name,{...item,bytes})
 }
 const server=createServer(async(req,res)=>{
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end();return}
  const path=new URL(req.url,'http://localhost').pathname
  const name=decodeURIComponent(path.slice(1)),item=entries.get(name)
  if(item){
   const {execFileSync}=await import('node:child_process')
   const manifest=JSON.parse(execFileSync('tar',['-xOf',item.tarball,'package/package.json'],{encoding:'utf8'}))
   const address=server.address(),base=`http://127.0.0.1:${address.port}`
   manifest.dist={tarball:`${base}/${item.name}/-/${item.name}-${item.version}.tgz`,integrity:'sha512-'+createHash('sha512').update(item.bytes).digest('base64'),shasum:createHash('sha1').update(item.bytes).digest('hex')}
   res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(req.method==='HEAD'?undefined:JSON.stringify({name:item.name,'dist-tags':{latest:item.version},versions:{[item.version]:manifest}}));return
  }
  for(const item of entries.values())if(path===`/${item.name}/-/${item.name}-${item.version}.tgz`){res.writeHead(200,{'content-type':'application/octet-stream','content-length':item.bytes.length});res.end(req.method==='HEAD'?undefined:item.bytes);return}
  if(path.startsWith('/better-dsh/')||path.startsWith('/super-dsh/')){res.writeHead(404);res.end('{}');return}
  const target=new URL(req.url.replace(/^\//,''),upstream.endsWith('/')?upstream:upstream+'/')
  res.writeHead(302,{location:target.href});res.end()
 })
 return server
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [dir,port,upstream]=process.argv.slice(2);const server=createPairRegistry(dir,upstream);server.listen(Number(port),'127.0.0.1',()=>console.log('Verified pair registry listening on loopback port '+port))
}
