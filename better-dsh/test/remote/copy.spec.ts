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
        expect(receipt).toMatchObject({ action: 'copy', route: 'hub-staged', verification: 'sha256', ok: true, bytes: bytes.length, entries: 4 });
        expect(await readFile(join(dst, '雪\nname'))).toEqual(bytes);
        expect(await readFile(join(dst, 'unrelated'), 'utf8')).toBe('keep');
        expect(await readdir(join(dst, 'empty'))).toEqual([]);
        expect((receipt as { scratch?: string }).scratch).toBeUndefined();
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
        expect(failure!.receipt).toMatchObject({ ok: false, reason: 'digest-mismatch', error: expect.stringContaining('mismatch') });
        expect(await readFile(join(failure!.receipt.scratch!, 'payload.bin'))).not.toHaveLength(0);
        const prior = await readdir(scratch);
        const receipt = await copyTree({ src, dst, verify: false }, { path: src, endpoint }, { path: dst, endpoint }, signal, scratch);
        expect(receipt).toMatchObject({ verification: 'not-applicable', ok: true, scope: 'transferred entries' });
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
        const schema = h.visibleTools(agent).find(t => t.name === 'remote_transfer')!;
        expect(schema.description).toContain('Every call declares its mode');
        expect(h.visibleTools(agent).find(t => t.name === 'remote')!.description).toContain('needs bash only — no Python');
        const result = await h.invoke(agent, { mode: 'copy', src, dst }, 'remote_transfer');
        expect((result as { receipt?: { action?: string; route?: string; verification?: string; ok?: boolean; bytes?: number; entries?: number } }).receipt).toMatchObject({ action: 'copy', route: 'hub-staged', verification: 'sha256', ok: true, bytes: 3, entries: 1 });
        expect(result.text).toContain('verification sha256');
        await expect(h.invoke(agent, { mode: 'copy', src, dst, cmd: 'true' }, 'remote_transfer')).rejects.toThrow(/unknown parameter/);
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
        const result = await h.invoke(agent, { mode: 'copy', src: `hub:src1:${src}`, dst: `hub:dst1:${dst}` }, 'remote_transfer');
        expect((result as { receipt?: { verification?: string; ok?: boolean; bytes?: number } }).receipt).toMatchObject({ verification: 'sha256', ok: true, bytes: bytes.length });
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
        const agent = await h.createAgent('file-owner'), copy = h.invoke(agent, { mode: 'copy', src: `hub:peer:${src}`, dst: join(home, 'destination') }, 'remote_transfer').catch(error => error);
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

// Task 1 (native shortcut spec): copy takes ordered native argv; one-shot
// CLI routes use argv, two-segment cross-endpoint routes use mutually
// exclusive pullArgv/pushArgv; verify/mkdir stay only on the Hub/local lane.
it('accepts argv for CLI peers and pullArgv/pushArgv for two-segment routes; Hub/local lane rejects CLI options', async () => {
    const { createRealRemoteHarness } = await import('./real-harness.ts');
    const h = await createRealRemoteHarness({ copies: 1 }), home = await mkdtemp(join(tmpdir(), 'copy-argv-'));
    try {
        const a = await h.createAgent('copy-argv');
        const src = join(home, 'src'), dst = join(home, 'dst');
        await mkdir(src); await writeFile(join(src, 'f'), 'payload');
        // Pure local lane: argv is not a declared capability of the old channel.
        await expect(h.invoke(a, { mode: 'copy', src, dst, argv: ['-p'] }, 'remote_transfer')).rejects.toThrow(/argv|not supported|native/);
        // verify/mkdir remain valid on the local lane.
        const local = (await h.invoke(a, { mode: 'copy', src, dst, verify: true, mkdir: true }, 'remote_transfer')) as unknown as { receipt: { verification?: string; ok?: boolean } };
        expect(local.receipt.verification).toBe('sha256');
        expect(local.receipt.ok).toBe(true);
        // argv + pull/push mixes are rejected before any work.
        await expect(h.invoke(a, { mode: 'copy', src, dst, argv: ['-p'], pullArgv: ['-a'] }, 'remote_transfer')).rejects.toThrow(/pullArgv|pushArgv|argv/);
        await expect(h.invoke(a, { mode: 'copy', src, dst, pullArgv: ['-a'], pushArgv: ['-p'] }, 'remote_transfer')).rejects.toThrow(/copy|pull|push/);
        // Removed rsync-only fields on copy are still rejected.
        await expect(h.invoke(a, { mode: 'copy', src, dst, dryRun: true }, 'remote_transfer')).rejects.toThrow(/dryRun/);
        // Malformed shapes fail before dialing.
        await expect(h.invoke(a, { mode: 'copy', src, dst, argv: 'not-an-array' }, 'remote_transfer')).rejects.toThrow(/argv/);
        await expect(h.invoke(a, { mode: 'copy', src, dst, argv: [7] }, 'remote_transfer')).rejects.toThrow(/argv/);
        await expect(h.invoke(a, { mode: 'copy', src, dst, argv: [null] }, 'remote_transfer')).rejects.toThrow(/argv/);
    }
    finally {
        await h.dispose();
        await rm(home, { recursive: true, force: true });
    }
});

