import { expect, it } from 'vitest';
import { parseFileEndpoint } from '../../src/remote/endpoints.ts';

it('endpoint parsing preserves prefixed targets and rejects relative paths and BYO-PTY', () => {
    expect(parseFileEndpoint('/absolute/path')).toEqual({ path: '/absolute/path' });
    expect(parseFileEndpoint('ssh:alias:/absolute/path')).toEqual({ target: 'ssh:alias', path: '/absolute/path' });
    expect(parseFileEndpoint('byossh:label:/absolute/path')).toEqual({ target: 'byossh:label', path: '/absolute/path' });
    expect(parseFileEndpoint('docker:name:/absolute/path')).toEqual({ target: 'docker:name', path: '/absolute/path' });
    expect(parseFileEndpoint('hub:machine:/absolute/path')).toEqual({ target: 'hub:machine', path: '/absolute/path' });
    expect(() => parseFileEndpoint('relative/path')).toThrow(/absolute/);
    expect(() => parseFileEndpoint('byop:label:/absolute/path')).toThrow(/BYO-PTY/);
});
