// MuxClient (machine-mesh P2 Task 1): the client half of the wire protocol
// `src/world-mux.ts` documents — open/item/end/cancel toward the server,
// item/end/error back, JSON `ping` answered with `pong`, liveness decided by
// received frames (2 heartbeat periods of silence → close).
//
// Everything runs against a fake socket (array-driven inbound, captured
// outbound) — no network, no `ws`. Wire compatibility is pinned the hard way:
// every stream frame the client sends must parse through the server's own
// `parseClientMessage`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { MuxClient, MuxClientError } from '../dist/mux-client.js'
import { parseClientMessage } from '../dist/world-mux.js'

/** Fake socket: captured sends, scripted receives, close accounting. */
function fakeSocket() {
  const sent = []
  const messageCbs = new Set()
  const closeCbs = new Set()
  const socket = {
    sent,
    closeCount: 0,
    send: (data) => { sent.push(data) },
    onMessage: (cb) => { messageCbs.add(cb) },
    onClose: (cb) => { closeCbs.add(cb) },
    close: () => {
      socket.closeCount += 1
      if (socket.closeCount > 1) return
      messageCbs.clear()
      for (const cb of [...closeCbs]) cb()
    },
  }
  return {
    socket,
    /** Feed one server frame (object or raw string) into the client. */
    receive: (frame) => {
      const data = typeof frame === 'string' ? frame : JSON.stringify(frame)
      for (const cb of [...messageCbs]) cb(data)
    },
  }
}

/** Parsed outbound frames so far. */
function framesOf(fake) {
  return fake.socket.sent.map((text) => JSON.parse(text))
}

/** Every client stream frame must survive the server's own parser. */
function assertWireCompatible(fake) {
  for (const text of fake.socket.sent) {
    const parsed = JSON.parse(text)
    if (parsed.type === 'pong') continue // control reply, not a stream frame
    assert.doesNotThrow(() => parseClientMessage(text), `frame rejected by server parser: ${text}`)
  }
}

async function drain(iterable) {
  const values = []
  for await (const value of iterable) values.push(value)
  return values
}

