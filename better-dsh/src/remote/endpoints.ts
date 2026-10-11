import { checkAbsolute } from './archive.ts';

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
