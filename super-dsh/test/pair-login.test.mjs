import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { checkPairLogin } from './check-pair-login.mjs'

async function withServer(apiStatus, run) {
  const server = createServer((request, response) => {
    if (request.url === '/') response.end('<form method="post" action="/"><input name="password" type="password"></form>')
    else { response.writeHead(apiStatus); response.end('{}') }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try { await run(`http://127.0.0.1:${server.address().port}`) }
  finally { await new Promise(resolve => server.close(resolve)) }
}
test('login form 200 is readiness only; protected API must reject anonymous requests', async () => {
  await withServer(401, async base => {
    assert.deepEqual(await checkPairLogin(base), { passwordForm: true, anonymousApiStatus: 401 })
  })
})
test('does not accept an unprotected API just because the login form is 200', async () => {
  await withServer(200, base => assert.rejects(checkPairLogin(base), /401/))
})
