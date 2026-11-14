import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
test('Better doc copy retains selected native/shared docs and excludes Hub reports',async()=>{
 const api=await import('../better-dsh/scripts/copy-docs.mjs');assert.equal(typeof api.copyDocs,'function');
 const root=mkdtempSync(join(tmpdir(),'superd-docs-'));
 try{
 const source=join(root,'docs'),target=join(root,'package/docs');mkdirSync(source);writeFileSync(join(source,'native.md'),'native token=synth-token_01234567');writeFileSync(join(source,'hub.md'),'foreign hub only');
 writeFileSync(join(source,'package-catalog.json'),JSON.stringify({'better-dsh':['native.md', {source:'hub.md', target:'legacy.md'}]}));api.copyDocs(source,target);
 // seed token is 20 chars: exercises copyDocs' redact regex (token=[A-Za-z0-9_-]{20,})
 // while staying under the leak-scrub threshold (token=[A-Za-z0-9_-]{25,}) — a past
 // scrub rewrote the original alphabet seed to <redacted>, defusing the redaction
 // assert and breaking the source-untouched assert below.
 assert.ok(existsSync(join(target,'native.md')));assert.ok(!existsSync(join(target,'hub.md')));assert.equal(readFileSync(join(target,'legacy.md'),'utf8'),'foreign hub only');assert.ok(!existsSync(join(target,'package-catalog.json')));assert.match(readFileSync(join(target,'native.md'),'utf8'),/token=<redacted>/);assert.match(readFileSync(join(source,'native.md'),'utf8'),/synth-token_01234567/);
 }finally{rmSync(root,{recursive:true,force:true})}
})
