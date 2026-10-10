/** Binary carrier v1: uint32 JSON header length, UTF-8 header, exactly n file bytes.
 * An explicit end header terminates the carrier. Metadata is bounded, data streams.
 */
import { createReadStream, createWriteStream, constants } from 'node:fs';
import { open, lstat, readdir, readlink, mkdir, mkdtemp, rm, symlink, rename } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, posix } from 'node:path';
import type { BinaryFileEndpoint } from './hub-contract.ts';
export const FILE_FRAME_BYTES = 64 * 1024;
export const FILE_MAX_ENTRIES = 10000;
export const FILE_MAX_METADATA = 8 * 1024 * 1024;
export interface FileEntry {
    p: string;
    t: 'f' | 'd' | 'l';
    n: number;
    link?: string;
    hash?: string;
    offset?: number;
}
const order = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
export function checkRelative(p: string): void {
    if (typeof p !== 'string' || Buffer.byteLength(p) > 4096 || p.includes('\0') || (p !== '' && (p.startsWith('/') || p.split('/').some(s => !s || s === '.' || s === '..'))))
        throw new Error('unsafe archive relative path');
}
export function checkAbsolute(p: string): void {
    if (typeof p !== 'string' || !p.startsWith('/') || p.includes('\0') || p.split('/').includes('..'))
        throw new Error('file endpoint requires an absolute path without traversal or NUL');
}
export function checkSelection(selection: readonly string[]): void {
    if (selection.length > FILE_MAX_ENTRIES || Buffer.byteLength(JSON.stringify(selection)) > FILE_MAX_METADATA)
        throw new Error('file selection metadata limit exceeded');
    const seen = new Set<string>();
    for (const p of selection) {
        checkRelative(p);
        if (seen.has(p))
            throw new Error('duplicate selection path');
        seen.add(p);
    }
}
function checkLink(e: FileEntry) {
    const link = e.link;
    if (e.p === '' || typeof link !== 'string' || !link || link.includes('\0') || link.startsWith('/') || Buffer.byteLength(link) > 4096)
        throw new Error('unsafe archive symlink');
    const target = posix.normalize(posix.join(posix.dirname(e.p), link));
    if (target === '..' || target.startsWith('../'))
        throw new Error('unsafe archive symlink escape');
}
/** Conservative effective resolution: links may traverse only members of this incoming tree.
 * Preserved destination extras cannot supply a symlink target or any of its ancestors.
 */
