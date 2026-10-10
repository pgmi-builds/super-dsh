import { expect, it } from 'vitest';
import { mkdtemp, writeFile, readFile, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
it('rejects archive traversal and existing destination symlink ancestors before writes', async () => {
    const module = await import('../../src/remote/archive.ts').catch(() => ({}));
    expect(module).toHaveProperty('localFileEndpoint');
    const { localFileEndpoint } = module as typeof import('../../src/remote/archive.ts');
    const home = await mkdtemp(join(tmpdir(), 'archive-safety-'));
    try {
        await mkdir(join(home, 'src'));
        await writeFile(join(home, 'src', 'a'), 'safe');
        await mkdir(join(home, 'outside'));
        await symlink(join(home, 'outside'), join(home, 'alias'));
        const e = localFileEndpoint(), signal = new AbortController().signal;
        const data = await e.exportTree(join(home, 'src'), signal);
        await expect(e.importTree(join(home, 'alias', 'dst'), data, { signal, mkdir: true })).rejects.toThrow(/symlink|symbolic|unsafe/i);
        await expect(readFile(join(home, 'outside', 'dst', 'a'))).rejects.toThrow();
        await expect(e.importTree(join(home, 'dst'), Readable.from([Buffer.from('invalid carrier')]), { signal, mkdir: true })).rejects.toThrow();
    }
    finally {
        await rm(home, { recursive: true, force: true });
    }
});
it('preflights every malicious member and type conflict before writing any destination payload', async () => {
    const { localFileEndpoint } = await import('../../src/remote/archive.ts');
    const home = await mkdtemp(join(tmpdir(), 'archive-malicious-')), endpoint = localFileEndpoint(), signal = new AbortController().signal;
    const carrier = (entries: Array<Record<string, unknown>>) => Buffer.concat([...entries, { end: true }].flatMap(e => { const b = Buffer.from(JSON.stringify(e)), n = Buffer.alloc(4); n.writeUInt32BE(b.length); return [n, b, ...(e.t === 'f' ? [Buffer.alloc(Number(e.n), 65)] : [])]; }));
    try {
        const root = { p: '', t: 'd', n: 0 }, safe = { p: 'first', t: 'f', n: 1 };
        for (const bad of [{ p: '../escape', t: 'f', n: 1 }, { p: '/absolute', t: 'f', n: 1 }, { p: 'l', t: 'l', n: 0, link: '../../outside' }, { p: 'first/child', t: 'f', n: 1 }, { p: 'first', t: 'f', n: 1 }]) {
            await expect(endpoint.importTree(join(home, 'dst'), Readable.from([carrier([root, safe, bad])]), { mkdir: true, signal })).rejects.toThrow();
            await expect(readFile(join(home, 'dst', 'first'))).rejects.toThrow();
        }
        await mkdir(join(home, 'dst'));
        await writeFile(join(home, 'dst', 'conflict'), 'original');
        await expect(endpoint.importTree(join(home, 'dst'), Readable.from([carrier([root, safe, { p: 'conflict', t: 'd', n: 0 }])]), { mkdir: true, signal })).rejects.toThrow(/conflict/);
        await expect(readFile(join(home, 'dst', 'first'))).rejects.toThrow();
        expect(await readFile(join(home, 'dst', 'conflict'), 'utf8')).toBe('original');
    }
    finally {
        await rm(home, { recursive: true, force: true });
    }
});
it('rejects incoming symlink chains through preserved destination aliases before any writes', async () => {
    const { localFileEndpoint } = await import('../../src/remote/archive.ts');
    const home = await mkdtemp(join(tmpdir(), 'archive-link-chain-')), e = localFileEndpoint(), signal = new AbortController().signal;
    try {
        const src = join(home, 'src'), dst = join(home, 'dst'), outside = join(home, 'outside');
        await mkdir(src);
        await mkdir(dst);
        await mkdir(outside);
        await writeFile(join(src, 'a-first'), 'must-not-write');
        await writeFile(join(outside, 'file'), 'outside');
        await symlink(outside, join(dst, 'alias'));
        await symlink('alias', join(dst, 'chain'));
        for (const target of ['alias/file', 'chain/file']) {
            await symlink(target, join(src, 'z-link'));
            await expect(e.importTree(dst, await e.exportTree(src, signal), { mkdir: true, signal })).rejects.toThrow(/symlink|link|unsafe/i);
            await expect(readFile(join(dst, 'a-first'))).rejects.toThrow();
            await rm(join(src, 'z-link'));
        }
    }
    finally {
        await rm(home, { recursive: true, force: true });
    }
});
