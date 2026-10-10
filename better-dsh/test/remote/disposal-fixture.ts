import { readFileSync } from 'node:fs'
import type { RemoteDriverOptions } from '../../src/remote/driver.ts'

/** Pause only target discovery; real tools, driver routing, and bash execution remain live. */
export function deferredTargetResolution() {
  const entered = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  const options: RemoteDriverOptions = {
    sshConfigReader: async () => '',
    rosterRunner: async () => {
      entered.resolve()
      await gate.promise
      return { exit: 0, timedOut: false, stdout: 'delayed', stderr: '', durationMs: 0 }
    },
    ptyArgvFor: () => ['bash'],
    oneshotArgvFor: (_plan, cmd) => ['bash', '-c', cmd],
  }
  return { options, entered: entered.promise, release: () => gate.resolve() }
}

/** Clean only a PID returned by this fixture's failed RED command. */
export function killReturnedShell(pidText: string | undefined) {
  const pid = Number(pidText)
  if (Number.isInteger(pid) && pid > 1) {
    try { process.kill(-pid, 'SIGKILL') } catch { /* already cleaned */ }
  }
}

/** A zombie is not a live executable descendant, even before PID 1 reaps it. */
export function descendantIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    if (process.platform !== 'linux') return true
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]
    return state !== 'Z' && state !== 'X'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH' || (error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export function killFixtureDescendant(pid: number | undefined): void {
  if (pid !== undefined && Number.isInteger(pid) && pid > 1) {
    try { process.kill(pid, 'SIGKILL') } catch { /* already cleaned */ }
  }
}