// Task 2 (native shortcut spec): real scp routes with BYO identities; spaces,
// quotes and newlines in paths survive; success never claims verification.
it('copies local↔SSH with native scp and ordered argv; no forced verification claim', async () => {
    const { withSshFixture } = await import('./ssh-fixture.ts');
    await withSshFixture(async f => {
        const d = new RemoteDriver({ nativeArgvFor: argv => (argv[0] === 'ssh' || argv[0] === 'scp') ? f.isolateOpts(argv) : argv });
        try {
            await d.call({ target: 'ssh:remote', ssh: f.destination }, { sessionKey: 'spec' });
            const odd = join(f.directory, "copy 'quote 雪\nfile");
            const remote = join(f.directory, 'scp-remote');
            await mkdir(remote);
            await writeFile(odd, 'native-scp-payload');
            const up = await d.copy({ src: odd, dst: `ssh:remote:${remote}/`, argv: ['-p'] }, new AbortController().signal, { sessionKey: 'spec' }) as import('../../src/remote/native-copy.ts').NativeCopyReceipt;
            expect(up.route).toBe('scp');
            expect(up.exits).toEqual([0]);
            expect(up.verification).toBe('native-exit-only');
            expect(up.ok).toBe(true);
            expect(up.argv[0]).toContain('-p');
            expect(await readFile(join(remote, "copy 'quote 雪\nfile"), 'utf8')).toBe('native-scp-payload');
            const srcDir = join(f.directory, 'auto-r-src');
            await mkdir(join(srcDir, 'sub'), { recursive: true });
            await writeFile(join(srcDir, 'sub', 'g.txt'), 'auto-r-payload');
            const autoR = await d.copy({ src: srcDir, dst: `ssh:remote:${remote}/auto-r` }, new AbortController().signal, { sessionKey: 'spec' }) as import('../../src/remote/native-copy.ts').NativeCopyReceipt;
            expect(autoR.exits).toEqual([0]);
            expect(autoR.argv[0]).toContain('-r'); // D8: auto-appended, disclosed in argv
            expect(await readFile(join(remote, 'auto-r', 'sub', 'g.txt'), 'utf8')).toBe('auto-r-payload');
            const down = join(f.directory, 'scp-back');
            await mkdir(down);
            const back = await d.copy({ src: `ssh:remote:${remote}/`, dst: down, argv: ['-r'] }, new AbortController().signal, { sessionKey: 'spec' }) as import('../../src/remote/native-copy.ts').NativeCopyReceipt;
            expect(back.exits).toEqual([0]);
            expect(await readFile(join(down, 'scp-remote', "copy 'quote 雪\nfile"), 'utf8')).toBe('native-scp-payload');
            const missing = await d.copy({ src: join(f.directory, 'missing-src'), dst: `ssh:remote:${remote}` }, new AbortController().signal, { sessionKey: 'spec' }) as import('../../src/remote/native-copy.ts').NativeCopyReceipt;
            expect(missing.exits[0]).not.toBe(0);
            expect(missing.stderr.join('\n')).toMatch(/No such file|does not exist/i);
            expect(missing.ok).toBe(false);
            expect(missing.reason).toBe('non-zero-exit');
            expect(missing.verification).toBe('native-exit-only');
        }
        finally { await d.dispose() }
    })
}, 40000);

