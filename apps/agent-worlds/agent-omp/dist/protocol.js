/**
 * omp-web sidecar protocol (v0).
 *
 * Transport: JSON lines over stdio of the bun sidecar process.
 *  - Node → sidecar: request  frame  { id, method, params }
 *  - sidecar → Node: response frame  { id, ok: true, result } | { id, ok: false, error }
 *  - sidecar → Node: event     frame  { event: "<channel>", sessionId?, payload }
 *  - Node → sidecar: notification    { method, params }  (no id, no response — e.g. session.prompt cancel is out of band via abort)
 *
 * Handshake: on start the sidecar pushes { event: "ready", payload: { protocol: 0, sdk: <version> } }.
 * Every request gets exactly one response, in any order (correlate by id).
 */
export const PROTOCOL_VERSION = 0;
