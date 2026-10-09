import type { Context } from '@deepseek-ai/cordis'
import type { HostConnectionHandle, ConnectionIndexRequest, ConnectionIndexResponse } from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'

export const PAIRING_AUTH_PATH = '/superd/pair-auth'

/** Exchange the native launch token without taking ownership of the password page. */
export function handlePairingAuth(
  request: ConnectionIndexRequest,
  response: ConnectionIndexResponse,
  connection: Pick<HostConnectionHandle, 'authorizeIndex'>,
): void {
  if (request.method !== 'GET') {
    response.writeHead(405, { allow: 'GET', 'cache-control': 'no-store' })
    response.end()
    return
  }
  const url = new URL(request.url ?? PAIRING_AUTH_PATH, 'http://dsh.invalid')
  const tokens = url.searchParams.getAll('token')
  if (tokens.length !== 1 || tokens[0] === '') {
    response.writeHead(401, { 'cache-control': 'no-store' })
    response.end()
    return
  }
  // Host headers keep native authority binding. Connection alone checks the
  // process token and signs the cookie; no credential or verifier is copied.
  if (connection.authorizeIndex({ method: 'GET', url: '/' + url.search, headers: request.headers }, response)) {
    response.writeHead(401, { 'cache-control': 'no-store' })
    response.end()
  }
}

/** Called only in ctx0's real WebServer/Connection injection scope. */
export function registerPairingAuth(ctx: Context): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: PAIRING_AUTH_PATH,
    handler: (request, response) => handlePairingAuth(request, response, ctx.connection),
  }), 'superd-hub: native pairing authentication')
}
