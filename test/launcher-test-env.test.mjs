import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const launcher = readFileSync('super-dsh/test/start-4999.sh', 'utf8');
const section = launcher.slice(launcher.indexOf('# ---- test preparation'), launcher.indexOf('# Auth seed awareness'));
for (const mode of ['retained', 'explicit', 'missing']) test(`test env ${mode}`, () => {
 const root = mkdtempSync(join(tmpdir(), 'task8-env-'));
 try {
  const home = join(root, 'user'); const target = join(root, 'test');
  mkdirSync(join(home, '.dsh'), {recursive:true}); mkdirSync(target);
  writeFileSync(join(home, '.dsh/.env'), 'FORBIDDEN_PROD_SENTINEL=1\n');
  const source = join(root, 'test-source.env'); writeFileSync(source, 'TEST_SOURCE=1\n');
  if (mode === 'retained') writeFileSync(join(target, '.env'), 'TEST_RETAINED=1\n');
  const result = spawnSync('bash', ['-euc', section], {encoding:'utf8',env:{PATH:process.env.PATH,HOME:home,DSH_HOME_DIR:target,...(mode==='explicit'?{SUPERD_TEST_ENV_FILE:source}:{})}});
  if (mode==='missing') { assert.notEqual(result.status,0); assert.match(result.stderr,/test.*env|env.*test/i); }
  else { assert.equal(result.status,0,result.stderr); assert.equal(readFileSync(join(target,'.env'),'utf8'), mode==='retained'?'TEST_RETAINED=1\n':'TEST_SOURCE=1\n'); assert.equal(statSync(join(target,'.env')).mode&0o777,0o600); }
 } finally {rmSync(root,{recursive:true,force:true});}
});

test('explicit test binary prefix reaches the actual launcher unit PATH', () => {
 const pathOption = launcher.split('\n').find(line => line.includes('--property=Environment="PATH='));
 const result = spawnSync('bash', ['-euc', 'printf "%s" '+pathOption.trim().replace(/\\$/, '')], {encoding:'utf8',env:{PATH:process.env.PATH,HOME:'/fixture/home',SUPERD_TEST_BIN_DIR:'/fixture/bin'}});
 assert.equal(result.status,0,result.stderr);
 assert.equal(result.stdout,'--property=Environment=PATH=/fixture/bin:/fixture/home/.local/bin:/usr/local/bin:/usr/bin:/bin');
});
