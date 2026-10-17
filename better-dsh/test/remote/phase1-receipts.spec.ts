import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { nativeCopy, ensureDestinationDir, tempSshConfig, runNative, type NativeCopyReceipt } from '../../src/remote/native-copy.ts';
import { waitForDaemonReady } from '../../src/remote/ssh-rsync-native-relay.ts';

// Phase 1 (spec remote-rescope §3/§4, 2026-10-17): S3/S4 unified receipts,
// S6/S7 internal-path scrubbing, D3 mkdir pre-hop disclosure, F1/F4 regression
// fixtures for the two 2026-10-14 acceptance bugs.

it('F1 regression: scp -3 temp config inlines config-specified IdentityFile paths, filters compiled defaults', async () => {
    // A fixture ssh config with a NON-default IdentityFile: 0.3.1-e dropped
    // exactly these paths and dev4 (whose only authorized key lived in config)
    // failed with a bare Permission denied.
    const home = await mkdtemp(join(tmpdir(), 'f1-fixture-'));
    try {
        const keyDir = join(home, 'keys');
        await mkdir(keyDir);
        const keyPath = join(keyDir, 'custom_deploy_key');
        await writeFile(keyPath, 'placeholder-key-material');
        const configPath = join(home, 'config');
        await writeFile(configPath, [
            'Host f1alias',
            `  IdentityFile ${keyPath}`,
            '  User f1user',
            '',
        ].join('\n'), { mode: 0o600 });
        // resolveThroughOriginConfig runs `ssh -G` against the ORIGIN's real
        // config; the probe seam lets us point -G at the fixture config.
        const probe = (argv: string[]) => new Promise<{ exit: number | null; stdout: string }>(resolve => {
            const child = spawn(argv[0]!, argv.slice(1), { stdio: ['ignore', 'pipe', 'ignore'] });
            let stdout = '';
            child.stdout.setEncoding('utf8');
            child.stdout.on('data', (text: string) => { stdout += text });
            child.on('error', () => resolve({ exit: 127, stdout: '' }));
            child.on('close', exit => resolve({ exit, stdout }));
        });
        const { resolveThroughOriginConfig } = await import('../../src/remote/native-copy.ts');
        const resolved = await resolveThroughOriginConfig({ host: 'f1alias' }, async argv => {
            expect(argv.slice(0, 3)).toEqual(['ssh', '-G', 'f1alias']);
            // Insert -F BEFORE the host so ssh resolves the fixture config.
            return probe(['ssh', '-G', '-F', configPath, 'f1alias']);
        });
        expect(resolved.identityFiles).toEqual([keyPath]);
        expect(resolved.connection.user).toBe('f1user');
        expect(resolved.connection.host).toBe('f1alias');
        // And the temp config actually carries the path.
        const { path, dir } = await tempSshConfig({ host: 'f1alias' }, { host: 'other-host' }, async argv => probe(argv[2] === '-G' && argv[3] === '-F' ? argv : ['ssh', '-G', '-F', configPath, ...argv.slice(2)]));
        const { readFile } = await import('node:fs/promises');
        const text = await readFile(path, 'utf8');
        expect(text).toContain(`IdentityFile ${keyPath}`);
        await rm(dir, { recursive: true, force: true });
    }
    finally {
        await rm(home, { recursive: true, force: true });
    }
}, 30000);

it('F4 regression: waitForDaemonReady resolves on the stderr marker, exits, and times out', async () => {
    const fake = (markerAfterMs?: number, quickExit = false) => {
        const state = { stderrSink: { text: '' }, child: { exitCode: null as number | null } };
        if (quickExit) setTimeout(() => { state.child.exitCode = 64 }, 10);
        if (markerAfterMs !== undefined) setTimeout(() => { state.stderrSink.text = `SUPERD-RSYNC-TMP /tmp/superd-rsync.XYZ\n` }, markerAfterMs);
        return state;
    };
    // 0.3.1-e race shape: -L opens at session start, daemon dies ~150ms later —
    // but a HEALTHY daemon prints the marker only after its directory check.
    expect(await waitForDaemonReady(fake(80), 2000)).toBe('ready');
    expect(await waitForDaemonReady(fake(undefined, true), 2000)).toBe('exited');
    expect(await waitForDaemonReady(fake(600), 150)).toBe('timeout');
}, 10000);

