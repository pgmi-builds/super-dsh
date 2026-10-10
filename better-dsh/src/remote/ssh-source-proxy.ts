import { createConnection, type Socket } from 'node:net'
import type { Writable } from 'node:stream'
import { startBinaryProcess } from './process.ts'

/** One sequential connection at a time; all queues bounded independently of file size.
 * This helper is a child of native-command, never an independently owned daemon. */
export const SOURCE_PROXY_HELPER = String.raw`import json,os,select,signal,socket,struct,sys,time
port=int(sys.argv[1]);MAX=65536;CAP=262144
stopped=False
def stop(sig,frame):
    global stopped
    stopped=True
for sig in (signal.SIGTERM,signal.SIGHUP,signal.SIGINT):signal.signal(sig,stop)
for fd in (0,1,2):os.set_blocking(fd,False)
listener=socket.socket();listener.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
client=None;probe=None;incoming=bytearray();out=bytearray();pending=bytearray()
read_end=False;write_end=False;shutdown=False;verified=False;ready=False;greeting=bytearray()
def frame(kind,data=b''):
    if len(data)>MAX or len(out)+len(data)+5>CAP:raise RuntimeError('source proxy output bound')
    out.extend(struct.pack('!BI',kind,len(data)));out.extend(data)
try:
    listener.bind(('127.0.0.1',port));listener.listen(1);listener.setblocking(False)
    # An internal client traverses this exact listener, SSH stream and destination-L.
    probe=socket.create_connection(('127.0.0.1',port),timeout=2);probe.setblocking(False)
    deadline=time.monotonic()+10
    while not stopped:
        if not ready and time.monotonic()>deadline:raise RuntimeError('source proxy @RSYNCD greeting timeout')
        # Parse at most one bounded data frame ahead of the destination writer.
        while len(incoming)>=5:
            kind,size=struct.unpack('!BI',incoming[:5])
            if size>MAX or kind not in (2,3) or (kind==3 and size):raise RuntimeError('invalid source proxy frame')
            if len(incoming)<5+size or len(pending)+size>CAP:break
            if client is None:raise RuntimeError('source proxy frame without connection')
            data=bytes(incoming[5:5+size]);del incoming[:5+size]
            if kind==2:
                if write_end:raise RuntimeError('source proxy data after EOF')
                pending.extend(data)
            else:write_end=True
        if client is not None and write_end and not pending and not shutdown:
            client.shutdown(socket.SHUT_WR);shutdown=True
        if client is not None and read_end and shutdown and not pending and len(out)+5<=CAP:
            client.close();client=None;frame(4)
            if verified and not ready:
                os.write(2,b'SOURCE_PROXY_READY\n');ready=True
        readers=[];writers=[]
        if len(incoming)<MAX+5 and len(pending)<=CAP-MAX:readers.append(0)
        if out:writers.append(1)
        if client is None and len(out)<=CAP-5:readers.append(listener)
        if client is not None:
            if not read_end and len(out)<=CAP-MAX-5:readers.append(client)
            if pending:writers.append(client)
        if probe is not None:readers.append(probe)
        r,w,_=select.select(readers,writers,[],.05)
        if 0 in r:
            data=os.read(0,MAX+5-len(incoming))
            if not data:break
            incoming.extend(data)
        if 1 in w:
            n=os.write(1,out);del out[:n]
        if listener in r:
            client,_=listener.accept();client.setblocking(False)
            read_end=False;write_end=False;shutdown=False;frame(1)
        if client is not None and client in r:
            data=client.recv(MAX)
            if data:frame(2,data)
            else:read_end=True;frame(3)
        if client is not None and client in w:
            n=client.send(pending);del pending[:n]
        if probe is not None and probe in r:
            data=probe.recv(1024-len(greeting))
            if not data:raise RuntimeError('source proxy missing @RSYNCD greeting')
            greeting.extend(data)
            if b'\n' in greeting:
                if not greeting.startswith(b'@RSYNCD: '):raise RuntimeError('source proxy invalid @RSYNCD greeting')
                verified=True;probe.close();probe=None
            elif len(greeting)>=1024:raise RuntimeError('source proxy greeting exceeds bound')
finally:
    for item in (probe,client,listener):
        if item is not None:item.close()
`

