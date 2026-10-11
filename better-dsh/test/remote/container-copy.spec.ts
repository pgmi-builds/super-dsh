import { expect, it } from 'vitest';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemoteDriver } from '../../src/remote/driver.ts';
import type { NativeCopyReceipt } from '../../src/remote/native-copy.ts';
const run = promisify(execFile);
const command = (program: string, args: string[]) => {
    const pending = run(program, args, { timeout: 120000 });
    // Incus init accepts configuration from stdin; EOF is required with execFile pipes.
    pending.child.stdin?.end();
    return pending;
};
it.each(['docker', 'incus'] as const)('%s native CLI roundtrips binary without helper installation and never claims verification', async (engine) => {
    const name = `superd-task6-${randomUUID().slice(0, 8)}`, dir = await mkdtemp(join(tmpdir(), 'container-copy-')), driver = new RemoteDriver();
    let created = false;
    try {
        if (engine === 'docker')
            await command('docker', ['run', '--pull=never', '-d', '--network', 'none', '--name', name, 'python:3.14-slim', 'sleep', '120']);
        else
            await command('incus', ['init', 'ctr1-clean-20261008', name, '--ephemeral', '--no-profiles', '--storage', 'default']);
        created = true;
        if (engine === 'incus')
            await command('incus', ['start', name]);
        // Native CLIs do not create destination parents; the fixture pre-creates them.
        if (engine === 'docker')
            await command('docker', ['exec', name, 'mkdir', '-p', '/root/task6']);
        else
            await command('incus', ['exec', name, '--', 'mkdir', '-p', '/root/task6']);
        const bytes = randomBytes(190000), src = join(dir, 'source'), dst = join(dir, 'result'), remote = `${engine}:${name}:/root/task6/雪\nfile`;
        bytes[0] = 0;
        bytes[1] = 255;
        await writeFile(src, bytes);
        const up = await driver.copy({ src, dst: remote }, new AbortController().signal) as NativeCopyReceipt;
        expect(up.route).toContain(engine);
        expect(up.exits).toEqual([0]);
        expect(up.verified).toBe(false);
        const down = await driver.copy({ src: remote, dst }, new AbortController().signal) as NativeCopyReceipt;
        expect(down.exits).toEqual([0]);
        expect(down.verified).toBe(false);
        expect(await readFile(dst)).toEqual(bytes);
        // Native failure passes through: a missing remote path is the CLI's exit.
        const missing = await driver.copy({ src: `${engine}:${name}:/root/no-such-file`, dst: join(dir, 'never') }, new AbortController().signal) as NativeCopyReceipt;
        expect(missing.exits[0]).not.toBe(0);
        expect(missing.stderr.join('\n')).toMatch(/no such file|No such file|not found|error/i);
        expect(missing.verified).toBe(false);
        expect(missing.route).toContain(engine);
    }
    finally {
        await driver.dispose();
        if (created) {
            if (engine === 'docker')
                await command('docker', ['rm', '--force', name]);
            else
                await command('incus', ['delete', '--force', name]);
        }
        await rm(dir, { recursive: true, force: true });
    }
}, 180000);

// Two-segment cross-endpoint copy: SSH↔Docker pulls to origin staging then
// pushes; pullArgv/pushArgv carry per-half native options.
it('copies SSH↔Docker with two native commands, per-half argv and origin staging', async () => {
    const { withSshFixture } = await import('./ssh-fixture.ts');
    await withSshFixture(async f => {
        const name = `superd-seg-${randomUUID().slice(0, 8)}`, dir = await mkdtemp(join(tmpdir(), 'container-copy-')), driver = new RemoteDriver({ nativeArgvFor: argv => (argv[0] === 'ssh' || argv[0] === 'scp') ? f.isolateOpts(argv) : argv });
        try {
            await command('docker', ['run', '--pull=never', '-d', '--network', 'none', '--name', name, 'python:3.14-slim', 'sleep', '120']);
            await command('docker', ['exec', name, 'mkdir', '-p', '/root/seg-dst']);
            driver.registerSsh('byossh:src', f.jump);
            const remote = join(f.directory, 'seg-src');
            const { mkdir } = await import('node:fs/promises');
            await mkdir(remote);
            await writeFile(join(remote, 'seg-file'), 'seg-payload');
            const receipt = await driver.copy({ src: `byossh:src:${remote}/`, dst: `docker:${name}:/root/seg-dst`, pullArgv: ['-r'], pushArgv: ['-a'] }, new AbortController().signal) as NativeCopyReceipt;
            expect(receipt.route).toContain('two native commands');
            expect(receipt.argv).toHaveLength(2);
            expect(receipt.argv[0]).toContain('-r');
            expect(receipt.argv[1]).toContain('-a');
            expect(receipt.exits).toEqual([0, 0]);
            expect(receipt.verified).toBe(false);
            expect(receipt.cleanup).toBe('released');
            // Each segment's native CLI decides layout: scp stages the source
            // tree under the staging dir, docker cp copies that staging dir
            // itself into the container destination.
            const { stdout } = await command('docker', ['exec', name, 'cat', '/root/seg-dst/staged/seg-file']);
            expect(stdout).toBe('seg-payload');
            // Mixing argv with pull/push is refused before any work.
            await expect(driver.copy({ src: `byossh:src:${remote}`, dst: `docker:${name}:/root/x`, argv: ['-r'], pullArgv: ['-r'], pushArgv: [] }, new AbortController().signal)).rejects.toThrow(/argv/);
        }
        finally {
            await driver.dispose();
            await command('docker', ['rm', '--force', name]);
            await rm(dir, { recursive: true, force: true });
        }
    })
}, 120000);
