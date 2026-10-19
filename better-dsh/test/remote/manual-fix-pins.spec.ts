import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeCopy, type CopyPlan, type NativeCopyReceipt } from '../../src/remote/native-copy.ts';
import { RemoteDriver } from '../../src/remote/driver.ts';

// Manual-acceptance fix pins (user close-out ruling 2026-10-17): F3/F4/F5 were
// fixed by hand-verified rounds (0.3.1-g/h) and survived the letter rebase —
// these specs make that survival a non-reversible contract, so the next rebase
// cannot silently drop them. No new behavior is tested; only what hand
// acceptance already established.

it('F3 pin: LOCAL directory sources auto-append the route recursive flag, exactly once, files and remote sources never do', async () => {
    const home = await mkdtemp(join(tmpdir(), 'f3-pin-'));
    try {
        await mkdir(join(home, 'dir'));
        await writeFile(join(home, 'dir/f'), 'f3');
        await writeFile(join(home, 'file'), 'f3');
        const capture: string[][] = []
        const wrap = (argv: string[]): string[] => { capture.push([...argv]); return argv[0] === 'scp' || argv[0] === 'incus' ? ['true'] : argv }
        const run = async (src: { plan: CopyPlan; path: string }, dst: { plan: CopyPlan; path: string }, argv?: string[]) =>
            await nativeCopy({ src: src.path, dst: dst.path, ...(argv === undefined ? {} : { argv }) },
                { src: { plan: src.plan, path: src.path }, dst: { plan: dst.plan, path: dst.path } },
                new AbortController().signal, { wrapArgv: wrap, execArgvFor: () => ['echo', 'existed'] }) as NativeCopyReceipt
        // Local DIRECTORY → ssh: -r auto-appended (D8), disclosed in receipt argv.
        const dirUp = await run({ plan: { kind: 'local' }, path: join(home, 'dir') }, { plan: { kind: 'ssh', host: 'dev3' }, path: '/tmp/x' })
        const dirScp = dirUp.argv[0]!
        expect(dirScp.filter(token => token === '-r' || token === '--recursive')).toEqual(['-r'])
        // Caller-provided -r wins: still exactly one.
        const explicit = await run({ plan: { kind: 'local' }, path: join(home, 'dir') }, { plan: { kind: 'ssh', host: 'dev3' }, path: '/tmp/x' }, ['-r'])
        expect(explicit.argv[0]!.filter(token => token === '-r')).toEqual(['-r'])
        // Local FILE → ssh: never.
        const fileUp = await run({ plan: { kind: 'local' }, path: join(home, 'file') }, { plan: { kind: 'ssh', host: 'dev3' }, path: '/tmp/x' })
        expect(fileUp.argv[0]).not.toContain('-r')
        // REMOTE source → local: no dialing to stat, no flag.
        const pull = await run({ plan: { kind: 'ssh', host: 'dev3' }, path: '/tmp/y' }, { plan: { kind: 'local' }, path: join(home, 'down') })
        expect(pull.argv[0]).not.toContain('-r')
        // Local directory → incus push: the route's own -r.
        const incus = await nativeCopy({ src: join(home, 'dir'), dst: 'incus:c1:/root/x' },
            { src: { plan: { kind: 'local' }, path: join(home, 'dir') }, dst: { plan: { kind: 'incus', container: 'c1' }, path: '/root/x' } },
            new AbortController().signal, { wrapArgv: wrap, execArgvFor: () => ['echo', 'existed'] }) as NativeCopyReceipt
        expect(incus.argv[0]!.filter(token => token === '-r')).toEqual(['-r'])
    }
    finally {
        await rm(home, { recursive: true, force: true });
    }
}, 30000);

it('F5 pin: docker cp "invalid symlink" failure gets the -L hint appended, other failures and successes do not', async () => {
    const home = await mkdtemp(join(tmpdir(), 'f5-pin-'));
    try {
        await writeFile(join(home, 'f'), 'f5');
        const failing = (stderrLine: string) => ['bash', '-c', `echo ${stderrLine} >&2; exit 1`]
        const copy = async (wrapArgv: (argv: string[]) => string[]) => await nativeCopy({ src: join(home, 'f'), dst: 'docker:c1:/root/f' },
            { src: { plan: { kind: 'local' }, path: join(home, 'f') }, dst: { plan: { kind: 'docker', container: 'c1' }, path: '/root/f' } },
            new AbortController().signal, { wrapArgv, execArgvFor: () => ['echo', 'existed'] }) as NativeCopyReceipt
        // The exact native error string arms the one-line remedy (user-env reproduced; local 29.1.3 does not).
        const hinted = await copy(() => failing('docker cp: invalid symlink: /etc/os-release'))
        expect(hinted.stderr.join('\n')).toMatch(/invalid symlink/)
        expect(hinted.stderr.join('\n')).toContain('hint: docker cp follows symlinks only with -L')
        // Any other failure: verbatim stderr, no hint.
        const plain = await copy(() => failing('docker cp: some other error'))
        expect(plain.stderr.join('\n')).not.toContain('hint:')
        // Success: untouched.
        const ok = await copy(() => ['bash', '-c', 'exit 0'])
        expect(ok.ok).toBe(true)
        expect(ok.stderr.join('\n')).not.toContain('hint:')
    }
    finally {
        await rm(home, { recursive: true, force: true });
    }
}, 30000);

it('F4 pin (human surface): a destination whose daemon dies before the marker fails with "daemon exited before serving" plus relay stderr', async () => {
    const { withSshFixture } = await import('./ssh-fixture.ts');
    const { mkdir, writeFile: wf } = await import('node:fs/promises');
    await withSshFixture(async f => {
        const d = new RemoteDriver({ nativeArgvFor: argv => (argv[0] === 'ssh' || argv[0] === 'scp') ? f.isolateOpts(argv) : argv });
        try {
            await d.call({ target: 'ssh:src', ssh: f.jump }, { sessionKey: 'spec' });
            await d.call({ target: 'ssh:dst', ssh: f.destination }, { sessionKey: 'spec' });
            const src = join(f.directory, 'f4-src')
            await mkdir(src)
            await wf(join(src, 'f'), 'f4')
            // Destination directory intentionally NOT created: the daemon script's
            // own directory check exits 64 before the SUPERD-RSYNC-TMP marker —
            // the 0.3.1-e race shape, now surfaced as an explicit human error.
            await expect(d.rsync({ src: `ssh:src:${src}/`, dst: `ssh:dst:${join(f.directory, 'f4-missing-dst')}/`, argv: ['-a'] }, new AbortController().signal))
                .rejects.toThrow(/daemon exited before serving/)
        }
        finally {
            await d.dispose();
        }
    });
}, 60000);