// Native CLI routes refuse verify (staged-lane-only, D1=A tier language);
// mkdir is now a native default (D3, 2026-10-17) and mkdir:false is accepted
// with created:'n-a'. scp -R also hides inside short-option clusters.
it('native scp routes refuse verify, accept mkdir:false as n-a, and reject -R inside option clusters', async () => {
    const { withSshFixture } = await import('./ssh-fixture.ts');
    await withSshFixture(async f => {
        const d = new RemoteDriver({ nativeArgvFor: argv => (argv[0] === 'ssh' || argv[0] === 'scp') ? f.isolateOpts(argv) : argv });
        try {
            await d.call({ target: 'ssh:remote', ssh: f.destination }, { sessionKey: 'spec' });
            const local = join(f.directory, 'guard-src'), remote = join(f.directory, 'guard-remote');
            await mkdir(local); await mkdir(remote);
            await writeFile(join(local, 'f'), 'guard-payload');
            await expect(d.copy({ src: local, dst: `ssh:remote:${remote}/`, argv: ['-r'], verify: true }, new AbortController().signal, { sessionKey: 'spec' })).rejects.toThrow(/verify.*Hub\/local|staged lane only/);
            await expect(d.copy({ src: local, dst: `ssh:remote:${remote}/`, argv: ['-pR'] }, new AbortController().signal, { sessionKey: 'spec' })).rejects.toThrow(/-R/);
            await expect(d.copy({ src: local, dst: `ssh:remote:${remote}/`, argv: ['--'] }, new AbortController().signal, { sessionKey: 'spec' })).rejects.toThrow(/--/);
            // Nothing ran for the throwing cases: the destination stayed empty.
            expect(await readdir(remote)).toEqual([]);
            // D3: mkdir:false is accepted and disclosed as created 'n-a'.
            const skipped = await d.copy({ src: local, dst: `ssh:remote:${remote}/`, argv: ['-r'], mkdir: false }, new AbortController().signal, { sessionKey: 'spec' }) as import('../../src/remote/native-copy.ts').NativeCopyReceipt;
            expect(skipped.created).toBe('n-a');
            expect(skipped.ok).toBe(true);
        }
        finally { await d.dispose() }
    })
}, 40000);

// Caller-supplied identity options come AFTER the registered identity in the
// scp argv, so scp's last-option-wins lets the caller override -i/-P (spec:
// explicit caller options win over the tool's chosen identity).
it('caller -i in argv overrides the registered scp identity (last option wins)', async () => {
    const { withSshFixture } = await import('./ssh-fixture.ts');
    await withSshFixture(async f => {
        const seen: string[][] = [];
        const d = new RemoteDriver({ nativeArgvFor: argv => {
            if (argv[0] === 'ssh') return f.isolateOpts(argv);
            if (argv[0] === 'scp') { seen.push([...argv]); return f.isolateOpts(argv) }
            return argv;
        } });
        try {
            await d.call({ target: 'ssh:remote', ssh: f.destination }, { sessionKey: 'spec' });
            const local = join(f.directory, 'override-src'), remote = join(f.directory, 'override-remote');
            await mkdir(local); await mkdir(remote);
            await writeFile(join(local, 'f'), 'override-payload');
            const callerKey = join(f.directory, 'caller-key');
            await writeFile(callerKey, 'not-a-real-key');
            const receipt = await d.copy({ src: join(local, 'f'), dst: `ssh:remote:${remote}/`, argv: ['-i', callerKey] }, new AbortController().signal, { sessionKey: 'spec' }) as import('../../src/remote/native-copy.ts').NativeCopyReceipt;
            // The caller's -i must appear AFTER the registered identity's -i.
            const scpArgv = seen[0]!;
            const registered = scpArgv.indexOf('-i', 1), caller = scpArgv.lastIndexOf('-i');
            expect(registered).toBeGreaterThan(0);
            expect(caller).toBeGreaterThan(registered);
            expect(scpArgv[caller + 1]).toBe(callerKey);
            // Fixture identity wins only because both point at the same key
            // semantics; the structural guarantee (caller last) is the assertion.
            expect(receipt.exits).toEqual([0]);
            expect(await readFile(join(remote, 'f'), 'utf8')).toBe('override-payload');
        }
        finally { await d.dispose() }
    })
}, 40000);

