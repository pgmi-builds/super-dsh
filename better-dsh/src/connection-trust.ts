import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'

/**
 * Use the native index authenticator as a cookie-only admission delegate.
 * A fixed, query-free index path prevents token exchange or redirects here;
 * original Host and Cookie headers preserve the native authority binding and
 * lifetime. No upstream private fields or cookie-format copies are needed.
 *
 * 0.2.1: the fence core is `admit()` — the HTTP bridge calls it directly and
 * `requestRejection()` is a thin wrapper over it, so overriding the public
 * `admit` is the one seam that still steers both paths. A fence rejection
 * (403) is retried as cookie-only admission; every other verdict (a live
 * peer, 401 from failed native authentication, disposed) passes through
 * untouched. An accepted cookie admits as the shared browser peer — the same
 * scope native browser authentication grants.
 */
export function installAuthenticationOnlyAdmission(connection: HostConnectionHandle): () => void {
  const original = connection.admit
  const response = { writeHead() { }, end() { } }
  connection.admit = (request) => {
    const admission = original.call(connection, request)
    if (!('rejection' in admission) || admission.rejection !== 403) return admission
    return connection.authorizeIndex({
      headers: request.headers,
      method: 'GET',
      url: '/index.html',
    }, response) ? { peer: connection.browserPeer } : { rejection: 401 }
  }
  return () => { connection.admit = original }
}
