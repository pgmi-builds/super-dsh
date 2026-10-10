/** Native Node receiver worker. Loaded from the private generated worker leaf, never a TS loader or host plugin resolver.
 * Parent owns the root and every announced temporary path after group cleanup, even on KILL.
 */
import { mkdirSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { localFileEndpoint, FILE_MAX_METADATA } from './archive.ts';
export async function runFileWorker(request: {
    action: 'export' | 'import' | 'digest';
    path: string;
    mkdir: boolean;
    root: string;
    selected: boolean;
}): Promise<void> {
    const abort = new AbortController(), cancel = () => abort.abort(new Error('binary file worker cancelled'));
    process.on('SIGTERM', cancel);
    process.on('SIGHUP', cancel);
    const report = (value: unknown) => new Promise<void>((resolve, reject) => process.stderr.write(JSON.stringify(value) + '\n', error => error ? reject(error) : resolve()));
    try {
        mkdirSync(request.root, { mode: 0o700 });
        const endpoint = localFileEndpoint({ receiveRoot: request.root, temporary: (path, active) => report({ temporary: path, active }) });
        if (request.action === 'export')
            await pipeline(await endpoint.exportTree(request.path, abort.signal), process.stdout, { signal: abort.signal });
        else if (request.action === 'import')
            await endpoint.importTree(request.path, process.stdin, { mkdir: request.mkdir, signal: abort.signal });
        else {
            let metadata = '';
            process.stdin.setEncoding('utf8');
            for await (const chunk of process.stdin) {
                metadata += String(chunk);
                if (Buffer.byteLength(metadata) > FILE_MAX_METADATA)
                    throw new Error('file selection metadata limit exceeded');
            }
            process.stdout.write(JSON.stringify(await endpoint.digest(request.path, abort.signal, request.selected ? JSON.parse(metadata) : undefined)));
        }
    }
    catch (error) {
        await report({ error: error instanceof Error ? error.message : String(error) }).catch(() => { });
        process.exitCode = 1;
    }
    finally {
        process.removeListener('SIGTERM', cancel);
        process.removeListener('SIGHUP', cancel);
    }
}
