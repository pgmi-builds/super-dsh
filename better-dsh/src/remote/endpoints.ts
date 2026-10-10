import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { BinaryFileEndpoint } from './hub-contract.ts';
import type { TargetPlan } from './target.ts';
import { sshArgv } from './ssh-targets.ts';
import { shQuote } from './transports.ts';
import { startOwnedBinaryProcess } from './ssh-process.ts';
import { FILE_PYTHON } from './archive-python.ts';
import { checkAbsolute, checkSelection } from './archive.ts';
export function parseFileEndpoint(value: string): {
    target?: string;
    path: string;
} {
    if (typeof value !== 'string' || !value)
        throw new Error('file endpoint required');
    if (value.startsWith('/')) {
        checkAbsolute(value);
        return { path: value };
    }
    const split = value.lastIndexOf(':/');
    if (split < 1)
        throw new Error('file endpoint must be [target:]absolute/path');
    const target = value.slice(0, split), path = value.slice(split + 1);
    checkAbsolute(path);
    if (target.startsWith('byop:'))
        throw new Error('BYO-PTY has no binary file lane; select SSH/Docker/Incus/Hub');
    return { target, path };
}
export function fileArgv(plan: TargetPlan, op: string, path: string, mkdir = false): string[] {
    const args = ['python3', '-c', FILE_PYTHON, op, path, String(mkdir)];
    switch (plan.kind) {
        case 'ssh': return sshArgv(plan.connection ?? { host: plan.host }, { command: args.map(shQuote).join(' ') });
        case 'docker': return ['docker', 'exec', '-i', '--', plan.container, ...args];
        case 'incus': return ['incus', 'exec', '--force-noninteractive', plan.container, '--', ...args];
    }
}
/** Shared process-group lifecycle; binary stdout never enters the text output ring. */
export function cliFileEndpoint(plan: TargetPlan): BinaryFileEndpoint {
    const run = async (op: string, path: string, signal: AbortSignal, mkdir = false) => {
        checkAbsolute(path);
        signal.throwIfAborted();
        const child = await startOwnedBinaryProcess(plan, ['python3', '-c', FILE_PYTHON, op, path, String(mkdir)], signal);
        let stderr = '';
        child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-8000); });
        const cancel = () => child.cancel();
        signal.addEventListener('abort', cancel, { once: true });
        const done = child.done.then(result => {
            signal.removeEventListener('abort', cancel);
            if (signal.aborted)
                throw signal.reason;
            if (result.exit !== 0)
                throw new Error(`binary CLI ${op} failed (receiving owner requires Bash 4.1+, Python 3.7+, fcntl and shared monotonic clock; containers also ctypes/subreaper): ${child.diagnostic() ?? stderr ?? result.exit}`);
        });
        void done.catch(() => { });
        return { child, done };
    };
    return {
        async exportTree(path, signal) {
            const { child, done } = await run('export', path, signal);
            child.stdin.end();
            return Readable.from((async function* () { try {
                for await (const chunk of child.stdout)
                    yield chunk;
                await done;
            }
            finally {
                child.cancel();
                await done.catch(() => { });
            } })());
        },
        async importTree(path, source, { mkdir, signal }) {
            const { child, done } = await run('import', path, signal, mkdir);
            child.stdout.resume();
            try {
                await pipeline(source, child.stdin, { signal });
                await done;
            }
            catch (error) {
                child.cancel();
                await done;
                throw error;
            }
            finally {
                child.cancel();
                await done.catch(() => { });
            }
        },
        async digest(path, signal, selection) {
            if (selection)
                checkSelection(selection);
            const { child, done } = await run('digest', path, signal);
            child.stdin.end(selection ? JSON.stringify(selection) : '');
            let data = '';
            try {
                for await (const chunk of child.stdout) {
                    data += String(chunk);
                    if (data.length > 8192)
                        throw new Error('oversized digest response');
                }
                ;
                await done;
                return JSON.parse(data);
            }
            finally {
                child.cancel();
                await done.catch(() => { });
            }
        },
    };
}