async function captureRejection(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  assert.fail('expected the promise to reject')
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('open streams items; server end drains then terminates items', async () => {
  const fake = fakeSocket()
  const client = new MuxClient(fake.socket)
  const handle = client.openStream('$events', { world: 'omp' })
  assert.deepEqual(framesOf(fake), [
    { type: 'open', streamId: '1', endpoint: '$events', payload: { world: 'omp' } },
  ], 'open carries the endpoint and payload; the wire id is the stringified counter')

  fake.receive({ type: 'item', streamId: '1', value: { a: 1 } })
  fake.receive({ type: 'item', streamId: '1', value: { a: 2 } })
  fake.receive({ type: 'end', streamId: '1' })
  assert.deepEqual(await drain(handle.items), [{ a: 1 }, { a: 2 }], 'queued items drain in order')
  const iterator = handle.items[Symbol.asyncIterator]()
  assert.deepEqual(await iterator.next(), { value: undefined, done: true }, 'items stays done after end')
  assertWireCompatible(fake)
  client.dispose()
})

test('multiplexed streams route by streamId with distinct auto ids', async () => {
  const fake = fakeSocket()
  const client = new MuxClient(fake.socket)
  const one = client.openStream('ep/one', 1)
  const two = client.openStream('ep/two', 2)
  assert.deepEqual(framesOf(fake).map((f) => f.streamId), ['1', '2'], 'ids are a monotonic counter, never reused')

  fake.receive({ type: 'item', streamId: '2', value: 'two-first' })
  fake.receive({ type: 'item', streamId: '1', value: 'one-first' })
  fake.receive({ type: 'end', streamId: '2' })
  fake.receive({ type: 'item', streamId: '1', value: 'one-last' })
  fake.receive({ type: 'end', streamId: '1' })
  assert.deepEqual(await drain(one.items), ['one-first', 'one-last'])
  assert.deepEqual(await drain(two.items), ['two-first'])
  client.dispose()
})

test('upstream pushes send item frames immediately, one per read, no buffering', async () => {
  const fake = fakeSocket()
  const client = new MuxClient(fake.socket)
  const handle = client.openStream('uplink/echo', null)
  const push = handle.upstream[Symbol.asyncIterator]()

  const first = await push.next('u1')
  assert.deepEqual(first, { value: undefined, done: false })
  assert.deepEqual(framesOf(fake).at(-1), { type: 'item', streamId: '1', value: 'u1' }, 'the send happened by the time next() resolved — zero queueing')

  await push.next({ two: 2 })
  assert.deepEqual(framesOf(fake).at(-1), { type: 'item', streamId: '1', value: { two: 2 } })
  await push.next() // value-less push = undefined item on the wire
  assert.deepEqual(framesOf(fake).at(-1), { type: 'item', streamId: '1' }, 'JSON has no undefined: the value key is omitted')

  handle.end()
  handle.end()
  assert.equal(framesOf(fake).filter((f) => f.type === 'end').length, 1, 'end half-closes once, idempotent')
  assert.deepEqual(framesOf(fake).filter((f) => f.type !== 'open'), [
    { type: 'item', streamId: '1', value: 'u1' },
    { type: 'item', streamId: '1', value: { two: 2 } },
    { type: 'item', streamId: '1' },
    { type: 'end', streamId: '1' },
  ])
  assertWireCompatible(fake)

  const after = await push.next('late')
  assert.deepEqual(after, { value: undefined, done: true }, 'the uplink channel is done after end; late pushes send nothing')
  assert.equal(fake.socket.sent.length, 5)
  client.dispose()
})

test('a server error frame throws the wire failure out of items (drain, then throw)', async () => {
  const fake = fakeSocket()
  const client = new MuxClient(fake.socket)
  const handle = client.openStream('ep', {})
  fake.receive({ type: 'item', streamId: '1', value: 'kept' })
  fake.receive({ type: 'item', streamId: '1', value: 'dropped' })
  fake.receive({
    type: 'error',
    streamId: '1',
    error: { code: 'gateway/stream-error', message: 'boom', details: { cause: 'test' } },
  })

  // Pinned delivery semantics (the brief allowed a {muxError} tail item OR a
  // throw; this pins THROW): items received before the error frame are
  // delivered in order, then the iterable throws the wire failure.
  const collected = []
  const error = await captureRejection((async () => {
    for await (const value of handle.items) collected.push(value)
  })())
  assert.ok(error instanceof MuxClientError)
  assert.equal(error.code, 'gateway/stream-error')
  assert.equal(error.message, 'boom')
  assert.deepEqual(error.details, { cause: 'test' })
  assert.deepEqual(collected, ['kept', 'dropped'])

  const iterator = handle.items[Symbol.asyncIterator]()
  assert.deepEqual(await iterator.next(), { value: undefined, done: true }, 'after the throw the iterable is done')
  client.dispose()
})

test('error frame after items already yielded: consumer saw the items before the throw', async () => {
  const fake = fakeSocket()
  const client = new MuxClient(fake.socket)
  const handle = client.openStream('ep', {})
  const seen = []
  const failing = (async () => {
    for await (const value of handle.items) seen.push(value)
  })()
  fake.receive({ type: 'item', streamId: '1', value: 'before-error' })
  fake.receive({ type: 'error', streamId: '1', error: { code: 'x/fail', message: 'nope', details: {} } })
  const error = await captureRejection(failing)
  assert.deepEqual(seen, ['before-error'], 'items yielded before the error frame are delivered, then the iterable throws')
  assert.equal(error.code, 'x/fail')
  client.dispose()
})

test('late frames for retired or unknown streams are silently dropped', async () => {
  const fake = fakeSocket()
  const client = new MuxClient(fake.socket)
  const handle = client.openStream('ep', {})
  fake.receive({ type: 'end', streamId: '1' })
  assert.deepEqual(await drain(handle.items), [])
  const sentBefore = fake.socket.sent.length

  fake.receive({ type: 'item', streamId: '1', value: 'late' })
  fake.receive({ type: 'end', streamId: '1' })
  fake.receive({ type: 'error', streamId: '1', error: { code: 'x', message: 'x', details: {} } })
  fake.receive({ type: 'item', streamId: '999', value: 'never-opened' })
  fake.receive({ type: 'end', streamId: '999' })
  assert.equal(fake.socket.sent.length, sentBefore, 'dropped frames provoke no sends and no throws')
  assert.equal(fake.socket.closeCount, 0, 'and no socket close')
  client.dispose()
})

test('cancel sends one cancel frame and retires the stream locally', async () => {
  const fake = fakeSocket()
  const client = new MuxClient(fake.socket)
  const handle = client.openStream('ep', {})
  fake.receive({ type: 'item', streamId: '1', value: 'queued' })
  handle.cancel()
  handle.cancel()
  assert.deepEqual(framesOf(fake).filter((f) => f.type === 'cancel'), [{ type: 'cancel', streamId: '1' }])

  assert.deepEqual(await drain(handle.items), [], 'cancel drops queued items and ends items immediately')
  fake.receive({ type: 'item', streamId: '1', value: 'late' })
  fake.receive({ type: 'end', streamId: '1' })
  assert.equal(fake.socket.closeCount, 0)
  assertWireCompatible(fake)
  client.dispose()
})

test('a server ping frame is answered with pong immediately', async () => {
  const fake = fakeSocket()
  const client = new MuxClient(fake.socket)
  fake.receive({ type: 'ping' })
  fake.receive({ type: 'ping' })
  assert.deepEqual(framesOf(fake), [{ type: 'pong' }, { type: 'pong' }])
  client.dispose()
})

test('two heartbeat periods with no received frames close the socket and fail live streams', async () => {
  const fake = fakeSocket()
  const client = new MuxClient(fake.socket, { heartbeatIntervalMs: 50 })
  const handle = client.openStream('ep', {})
  fake.receive({ type: 'item', streamId: '1', value: 1 })

  // Frames keep arriving inside the window → stays open.
  for (let i = 0; i < 6; i += 1) {
    await delay(30)
    fake.receive({ type: 'ping' })
  }
  assert.equal(fake.socket.closeCount, 0, 'received frames reset the silence watchdog')

  // Silence for 2 × interval → the client closes and fails the stream.
  const error = await captureRejection(drain(handle.items))
  assert.ok(error instanceof MuxClientError)
  assert.equal(error.code, 'gateway/heartbeat-silence')
  assert.ok(fake.socket.closeCount >= 1, 'the watchdog closed the socket')
})

test('an out-of-protocol server frame closes the socket (1008 mirror)', async () => {
  const fake = fakeSocket()
  const client = new MuxClient(fake.socket)
  const handle = client.openStream('ep', {})
  fake.receive({ type: 'open', streamId: '1', endpoint: 'evil', payload: {} })
  const error = await captureRejection(drain(handle.items))
  assert.ok(error instanceof MuxClientError)
  assert.equal(error.code, 'gateway/protocol')
  assert.equal(fake.socket.closeCount, 1)
})

test('a malformed server frame closes the socket', async () => {
  const fake = fakeSocket()
  const client = new MuxClient(fake.socket)
  fake.receive('{not json')
  assert.equal(fake.socket.closeCount, 1)
  client.dispose()
})

test('dispose closes every stream and the socket exactly once; it is idempotent', async () => {
  const fake = fakeSocket()
  const client = new MuxClient(fake.socket)
  const one = client.openStream('ep/1', {})
  const two = client.openStream('ep/2', {})

  client.dispose()
  client.dispose()
  client.dispose()
  assert.equal(fake.socket.closeCount, 1, 'the socket is closed exactly once')

  const errorOne = await captureRejection(drain(one.items))
  const errorTwo = await captureRejection(drain(two.items))
  assert.equal(errorOne.code, 'gateway/disposed')
  assert.equal(errorTwo.code, 'gateway/disposed')

  one.end()
  const push = one.upstream[Symbol.asyncIterator]()
  assert.deepEqual(await push.next('x'), { value: undefined, done: true }, 'post-dispose uplink pushes are no-ops')
  assert.equal(framesOf(fake).filter((f) => f.type !== 'open').length, 0, 'no stream frames after dispose')
  assert.throws(() => client.openStream('ep/3', {}), /disposed/, 'opening after dispose fails loud')
})

test('a server-side socket close fails live streams as a wire cut', async () => {
  const fake = fakeSocket()
  const client = new MuxClient(fake.socket)
  const handle = client.openStream('ep', {})
  fake.socket.close() // the remote end hangs up
  const error = await captureRejection(drain(handle.items))
  assert.ok(error instanceof MuxClientError)
  assert.equal(error.code, 'gateway/socket-closed')
})

test('uplink half-close keeps the downlink live until the server ends', async () => {
  const fake = fakeSocket()
  const client = new MuxClient(fake.socket)
  const handle = client.openStream('ep', {})
  const push = handle.upstream[Symbol.asyncIterator]()
  await push.next('only')
  handle.end()

  fake.receive({ type: 'item', streamId: '1', value: 'still-live' })
  fake.receive({ type: 'end', streamId: '1' })
  assert.deepEqual(await drain(handle.items), ['still-live'], 'half-close is per-direction: downlink survives uplink end')
  client.dispose()
})
