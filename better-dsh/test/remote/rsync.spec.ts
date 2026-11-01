import { it, expect } from 'vitest'
import { mkdir, writeFile, readFile, readdir, access, symlink, lstat, readlink, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes, createHash } from 'node:crypto'
import { RemoteDriver } from '../../src/remote/driver.ts'
import { withSshFixture } from './ssh-fixture.ts'
import { createRealRemoteHarness } from './real-harness.ts'

// Task 1 (native shortcut spec): argv is an ordered native option array; no
// forced archive/timeout/dry-run; removed high-level fields are rejected
// explicitly rather than silently ignored (parameter roots are open objects,
// so schema removal alone would let them pass through).
it('passes ordered native argv tokens without forced options and rejects removed high-level fields', async () => {
  await withSshFixture(async f => {
    const d = new RemoteDriver({ nativeArgvFor: argv => argv[0] === 'ssh' ? f.isolate(argv) : argv })
    try {
      await d.call({ target: 'ssh:remote', ssh: f.destination }, { sessionKey: 'spec' })
      const src = join(f.directory, 'argv-source'), dst = join(f.directory, 'argv-dst')
      await writeFile(src, 'argv-token-payload\n')
      // No argv: plain rsync defaults — a file copy works without any hidden
      // --dry-run, and no archive/-a/--timeout is injected. Directories would
      // need -r by native semantics (no forced recursion either).
      const plain = await d.rsync({ src, dst: `ssh:remote:${dst}` }, new AbortController().signal, { sessionKey: 'spec' })
      expect(plain.exit).toBe(0)
      expect(await readFile(dst, 'utf8')).toBe('argv-token-payload\n')
      expect(plain.argv).toEqual([])
      expect(plain.command).toContain('rsync')
      expect(plain.command).not.toContain('--dry-run')
      expect(plain.command).not.toContain('--timeout')
      // Explicit ordered argv passes through verbatim, one token per element.
      const dry = await d.rsync({ src, dst: `ssh:remote:${dst}`, argv: ['--itemize-changes', '--dry-run'] }, new AbortController().signal, { sessionKey: 'spec' })
      expect(dry.exit).toBe(0)
      expect(dry.argv).toEqual(['--itemize-changes', '--dry-run'])
      // --dry-run means no destination write.
      await writeFile(src, 'changed-payload\n')
      await d.rsync({ src, dst: `ssh:remote:${dst}`, argv: ['--dry-run'] }, new AbortController().signal, { sessionKey: 'spec' })
      expect(await readFile(dst, 'utf8')).toBe('argv-token-payload\n')
      // Removed high-level fields are refused before dialing.
      for (const legacy of [ { dryRun: true }, { dryRun: false }, { delete: true }, { excludes: ['x'] }, { preserve: false } ])
        await expect(d.rsync({ src, dst: `ssh:remote:${dst}`, ...(legacy as object) } as never, new AbortController().signal, { sessionKey: 'spec' })).rejects.toThrow(/dryRun|delete|excludes|preserve/)
    } finally { await d.dispose() }
  })
}, 40000)

it('rejects malformed argv shapes before dialing', async () => {
  await withSshFixture(async f => {
    const d = new RemoteDriver({ nativeArgvFor: argv => argv[0] === 'ssh' ? f.isolate(argv) : argv })
    try {
      await d.call({ target: 'ssh:remote', ssh: f.destination }, { sessionKey: 'spec' })
      const dst = join(f.directory, 'shape-dst')
      for (const bad of [ 'string', 5, {}, [5], [null], ['ok', undefined as unknown as string] ])
        await expect(d.rsync({ src: '/no/dial', dst: `ssh:remote:${dst}`, argv: bad as never }, new AbortController().signal, { sessionKey: 'spec' })).rejects.toThrow(/argv/)
      await expect(d.rsync({ src: '/no/dial', dst: `ssh:remote:${dst}`, argv: ['-a'], pullArgv: ['-a'] } as never, new AbortController().signal, { sessionKey: 'spec' })).rejects.toThrow(/pullArgv|pushArgv|argv/)
      await expect(d.rsync({ src: '/no/dial', dst: `ssh:remote:${dst}`, argv: [] , pushArgv: [] } as never, new AbortController().signal, { sessionKey: 'spec' })).rejects.toThrow(/pullArgv|pushArgv|argv/)
      // rsync never had pull/push segmentation: those fields are refused outright.
      await expect(d.rsync({ src: '/no/dial', dst: `ssh:remote:${dst}`, pullArgv: ['-a'], pushArgv: ['-p'] } as never, new AbortController().signal, { sessionKey: 'spec' })).rejects.toThrow(/pullArgv/)
    } finally { await d.dispose() }
  })
}, 20000)

