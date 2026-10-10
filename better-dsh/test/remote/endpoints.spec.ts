import { expect, it } from 'vitest';
import { mkdir, writeFile, readFile, symlink, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { withSshFixture } from './ssh-fixture.ts';
import { RemoteDriver } from '../../src/remote/driver.ts';
import { cliFileEndpoint, parseFileEndpoint } from '../../src/remote/endpoints.ts';
import { localFileEndpoint } from '../../src/remote/archive.ts';
import { shQuote } from '../../src/remote/transports.ts';
it('Node/Python carrier and selected SHA manifests agree through real SSH port/key/ProxyJump, including non-BMP ordering', async () => {
    await withSshFixture(async (fixture) => {
        const before = process.env.PATH, bin = join(fixture.directory, 'bin');
        await mkdir(bin);
        await writeFile(join(bin, 'ssh'), `#!/bin/sh\nexec /usr/bin/ssh -F ${shQuote(fixture.config)} "$@"\n`);
        await chmod(join(bin, 'ssh'), 0o700);
        process.env.PATH = bin + ':' + before;
        const driver = new RemoteDriver();
        try {
            driver.registerSsh('byossh:peer', { ...fixture.destination, proxyJump: 'fixture-jump' });
            const src = join(fixture.directory, 'src'), dst = join(fixture.directory, 'destination-tree'), again = join(fixture.directory, 'again');
            await mkdir(join(src, 'empty'), { recursive: true });
            await mkdir(dst);
            const bytes = randomBytes(220000);
            for (const name of ['雪\nname', '😀', '\ue000'])
                await writeFile(join(src, name), bytes);
            await writeFile(join(src, 'zero'), '');
            await symlink('雪\nname', join(src, 'link'));
            await writeFile(join(dst, 'extra'), 'untouched');
            const signal = new AbortController().signal;
            const phaseStarted=Date.now();console.log('endpoint phase: copy-in');const receipt = await driver.copy({ src, dst: `byossh:peer:${dst}` }, signal);
            console.log('endpoint copy-in elapsed',Date.now()-phaseStarted);expect(receipt.verified).toBe(true);
            expect(await readFile(join(dst, '雪\nname'))).toEqual(bytes);
            const remote = cliFileEndpoint(await driver.resolveConnectionTarget('byossh:peer'));
            console.log('endpoint phase: digests',Date.now()-phaseStarted);expect(await remote.digest(src, signal)).toEqual(await localFileEndpoint().digest(src, signal));
            expect(await remote.digest(dst, signal, ['', '雪\nname', '😀', '\ue000', 'zero', 'link', 'empty'])).toEqual(await localFileEndpoint().digest(src, signal));
            console.log('endpoint phase: copy-out',Date.now()-phaseStarted);expect((await driver.copy({ src: `byossh:peer:${src}`, dst: again }, signal)).verified).toBe(true);
            expect(await readFile(join(again, '😀'))).toEqual(bytes);
            expect(await readFile(join(dst, 'extra'), 'utf8')).toBe('untouched');
            console.log('endpoint phase: rejection cases',Date.now()-phaseStarted);const { Readable } = await import('node:stream');
            const header = (value: unknown) => { const b = Buffer.from(JSON.stringify(value)), n = Buffer.alloc(4); n.writeUInt32BE(b.length); return Buffer.concat([n, b]); };
            const malicious = Buffer.concat([header({ p: '', t: 'd', n: 0 }), header({ p: '../escape', t: 'f', n: 1 }), Buffer.from('x'), header({ end: true })]);
            await expect(remote.importTree(join(fixture.directory, 'malicious'), Readable.from([malicious]), { mkdir: true, signal })).rejects.toThrow(/unsafe/);
            console.log('endpoint malicious rejected',Date.now()-phaseStarted);await symlink(dst, join(fixture.directory, 'alias'));
            await expect(remote.importTree(join(fixture.directory, 'alias', 'new'), await localFileEndpoint().exportTree(src, signal), { mkdir: true, signal })).rejects.toThrow(/symlink|ancestor/);
            console.log('endpoint ancestor rejected',Date.now()-phaseStarted);await expect(readFile(join(fixture.directory, 'escape'))).rejects.toThrow();
            const linkSrc = join(fixture.directory, 'link-src'), linkDst = join(fixture.directory, 'link-dst');
            await mkdir(linkSrc);
            await mkdir(linkDst);
            await writeFile(join(linkSrc, 'a-first'), 'must-not-write');
            await symlink(dst, join(linkDst, 'alias'));
            await symlink('alias', join(linkDst, 'chain'));
            await symlink('chain/file', join(linkSrc, 'z-link'));
            await expect(remote.importTree(linkDst, await localFileEndpoint().exportTree(linkSrc, signal), { mkdir: true, signal })).rejects.toThrow(/symlink|link|unsafe/);
            await expect(readFile(join(linkDst, 'a-first'))).rejects.toThrow();console.log('endpoint all phases elapsed',Date.now()-phaseStarted);
        }
        finally {
            await driver.dispose();
            if (before === undefined)
                delete process.env.PATH;
            else
                process.env.PATH = before;
        }
    });
}, 90000);
it('endpoint parsing preserves prefixed targets and rejects relative paths and BYO-PTY', () => {
    expect(parseFileEndpoint('byossh:build:/data/雪\nname')).toEqual({ target: 'byossh:build', path: '/data/雪\nname' });
    for (const value of ['relative', 'byop:t:/tmp/a', 'ssh:x:/tmp/../escape', '/tmp/a\0'])
        expect(() => parseFileEndpoint(value)).toThrow();
});
it('cancelling an actual SSH Python import closes the helper and leaves no destination or named temporary file', async () => {
    const { PassThrough } = await import('node:stream'), { readdir, rm } = await import('node:fs/promises');
    await withSshFixture(async (fixture) => {
        const before = process.env.PATH, bin = join(fixture.directory, 'bin');
        await mkdir(bin);
        await writeFile(join(bin, 'ssh'), `#!/bin/sh\nexec /usr/bin/ssh -F ${shQuote(fixture.config)} "$@"\n`);
        await chmod(join(bin, 'ssh'), 0o700);
        process.env.PATH = bin + ':' + before;
        const dst = join(fixture.directory, 'cancel-destination'), signal = new AbortController(), source = new PassThrough();
        const endpoint = cliFileEndpoint({ kind: 'ssh', host: fixture.destination.host, connection: fixture.destination });
        const pending = endpoint.importTree(dst, source, { mkdir: true, signal: signal.signal }).then(() => undefined, error => error);
        const helpers = async () => {
            const pids: number[] = [];
            for (const pid of await readdir('/proc'))
                if (/^\d+$/.test(pid)) {
                    try {
                        const argv = (await readFile(`/proc/${pid}/cmdline`)).toString().split('\0');
                        if (argv[0]?.endsWith('python3') && argv.includes(dst))
                            pids.push(Number(pid));
                    }
                    catch { }
                }
            return pids;
        };
        try {
            let pids: number[] = [];
            for (let i = 0; i < 100; i++) {
                pids = await helpers();
                if (pids.length)
                    break;
                await new Promise(r => setTimeout(r, 20));
            }
            expect(pids.length).toBeGreaterThan(0);
            source.write(Buffer.alloc(100));
            signal.abort(new Error('fixture copy cancelled'));
            expect(String(await pending)).toMatch(/abort|cancel/i);
            await expect(readFile(dst)).rejects.toThrow();
            // Receiving ownership must be released before cancellation settles.
            expect(await helpers()).toEqual([]);
            expect((await readdir(fixture.directory)).some(n => n.startsWith('.remote-copy-'))).toBe(false);
        }
        finally {
            signal.abort();
            source.destroy();
            await pending;
            if (before === undefined)
                delete process.env.PATH;
            else
                process.env.PATH = before;
        }
    });
}, 12000);