const MAX = 65536
function write(stream: Writable, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => { stream.write(data, error => error ? reject(error) : resolve()) })
}
/** Origin-only bytes bridge. Local teardown is a resource barrier, not receiving proof. */
export function startSourceProxy(argv: string[], destinationPort: number, signal: AbortSignal) {
  signal.throwIfAborted()
  const child = startBinaryProcess(argv)
  let socket: Socket | undefined, socketReader: Promise<void> | undefined
  let closing = false, stderr = '', readyResolve!: () => void, readyReject!: (e: unknown) => void, fail!: (e: unknown) => void
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  const failed = new Promise<never>((_, reject) => { fail = reject })
  void failed.catch(() => {})
  const failure = (error: unknown, stage = 'bridge') => { if (!closing) { const detail = new Error(`source proxy ${stage}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });readyReject(detail);fail(detail) } }
  child.stderr.setEncoding('utf8');child.stderr.on('data', (data: string) => {
    stderr = (stderr + data).slice(-2 * 1024 * 1024)
    if (stderr.includes('SOURCE_PROXY_READY\n')) readyResolve()
  })
  const send = async (kind: number, data: Buffer = Buffer.alloc(0)) => {
    const header = Buffer.alloc(5);header[0] = kind;header.writeUInt32BE(data.length, 1)
    await write(child.stdin, Buffer.concat([header, data]))
  }
  const pump = (async () => {
    let input = Buffer.alloc(0)
    for await (const chunk of child.stdout) {
      input = Buffer.concat([input, chunk as Buffer])
      while (input.length >= 5) {
        const kind = input[0]!, size = input.readUInt32BE(1)
        if (size > MAX || ![1,2,3,4].includes(kind) || (kind !== 2 && size)) throw new Error('invalid source proxy frame')
        if (input.length < size + 5) break
        const data = input.subarray(5, size + 5);input = input.subarray(size + 5)
        if (kind === 1) {
          if (socket) throw new Error('source proxy overlapping connection')
          const active = createConnection({ host: '127.0.0.1', port: destinationPort, allowHalfOpen: true });socket = active
          // Attach immediately; even a refused connect must never become unhandled.
          active.on('error', error => failure(error, 'destination socket'))
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => { active.destroy(new Error('source proxy destination connect timeout')) }, 5000)
            active.once('connect', () => { clearTimeout(timer);resolve() });active.once('error', error => { clearTimeout(timer);reject(error) })
          })
          // Read EOF is only a half-close: retain the writable side until peer EOF/CLOSE.
          socketReader = (async () => { for await (const bytes of active.iterator({ destroyOnReturn: false })) { const data = bytes as Buffer;for (let i = 0; i < data.length; i += MAX) await send(2, data.subarray(i, i + MAX)) };await send(3) })()
          void socketReader.catch(error => failure(error, 'destination reader'))
        } else {
          if (!socket) throw new Error('source proxy frame without socket')
          if (kind === 2) await write(socket, data)
          else if (kind === 3) socket.end()
          else {
            const previous = socket
            const closed = previous.closed ? Promise.resolve() : new Promise<void>(resolve => previous.once('close', () => resolve()))
            await socketReader;previous.destroy();await closed;socket = undefined;socketReader = undefined
          }
        }
      }
      if (input.length > MAX + 5) throw new Error('source proxy input bound')
    }
    if (input.length) throw new Error('truncated source proxy frame')
  })()
  void pump.catch(error => failure(error, 'source frame reader'))
  void child.done.then(result => failure(new Error(`source proxy closed: exit ${result.exit}; ${stderr || child.diagnostic() || 'no greeting'}`)))
  const abort = () => { socket?.destroy();child.stdin.destroy();failure(signal.reason) }
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  let closePromise: Promise<void> | undefined
  const close = () => closePromise ??= (async () => {
    closing = true;signal.removeEventListener('abort', abort)
    const active = socket
    const socketClosed = active && !active.closed ? new Promise<void>(resolve => active.once('close', () => resolve())) : Promise.resolve()
    active?.destroy();child.stdin.destroy();child.stdout.destroy();child.cancel()
    await Promise.allSettled([pump, socketReader, socketClosed, child.done])
  })()
  return { ready, failed, close, stderr: () => stderr }
}
