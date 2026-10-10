import { expect, it } from 'vitest';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemoteDriver } from '../../src/remote/driver.ts';
const run = promisify(execFile);
const command = (program: string, args: string[]) => {
    const pending = run(program, args, { timeout: 120000 });
    // Incus init accepts configuration from stdin; EOF is required with execFile pipes.
    pending.child.stdin?.end();
    return pending;
};
it.each(['docker', 'incus'] as const)('%s actual isolated local-image fixture roundtrips binary without TTY or helper installation', async (engine) => {
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
        // Prerequisite failure is evidence, never trigger an install in the fixture.
        await command(engine, engine === 'docker' ? ['exec', name, 'python3', '--version'] : ['exec', name, '--', 'python3', '--version']);
        const bytes = randomBytes(190000), src = join(dir, 'source'), dst = join(dir, 'result'), remote = `${engine}:${name}:/root/task6/雪\nfile`;
        bytes[0] = 0;
        bytes[1] = 255;
        await writeFile(src, bytes);
        expect((await driver.copy({ src, dst: remote }, AbortSignal.timeout(20000))).verified).toBe(true);
        expect((await driver.copy({ src: remote, dst }, AbortSignal.timeout(20000))).verified).toBe(true);
        expect(await readFile(dst)).toEqual(bytes);
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
it('missing Python 3 fails loudly without destination writes in a real Docker peer', async () => {
    const name = `superd-task6-${randomUUID().slice(0, 8)}`, dir = await mkdtemp(join(tmpdir(), 'container-copy-')), driver = new RemoteDriver();
    let created = false;
    try {
        await command('docker', ['run', '--pull=never', '-d', '--network', 'none', '--env', 'PATH=/missing', '--name', name, 'python:3.14-slim', '/bin/sleep', '60']);
        created = true;
        const src = join(dir, 'binary');
        await writeFile(src, randomBytes(500000));
        // Ruling26 surface: the receiving-owner prerequisite probe rejects loudly before
        // any transfer (no destination writes) instead of the legacy in-helper Python check.
        await expect(driver.copy({ src, dst: `docker:${name}:/tmp/no-python-output` }, AbortSignal.timeout(10000))).rejects.toThrow(/native receiving recovery prerequisite failed: Bash4\.1\+, Python3\.7\+/);
        await command('docker', ['exec', name, '/bin/test', '!', '-e', '/tmp/no-python-output']);
    }
    finally {
        await driver.dispose();
        if (created)
            await command('docker', ['rm', '--force', name]);
        await rm(dir, { recursive: true, force: true });
    }
}, 20000);
