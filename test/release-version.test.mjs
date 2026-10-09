import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
test('one version operation synchronizes independent packages and removes legacy delivery dependency', async()=>{
 const api=await import('../scripts/release-version.mjs').catch(()=>({}));assert.equal(typeof api.setReleaseVersion,'function');
 const root=mkdtempSync(join(tmpdir(),'superd-version-'));
 try{
 for(const [dir,data]of [['',{name:'superd',private:true,version:'0.2.0',releaseTarget:'0.3.0'}],['better-dsh',{name:'better-dsh',version:'0.2.0'}],['super-dsh',{name:'super-dsh',version:'0.2.0',dependencies:{'better-dsh':'0.2.0',ws:'8.21.0'}}]]){mkdirSync(join(root,dir),{recursive:true});writeFileSync(join(root,dir,'package.json'),JSON.stringify(data))}
 api.setReleaseVersion(root,'0.3.0-a');assert.equal(api.assertReleaseVersions(root),'0.3.0-a');
 assert.equal(JSON.parse(readFileSync(join(root,'super-dsh/package.json'))).dependencies['better-dsh'],undefined);
 assert.equal(JSON.parse(readFileSync(join(root,'super-dsh/package.json'))).dependencies.ws,'8.21.0');
 const p=join(root,'better-dsh/package.json');writeFileSync(p,JSON.stringify({name:'better-dsh',version:'0.3.0-b'}));assert.throws(()=>api.assertReleaseVersions(root),/version/);
 assert.throws(()=>api.setReleaseVersion(root,'0.3'),/version/);assert.throws(()=>api.setReleaseVersion(root,'0.3.0-01'),/version/);assert.equal(api.isReleaseVersion('0.3.0-rc.1'),true);
 }finally{rmSync(root,{recursive:true,force:true})}
})
test('the pack default resolves the physical same-repository Better source',async()=>{
 const api=await import('../super-dsh/scripts/build-better.mjs');assert.equal(typeof api.resolveBetterDashSource,'function');
 const root=mkdtempSync(join(tmpdir(),'superd-source-'));
 try{mkdirSync(join(root,'better-dsh'));assert.equal(api.resolveBetterDashSource(root),join(root,'better-dsh'));rmSync(join(root,'better-dsh'),{recursive:true});assert.throws(()=>api.resolveBetterDashSource(root))}finally{rmSync(root,{recursive:true,force:true})}
})
