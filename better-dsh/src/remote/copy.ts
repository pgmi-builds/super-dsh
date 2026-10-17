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
    route: 'hub-staged';
    /** S4: tier actually performed — sha256 digests ran and matched, or explicitly skipped. */
    verification: 'sha256' | 'not-applicable';
    /** S3 unified failure envelope. */
    ok: boolean;
    reason?: 'digest-mismatch' | 'staging-error' | 'aborted';
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
/** Tree lane (Hub/local binary endpoints) with staged archive and digest
 * verification. CLI-option fields are rejected: this lane has no native CLI. */
export async function copyTree(request: CopyRequest & { argv?: unknown; pullArgv?: unknown; pushArgv?: unknown }, source: {
    endpoint: BinaryFileEndpoint;
    path: string;
}, destination: {
    endpoint: BinaryFileEndpoint;
    path: string;
}, signal: AbortSignal, scratchRoot = join(process.cwd(), '.scratch')): Promise<TransferReceipt> {
    signal.throwIfAborted();
    if (request.argv !== undefined || request.pullArgv !== undefined || request.pushArgv !== undefined)
        throw new Error('copy: argv/pullArgv/pushArgv are native CLI options; the Hub/local staged lane does not accept CLI options');
    await mkdir(scratchRoot, { recursive: true });
    const receipt: TransferReceipt = { action: 'copy', route: 'hub-staged', src: request.src, dst: request.dst, ok: false, verification: 'not-applicable', bytes: 0, entries: 0, scope: 'transferred entries' };
    const scratch = await mkdtemp(join(scratchRoot, 'remote-copy-')), payload = join(scratch, 'payload.bin');
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
            receipt.verification = 'sha256';
        }
        signal.throwIfAborted();
        await rm(scratch, { recursive: true, force: true });
        receipt.ok = true;
        return receipt;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const reason: TransferReceipt['reason'] = signal.aborted ? 'aborted' : /mismatch/i.test(message) ? 'digest-mismatch' : 'staging-error';
        throw new CopyError({ ...receipt, ok: false, reason, scratch, error: message });
    }
}
