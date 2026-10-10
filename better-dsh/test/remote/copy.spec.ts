import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { RemoteDriver } from '../../src/remote/driver.ts';
it('copies binary trees, verifies transferred entries while preserving destination extras, and removes owned staging', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'binary-copy-'));
    const driver = new RemoteDriver();
    try {
        const src = join(dir, 'src'), dst = join(dir, 'dst');
        await mkdir(join(src, 'empty'), { recursive: true });
        await mkdir(dst);
        const bytes = Buffer.concat([Buffer.from([0, 255, 128, 10]), randomBytes(300000)]);
        await writeFile(join(src, '雪\nname'), bytes);
        await writeFile(join(src, 'empty-file'), '');
        await writeFile(join(dst, 'unrelated'), 'keep');
        expect(driver).toHaveProperty('copy');
        const receipt = await (driver as RemoteDriver & {
            copy(request: unknown, signal: AbortSignal): Promise<any>;
        }).copy({ src, dst, verify: true, mkdir: true }, new AbortController().signal);
        expect(receipt).toMatchObject({ action: 'copy', verified: true, bytes: bytes.length, entries: 4 });
        expect(await readFile(join(dst, '雪\nname'))).toEqual(bytes);
        expect(await readFile(join(dst, 'unrelated'), 'utf8')).toBe('keep');
        expect(await readdir(join(dst, 'empty'))).toEqual([]);
        expect(receipt.scratch).toBeUndefined();
    }
    finally {
        await driver.dispose();
        await rm(dir, { recursive: true, force: true });
    }
});
it('retains only failed payload diagnostics on destination tamper; successful unverified copies remove staging', async () => {
    const { copyTree, CopyError } = await import('../../src/remote/copy.ts'), { localFileEndpoint } = await import('../../src/remote/archive.ts');
    const home = await mkdtemp(join(tmpdir(), 'copy-receipt-')), src = join(home, 'source'), dst = join(home, 'destination'), scratch = join(home, 'scratch');
    const endpoint = localFileEndpoint(), signal = new AbortController().signal;
    try {
        await writeFile(src, Buffer.from([0, 255, 128, 10]));
        const corrupt = { ...endpoint, async importTree(...args: Parameters<typeof endpoint.importTree>) { await endpoint.importTree(...args); await writeFile(dst, 'corrupted'); } };
        let failure: InstanceType<typeof CopyError> | undefined;
        try {
            await copyTree({ src, dst }, { path: src, endpoint }, { path: dst, endpoint: corrupt }, signal, scratch);
        }
        catch (error) {
            failure = error as InstanceType<typeof CopyError>;
        }
        expect(failure).toBeInstanceOf(CopyError);
        expect(failure!.receipt).toMatchObject({ verified: false, error: expect.stringContaining('mismatch') });
        expect(await readFile(join(failure!.receipt.scratch!, 'payload.bin'))).not.toHaveLength(0);
        const prior = await readdir(scratch);
        const receipt = await copyTree({ src, dst, verify: false }, { path: src, endpoint }, { path: dst, endpoint }, signal, scratch);
        expect(receipt).toMatchObject({ verified: false, scope: 'transferred entries' });
        expect(receipt.sourceDigest).toBeUndefined();
        expect(receipt.destinationDigest).toBeUndefined();
        expect(await readdir(scratch)).toEqual(prior);
    }
    finally {
        await rm(home, { recursive: true, force: true });
    }
});
it('real scoped tool advertises binary copy and returns a declared verified receipt', async () => {
    const { createRealRemoteHarness } = await import('./real-harness.ts');
    const h = await createRealRemoteHarness({ copies: 1 }), home = await mkdtemp(join(tmpdir(), 'copy-tool-'));
    try {
        const agent = await h.createAgent('copy'), src = join(home, 'source'), dst = join(home, 'dest');
        await writeFile(src, Buffer.from([0, 255, 128]));
        const schema = h.visibleTools(agent).find(t => t.name === 'remote')!;
        expect(schema.description).toContain('Python 3');
        const result = await h.invoke(agent, { action: 'copy', src, dst });
        expect(JSON.parse(result.text)).toMatchObject({ action: 'copy', verified: true, bytes: 3, entries: 1 });
        await expect(h.invoke(agent, { action: 'copy', src, dst, cmd: 'true' })).rejects.toThrow(/cannot be combined/);
    }
    finally {
        await h.dispose();
        await rm(home, { recursive: true, force: true });
    }
});
it('real scoped tool copies Hub-to-Hub through complete origin staging without SSH aliases', async () => {
    const { createServer } = await import('node:http');
    const { registerRemoteFileRpc } = await import('../../../super-dsh/superd-hub/dist/remote-file-rpc.js');
    const { installHubRemoteTransport } = await import('../../../super-dsh/superd-hub/dist/remote-row.js');
    const { upsertRemote } = await import('../../../super-dsh/superd-hub/dist/machines.js');
    const { createRealRemoteHarness } = await import('./real-harness.ts');
    const h = await createRealRemoteHarness({ copies: 1 }), home = await mkdtemp(join(tmpdir(), 'hub-copy-tool-')), server = createServer();
    let handler: Parameters<Parameters<typeof registerRemoteFileRpc>[0]['registerUpgrade']>[0]['handler'] | undefined;
    const off = await registerRemoteFileRpc({ registerUpgrade: route => { handler = route.handler; return () => { handler = undefined; }; } }, { authorize: req => (req as import('node:http').IncomingMessage).headers.cookie === 'paired=yes' });
    server.on('upgrade', (req, socket, head) => handler?.(req, socket, head));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
    for (const id of ['src1', 'dst1'])
        upsertRemote(home, { id, name: 'paired-only', origin, cookie: 'paired=yes', enabled: true, addedAt: Date.now() });
    const row = await h.ctx.plugin({ name: 'hub-copy', apply: ctx => installHubRemoteTransport(ctx, { home }) });
    try {
        const src = join(home, 'source'), dst = join(home, 'destination'), bytes = randomBytes(350000);
        bytes[0] = 0;
        bytes[1] = 255;
        await writeFile(src, bytes);
        const agent = await h.createAgent('hub-copy');
        const result = await h.invoke(agent, { action: 'copy', src: `hub:src1:${src}`, dst: `hub:dst1:${dst}` });
        expect(JSON.parse(result.text)).toMatchObject({ verified: true, bytes: bytes.length, scope: 'transferred entries' });
        expect(await readFile(dst)).toEqual(bytes);
    }
    finally {
        await h.dispose();
        await row.dispose();
        await off();
        await new Promise<void>(r => server.close(() => r()));
        await rm(home, { recursive: true, force: true });
    }
}, 12000);
it('real scoped Agent disposal awaits partitioned Hub worker, socket and origin payload FD cleanup', async () => {
    const { createServer } = await import('node:http'), { createRequire } = await import('node:module'), { open, readlink } = await import('node:fs/promises');
    const { WebSocket, WebSocketServer } = createRequire(new URL('../../../super-dsh/superd-hub/package.json', import.meta.url))('ws');
    const mod = await import('../../../super-dsh/superd-hub/dist/remote-file-rpc.js'), { installHubRemoteTransport } = await import('../../../super-dsh/superd-hub/dist/remote-row.js'), { upsertRemote } = await import('../../../super-dsh/superd-hub/dist/machines.js'), { createRealRemoteHarness } = await import('./real-harness.ts');
    const h = await createRealRemoteHarness({ copies: 1 }), home = await mkdtemp(join(tmpdir(), 'agent-file-partition-')), src = join(home, 'source'), receiver = createServer(), proxy = createServer(), peers = new Set<any>();
    const file = await open(src, 'w');
    await file.truncate(256 * 1024 * 1024);
    await file.close();
    let handler: any, drop = false, pid: number | undefined, ownedRoot: string | undefined, row: any;
    const off = await mod.registerRemoteFileRpc({ registerUpgrade: r => { handler = r.handler; return () => { handler = undefined; }; } }, { authorize: () => true });
    receiver.on('upgrade', (req, socket, head) => handler?.(req, socket, head));
    await new Promise<void>(r => receiver.listen(0, '127.0.0.1', r));
    const wss = new WebSocketServer({ noServer: true });
    proxy.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (down: any) => {
        const up = new WebSocket(`ws://127.0.0.1:${(receiver.address() as import('node:net').AddressInfo).port}${mod.REMOTE_FILE_PATH}`);
        peers.add(up);
        peers.add(down);
        const queued: any[] = [];
        up.on('open', () => { for (const [b, binary] of queued)
            up.send(b, { binary }); });
        down.on('message', (b: any, binary: boolean) => { if (!drop) {
            if (up.readyState === 1)
                up.send(b, { binary });
            else
                queued.push([b, binary]);
        } });
        up.on('message', (b: any, binary: boolean) => { if (!drop && down.readyState === 1)
            down.send(b, { binary }); });
        up.on('error', () => { });
        down.on('error', () => { });
    }));
    await new Promise<void>(r => proxy.listen(0, '127.0.0.1', r));
    try {
        upsertRemote(home, { id: 'peer', name: 'paired-only', origin: `http://127.0.0.1:${(proxy.address() as import('node:net').AddressInfo).port}`, cookie: 'paired', enabled: true, addedAt: Date.now() });
        row = await h.ctx.plugin({ name: 'hub-file-fault', apply: ctx => installHubRemoteTransport(ctx, { home }) });
        const agent = await h.createAgent('file-owner'), copy = h.invoke(agent, { action: 'copy', src: `hub:peer:${src}`, dst: join(home, 'destination') }).catch(error => error);
        for (let i = 0; i < 100 && !pid; i++) {
            for (const candidate of await readdir('/proc'))
                if (/^\d+$/.test(candidate)) {
                    try {
                        const argv = (await readFile(`/proc/${candidate}/cmdline`)).toString().split('\0');
                        if (!argv.some(a => a.includes('runFileWorker')) || !argv.some(a => a.startsWith('{') && a.includes(src)))
                            continue;
                        for (const fd of await readdir(`/proc/${candidate}/fd`))
                            if (await readlink(`/proc/${candidate}/fd/${fd}`) === src) {
                                pid = Number(candidate);
                                ownedRoot = JSON.parse(argv.find(a => a.startsWith('{') && a.includes(src))!).root;
                                process.kill(pid, 'SIGSTOP');
                                break;
                            }
                    }
                    catch { }
                }
            if (!pid)
                await new Promise(r => setTimeout(r, 5));
        }
        expect(pid).toBeDefined();
        drop = true;
        const disposed = h.disposeAgent(agent);
        expect(String(await copy)).toMatch(/cancel|abort|disposed/i);
        await disposed;
        expect(() => process.kill(pid!, 0)).toThrow(/ESRCH/);
        expect([...peers].every(s => s.readyState === 3)).toBe(true);
        expect(ownedRoot).toBeDefined();
        await expect(readdir(ownedRoot!)).rejects.toThrow(/ENOENT/);
        for (const fd of await readdir('/proc/self/fd')) {
            let path = '';
            try {
                path = await readlink(`/proc/self/fd/${fd}`);
            }
            catch { }
            ;
            expect(path).not.toContain('/.scratch/remote-copy-');
        }
    }
    finally {
        for (const socket of peers)
            socket.terminate();
        await h.dispose();
        await row?.dispose();
        await off();
        wss.close();
        await Promise.all([new Promise<void>(r => receiver.close(() => r())), new Promise<void>(r => proxy.close(() => r()))]);
        await rm(home, { recursive: true, force: true });
    }
}, 20000);