it('D3: mkdir pre-hop discloses created/existed/n-a without gating the transfer', async () => {
    const home = await mkdtemp(join(tmpdir(), 'd3-mkdir-'));
    try {
        // Local dst (unit level — the driver routes local↔local to the staged
        // tree lane, so nativeCopy never sees it): created/existed/n-a directly.
        const blank = (created?: true | false | 'n-a') => ({ action: 'copy' as const, src: '', dst: '', route: '', argv: [], exits: [], stdout: [], stderr: [], outputTruncated: false, verification: 'native-exit-only' as const, ok: true, ...(created === undefined ? {} : { created }), cleanup: 'none-required' as const })
        const made = blank();
        await ensureDestinationDir({ plan: { kind: 'local' }, path: join(home, 'made/up/dir/file') }, new AbortController().signal, undefined, argv => argv, made);
        expect(made.created).toBe(true);
        const kept = blank();
        await ensureDestinationDir({ plan: { kind: 'local' }, path: join(home, 'made/up/dir/file2') }, new AbortController().signal, undefined, argv => argv, kept);
        expect(kept.created).toBe(false);
        // mkdir:false is decided one level up (nativeCopy marks n-a before routes).
        // Remote dst: exec hop answers created/existed; a failing hop degrades to n-a + note.
        const probe = await nativeCopy({ src: join(home, 's'), dst: 'dev3:/srv/deploy/file' },
            { src: { plan: { kind: 'local' }, path: join(home, 's') }, dst: { plan: { kind: 'ssh', host: 'dev3' }, path: '/srv/deploy/file' } },
            new AbortController().signal, { wrapArgv: argv => argv[0] === 'scp' ? ['true'] : argv, execArgvFor: () => ['echo', 'created'] });
        expect(probe.created).toBe(true);
        const broken = await nativeCopy({ src: join(home, 's'), dst: 'dev3:/srv/deploy/file' },
            { src: { plan: { kind: 'local' }, path: join(home, 's') }, dst: { plan: { kind: 'ssh', host: 'dev3' }, path: '/srv/deploy/file' } },
            new AbortController().signal, { wrapArgv: argv => argv[0] === 'scp' ? ['true'] : argv, execArgvFor: () => ['sh', '-c', 'echo is-not-running >&2; exit 125'] });
        expect(broken.created).toBe('n-a');
        expect(broken.note).toContain('exit 125');
    }
    finally {
        await rm(home, { recursive: true, force: true });
    }
}, 30000);

it('S3/S6/S8: receipts carry tier strings, stable route ids and placeholder paths', async () => {
    const home = await mkdtemp(join(tmpdir(), 's3-receipt-'));
    try {
        const receipt = await nativeCopy({ src: join(home, 's'), dst: 'dev4:/tmp/x' },
            { src: { plan: { kind: 'local' }, path: join(home, 's') }, dst: { plan: { kind: 'ssh', host: 'dev4' }, path: '/tmp/x' } },
            new AbortController().signal, { wrapArgv: argv => argv[0] === 'scp' ? ['true'] : argv, execArgvFor: () => ['echo', 'existed'] });
        expect(receipt.verification).toBe('native-exit-only');
        expect(receipt.ok).toBe(true);
        expect(receipt.route).toBe('scp');
        expect(receipt.created).toBe(false);
        // Failure envelope: ok/reason on a non-zero exit.
        const failed: NativeCopyReceipt = await nativeCopy({ src: join(home, 's'), dst: 'dev4:/tmp/x' },
            { src: { plan: { kind: 'local' }, path: join(home, 's') }, dst: { plan: { kind: 'ssh', host: 'dev4' }, path: '/tmp/x' } },
            new AbortController().signal, { wrapArgv: () => ['sh', '-c', 'echo boom >&2; exit 3'], execArgvFor: () => ['echo', 'existed'] });
        expect(failed.ok).toBe(false);
        expect(failed.reason).toBe('non-zero-exit');
        expect(failed.stderr.join('\n')).toContain('boom');
        // Two-segment staging paths never leak into receipt argv (S6).
        const staged = await nativeCopy({ src: 'dev3:/a/f', dst: 'docker:c1:/b/f', pullArgv: [], pushArgv: [] },
            { src: { plan: { kind: 'ssh', host: 'dev3' }, path: '/a/f' }, dst: { plan: { kind: 'docker', container: 'c1' }, path: '/b/f' } },
            new AbortController().signal, { wrapArgv: argv => argv[0] === 'scp' ? ['true'] : argv, execArgvFor: () => ['echo', 'existed'], scratchRoot: home });
        expect(staged.route).toBe('staged-pull-push');
        expect(staged.argv.flat().some(token => token.includes('remote-native-copy-'))).toBe(false);
        expect(staged.argv.flat()).toContain('<staging>');
        expect(staged.cleanup).toBe('released');
    }
    finally {
        await rm(home, { recursive: true, force: true });
    }
}, 30000);
