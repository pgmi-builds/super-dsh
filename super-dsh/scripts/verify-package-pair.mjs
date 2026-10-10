// Verify independent synchronized package delivery and real browser exports.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
const sha256=data=>createHash('sha256').update(data).digest('hex')
export function verifyPackagePair(tarball, dependencyTarball, sourceRepo) {
 const scratch=mkdtempSync(join(tmpdir(),'superd-dependency-'))
 try {
  for(const [dir,archive] of [['super',tarball],['better',dependencyTarball]]){mkdirSync(join(scratch,dir));execFileSync('tar',['-xf',archive,'-C',join(scratch,dir)])}
  const outer=join(scratch,'super/package'),better=join(scratch,'better/package')
  const a=JSON.parse(readFileSync(join(outer,'package.json'))),b=JSON.parse(readFileSync(join(better,'package.json')))
  if(a.name!=='super-dsh'||b.name!=='better-dsh'||a.version!==b.version)throw new Error('Super and Better must have synchronized package versions')
  if(['dependencies','optionalDependencies','peerDependencies'].some(field=>a[field]?.['better-dsh']!==undefined))throw new Error('Super must not declare a Better dependency')
  if(a.exports?.['./remote']!==undefined){
   const exp=a.exports['./remote'];if(exp?.types!=='./remote/plugin.d.ts'||exp?.default!=='./remote/plugin.js')throw new Error('Invalid standalone remote export')
   verifyRemoteClosure(outer,sourceRepo)
  }
  const bundled=a.bundledDependencies??a.bundleDependencies
  if(bundled===true||Array.isArray(bundled)&&bundled.includes('better-dsh'))throw new Error('Physical Better bundling is forbidden')
  const files=execFileSync('tar',['-tf',tarball],{encoding:'utf8',maxBuffer:16*1024*1024}).split('\n')
  if(files.some(file=>/(?:^|\/)node_modules\/better-dsh(?:\/|$)/.test(file)||/^package\/(?:bundles|better-dsh)(?:\/|$)/.test(file)||/better-dsh.*\.tgz$/.test(file)))throw new Error('Physical Better payload is forbidden')
  if(a.superd?.delivery!==undefined||a.dsh?.bundle?.patch!=='./cordis.patch.yml')throw new Error('Super must use its independent native bundle without archive delivery')
  const dirs=[outer,better,...readdirSync(outer,{withFileTypes:true}).filter(e=>e.isDirectory()&&e.name!=='node_modules').map(e=>join(outer,e.name))]
  for(const dir of dirs){if(!existsSync(join(dir,'package.json')))continue;const m=JSON.parse(readFileSync(join(dir,'package.json')));if(m.dsh?.client===undefined)continue;const exp=m.exports?.['./client'];const file=typeof exp==='string'?exp:exp?.default;if(typeof file!=='string'||!existsSync(join(dir,file)))throw new Error(`Missing declared client export: ${m.name}`)}
  return true
 }finally{rmSync(scratch,{recursive:true,force:true})}
}

/** The remote exception permits only the independent, provenance-checked entry. */
export function verifyRemoteClosure(packageDir, sourceRepo) {
 const remote=join(packageDir,'remote')
 const manifest=JSON.parse(readFileSync(join(remote,'provenance.json'),'utf8'))
 if(manifest.format!==1||manifest.entry!=='better-dsh/src/remote/plugin.ts')throw new Error('Invalid remote provenance')
 const actual=readdirSync(remote).sort()
 if(JSON.stringify(actual)!==JSON.stringify(['file-worker.js','plugin.d.ts','plugin.js','provenance.json']))throw new Error('Remote closure must not copy Better shared chunks or payload')
 if(manifest.workerEntry!=='better-dsh/src/remote/file-worker.ts')throw new Error('Invalid private file worker provenance')
 for(const name of ['plugin.js','plugin.d.ts','file-worker.js']){
  const data=readFileSync(join(remote,name))
  if(sha256(data)!==manifest.outputs?.[name])throw new Error(`Remote output hash mismatch: ${name}`)
  if(name==='file-worker.js'&&/(?:from\s*|import\s*\(|import\s+|require\s*\()\s*["'](?!node:)/.test(data.toString()))throw new Error('Private file worker must import Node builtins only')
  if(/(?:from\s*|import\s*\()["'](?:better-dsh|#schemastery)/.test(data.toString()))throw new Error(`Remote closure has a cross-package import: ${name}`)
 }
 if(!manifest.sources||!Object.keys(manifest.sources).length)throw new Error('Remote provenance has no sources')
 if(sourceRepo){
  const canonical=readdirSync(join(sourceRepo,'better-dsh/src/remote')).filter(file=>file.endsWith('.ts')).map(file=>`better-dsh/src/remote/${file}`)
  if(canonical.some(path=>manifest.sources[path]===undefined))throw new Error('Remote provenance omits canonical source')
 }
 for(const [path,hash] of Object.entries(manifest.sources)){
  if(!/^better-dsh\/(?:src\/remote\/|third_party\/schemastery\/)/.test(path)||path.split('/').includes('..')||!/^[a-f0-9]{64}$/.test(hash))throw new Error('Invalid remote source provenance')
  if(sourceRepo&&sha256(readFileSync(join(sourceRepo,path)))!==hash)throw new Error(`Stale remote source: ${path}`)
 }
 return true
}