// Task 3 (native shortcut spec): local↔SSH native rsync with caller-chosen
// options. --dry-run writes nothing; --delete/--exclude/--partial/--inplace are
// the caller's choice and only the caller's choice; a large file with a small
// change produces real native delta (Matched data) when --stats is requested;
// trailing-slash semantics stay rsync-native.
it('runs local↔SSH native rsync with caller options, dry-run discipline and native delta', async () => {
  await withSshFixture(async f => {
    const d = new RemoteDriver({ nativeArgvFor: argv => argv[0] === 'ssh' ? f.isolate(argv) : argv })
    try {
      await d.call({ target: 'ssh:remote', ssh: f.destination }, { sessionKey: 'spec' })
      const src = join(f.directory, 'delta-src'), dst = join(f.directory, 'delta-dst')
      await mkdir(src); await mkdir(dst)
      const file = join(src, 'binary'), bytes = randomBytes(8 * 1024 * 1024)
      await writeFile(file, bytes)
      // Explicit --dry-run: no destination data changes.
      const dry = await d.rsync({ src: `${src}/`, dst: `ssh:remote:${dst}/`, argv: ['-a', '--dry-run'] }, new AbortController().signal, { sessionKey: 'spec' })
      expect(dry.exit).toBe(0)
      await expect(access(join(dst, 'binary'))).rejects.toThrow()
      // Real sync with -a and --stats; the receipt parses only what the CLI printed.
      const initial = await d.rsync({ src: `${src}/`, dst: `ssh:remote:${dst}/`, argv: ['-a', '--stats'] }, new AbortController().signal, { sessionKey: 'spec' })
      expect(initial.exit).toBe(0)
      expect(createHash('sha256').update(await readFile(join(dst, 'binary'))).digest('hex')).toBe(createHash('sha256').update(bytes).digest('hex'))
      expect(initial.literalBytes).toBeGreaterThan(0)
      expect(initial.command).toContain('--stats')
      // Small change: real native delta — matched bytes dominate when --stats is present.
      bytes.write('SMALL-DELTA\0\xff', 4000000, 'latin1'); await writeFile(file, bytes)
      await utimes(file, new Date(), new Date(Date.now() + 5000))
      const delta = await d.rsync({ src: `${src}/`, dst: `ssh:remote:${dst}/`, argv: ['-a', '--stats'] }, new AbortController().signal, { sessionKey: 'spec' })
      expect(delta.exit).toBe(0)
      expect(delta.matchedBytes ?? 0).toBeGreaterThan(8e6)
      expect(createHash('sha256').update(await readFile(join(dst, 'binary'))).digest('hex')).toBe(createHash('sha256').update(await readFile(file)).digest('hex'))
      // Without --stats no fields are fabricated: literal/matched stay undefined.
      const plain = await d.rsync({ src: file, dst: `ssh:remote:${join(dst, 'binary')}`, argv: ['-a'] }, new AbortController().signal, { sessionKey: 'spec' })
      expect(plain.exit).toBe(0)
      expect(plain.literalBytes).toBeUndefined()
      expect(plain.matchedBytes).toBeUndefined()
    } finally { await d.dispose() }
  })
}, 60000)

