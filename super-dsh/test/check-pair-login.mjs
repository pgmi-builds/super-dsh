import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

/** Check password-door readiness without claiming an anonymous 200 is an authenticated app. */
export async function checkPairLogin(base) {
  const index = await fetch(`${base}/`, { signal: AbortSignal.timeout(10000) })
  assert.equal(index.status, 200, 'password door must be ready')
  assert.ok((await index.text()).includes('name="password"'), 'expected Better Dash password form')
  const api = await fetch(`${base}/api/session/list`, {
    method: 'POST', signal: AbortSignal.timeout(10000),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'pair-anonymous', method: 'session/list', payload: { args: {} } }),
  })
  assert.equal(api.status, 401, 'protected API must reject anonymous requests with 401')
  return { passwordForm: true, anonymousApiStatus: api.status }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await checkPairLogin(process.argv[2])))
}
