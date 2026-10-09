import {readFileSync,writeFileSync,existsSync} from 'node:fs'
import {join,dirname} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
const dirs=['','better-dsh','super-dsh']
const load=(repo,dir)=>JSON.parse(readFileSync(join(repo,dir,'package.json'),'utf8'))
export function assertReleaseVersions(repo){
 const [root,better,superDash]=dirs.map(dir=>load(repo,dir))
 if(root.private!==true||better.name!=='better-dsh'||superDash.name!=='super-dsh'||root.version!==better.version||root.version!==superDash.version||['dependencies','optionalDependencies','peerDependencies'].some(field=>superDash[field]?.['better-dsh']!==undefined))throw new Error('Release version mismatch: root, Better Dash, Super Dash must agree and remain independent')
 return root.version
}
export function isReleaseVersion(version){
 if(typeof version!=='string')return false
 const match=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(version)
 return Boolean(match)&&(!match[4]||match[4].split('.').every(part=>!/^\d+$/.test(part)||part==='0'||part[0]!=='0'))
}
export function setReleaseVersion(repo,version){
 if(!isReleaseVersion(version))throw new Error(`Invalid release version: ${version}`)
 const manifests=dirs.map(dir=>load(repo,dir));if(manifests[0].private!==true||manifests[1].name!=='better-dsh'||manifests[2].name!=='super-dsh')throw new Error('Unexpected release package identity')
 for(const manifest of manifests)manifest.version=version
 for(const field of ['dependencies','optionalDependencies','peerDependencies']){if(manifests[2][field])delete manifests[2][field]['better-dsh']}
 for(const [i,dir]of dirs.entries()){
  const manifest=manifests[i];writeFileSync(join(repo,dir,'package.json'),JSON.stringify(manifest,null,2)+'\n')
  const lockPath=join(repo,dir,'package-lock.json');if(existsSync(lockPath)){
   const lock=JSON.parse(readFileSync(lockPath,'utf8'));lock.name=manifest.name;lock.version=version
   if(lock.packages?.['']){lock.packages[''].name=manifest.name;lock.packages[''].version=version;for(const key of ['dependencies','devDependencies','peerDependencies','peerDependenciesMeta','engines']){if(manifest[key])lock.packages[''][key]=manifest[key];else delete lock.packages[''][key]}}
   writeFileSync(lockPath,JSON.stringify(lock,null,2)+'\n')
  }
 }
 return assertReleaseVersions(repo)
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const repo=dirname(dirname(fileURLToPath(import.meta.url)));const version=process.argv[2]
 console.log(version?setReleaseVersion(repo,version):assertReleaseVersions(repo))
}