// Caller-chosen destructive options stay exactly that: --delete removes
// destination extras; --exclude skips entries; nothing is forced on.
it('honors caller --delete/--exclude and native trailing-slash semantics', async () => {
  await withSshFixture(async f => {
    const d = new RemoteDriver({ nativeArgvFor: argv => argv[0] === 'ssh' ? f.isolate(argv) : argv })
    try {
      await d.call({ target: 'ssh:remote', ssh: f.destination }, { sessionKey: 'spec' })
      const src = join(f.directory, 'tree'), dst = join(f.directory, 'tree-dst')
      await mkdir(src); await mkdir(dst)
      await writeFile(join(src, 'keep'), 'binary\0\xff')
      await writeFile(join(src, 'excluded'), 'skip')
      await writeFile(join(dst, 'extra'), 'remove')
      // Trailing slash on src copies contents; no slash copies the named directory.
      const up = await d.rsync({ src: `${src}/`, dst: `ssh:remote:${dst}/`, argv: ['-a', '--exclude=excluded'] }, new AbortController().signal, { sessionKey: 'spec' })
      expect(up.exit).toBe(0)
      expect(await readdir(dst)).toEqual(['extra', 'keep'])
      const deleted = await d.rsync({ src: `${src}/`, dst: `ssh:remote:${dst}/`, argv: ['-a', '--delete', '--exclude=excluded'] }, new AbortController().signal, { sessionKey: 'spec' })
      expect(deleted.exit).toBe(0)
      expect(await readdir(dst)).toEqual(['keep'])
      // No-slash source copies the named directory itself.
      const nested = join(f.directory, 'nested'); await mkdir(nested)
      await d.rsync({ src, dst: `ssh:remote:${nested}/`, argv: ['-a'] }, new AbortController().signal, { sessionKey: 'spec' })
      expect(await readFile(join(nested, 'tree', 'keep'), 'utf8')).toBe('binary\0\xff')
      // Symlinks survive -a; caller can choose other semantics natively.
      await symlink('keep', join(src, 'link'))
      const linked = await d.rsync({ src: `${src}/`, dst: `ssh:remote:${dst}/`, argv: ['-a'] }, new AbortController().signal, { sessionKey: 'spec' })
      expect(linked.exit).toBe(0)
      expect((await lstat(join(dst, 'link'))).isSymbolicLink()).toBe(true)
      expect(await readlink(join(dst, 'link'))).toBe('keep')
      // Native failure: missing source surfaces the CLI's own error.
      const bad = await d.rsync({ src: join(f.directory, 'missing'), dst: `ssh:remote:${nested}/`, argv: ['-a'] }, new AbortController().signal, { sessionKey: 'spec' })
      expect(bad.exit).not.toBe(0)
      expect(bad.stderr).toContain('No such file')
      // Mixed transports remain rejected.
      await expect(d.rsync({ src: `docker:x:${src}`, dst: join(f.directory, 'x'), argv: ['-a'] }, new AbortController().signal, { sessionKey: 'spec' })).rejects.toThrow(/SSH|rsync supports/)
    } finally { await d.dispose() }
  })
}, 60000)

