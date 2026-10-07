import test from 'node:test'
import assert from 'node:assert/strict'
import {existsSync,readFileSync,readdirSync} from 'node:fs'
import {resolve,join} from 'node:path'
const root=resolve('better-dsh')
test('real vendored schema runtime and types are present as clean-clone build inputs',()=>{
 for(const path of ['third_party/schemastery/lib/index.mjs','third_party/schemastery/lib/index.d.mts','third_party/schemastery/lib/types/index.d.ts','third_party/schemastery/node_modules/@deepseek-ai/cosmokit/lib/index.js','third_party/schemastery/node_modules/@standard-schema/spec/dist/index.d.ts'])assert.ok(existsSync(join(root,path)),path)
})
test('built native runtime does not leave a private schema import unresolved',()=>{
 for(const file of readdirSync(join(root,'lib')).filter(file=>file.endsWith('.js'))){
  const code=readFileSync(join(root,'lib',file),'utf8');assert.ok(!/from\s*["']#schemastery["']/.test(code),'schema must be bundled: '+file)
 }
})
