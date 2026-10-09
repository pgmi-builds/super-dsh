import {readFileSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {pathToFileURL} from 'node:url'
import {isReleaseVersion} from './release-version.mjs'
import {verifyPackagePair} from '../super-dsh/scripts/verify-package-pair.mjs'

/** Delivery-only consumption of a pair already built from local source. No registry fallback. */
export function readPackPair(directory){
 const dir=resolve(directory);const input=JSON.parse(readFileSync(join(dir,'pair.json'),'utf8'))
 if(input.betterDash?.version!==input.superDash?.version)throw new Error('Received pair version mismatch')
 const result={...input}
 for(const [key,name]of [['betterDash','better-dsh'],['superDash','super-dsh']]){
  const entry=input[key]
  if(entry?.name!==name||!isReleaseVersion(entry.version))throw new Error('Received pair identity/version mismatch')
  const tarball=join(dir,`${name}-${entry.version}.tgz`)
  const bytes=readFileSync(tarball);const sha256=createHash('sha256').update(bytes).digest('hex')
  if(entry.sha256!==sha256)throw new Error(`Received ${name} SHA256 mismatch`)
  const packed=JSON.parse(execFileSync('tar',['-xOf',tarball,'package/package.json'],{encoding:'utf8'}))
  if(packed.name!==name||packed.version!==entry.version)throw new Error(`Received ${name} manifest version mismatch`)
  if(name==='super-dsh'&&packed.dsh?.bundle?.patch!=='./cordis.patch.yml')throw new Error('Received bundle activation boundary mismatch')
  result[key]={...entry,tarball}
 }
 result.independentPackages=verifyPackagePair(result.superDash.tarball,result.betterDash.tarball)
 return result
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const result=readPackPair(process.argv[2]);const selected=result[process.argv[3]??'superDash'];console.log(selected.tarball)
}
