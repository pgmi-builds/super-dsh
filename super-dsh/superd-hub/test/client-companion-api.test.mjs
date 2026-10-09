import assert from 'node:assert/strict'
import test from 'node:test'

const {callCompanion}=await import('../dist/client/companion-api.js')
const status={installed:false,installing:false,requestedVersion:'0.3.0-f'}

test('companion requests always use the local native namespace with an empty unary payload',async()=>{
 const value=await callCompanion('getBetterDash',async(path,init)=>{
  assert.equal(path,'/api/superdCompanions/getBetterDash')
  assert.equal(init.credentials,'same-origin')
  const body=JSON.parse(init.body)
  assert.equal(body.method,'superdCompanions/getBetterDash')
  assert.equal(body.type,'client-request')
  assert.deepEqual(body.payload,{args:{}})
  return {ok:true,status:200,text:async()=>JSON.stringify({rpcId:body.rpcId,result:{ok:true,value:status}})}
 })
 assert.deepEqual(value,status)
})

test('native errors and transport failures are not presented as installed',async()=>{
 await assert.rejects(callCompanion('installBetterDash',async()=>({ok:true,status:200,text:async()=>JSON.stringify({result:{ok:false,error:{message:'Installation refused'}}})})),/Installation refused/)
 await assert.rejects(callCompanion('installBetterDash',async()=>({ok:false,status:502,text:async()=>'<html>Bad gateway</html>'})),/HTTP 502/)
 await assert.rejects(callCompanion('getBetterDash',async()=>({ok:true,status:200,text:async()=>JSON.stringify({result:{ok:true,value:{installed:'yes'}}})})),/invalid status/)
})