// Two different BYO identities via scp -3 through the origin; identities stay
// on the origin (temp config only), scp -R is refused.
it('copies SSH↔SSH through the origin with two different BYO keys; refuses scp -R', async () => {
    const { withSshFixture } = await import('./ssh-fixture.ts');
    await withSshFixture(async f => {
        const d = new RemoteDriver({ nativeArgvFor: argv => (argv[0] === 'ssh' || argv[0] === 'scp') ? f.isolateOpts(argv) : argv });
        try {
            await d.call({ target: 'ssh:src', ssh: f.jump }, { sessionKey: 'spec' });
            await d.call({ target: 'ssh:dst', ssh: f.destination }, { sessionKey: 'spec' });
            const remote = join(f.directory, 'hop-src');
            await mkdir(remote);
            await writeFile(join(remote, 'hop-file'), 'hop-payload');
            const receipt = await d.copy({ src: `ssh:src:${remote}/`, dst: `ssh:dst:${join(f.directory, 'hop-final')}/`, argv: ['-r'] }, new AbortController().signal, { sessionKey: 'spec' }) as import('../../src/remote/native-copy.ts').NativeCopyReceipt;
            expect(receipt.route).toContain('-3');
            expect(receipt.exits).toEqual([0]);
            expect(receipt.verification).toBe('native-exit-only');
            expect(receipt.ok).toBe(true);
            expect(await readFile(join(f.directory, 'hop-final', 'hop-file'), 'utf8')).toBe('hop-payload');
            expect(receipt.cleanup).toBe('released');
            await expect(d.copy({ src: `ssh:src:${remote}`, dst: `ssh:dst:${join(f.directory, 'never')}`, argv: ['-R'] }, new AbortController().signal, { sessionKey: 'spec' })).rejects.toThrow(/-R/);
            const { readdir } = await import('node:fs/promises');
            const { tmpdir } = await import('node:os');
            const leftovers = (await readdir(tmpdir())).filter(n => n.startsWith('superd-scp3-'));
            expect(leftovers).toEqual([]);
        }
        finally { await d.dispose() }
    })
}, 60000);

// `ssh:<alias>` targets reach the scp -3 temp config verbatim: a newline in
// the alias must be refused before any config file is written (config-line
// injection guard), and nothing may be copied.
it('refuses newline-bearing ssh: aliases before writing the scp -3 temp config', async () => {
    const { withSshFixture } = await import('./ssh-fixture.ts');
    await withSshFixture(async f => {
        const d = new RemoteDriver({ nativeArgvFor: argv => (argv[0] === 'ssh' || argv[0] === 'scp') ? f.isolateOpts(argv) : argv });
        try {
            await d.call({ target: 'ssh:src', ssh: f.jump }, { sessionKey: 'spec' });
            const injected = `ssh:alias\nHost evil\n  ProxyCommand /bin/false`;
            await expect(d.copy({ src: `ssh:src:${join(f.directory, 'hop-src')}/`, dst: `${injected}:${join(f.directory, 'never')}/`, argv: ['-r'] }, new AbortController().signal, { sessionKey: 'spec' })).rejects.toThrow(/newline.*SSH host|SSH host.*newline|config injection/);
            const { readdir } = await import('node:fs/promises');
            const { tmpdir } = await import('node:os');
            const leftovers = (await readdir(tmpdir())).filter(n => n.startsWith('superd-scp3-'));
            expect(leftovers).toEqual([]);
        }
        finally { await d.dispose() }
    })
}, 60000);
