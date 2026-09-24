// World mux server (AW-B DL6): our own wire-compatible implementation of the
// dsh 0.1.7 Remote stream mux, bound to the ADDRESSED world's openWireStream.
// Driven here through a real HTTP upgrade + the real `ws` client, so the
// frames are verified on the wire, not just in unit form.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { WorldMuxServer } from '../dist/world-mux.js'
import WebSocket from 'ws'

const MUX_PATH = '/omp/api/remote.mux'

async function listen(mux) {
  const server = createServer()
  server.on('upgrade', (req, socket, head) => { void mux.handleUpgrade(req, socket, head) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: server.address().port }
}

function connect(port) {
  return new WebSocket(`ws://127.0.0.1:${port}${MUX_PATH}`)
}

function opened(socket) {
  return new Promise((resolve, reject) => { socket.on('open', resolve); socket.on('error', reject) })
}

function collect(socket, expected) {
  const frames = []
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${frames.length} frames`)), 3000)
    socket.on('message', (data) => {
      frames.push(JSON.parse(String(data)))
      if (frames.length >= expected) { clearTimeout(timer); resolve(frames) }
    })
    socket.on('error', reject)
  })
}

test('open streams items and a terminal end frame', async () => {
  const openedArgs = []
  const mux = new WorldMuxServer(async (endpoint, payload, uplink, control) => {
    openedArgs.push({ endpoint, payload, uplink, control })
    return (async function*() { yield { a: 1 }; yield { a: 2 } })()
  })
  const { server, port } = await listen(mux)
  const socket = connect(port)
  await opened(socket)
  const frames = collect(socket, 3)
  socket.send(JSON.stringify({ type: 'open', streamId: 's1', endpoint: '$events', payload: {} }))
  const got = await frames
  assert.deepEqual(openedArgs[0].endpoint, '$events')
  assert.equal(typeof openedArgs[0].uplink[Symbol.asyncIterator], 'function', 'uplink iterable reaches the world')
  assert.equal(typeof openedArgs[0].control.abort, 'function', 'stream controller reaches the world')
  assert.deepEqual(got, [
    { type: 'item', streamId: 's1', value: { a: 1 } },
    { type: 'item', streamId: 's1', value: { a: 2 } },
    { type: 'end', streamId: 's1' },
  ])
  socket.close()
  await mux.close()
  server.close()
})

test('uplink items and end flow into the world stream (0.1.7 client uplink)', async () => {
  const received = []
  let halfClosed = false
  const mux = new WorldMuxServer(async (endpoint, payload, uplink) => {
    for await (const item of uplink) received.push(item)
    halfClosed = true
    return (async function*() { yield { echoed: received.length } })()
  })
  const { server, port } = await listen(mux)
  const socket = connect(port)
  await opened(socket)
  const frames = collect(socket, 2)
  socket.send(JSON.stringify({ type: 'open', streamId: 'u1', endpoint: 'uplink/echo', payload: {} }))
  socket.send(JSON.stringify({ type: 'item', streamId: 'u1', value: 'one' }))
  socket.send(JSON.stringify({ type: 'item', streamId: 'u1' }))
  socket.send(JSON.stringify({ type: 'item', streamId: 'u1', value: { two: 2 } }))
  socket.send(JSON.stringify({ type: 'end', streamId: 'u1' }))
  const got = await frames
  assert.deepEqual(received, ['one', undefined, { two: 2 }], 'every uplink item, value-less included')
  assert.equal(halfClosed, true, 'the end frame half-closes the uplink')
  assert.deepEqual(got, [
    { type: 'item', streamId: 'u1', value: { echoed: 3 } },
    { type: 'end', streamId: 'u1' },
  ])
  socket.close()
  await mux.close()
  server.close()
})

test('a world stream that never reads the uplink settles cleanly', async () => {
  const mux = new WorldMuxServer(async (endpoint, payload, uplink) => {
    // releaseUplink parity: a stream that reads no uplink just returns
    void uplink
    return (async function*() { yield 'down' })()
  })
  const { server, port } = await listen(mux)
  const socket = connect(port)
  await opened(socket)
  const frames = collect(socket, 2)
  socket.send(JSON.stringify({ type: 'open', streamId: 'u2', endpoint: '$events', payload: {} }))
  socket.send(JSON.stringify({ type: 'item', streamId: 'u2', value: 'dropped' }))
  socket.send(JSON.stringify({ type: 'end', streamId: 'u2' }))
  const got = await frames
  assert.deepEqual(got, [
    { type: 'item', streamId: 'u2', value: 'down' },
    { type: 'end', streamId: 'u2' },
  ])
  socket.close()
  await mux.close()
  server.close()
})

test('uplink frames for a settled stream are dropped, not fatal', async () => {
  const mux = new WorldMuxServer(async () => (async function*() { yield 1 })())
  const { server, port } = await listen(mux)
  const socket = connect(port)
  await opened(socket)
  const frames = collect(socket, 2)
  socket.send(JSON.stringify({ type: 'open', streamId: 'u3', endpoint: 'x/y', payload: {} }))
  await frames
  // the stream has settled and left the table; late frames must not close the socket
  socket.send(JSON.stringify({ type: 'item', streamId: 'u3', value: 'late' }))
  socket.send(JSON.stringify({ type: 'end', streamId: 'u3' }))
  socket.send(JSON.stringify({ type: 'cancel', streamId: 'u3' }))
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(socket.readyState, WebSocket.OPEN, 'socket survives late frames')
  socket.close()
  await mux.close()
  server.close()
})

test('an uplink item after end fails the stream with gateway/protocol', async () => {
  const mux = new WorldMuxServer(async (endpoint, payload, uplink) => {
    // consume the uplink so the violation reaches a pending read
    void uplink
    return (async function*() { await new Promise((resolve) => setTimeout(resolve, 120)); yield 'late-down' })()
  })
  const { server, port } = await listen(mux)
  const socket = connect(port)
  await opened(socket)
  const frames = collect(socket, 2)
  socket.send(JSON.stringify({ type: 'open', streamId: 'u4', endpoint: 'x/y', payload: {} }))
  socket.send(JSON.stringify({ type: 'end', streamId: 'u4' }))
  socket.send(JSON.stringify({ type: 'item', streamId: 'u4', value: 'after-end' }))
  const got = await frames
  const failure = got.find((f) => f.type === 'error')
  assert.ok(failure !== undefined, 'an error frame terminates the stream')
  assert.equal(failure.error.code, 'gateway/protocol')
  socket.close()
  await mux.close()
  server.close()
})

test('uplink overflow fails the stream with gateway/uplink-overflow', async () => {
  const mux = new WorldMuxServer(async (endpoint, payload, uplink) => {
    void uplink
    return (async function*() { await new Promise((resolve) => setTimeout(resolve, 120)); yield 'never' })()
  }, { streamInboxBytes: 16 })
  const { server, port } = await listen(mux)
  const socket = connect(port)
  await opened(socket)
  const frames = collect(socket, 2)
  socket.send(JSON.stringify({ type: 'open', streamId: 'u5', endpoint: 'x/y', payload: {} }))
  socket.send(JSON.stringify({ type: 'item', streamId: 'u5', value: 'x'.repeat(64) }))
  const got = await frames
  const failure = got.find((f) => f.type === 'error')
  assert.ok(failure !== undefined, 'an error frame terminates the stream')
  assert.equal(failure.error.code, 'gateway/uplink-overflow')
  socket.close()
  await mux.close()
  server.close()
})

test('cancel aborts the world stream and emits no terminal frame', async () => {
  let aborted = false
  const mux = new WorldMuxServer(async (endpoint, payload, uplink, control) => {
    void uplink
    return (async function*() {
      try {
        yield 'first'
        await new Promise((resolve) => setTimeout(resolve, 50))
        yield 'second'
      } finally {
        aborted = control.signal.aborted
      }
    })()
  })
  const { server, port } = await listen(mux)
  const socket = connect(port)
  await opened(socket)
  const first = collect(socket, 1)
  socket.send(JSON.stringify({ type: 'open', streamId: 's2', endpoint: '$events', payload: {} }))
  await first
  socket.send(JSON.stringify({ type: 'cancel', streamId: 's2' }))
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(aborted, true, 'the world stream observes cancellation')
  socket.close()
  await mux.close()
  server.close()
})

test('a failing world stream answers one error frame with the mapped failure', async () => {
  const mux = new WorldMuxServer(async () => {
    throw Object.assign(new Error('no such endpoint'), { code: 'gateway/invocation-unavailable' })
  })
  const { server, port } = await listen(mux)
  const socket = connect(port)
  await opened(socket)
  const frames = collect(socket, 1)
  socket.send(JSON.stringify({ type: 'open', streamId: 's3', endpoint: 'nope', payload: {} }))
  const [frame] = await frames
  assert.equal(frame.type, 'error')
  assert.equal(frame.streamId, 's3')
  assert.equal(frame.error.code, 'gateway/invocation-unavailable')
  assert.deepEqual(frame.error.details, {})
  socket.close()
  await mux.close()
  server.close()
})

test('a malformed frame closes the socket with 1008 and no world call', async () => {
  let calls = 0
  const mux = new WorldMuxServer(async () => { calls += 1; return (async function*() { })() })
  const { server, port } = await listen(mux)
  const socket = connect(port)
  await opened(socket)
  const closed = new Promise((resolve) => socket.on('close', (code) => resolve(code)))
  socket.send(JSON.stringify({ type: 'open', streamId: 's4' }))
  const code = await closed
  assert.equal(code, 1008)
  assert.equal(calls, 0)
  await mux.close()
  server.close()
})

test('a duplicate open closes the socket with 1008', async () => {
  const mux = new WorldMuxServer(async () => (async function*() { await new Promise((resolve) => setTimeout(resolve, 80)); yield 1 })())
  const { server, port } = await listen(mux)
  const socket = connect(port)
  await opened(socket)
  const closed = new Promise((resolve) => socket.on('close', (code) => resolve(code)))
  socket.send(JSON.stringify({ type: 'open', streamId: 's5', endpoint: 'x/y', payload: {} }))
  socket.send(JSON.stringify({ type: 'open', streamId: 's5', endpoint: 'x/y', payload: {} }))
  const code = await closed
  assert.equal(code, 1008)
  socket.close()
  await mux.close()
  server.close()
})