// Real scoped tool: argv passes through the schema, defaults are gone, and the
// description no longer advertises forced dry-run or Python prerequisites.
it('declares native argv Surface and returns native receipts through the real scoped tool', async () => {
  await withSshFixture(async f => {
    const h = await createRealRemoteHarness({ copies: 1, driverOptions: { nativeArgvFor: (argv: string[]) => argv[0] === 'ssh' ? f.isolate(argv) : argv } })
    try {
      const a = await h.createAgent('rsync-tool'), src = join(f.directory, 'source'), dst = join(f.directory, 'dest')
      await mkdir(src); await mkdir(dst); await writeFile(join(src, 'test'), 'content')
      await h.invoke(a, { action: 'add', target: 'ssh:dest', ssh: f.destination })
      const transfer = h.visibleTools(a).find(t => t.name === 'remote_transfer')!.description
      expect(transfer).toContain('argv')
      // The transfer surface needs no Python at all (native CLIs and the Hub binary lane only).
      expect(transfer).not.toContain('Python')
      // The execution surface keeps the oneshot supervision guarantee.
      expect(h.visibleTools(a).find(t => t.name === 'remote')!.description).toContain('POSIX shim')
      const receipt = ((await h.invoke(a, { mode: 'rsync', src: `${src}/`, dst: `ssh:dest:${dst}/`, argv: ['-a'] }, 'remote_transfer')) as unknown as { text: string; receipt: Record<string, unknown> }).receipt
      expect(receipt).toMatchObject({ action: 'rsync', exit: 0, verification: 'native-exit-only', ok: true })
      expect(receipt.argv).toEqual(['-a'])
      expect(receipt.verified).toBeUndefined()
      expect(await readFile(join(dst, 'test'), 'utf8')).toBe('content')
      // A real native failure is reported, not hidden as a schema error.
      await expect(h.invoke(a, { mode: 'rsync', src: join(src, 'missing'), dst: `ssh:dest:${dst}/`, argv: ['-a'] }, 'remote_transfer')).rejects.toThrow(/No such file/)
    } finally { await h.dispose() }
  })
}, 40000)

// IPv6 and BYO identity survive the native RSYNC_RSH wiring: the placeholder
// host is consumed on the origin, the canonical ssh argv carries the address.
it('uses the full canonical IPv6 SSH identity without rsync misparsing the host', async () => {
  await withSshFixture(async f => {
    const d = new RemoteDriver({ nativeArgvFor: argv => argv[0] === 'ssh' ? f.isolate(argv) : argv })
    try {
      await d.call({ target: 'ssh:v6', ssh: { ...f.destination, host: '::1' } }, { sessionKey: 'spec' })
      const src = join(f.directory, 'binary'), dst = join(f.directory, 'v6-copy')
      await writeFile(src, Buffer.from([0, 255, 128, 13, 10]))
      expect(await d.rsync({ src, dst: `ssh:v6:${dst}`, argv: ['-a'] }, new AbortController().signal, { sessionKey: 'spec' })).toMatchObject({ exit: 0 })
      expect(await readFile(dst)).toEqual(await readFile(src))
    } finally { await d.dispose() }
  }, { ipv6: true })
}, 20000)

// An explicit -e/--rsh in argv overrides the tool's SSH wiring per rsync's
// own rules: the real host operand is passed and rsync parses it natively.
it('lets caller -e override the default SSH wiring', async () => {
  await withSshFixture(async f => {
    const d = new RemoteDriver({ nativeArgvFor: argv => argv[0] === 'ssh' ? f.isolate(argv) : argv })
    try {
      await d.call({ target: 'ssh:remote', ssh: f.destination }, { sessionKey: 'spec' })
      const src = join(f.directory, 'override-src'), dst = join(f.directory, 'override-dst')
      await writeFile(src, 'override-payload\n')
      // The caller's -e replaces the tool's SSH wiring entirely: the command
      // must carry its own port/key/config (that is what "override" means).
      const sshCommand = `ssh -p ${f.destination.port} -i ${f.destination.key} -F ${f.config}`
      const receipt = await d.rsync({ src, dst: `ssh:remote:${dst}`, argv: ['-a', '-e', sshCommand] }, new AbortController().signal, { sessionKey: 'spec' })
      expect(receipt.exit).toBe(0)
      expect(receipt.argv).toEqual(['-a', '-e', sshCommand])
      expect(await readFile(dst, 'utf8')).toBe('override-payload\n')
    } finally { await d.dispose() }
  })
}, 30000)

