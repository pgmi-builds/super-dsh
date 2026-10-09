// Verify ordinary exact registry dependency delivery and real browser exports.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
export function verifyDependencyPair(tarball, dependencyTarball) {
 const scratch=mkdtempSync(join(tmpdir(),'superd-dependency-'))
 try {
  for(const [dir,archive] of [['super',tarball],['better',dependencyTarball]]){mkdirSync(join(scratch,dir));execFileSync('tar',['-xf',archive,'-C',join(scratch,dir)])}
  const outer=join(scratch,'super/package'),better=join(scratch,'better/package')
  const a=JSON.parse(readFileSync(join(outer,'package.json'))),b=JSON.parse(readFileSync(join(better,'package.json')))
  if(a.name!=='super-dsh'||b.name!=='better-dsh'||a.version!==b.version||a.dependencies?.['better-dsh']!==b.version)throw new Error('Super must declare the synchronized exact Better registry version')
  const bundled=a.bundledDependencies??a.bundleDependencies
  if(bundled===true||Array.isArray(bundled)&&bundled.includes('better-dsh'))throw new Error('Physical Better bundling is forbidden')
  const files=execFileSync('tar',['-tf',tarball],{encoding:'utf8',maxBuffer:16*1024*1024}).split('\n')
  if(files.some(file=>/(?:^|\/)node_modules\/better-dsh(?:\/|$)/.test(file)||/^package\/bundles\//.test(file)||/better-dsh.*\.tgz$/.test(file)))throw new Error('Physical Better payload is forbidden')
  if(a.superd?.delivery!==undefined||a.dsh?.bundle?.patch!=='./cordis.patch.yml')throw new Error('Super must use its independent native bundle without archive delivery')
  const dirs=[outer,better,...readdirSync(outer,{withFileTypes:true}).filter(e=>e.isDirectory()&&e.name!=='node_modules').map(e=>join(outer,e.name))]
  for(const dir of dirs){if(!existsSync(join(dir,'package.json')))continue;const m=JSON.parse(readFileSync(join(dir,'package.json')));if(m.dsh?.client===undefined)continue;const exp=m.exports?.['./client'];const file=typeof exp==='string'?exp:exp?.default;if(typeof file!=='string'||!existsSync(join(dir,file)))throw new Error(`Missing declared client export: ${m.name}`)}
  return true
 }finally{rmSync(scratch,{recursive:true,force:true})}
}
