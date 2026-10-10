/** Independent binary lane. Task lease, not transport pong, owns native filesystem work. */
import { createRequire } from 'node:module';
import { Readable, PassThrough } from 'node:stream';
import { once } from 'node:events';
import { finished, pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBinaryProcess, PROCESS_CLEANUP_BOUND_MS, FILE_FRAME_BYTES, FILE_MAX_ENTRIES, FILE_MAX_METADATA, checkAbsolute, checkSelection, type BinaryFileEndpoint } from '../../remote/plugin.js';
import { TASK_LEASE_MS, TASK_RENEW_STEP_MS, TASK_CONTROL_TIMEOUT_MS } from './remote-job-rpc.js';
import type { PtyExecutorOptions } from './exec-pty-rpc.js';
export const FILE_IDLE_MS = 6000;
export const FILE_SOCKET_CLOSE_MS = 1000;
// Canonical group TERM/KILL/settle + socket termination + bounded, constant-count local unlink margin.
// As with the process lease, assumes the host event loop/kernel/filesystem remain schedulable.
export const FILE_CLEANUP_MS = PROCESS_CLEANUP_BOUND_MS + FILE_SOCKET_CLOSE_MS + 1000;
export const FILE_LEASE_PROTOCOL = 1;
export const REMOTE_FILE_PATH = '/api/superd/file';
interface Socket {
    readyState: number;
    on(event: string, listener: (...args: any[]) => void): this;
    once(event: string, listener: (...args: any[]) => void): this;
    send(data: string | Buffer, callback?: (error?: Error) => void): void;
    close(): void;
    terminate(): void;
}
const ws = createRequire(import.meta.url)('ws') as {
    WebSocket: new (url: string, options: unknown) => Socket;
    WebSocketServer: new (options: unknown) => {
        handleUpgrade(req: unknown, socket: unknown, head: Buffer, callback: (socket: Socket) => void): void;
        close(): void;
    };
};
const control = (socket: Socket, value: unknown) => { if (socket.readyState === 1)
    socket.send(JSON.stringify(value)); };
