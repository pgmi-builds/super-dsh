import { expect, it } from 'vitest';
import { parseFileEndpoint } from '../../src/remote/endpoints.ts';

it('endpoint parsing preserves prefixed targets and rejects relative paths and pty sessions', () => {
    expect(parseFileEndpoint('/absolute/path')).toEqual({ path: '/absolute/path' });
    expect(parseFileEndpoint('ssh:alias:/absolute/path')).toEqual({ target: 'ssh:alias', path: '/absolute/path' });
    expect(parseFileEndpoint('ssh:label:/absolute/path')).toEqual({ target: 'ssh:label', path: '/absolute/path' });
    expect(parseFileEndpoint('docker:name:/absolute/path')).toEqual({ target: 'docker:name', path: '/absolute/path' });
    expect(parseFileEndpoint('hub:machine:/absolute/path')).toEqual({ target: 'hub:machine', path: '/absolute/path' });
    expect(() => parseFileEndpoint('relative/path')).toThrow(/absolute/);
    expect(() => parseFileEndpoint('pty:label:/absolute/path')).toThrow(/PTY session/);
});