function checkTreeLinks(entries: readonly FileEntry[]) {
    const incoming = new Map(entries.map(e => [e.p, e]));
    for (const link of entries.filter(e => e.t === 'l')) {
        const stack = posix.dirname(link.p) === '.' ? [] : posix.dirname(link.p).split('/');
        let pending = link.link!.split('/'), hops = 0;
        while (pending.length) {
            const part = pending.shift()!;
            if (!part || part === '.')
                continue;
            if (part === '..') {
                if (!stack.length)
                    throw new Error('unsafe symlink chain escape');
                stack.pop();
                continue;
            }
            const entry = incoming.get([...stack, part].join('/'));
            if (!entry)
                throw new Error('unsafe symlink target outside incoming tree (destination aliases are not followed)');
            if (entry.t === 'l') {
                if (++hops > 40)
                    throw new Error('unsafe symlink cycle or chain limit');
                pending = [...entry.link!.split('/'), ...pending];
            }
            else {
                if (pending.length && entry.t !== 'd')
                    throw new Error('unsafe symlink non-directory target ancestor');
                stack.push(part);
            }
        }
    }
}
function header(e: unknown) { const b = Buffer.from(JSON.stringify(e)), n = Buffer.alloc(4); n.writeUInt32BE(b.length); return Buffer.concat([n, b]); }
export function manifestDigest(entries: readonly FileEntry[]) {
    const hash = createHash('sha256');
    let bytes = 0;
    for (const e of [...entries].sort((a, b) => order(a.p, b.p))) {
        hash.update(header([e.p, e.t, e.n, e.t === 'f' ? e.hash : e.t === 'l' ? e.link : '']));
        if (e.t === 'f')
            bytes += e.n;
    }
    return { sha256: hash.digest('hex'), bytes, entries: entries.length };
}
/** Reject even existing parent symlinks; leaf may be an explicitly copied symlink. */
async function ancestors(path: string, includeLeaf = false) {
    checkAbsolute(path);
    const parts = resolve(path).split('/').filter(Boolean);
    for (let i = 1; i <= parts.length - (includeLeaf ? 0 : 1); i++) {
        try {
            const st = await lstat('/' + parts.slice(0, i).join('/'));
            if (st.isSymbolicLink() || !st.isDirectory())
                throw new Error('unsafe destination/source ancestor: symlink or non-directory');
        }
        catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
                throw e;
        }
    }
}
async function safeRead(path: string, signal: AbortSignal) {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    return file.createReadStream({ autoClose: true, highWaterMark: FILE_FRAME_BYTES, signal });
}
async function entryAt(root: string, p: string, signal: AbortSignal): Promise<FileEntry> {
    signal.throwIfAborted();
    const path = p ? join(root, p) : root;
    await ancestors(path);
    const st = await lstat(path);
    if (st.isDirectory())
        return { p, t: 'd', n: 0 };
    if (st.isSymbolicLink()) {
        const e: FileEntry = { p, t: 'l', n: 0, link: await readlink(path) };
        checkLink(e);
        return e;
    }
    if (!st.isFile())
        throw new Error('unsupported file type (only files, directories and safe relative symlinks)');
    const hash = createHash('sha256');
    for await (const chunk of await safeRead(path, signal))
        hash.update(chunk);
    return { p, t: 'f', n: st.size, hash: hash.digest('hex') };
}
async function tree(root: string, signal: AbortSignal, selection?: readonly string[]) {
    checkAbsolute(root);
    const entries: FileEntry[] = [];
    const visit = async (p: string): Promise<void> => {
        const e = await entryAt(root, p, signal);
        entries.push(e);
        if (entries.length > FILE_MAX_ENTRIES)
            throw new Error('archive entry limit exceeded');
        if (e.t === 'd')
            for (const name of (await readdir(p ? join(root, p) : root)).sort(order))
                await visit(p ? `${p}/${name}` : name);
    };
    if (selection) {
        checkSelection(selection);
        for (const p of selection)
            entries.push(await entryAt(root, p, signal));
    }
    else
        await visit('');
    if (Buffer.byteLength(JSON.stringify(entries)) > FILE_MAX_METADATA)
        throw new Error('archive metadata limit exceeded');
    return entries;
}
export async function inspectArchive(path: string, signal: AbortSignal): Promise<FileEntry[]> {
    const file = await open(path, 'r');
    let offset = 0, metadata = 0;
    const entries: FileEntry[] = [];
    const seen = new Map<string, FileEntry>();
    const exact = async (n: number) => {
        const b = Buffer.alloc(n);
        let at = 0;
        while (at < n) {
            signal.throwIfAborted();
            const r = await file.read(b, at, n - at, offset);
            if (!r.bytesRead)
                throw new Error('truncated binary archive');
            at += r.bytesRead;
            offset += r.bytesRead;
        }
        ;
        return b;
    };
    try {
        while (true) {
            const size = (await exact(4)).readUInt32BE();
            if (!size || size > FILE_FRAME_BYTES)
                throw new Error('archive header limit exceeded');
            metadata += size;
            if (metadata > FILE_MAX_METADATA)
                throw new Error('archive metadata limit exceeded');
            const e = JSON.parse((await exact(size)).toString('utf8')) as FileEntry & {
                end?: boolean;
            };
            if (e.end === true) {
                if ((await file.stat()).size !== offset)
                    throw new Error('trailing archive bytes');
                break;
            }
            checkRelative(e.p);
            if (!['f', 'd', 'l'].includes(e.t) || !Number.isSafeInteger(e.n) || e.n < 0 || (e.t !== 'f' && e.n !== 0))
                throw new Error('unsafe archive type/size');
            if (entries.length >= FILE_MAX_ENTRIES || seen.has(e.p))
                throw new Error('archive entry limit or duplicate path');
            if (e.p !== '' && seen.get(posix.dirname(e.p) === '.' ? '' : posix.dirname(e.p))?.t !== 'd')
                throw new Error('unsafe archive parent ordering/type');
            if (!entries.length && e.p !== '')
                throw new Error('archive root missing');
            if (e.t === 'l')
                checkLink(e);
            e.offset = offset;
            if (e.t === 'f') {
                const hash = createHash('sha256');
                let left = e.n;
                while (left) {
                    const chunk = await exact(Math.min(FILE_FRAME_BYTES, left));
                    hash.update(chunk);
                    left -= chunk.length;
                }
                ;
                e.hash = hash.digest('hex');
            }
            entries.push(e);
            seen.set(e.p, e);
        }
        if (!entries.length)
            throw new Error('archive root missing');
        return entries;
    }
    finally {
        await file.close();
    }
}
async function importArchive(destination: string, payload: string, mkdirParents: boolean, signal: AbortSignal, resources: LocalFileResources) {
    checkAbsolute(destination);
    const entries = await inspectArchive(payload, signal);
    checkTreeLinks(entries);
    // Preflight the complete tree before any destination mutation.
    for (const e of entries) {
        const path = e.p ? join(destination, e.p) : destination;
        await ancestors(path);
        try {
            const st = await lstat(path);
            const type = st.isSymbolicLink() ? 'l' : st.isDirectory() ? 'd' : st.isFile() ? 'f' : '?';
            if (type !== e.t || type === 'l')
                throw new Error('destination path/type conflict or existing symlink');
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                throw error;
        }
    }
    await ancestors(destination);
    if (mkdirParents)
        await mkdir(dirname(destination), { recursive: true });
    for (const e of entries) {
        signal.throwIfAborted();
        const path = e.p ? join(destination, e.p) : destination;
        await ancestors(path);
        if (e.t === 'd') {
            await mkdir(path, { recursive: false }).catch(error => {
                if (error.code !== 'EEXIST')
                    throw error;
            });
            continue;
        }
        if (e.t === 'l') {
            await symlink(e.link!, path);
            continue;
        }
        const temporary = join(dirname(path), `.remote-copy-${randomUUID()}`);
        await resources.temporary?.(temporary, true);
        try {
            const output = createWriteStream(temporary, { flags: 'wx', mode: 0o600 });
            await pipeline(e.n ? createReadStream(payload, { start: e.offset!, end: e.offset! + e.n - 1 }) : Readable.from([]), output, { signal });
            await ancestors(path);
            signal.throwIfAborted();
            // Rename replaces a leaf symlink rather than following it; ancestor checks reject escapes.
            await rename(temporary, path);
        }
        finally {
            await rm(temporary, { force: true });
            await resources.temporary?.(temporary, false);
        }
    }
}
/** Internal worker ownership hooks, not a second endpoint contract. */
export interface LocalFileResources {
    receiveRoot?: string;
    temporary?(path: string, active: boolean): Promise<void>;
}
export function localFileEndpoint(resources: LocalFileResources = {}): BinaryFileEndpoint {
    return {
        async exportTree(path, signal) {
            const entries = await tree(path, signal);
            return Readable.from((async function* () {
                for (const e of entries) {
                    signal.throwIfAborted();
                    yield header({ p: e.p, t: e.t, n: e.n, ...(e.link === undefined ? {} : { link: e.link }) });
                    if (e.t === 'f' && e.n)
                        for await (const chunk of await safeRead(e.p ? join(path, e.p) : path, signal))
                            yield chunk;
                }
                yield header({ end: true });
            })());
        },
        async importTree(path, source, { mkdir: parents, signal }) {
            checkAbsolute(path);
            const scratch = resources.receiveRoot ?? await mkdtemp(join(tmpdir(), 'remote-file-receive-'));
            try {
                const payload = join(scratch, 'payload');
                await pipeline(source, createWriteStream(payload, { flags: 'wx', mode: 0o600 }), { signal });
                await importArchive(path, payload, parents, signal, resources);
            }
            finally {
                (source as Readable).destroy?.();
                await rm(scratch, { recursive: true, force: true });
            }
        },
        async digest(path, signal, selection) { return manifestDigest(await tree(path, signal, selection)); },
    };
}
