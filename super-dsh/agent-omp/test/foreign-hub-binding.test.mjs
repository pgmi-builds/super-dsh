import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OmpProvider } from '../dist/index.js';
import { registerForeignHubHost, foreignAgentHandle } from '@pgmi-builds/superd-hub/foreign-hub';

test('OMP binds the world home supplied by the official boot path function', async t => {
  const home = mkdtempSync(join(tmpdir(), 'omp-hub-'));
  const handle = { status: 'idle' };
  const close = registerForeignHubHost(home, {});
  t.after(async () => { await close(); rmSync(home, { recursive: true, force: true }); });
  const provider = Object.create(OmpProvider.prototype);
  provider.runtime = { ctx: { get: () => () => join(home, 'agents/omp'), agents: { get: id => id === 'omp-session' ? handle : undefined } } };
  const binding = provider.hubFor('omp-session');
  t.after(() => binding.dispose());
  assert.equal(binding.definition()?.name, 'superd-hub');
  assert.equal(foreignAgentHandle(home, 'omp-session'), handle);
});
