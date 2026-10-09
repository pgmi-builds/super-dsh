import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

/** Recognize Better's password door or the native challenge, while checking API protection. */
export async function checkPairLogin(base) {
  const index = await fetch(`${base}/`, { signal: AbortSignal.timeout(10000) })
  const passwordForm = index.status === 200 && (await index.text()).includes('name="password"')
  assert.ok(passwordForm || index.status === 401, 'expected Better Dash password form or native authentication challenge')
  const api = await fetch(`${base}/api/session/list`, {
    method: 'POST', signal: AbortSignal.timeout(10000),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'pair-anonymous', method: 'session/list', payload: { args: {} } }),
  })
  assert.equal(api.status, 401, 'protected API must reject anonymous requests with 401')
  return { passwordForm, anonymousApiStatus: api.status }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await checkPairLogin(process.argv[2])))
}
