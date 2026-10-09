import test from 'node:test'
import assert from 'node:assert/strict'
import { handlePairingAuth, PAIRING_AUTH_PATH } from '../dist/pairing-auth.js'
import { mintCookie } from '../dist/mesh-link.js'

test('dedicated pairing auth delegates the token and original authority to native Connection', () => {
  const req={method:'GET',url:PAIRING_AUTH_PATH+'?token=T',headers:{host:'peer:4999'}}
  const response={writeHead(){assert.fail('delegate owns response')},end(){assert.fail('delegate owns response')}}
  let called=false
  handlePairingAuth(req,response,{authorizeIndex(input,res){called=true;assert.equal(input.url,'/?token=T');assert.equal(input.headers,req.headers);assert.equal(res,response);return false}})
  assert.ok(called)
})

test('dedicated auth rejects non-token requests before any delegation', () => {
  for(const [method,url,status] of [['POST',PAIRING_AUTH_PATH+'?token=T',405],['GET',PAIRING_AUTH_PATH,401],['GET',PAIRING_AUTH_PATH+'?token=',401],['GET',PAIRING_AUTH_PATH+'?token=T&token=T',401]]){
    let actual
    handlePairingAuth({method,url,headers:{}},{writeHead(status){actual=status},end(){}},{authorizeIndex(){assert.fail('no valid token input')}})
    assert.equal(actual,status)
  }
})

test('mint falls back to dedicated auth when the root is a password page', async () => {
  const calls=[]
  const cookie=await mintCookie('http://peer','T',async url=>{
    calls.push(url)
    return calls.length===1 ? new Response('<form>password</form>') : new Response(null,{status:303,headers:{'set-cookie':'dsh-auth-x=ok; Path=/'}})
  })
  assert.equal(cookie,'dsh-auth-x=ok')
  assert.deepEqual(calls,['http://peer/?token=T','http://peer'+PAIRING_AUTH_PATH+'?token=T'])
})