// Task 4 (native shortcut spec): dual-SSH rsync through the native forwarding
// route — destination loopback daemon + dest -L + source -R; the two peers run
// ONE rsync protocol conversation, and a large existing destination file with
// a small change produces real delta (Matched data >> literal), not a copy.
it('relays dual-SSH rsync through native port forwards with real delta and origin-held identities', async () => {
  await withSshFixture(async f => {
    const spawned: string[][] = []
    const d = new RemoteDriver({ nativeArgvFor: argv => { if (argv[0] === 'ssh') { spawned.push(argv); return f.isolate(argv) } return argv } })
    try {
      await d.call({ target: 'ssh:src', ssh: f.jump }, { sessionKey: 'spec' })
      await d.call({ target: 'ssh:dst', ssh: f.destination }, { sessionKey: 'spec' })
      const src = join(f.directory, 'relay-src'), dst = join(f.directory, 'relay-dst')
      await mkdir(src); await mkdir(dst)
      const file = join(src, 'binary'), bytes = randomBytes(8 * 1024 * 1024)
      await writeFile(file, bytes)
      const initial = await d.rsync({ src: `ssh:src:${src}/`, dst: `ssh:dst:${dst}/`, argv: ['-a', '--stats'] }, new AbortController().signal, { sessionKey: 'spec' })
      expect(initial.exit).toBe(0)
      expect(initial.route).toBe('ssh-ssh-forward')
      expect(createHash('sha256').update(await readFile(join(dst, 'binary'))).digest('hex')).toBe(createHash('sha256').update(bytes).digest('hex'))
      // Small change over the large existing destination file: one protocol
      // conversation with real delta — matched data must dominate.
      bytes.write('SMALL-DELTA\0\xff', 4000000, 'latin1'); await writeFile(file, bytes)
      await utimes(file, new Date(), new Date(Date.now() + 5000))
      const delta = await d.rsync({ src: `ssh:src:${src}/`, dst: `ssh:dst:${dst}/`, argv: ['-a', '--stats'] }, new AbortController().signal, { sessionKey: 'spec' })
      expect(delta.exit).toBe(0)
      expect(delta.route).toBe('ssh-ssh-forward')
      expect(delta.matchedBytes ?? 0).toBeGreaterThan(8e6)
      expect(delta.literalBytes ?? 8e6).toBeLessThan(8e6 / 4)
      expect(createHash('sha256').update(await readFile(join(dst, 'binary'))).digest('hex')).toBe(createHash('sha256').update(await readFile(file)).digest('hex'))
      // All identities stayed on the origin: every spawned ssh argv carries
      // an origin-held key path for its own side, and no remote command line
      // (the argument after '--') contains any key path.
      expect(spawned.length).toBeGreaterThan(0)
      // Each rsync call spawns one -L and one -R session; two calls ran.
      expect(spawned.filter(argv => argv.some(token => token === '-L' || token === '-R')).length).toBeGreaterThanOrEqual(2)
      for (const argv of spawned) {
        const dash = argv.indexOf('--')
        const remotePart = dash >= 0 ? argv.slice(dash + 2) : []
        expect(remotePart.join(' ')).not.toContain(f.jump.key)
        expect(remotePart.join(' ')).not.toContain(f.destination.key)
        expect(argv.some(token => token === f.jump.key || token === f.destination.key)).toBe(true)
      }
      // The destination-side daemon temp dir (rsyncd.conf) must be removed by
      // the dedicated cleanup session — the fixture's "remote" /tmp is this
      // machine's /tmp, so count superd-rsync.* leftovers across both rsync
      // calls (regression: remote residue was once left on every run).
      const { readdir: lsTmp } = await import('node:fs/promises')
      const residue = (await lsTmp('/tmp')).filter(name => name.startsWith('superd-rsync.'))
      expect(residue).toEqual([])
    } finally { await d.dispose() }
  })
}, 90000)

