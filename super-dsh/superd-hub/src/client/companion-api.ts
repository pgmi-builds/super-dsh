/** Local ctx0 companion management, independent of the selected agent world. */
import {mintRpcId, type FetchLike} from './runtime-settings-api.js'
import type {BetterDashStatus} from '../companion-contract.js'

export type CompanionOperation = 'getBetterDash' | 'installBetterDash'

export async function callCompanion(operation: CompanionOperation, doFetch?: FetchLike): Promise<BetterDashStatus> {
  const method = `superdCompanions/${operation}`
  const send: FetchLike = doFetch ?? ((path, init) => fetch(path, init))
  const response = await send(`/api/${method}`, {
    method: 'POST', credentials: 'same-origin', headers: {'content-type': 'application/json'},
    body: JSON.stringify({type: 'client-request', rpcId: mintRpcId(), method, payload: {args: {}}}),
  })
  if (!response.ok) throw new Error(`Better Dash: HTTP ${response.status}`)
  let body: unknown
  try {body = JSON.parse(await response.text())} catch {throw new Error('Better Dash: unreadable response')}
  const result = (body as {result?: {ok?: boolean; value?: unknown; error?: {message?: string}}} | null)?.result
  if (result?.ok !== true) throw new Error(result?.error?.message ?? 'Better Dash: request failed')
  const value = result.value as Partial<BetterDashStatus> | null
  if (value === null || typeof value !== 'object' || typeof value.installed !== 'boolean'
      || typeof value.installing !== 'boolean' || typeof value.requestedVersion !== 'string'
      || (value.version !== undefined && typeof value.version !== 'string')
      || (value.enabled !== undefined && typeof value.enabled !== 'boolean')
      || (value.error !== undefined && typeof value.error !== 'string')) throw new Error('Better Dash: invalid status')
  return value as BetterDashStatus
}
