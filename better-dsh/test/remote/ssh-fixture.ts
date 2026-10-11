import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { createServer, createConnection } from 'node:net'
async function port(): Promise<number> {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no fixture port')
  await new Promise<void>(resolve => server.close(() => resolve()))
  return address.port
}
const delay = () => new Promise(resolve => setTimeout(resolve, 30))
async function listening(port: number): Promise<boolean> {
  return await new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port })
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => { socket.destroy(); resolve(false) })
  })
}
/** Test-only sshd identities/config; no production homes or global SSH settings. */
export interface SshFixtureOptions { forwarding?: Partial<Record<'jump' | 'destination', 'yes' | 'no'>>; agentForwarding?: boolean; ipv6?: boolean }
export async function createSshFixture(options: SshFixtureOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'superd-byossh-'))
  const children: ChildProcess[] = [], ports: number[] = []
  const cleanup = async () => {
    const waitClosed = (child: ChildProcess, timeoutMs: number): Promise<boolean> => {
      if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
      return new Promise(resolve => {
        const finish = (closed: boolean) => {
          clearTimeout(timer); child.off('close', onClose); resolve(closed)
        }
        const onClose = () => finish(true)
        const timer = setTimeout(() => finish(false), timeoutMs)
        child.once('close', onClose)
      })
    }
    const results = await Promise.allSettled([...children].reverse().map(async child => {
      if (child.exitCode !== null || child.signalCode !== null) return
      try { process.kill(-child.pid!, 'SIGTERM') } catch { /* already exited */ }
      if (await waitClosed(child, 1000)) return
      try { process.kill(-child.pid!, 'SIGKILL') } catch { /* already exited */ }
      if (!await waitClosed(child, 1000)) throw new Error(`owned fixture process ${child.pid} did not close after SIGKILL`)
    }))
    // Key removal cannot be skipped by one owned process's teardown failure.
    await rm(directory, { recursive: true, force: true })
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    for (const n of ports) if (await listening(n)) errors.push(new Error(`fixture listener leaked at ${n}`))
    if (errors.length) throw new AggregateError(errors, 'SSH fixture cleanup failed')
  }
  try {
    const endpoints = []
    for (const name of ['jump', 'destination'] as const) {
      const dir = join(directory, name); await mkdir(dir)
      const key = join(dir, 'identity'), host = join(dir, 'host')
      for (const file of [key, host]) execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', file])
      await writeFile(join(dir, 'authorized_keys'), await readFile(key + '.pub'))
      const n = await port(); ports.push(n)
      const config = join(dir, 'sshd.conf')
      await writeFile(config, `Port ${n}\nListenAddress 127.0.0.1\nHostKey ${host}\nPidFile ${dir}/pid\nAuthorizedKeysFile ${dir}/authorized_keys\nStrictModes no\nUsePAM no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPubkeyAuthentication yes\nAllowUsers ${userInfo().username}\nSubsystem sftp internal-sftp\nAllowTcpForwarding ${options.forwarding?.[name] ?? 'yes'}\nAllowAgentForwarding ${options.agentForwarding ? 'yes' : 'no'}\nPermitTTY yes\nGatewayPorts no\nLogLevel ERROR\n`)
      if (options.ipv6) await writeFile(config,(await readFile(config,'utf8')).replace('ListenAddress 127.0.0.1','ListenAddress 127.0.0.1\nListenAddress ::1'))
      const child = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', config], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] })
      let errors = ''; child.stderr!.on('data', chunk => { errors += chunk.toString() }); children.push(child)
      const until = Date.now() + 5000
      while (!await listening(n)) {
        if (Date.now() > until || child.exitCode !== null) throw new Error(`sshd fixture startup failed: ${errors}`)
        await delay()
      }
      endpoints.push({ host: '127.0.0.1', user: userInfo().username, port: n, key })
    }
    const knownHosts = join(directory, 'known_hosts')
    await writeFile(knownHosts, (await Promise.all(endpoints.map(async (e, i) => `[127.0.0.1]:${e.port} ${await readFile(join(directory, ['jump', 'destination'][i]!, 'host.pub'), 'utf8')}`))).join(''))
    if(options.ipv6) await writeFile(knownHosts,(await readFile(knownHosts,'utf8'))+(await readFile(knownHosts,'utf8')).replaceAll('[127.0.0.1]','[::1]'))
    const config = join(directory, 'ssh_config')
    await writeFile(config, `Host fixture-jump\n HostName 127.0.0.1\n Port ${endpoints[0]!.port}\n IdentityFile ${endpoints[0]!.key}\nHost fixture-native\n HostName 127.0.0.1\n Port ${endpoints[1]!.port}\n IdentityFile ${endpoints[1]!.key}\nHost *\n User ${userInfo().username}\n UserKnownHostsFile ${knownHosts}\n GlobalKnownHostsFile /dev/null\n StrictHostKeyChecking yes\n IdentitiesOnly yes\n IdentityAgent none\n ForwardAgent no\n ConnectTimeout 3\n`)
    return { directory, config, jump: endpoints[0]!, destination: endpoints[1]!, cleanup,
      // Isolation remains in this fixture, never in product sshArgv.
      isolate: (argv: string[]) => [argv[0]!, '-F', config, ...argv.slice(1)],
      // -o based isolation: works for both ssh and scp and coexists with a
      // product-generated -F config (last -F would otherwise win and lose the
      // fixture's UserKnownHostsFile).
      isolateOpts: (argv: string[]) => [argv[0]!, '-o', `UserKnownHostsFile=${knownHosts}`, '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'StrictHostKeyChecking=yes', '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-o', 'ForwardAgent=no', ...argv.slice(1)] }
  } catch (error) { await cleanup(); throw error }
}

/** Shared fixture lifetime around import, harness setup, execution and disposal. */
export async function withSshFixture<T>(work: (fixture: Awaited<ReturnType<typeof createSshFixture>>) => Promise<T>, options: SshFixtureOptions = {}): Promise<T> {
  const fixture = await createSshFixture(options)
  try { return await work(fixture) }
  finally { await fixture.cleanup() }
}