// Forwarding refused on the source side AND the stdio route reports itself
// unavailable on this SSH/rsync combination: the combined facts surface and
// nothing is copied — never a silent full copy.
it('reports combined route unavailability when source -R is refused; no full-copy fallback', async () => {
  await withSshFixture(async f => {
    const d = new RemoteDriver({ nativeArgvFor: argv => argv[0] === 'ssh' ? f.isolate(argv) : argv })
    try {
      await d.call({ target: 'ssh:src', ssh: f.jump }, { sessionKey: 'spec' })
      await d.call({ target: 'ssh:dst', ssh: f.destination }, { sessionKey: 'spec' })
      const src = join(f.directory, 'denied-src'), dst = join(f.directory, 'denied-dst')
      await mkdir(src); await mkdir(dst)
      const file = join(src, 'binary'), bytes = randomBytes(1024 * 1024)
      await writeFile(file, bytes)
      await expect(d.rsync({ src: `ssh:src:${src}/`, dst: `ssh:dst:${dst}/`, argv: ['-a'] }, new AbortController().signal, { sessionKey: 'spec' })).rejects.toThrow(/forwarding route denied|stdio route unavailable|no full-copy/)
      await expect(access(join(dst, 'binary'))).rejects.toThrow()
    } finally { await d.dispose() }
  }, { forwarding: { jump: 'no' } })
}, 60000)

// Both routes fail (nonexistent destination directory): the combined facts
// are reported and nothing is copied.
it('marks dual-SSH rsync unavailable when both routes fail; no full-copy fallback', async () => {
  await withSshFixture(async f => {
    const d = new RemoteDriver({ nativeArgvFor: argv => argv[0] === 'ssh' ? f.isolate(argv) : argv })
    try {
      await d.call({ target: 'ssh:src', ssh: f.jump }, { sessionKey: 'spec' })
      await d.call({ target: 'ssh:dst', ssh: f.destination }, { sessionKey: 'spec' })
      const src = join(f.directory, 'unavail-src')
      await mkdir(src)
      await writeFile(join(src, 'binary'), randomBytes(1024))
      await expect(d.rsync({ src: `ssh:src:${src}/`, dst: `ssh:dst:${join(f.directory, 'missing-dst')}/`, argv: ['-a'] }, new AbortController().signal, { sessionKey: 'spec' })).rejects.toThrow(/unavailable|no full-copy|directory/)
      await expect(access(join(f.directory, 'missing-dst'))).rejects.toThrow()
    } finally { await d.dispose() }
  }, { forwarding: { jump: 'no' } })
}, 60000)

// Task 5 (native shortcut spec): with BOTH endpoints denying TCP forwarding,
// the stdio route would be the only option. On this SSH/rsync combination it
// reports itself unavailable (see the verdict in ssh-rsync-native-relay.ts:
// the source-side rsync client with a stdio adapter makes ssh tear down the
// session stdin channel before the protocol starts). The error must say so
// honestly and nothing may be staged or copied.
it('reports stdio route unavailability when both forwards are denied; no full staging', async () => {
  await withSshFixture(async f => {
    const d = new RemoteDriver({ nativeArgvFor: argv => argv[0] === 'ssh' ? f.isolate(argv) : argv })
    try {
      await d.call({ target: 'ssh:src', ssh: f.jump }, { sessionKey: 'spec' })
      await d.call({ target: 'ssh:dst', ssh: f.destination }, { sessionKey: 'spec' })
      const src = join(f.directory, 'stdio-src'), dst = join(f.directory, 'stdio-dst')
      await mkdir(src); await mkdir(dst)
      await writeFile(join(src, 'binary'), randomBytes(8 * 1024 * 1024))
      await expect(d.rsync({ src: `ssh:src:${src}/`, dst: `ssh:dst:${dst}/`, argv: ['-a', '--stats'] }, new AbortController().signal, { sessionKey: 'spec' })).rejects.toThrow(/stdio route unavailable|no full-copy/)
      await expect(access(join(dst, 'binary'))).rejects.toThrow()
      // The origin staged nothing either: no remote-native-copy scratch dir.
      const { readdir } = await import('node:fs/promises')
      const scratch = join(process.cwd(), '.scratch')
      const staged = (await readdir(scratch, { recursive: true }).catch(() => [] as string[])).filter(name => String(name).startsWith('remote-native-copy'))
      expect(staged).toEqual([])
    } finally { await d.dispose() }
  }, { forwarding: { jump: 'no', destination: 'no' } })
}, 60000)
