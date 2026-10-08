import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import test from 'node:test'
import {packPackage} from '../super-dsh/scripts/pack-package.mjs'
test('received local pair verifies independent bundle activation and exact companion archive',async()=>{
 const api=await import('../scripts/read-pack-pair.mjs').catch(()=>({}));assert.equal(typeof api.readPackPair,'function');
 const root=mkdtempSync(join(tmpdir(),'superd-delivery-pair-'));
 try{
 const better=join(root,'better'),superDash=join(root,'super'),out=join(root,'out');mkdirSync(better);mkdirSync(superDash);
 const version='0.3.0-a';writeFileSync(join(better,'package.json'),JSON.stringify({name:'better-dsh',version,files:['cordis.patch.yml']}));writeFileSync(join(better,'cordis.patch.yml'),'[]\n');const b=packPackage(better,out);
 const nested=join(superDash,'node_modules/better-dsh');mkdirSync(nested,{recursive:true});execFileSync('tar',['-xf',join(out,b.filename),'-C',nested,'--strip-components=1']);
 mkdirSync(join(superDash,'bundles'));const betterBytes=readFileSync(join(out,b.filename));writeFileSync(join(superDash,'bundles/better-dsh.tgz'),betterBytes);writeFileSync(join(superDash,'bundles/manifest.json'),JSON.stringify({companions:[{name:'better-dsh',version,tarball:'./better-dsh.tgz',sha256:createHash('sha256').update(betterBytes).digest('hex')}]}));
 writeFileSync(join(superDash,'package.json'),JSON.stringify({name:'super-dsh',version,dependencies:{'better-dsh':version},bundledDependencies:['better-dsh'],files:['cordis.patch.yml','bundles'],superd:{delivery:'./bundles/manifest.json'},dsh:{bundle:{patch:'./cordis.patch.yml'}}}));writeFileSync(join(superDash,'cordis.patch.yml'),'[]\n');const s=packPackage(superDash,out);
 const entry=p=>({name:p.name,version:p.version,tarball:'/original-machine/'+p.filename,sha256:createHash('sha256').update(readFileSync(join(out,p.filename))).digest('hex')});const pair={betterDash:entry(b),superDash:entry(s)};
 const file=join(out,'pair.json');writeFileSync(file,JSON.stringify(pair));const valid=api.readPackPair(out);assert.equal(valid.betterDash.tarball,join(out,b.filename));assert.equal(valid.bundledFiles,2);
 const saved=readFileSync(join(out,s.filename));writeFileSync(join(out,s.filename),'corrupt');assert.throws(()=>api.readPackPair(out),/SHA256/);writeFileSync(join(out,s.filename),saved);
 writeFileSync(join(superDash,'bundles/better-dsh.tgz'),'wrong embedded archive');
 const changed=packPackage(superDash,out);pair.superDash=entry(changed);writeFileSync(file,JSON.stringify(pair));assert.throws(()=>api.readPackPair(out),/Archived companion/);
 writeFileSync(join(superDash,'bundles/better-dsh.tgz'),betterBytes);const restored=packPackage(superDash,out);pair.superDash=entry(restored);
 pair.betterDash.version='0.3.0-b';writeFileSync(file,JSON.stringify(pair));assert.throws(()=>api.readPackPair(out),/version/);
 }finally{rmSync(root,{recursive:true,force:true})}
})