const raw = (data: unknown) => Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const wait = () => deferred<void>();
const send = (socket: Socket, data: Buffer | string) => new Promise<void>((resolve, reject) => socket.send(data, error => error ? reject(error) : resolve()));
async function closeSocket(socket: Socket) {
    if (socket.readyState === 3)
        return;
    const closed = new Promise<void>(resolve => socket.once('close', resolve));
    const deadline = setTimeout(() => socket.terminate(), FILE_SOCKET_CLOSE_MS);
    if (socket.readyState === 0)
        socket.terminate();
    else
        socket.close();
    try {
        await closed;
    }
    finally {
        clearTimeout(deadline);
    }
}
export async function registerRemoteFileRpc(real: {
    registerUpgrade(route: {
        path: string;
        handler: (req: unknown, socket: unknown, head: Buffer) => void;
    }): unknown;
}, opts: PtyExecutorOptions): Promise<() => Promise<void>> {
    const server = new ws.WebSocketServer({ noServer: true, maxPayload: FILE_FRAME_BYTES, perMessageDeflate: false });
    const operations = new Set<{
        stop(error: Error): void;
        done: Promise<void>;
    }>();
    let disposed = false;
    const handler = (req: unknown, socket: unknown, head: Buffer) => {
        let status = 401;
        const allowed = opts.authorize(req, { writeHead: (code: number) => { status = code; }, end() { } });
        const rejection = disposed ? 503 : allowed ? opts.requestRejection?.(req) : status;
        if (rejection !== undefined) {
            (socket as {
                end(data: string): void;
            }).end(`HTTP/1.1 ${rejection} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
            return;
        }
        server.handleUpgrade(req, socket, head, client => {
            const abort = new AbortController(), complete = wait(), input = new PassThrough({ highWaterMark: FILE_FRAME_BYTES });
            input.on('error', () => { });
            let token = randomUUID(), expires = performance.now() + TASK_LEASE_MS, leaseTimer: NodeJS.Timeout, idleTimer: NodeJS.Timeout | undefined;
            let failureCloseTimer: NodeJS.Timeout | undefined;
            let request: {
                action: 'export' | 'import' | 'digest';
                path: string;
                mkdir: boolean;
                selected: boolean;
            } | undefined;
            const selection: string[] = [];
            let metadata = 0, started = false, writing = false, ended = false, finalizing = false, ack: ReturnType<typeof wait> | undefined;
            let worker: ReturnType<typeof startBinaryProcess> | undefined, root: string | undefined, workerError: string | undefined;
            const temporaries = new Set<string>();
            const finalize = async (result: Record<string, unknown>) => {
                if (finalizing)
                    return;
                finalizing = true;
                clearTimeout(leaseTimer);
                clearTimeout(idleTimer);
                input.destroy();
                worker?.cancel();
                await worker?.done;
                // Worker stderr is drained before child close/done: all created temporary paths are known.
                let cleaned = true;
                try {
                    for (const path of temporaries)
                        rmSync(path, { force: true });
                    if (root)
                        rmSync(root, { recursive: true, force: true });
                }
                catch (error) {
                    cleaned = false;
                    result = { op: 'error', error: `file receiver cleanup failed: ${String(error)}` };
                }
                // Terminal ACK follows worker/FD/temp cleanup. Closing socket is also owned, with a fixed bound.
                const closing = setTimeout(() => client.terminate(), FILE_SOCKET_CLOSE_MS);
                try {
                    if (client.readyState === 1)
                        await send(client, JSON.stringify({ ...result, cleaned })).catch(() => { });
                    await closeSocket(client);
                }
                finally {
                    clearTimeout(closing);
                    clearTimeout(failureCloseTimer);
                    operations.delete(operation);
                    complete.resolve();
                }
            };
            const fail = (error: unknown) => {
                // A pending WS send can be backpressured even after worker/ACK cancellation.
                // Arm transport termination here, independently of run/finalize unwinding.
                // Reuse the existing socket bound; worker/FD/temp completion still owns done.
                if (client.readyState !== 3)
                    failureCloseTimer ??= setTimeout(() => client.terminate(), FILE_SOCKET_CLOSE_MS);
                if (!abort.signal.aborted)
                    abort.abort(error);
                input.destroy(error instanceof Error ? error : new Error(String(error)));
                ack?.reject(error);
                worker?.cancel();
                if (!started)
                    void finalize({ op: 'error', error: String(error) });
            };
            const operation = { stop: fail, done: complete.promise };
            operations.add(operation);
            const armLease = () => { clearTimeout(leaseTimer); leaseTimer = setTimeout(() => fail(new Error('binary file task lease expired')), Math.max(0, expires - performance.now())); };
            const armIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => fail(new Error('binary file idle/ACK timeout')), FILE_IDLE_MS); };
            const lease = () => ({ protocol: FILE_LEASE_PROTOCOL, token, leaseMs: TASK_LEASE_MS, renewStepMs: TASK_RENEW_STEP_MS, cleanupMs: FILE_CLEANUP_MS });
            client.on('close', () => { if (!finalizing)
                fail(new Error('binary file peer disconnected')); });
            client.on('error', fail);
            const run = async () => {
                started = true;
                clearTimeout(idleTimer);
                let result: Record<string, unknown> = { op: 'done' };
                try {
                    abort.signal.throwIfAborted();
                    checkSelection(selection);
                    root = join(tmpdir(), `remote-file-worker-${randomUUID()}`);
                    const workerRequest = { ...request!, root };
                    // Private canonical worker leaf has Node-builtins-only imports; no host resolver exists in this owned child.
                    const script = `import {runFileWorker} from ${JSON.stringify(new URL('../../remote/file-worker.js', import.meta.url).href)}; await runFileWorker(JSON.parse(process.argv[1]));`;
                    worker = startBinaryProcess([process.execPath, '--input-type=module', '-e', script, JSON.stringify(workerRequest)]);
                    let stderr = '';
                    worker.stderr.setEncoding('utf8');
                    worker.stderr.on('data', (chunk: string) => {
                        stderr += chunk;
                        let at: number;
                        while ((at = stderr.indexOf('\n')) >= 0) {
                            const line = stderr.slice(0, at);
                            stderr = stderr.slice(at + 1);
                            try {
                                const message = JSON.parse(line);
                                if (typeof message.temporary === 'string') {
                                    if (message.active)
                                        temporaries.add(message.temporary);
                                    else
                                        temporaries.delete(message.temporary);
                                }
                                else if (typeof message.error === 'string')
                                    workerError = message.error;
                            }
                            catch {
                                workerError = line;
                            }
                        }
                        if (stderr.length > FILE_FRAME_BYTES) {
                            workerError = 'oversized worker metadata';
                            fail(new Error(workerError));
                        }
                    });
                    control(client, { op: 'ready' });
                    if (request!.action === 'import') {
                        worker.stdout.resume();
                        armIdle();
                        await pipeline(input, worker.stdin, { signal: abort.signal });
                    }
                    else {
                        worker.stdin.end(request!.action === 'digest' && request!.selected ? JSON.stringify(selection) : '');
                        let digest = '';
                        for await (const chunk of worker.stdout) {
                            if (request!.action === 'digest') {
                                digest += String(chunk);
                                if (digest.length > 8192)
                                    throw new Error('oversized digest response');
                                continue;
                            }
                            const data = raw(chunk);
                            for (let at = 0; at < data.length; at += FILE_FRAME_BYTES) {
                                abort.signal.throwIfAborted();
                                ack = wait();
                                void ack.promise.catch(() => { });
                                armIdle();
                                await send(client, data.subarray(at, at + FILE_FRAME_BYTES));
                                await ack.promise;
                                clearTimeout(idleTimer);
                                ack = undefined;
                            }
                        }
                        if (request!.action === 'digest' && digest)
                            result.digest = JSON.parse(digest);
                    }
                    const outcome = await worker.done;
                    abort.signal.throwIfAborted();
                    if (outcome.exit !== 0)
                        throw new Error(workerError ?? worker.diagnostic() ?? 'binary file worker failed');
                }
                catch (error) {
                    const reason = abort.signal.aborted ? abort.signal.reason : error;
                    result = { op: 'error', error: reason instanceof Error ? reason.message : String(reason) };
                }
                finally {
                    await finalize(result);
                }
            };
            client.on('message', (data: unknown, binary: boolean) => {
                if (abort.signal.aborted || finalizing)
                    return;
                try {
                    const bytes = raw(data);
                    if (bytes.length > FILE_FRAME_BYTES)
                        throw new Error('binary frame limit exceeded');
                    if (binary) {
                        if (!started || request?.action !== 'import' || writing || ended)
                            throw new Error('unexpected binary frame or peer exceeded ACK window');
                        writing = true;
                        armIdle();
                        void (async () => { try {
                            if (!input.write(bytes))
                                await once(input, 'drain', { signal: abort.signal });
                            writing = false;
                            control(client, { op: 'ack' });
                        }
                        catch (error) {
                            fail(error);
                        } })();
                        return;
                    }
                    const message = JSON.parse(bytes.toString());
                    if (message.op === 'cancel') {
                        fail(new Error('binary file transfer cancelled'));
                        return;
                    }
                    if (message.op === 'renew') {
                        if (!started || message.token !== token || performance.now() >= expires)
                            throw new Error('binary file lease expired or superseded');
                        expires = Math.min(expires + TASK_RENEW_STEP_MS, performance.now() + TASK_LEASE_MS);
                        token = randomUUID();
                        armLease();
                        control(client, { op: 'lease', lease: lease() });
                        return;
                    }
                    if (message.op === 'ack') {
                        if (!ack)
                            throw new Error('unexpected binary ACK');
                        ack.resolve();
                        return;
                    }
                    if (message.op === 'end') {
                        if (!started || request?.action !== 'import' || writing || ended)
                            throw new Error('unexpected binary end');
                        ended = true;
                        input.end();
                        clearTimeout(idleTimer);
                        return;
                    }
                    if (started)
                        throw new Error('unexpected control after begin');
                    if (message.op === 'open') {
                        if (request || !['export', 'import', 'digest'].includes(message.action) || typeof message.path !== 'string' || (message.mkdir !== undefined && typeof message.mkdir !== 'boolean'))
                            throw new Error('invalid binary file request');
                        checkAbsolute(message.path);
                        request = { action: message.action, path: message.path, mkdir: message.mkdir ?? false, selected: message.selected === true };
                        return;
                    }
                    if (message.op === 'select') {
                        if (request?.action !== 'digest' || typeof message.path !== 'string' || selection.length >= FILE_MAX_ENTRIES)
                            throw new Error('invalid selection');
                        metadata += bytes.length;
                        if (metadata > FILE_MAX_METADATA)
                            throw new Error('selection metadata limit exceeded');
                        selection.push(message.path);
                        return;
                    }
                    if (message.op === 'begin' && request) {
                        if (message.token !== token || performance.now() >= expires)
                            throw new Error('binary file preparation expired; nothing started');
                        void run();
                        return;
                    }
                    throw new Error('unknown binary file control');
                }
                catch (error) {
                    fail(error);
                }
            });
            armLease();
            control(client, { op: 'prepared', lease: lease() });
        });
    };
    const unregister = real.registerUpgrade({ path: REMOTE_FILE_PATH, handler }) as () => void;
    return async () => { disposed = true; unregister(); const owned = [...operations]; for (const task of owned)
        task.stop(new Error('Hub file receiver disposed')); await Promise.all(owned.map(task => task.done)); server.close(); };
}
interface Connection {
    origin: string;
    cookie: string;
}
interface FileLease {
    protocol: number;
    token: string;
    leaseMs: number;
    renewStepMs: number;
    cleanupMs: number;
}
/** Completion owns lease cleanup, local socket closure and (for import) the supplied source FD. */
export function createRemoteFileEndpoint(connection: () => Connection, providerSignal?: AbortSignal, track: (done: Promise<void>) => void = () => { }): BinaryFileEndpoint {
    const open = async (action: 'export' | 'import' | 'digest', path: string, signal: AbortSignal, mkdir = false, selection?: readonly string[]) => {
        checkAbsolute(path);
        if (selection)
            checkSelection(selection);
        signal = providerSignal ? AbortSignal.any([signal, providerSignal]) : signal;
        signal.throwIfAborted();
        const target = connection(), socket = new ws.WebSocket(target.origin.replace(/^http/, 'ws') + REMOTE_FILE_PATH, { headers: { Cookie: target.cookie }, maxPayload: FILE_FRAME_BYTES, perMessageDeflate: false, handshakeTimeout: 5000 });
        const ready = wait(), done = wait(), cleaned = wait();
        let failure: Error | undefined, terminal = false, started = false, acknowledged = false, acknowledgedAt = 0, lease: FileLease | undefined, cleanupDeadline = 0, nextRenewAt = 0;
        let ack: ReturnType<typeof wait> | undefined, next = deferred<Buffer | null>(), queued: Buffer | null | undefined, reading = false, digest: Awaited<ReturnType<BinaryFileEndpoint['digest']>> | undefined;
        let sourceRef: Readable | undefined, timer: NodeJS.Timeout | undefined, renewTimer: NodeJS.Timeout | undefined, renewDeadline: NodeJS.Timeout | undefined, prepareTimer: NodeJS.Timeout | undefined;
        const parseLease = (value: FileLease) => {
            if (!value || value.protocol !== FILE_LEASE_PROTOCOL || value.leaseMs !== TASK_LEASE_MS || value.renewStepMs !== TASK_RENEW_STEP_MS || value.cleanupMs !== FILE_CLEANUP_MS || typeof value.token !== 'string')
                throw new Error('Hub binary file bounded lease protocol unavailable/unsupported');
            return value;
        };
        const stopRenewing = () => { clearTimeout(renewTimer); clearTimeout(renewDeadline); clearTimeout(prepareTimer); };
        const confirm = () => { if (!acknowledged) {
            acknowledged = true;
            acknowledgedAt = performance.now();
            cleaned.resolve();
        } };
        const end = (error?: Error) => {
            if (terminal)
                return;
            terminal = true;
            failure = error;
            stopRenewing();
            clearTimeout(timer);
            if (error) {
                sourceRef?.destroy(error);
                ack?.reject(error);
                next.reject(error);
                if (started)
                    control(socket, { op: 'cancel' });
            }
            else
                next.resolve(null);
            void (async () => {
                try {
                    if (started && !acknowledged) {
                        let deadline: NodeJS.Timeout | undefined;
                        await Promise.race([cleaned.promise, new Promise<void>(resolve => { deadline = setTimeout(resolve, Math.max(0, cleanupDeadline - performance.now())); })]);
                        clearTimeout(deadline);
                    }
                    // A cleanup ACK covers files/worker. The receiver also owns a bounded closing socket;
                    // a proxy may forward ACK but swallow close, so account that explicit resource bound.
                    if (acknowledged)
                        await new Promise<void>(resolve => setTimeout(resolve, Math.max(0, acknowledgedAt + FILE_SOCKET_CLOSE_MS - performance.now())));
                    await closeSocket(socket);
                }
                finally {
                    signal.removeEventListener('abort', cancel);
                    if (failure) {
                        ready.reject(failure);
                        done.reject(failure);
                    }
                    else
                        done.resolve();
                }
            })();
        };
        const cancel = () => end(new Error('binary transfer cancelled'));
        const renew = () => {
            if (terminal || !lease)
                return;
            renewTimer = setTimeout(() => {
                if (terminal || !lease)
                    return;
                // Count a possibly applied request BEFORE sending, even if its response is lost/delayed.
                cleanupDeadline += TASK_RENEW_STEP_MS;
                control(socket, { op: 'renew', token: lease.token });
                renewDeadline = setTimeout(() => end(new Error('Hub binary file task renewal unavailable')), TASK_CONTROL_TIMEOUT_MS);
            }, Math.max(0, nextRenewAt - performance.now()));
        };
        signal.addEventListener('abort', cancel, { once: true });
        void ready.promise.catch(() => { });
        void done.promise.catch(() => { });
        void next.promise.catch(() => { });
        track(done.promise.catch(() => { }));
        socket.on('error', (error: Error) => end(new Error(`Hub binary file lane unavailable/unsupported: ${error.message}`)));
        socket.on('close', () => { if (!terminal)
            end(new Error('Hub binary file peer disconnected before completion')); });
        socket.on('open', () => { if (signal.aborted) {
            cancel();
            return;
        } ; prepareTimer = setTimeout(() => end(new Error('Hub binary file bounded lease preparation unavailable/unsupported')), TASK_CONTROL_TIMEOUT_MS); });
        socket.on('message', (data: unknown, binary: boolean) => {
            try {
                const bytes = raw(data);
                if (binary) {
                    if (terminal)
                        return;
                    if (action !== 'export' || queued !== undefined)
                        throw new Error('unexpected binary frame/ACK window');
                    if (reading) {
                        reading = false;
                        next.resolve(bytes);
                    }
                    else
                        queued = bytes;
                    return;
                }
                const message = JSON.parse(bytes.toString());
                if (message.op === 'done' || message.op === 'error') {
                    if (message.cleaned === true)
                        confirm();
                    if (!terminal) {
                        digest = message.digest;
                        end(message.op === 'error' ? new Error(String(message.error)) : signal.aborted ? new Error('binary transfer cancelled') : undefined);
                    }
                    return;
                }
                if (terminal)
                    return;
                if (message.op === 'prepared') {
                    if (lease)
                        throw new Error('duplicate file preparation');
                    lease = parseLease(message.lease);
                    cleanupDeadline = performance.now() + TASK_LEASE_MS + FILE_CLEANUP_MS;
                    clearTimeout(prepareTimer);
                    control(socket, { op: 'open', action, path, mkdir, selected: selection !== undefined });
                    for (const entry of selection ?? [])
                        control(socket, { op: 'select', path: entry });
                    // No receiving filesystem operation can start without this prepared, bounded token.
                    started = true;
                    nextRenewAt = performance.now() + TASK_RENEW_STEP_MS;
                    control(socket, { op: 'begin', token: lease.token });
                    renew();
                    return;
                }
                if (message.op === 'lease') {
                    lease = parseLease(message.lease);
                    clearTimeout(renewDeadline);
                    nextRenewAt += TASK_RENEW_STEP_MS;
                    renew();
                    return;
                }
                if (message.op === 'ready') {
                    if (!started)
                        throw new Error('unprepared file receiver');
                    ready.resolve();
                    return;
                }
                if (message.op === 'ack') {
                    if (!ack)
                        throw new Error('unexpected file ACK');
                    ack.resolve();
                    return;
                }
                throw new Error('unknown binary file response');
            }
            catch (error) {
                end(error instanceof Error ? error : new Error(String(error)));
            }
        });
        await ready.promise;
        return {
            done: done.promise, digest: () => digest!,
            async *read() {
                try {
                    while (true) {
                        if (failure)
                            throw failure;
                        if (terminal)
                            break;
                        let chunk: Buffer | null;
                        if (queued !== undefined) {
                            chunk = queued;
                            queued = undefined;
                        }
                        else {
                            reading = true;
                            chunk = await next.promise;
                        }
                        ;
                        next = deferred<Buffer | null>();
                        void next.promise.catch(() => { });
                        if (chunk === null)
                            break;
                        yield chunk;
                        control(socket, { op: 'ack' });
                    }
                    await done.promise;
                }
                finally {
                    if (!terminal)
                        cancel();
                    await done.promise.catch(() => { });
                }
            },
            async write(source: NodeJS.ReadableStream) {
                sourceRef = source as Readable;
                if (failure) {
                    sourceRef.destroy();
                    await done.promise;
                    throw failure;
                }
                const destroy = () => sourceRef?.destroy(new Error('binary transfer cancelled'));
                signal.addEventListener('abort', destroy, { once: true });
                try {
                    for await (const item of source as Readable) {
                        const b = raw(item);
                        for (let at = 0; at < b.length; at += FILE_FRAME_BYTES) {
                            signal.throwIfAborted();
                            ack = wait();
                            void ack.promise.catch(() => { });
                            await send(socket, b.subarray(at, at + FILE_FRAME_BYTES));
                            timer = setTimeout(() => end(new Error('Hub binary file ACK timeout')), FILE_IDLE_MS);
                            await ack.promise;
                            clearTimeout(timer);
                            ack = undefined;
                        }
                    }
                    control(socket, { op: 'end' });
                    await done.promise;
                }
                catch (error) {
                    if (!terminal)
                        end(error instanceof Error ? error : new Error(String(error)));
                    await done.promise.catch(() => { });
                    throw error;
                }
                finally {
                    sourceRef = undefined;
                    signal.removeEventListener('abort', destroy);
                    (source as Readable).destroy();
                }
            },
        };
    };
    return {
        async exportTree(path, signal) { const request = await open('export', path, signal); return Readable.from(request.read(), { objectMode: false, highWaterMark: FILE_FRAME_BYTES }); },
        importTree(path, source, { mkdir, signal }) {
            const work = (async () => {
                const closed = finished(source, { cleanup: true }).catch(() => {});
                try {
                const request = await open('import', path, signal, mkdir);
                await request.write(source);
            }
            finally {
                (source as Readable).destroy();
                await closed;
            } })();
            track(work.then(() => { }, () => { }));
            return work;
        },
        async digest(path, signal, selection) { const request = await open('digest', path, signal, false, selection); await request.done; const d = request.digest(); if (!d || !/^[a-f0-9]{64}$/.test(d.sha256) || !Number.isSafeInteger(d.bytes) || !Number.isSafeInteger(d.entries))
            throw new Error('invalid binary digest response'); return d; },
    };
}
