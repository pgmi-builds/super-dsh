import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import type { BinaryFileEndpoint } from './hub-contract.ts';
import { inspectArchive, manifestDigest } from './archive.ts';
export interface CopyRequest {
    src: string;
    dst: string;
    verify?: boolean;
    mkdir?: boolean;
}
export interface TransferReceipt {
    action: 'copy';
    src: string;
    dst: string;
    verified: boolean;
    sourceDigest?: string;
    destinationDigest?: string;
    bytes: number;
    entries: number;
    scratch?: string;
    scope: 'transferred entries';
    error?: string;
}
export class CopyError extends Error {
    constructor(readonly receipt: TransferReceipt) { super(`copy failed: ${JSON.stringify(receipt)}`); }
}
export async function copyTree(request: CopyRequest, source: {
    endpoint: BinaryFileEndpoint;
    path: string;
}, destination: {
    endpoint: BinaryFileEndpoint;
    path: string;
}, signal: AbortSignal, scratchRoot = join(process.cwd(), '.scratch')): Promise<TransferReceipt> {
    signal.throwIfAborted();
    await mkdir(scratchRoot, { recursive: true });
    signal.throwIfAborted();
    const scratch = await mkdtemp(join(scratchRoot, 'remote-copy-')), payload = join(scratch, 'payload.bin');
    const receipt: TransferReceipt = { action: 'copy', src: request.src, dst: request.dst, verified: false, bytes: 0, entries: 0, scope: 'transferred entries' };
    try {
        const stream = await source.endpoint.exportTree(source.path, signal);
        await pipeline(stream, createWriteStream(payload, { flags: 'wx', mode: 0o600 }), { signal });
        const manifest = await inspectArchive(payload, signal), staged = manifestDigest(manifest);
        receipt.bytes = staged.bytes;
        receipt.entries = staged.entries;
        const selection = manifest.map(e => e.p);
        if (request.verify !== false) {
            const original = await source.endpoint.digest(source.path, signal, selection);
            receipt.sourceDigest = original.sha256;
            if (original.sha256 !== staged.sha256)
                throw new Error('source changed during export; staged digest mismatch');
        }
        signal.throwIfAborted();
        await destination.endpoint.importTree(destination.path, createReadStream(payload), { mkdir: request.mkdir ?? true, signal });
        if (request.verify !== false) {
            const dest = await destination.endpoint.digest(destination.path, signal, selection);
            receipt.destinationDigest = dest.sha256;
            if (dest.sha256 !== receipt.sourceDigest)
                throw new Error('destination digest mismatch');
            receipt.verified = true;
        }
        signal.throwIfAborted();
        await rm(scratch, { recursive: true, force: true });
        return receipt;
    }
    catch (error) {
        throw new CopyError({ ...receipt, verified: false, scratch, error: error instanceof Error ? error.message : String(error) });
    }
}
