/** Native HMR with transaction lifetime separated from resource lifetime. */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Context } from '@deepseek-ai/cordis'
import Hmr, { type HmrConfig } from '@deepseek-ai/dsh-hmr'

/**
 * Native runExclusive keeps a boolean in ALS. HTTP servers created while
 * replacing webServer inherit that boolean after the transaction finishes,
 * so subsequent native Plugin Manager requests are refused as nested.
 *
 * The public runExclusive/watchConfig APIs expose no selective context reset.
 * AsyncLocalStorage.snapshot() also resets AgentRegistry initiator attribution
 * and its teardown lineage, so it cannot safely repair this host transaction.
 * This compatibility bridge reads the native TS-private `executing` storage
 * after checking its runtime shape. It never replaces that storage or changes
 * upstream files: only exit() clears its inherited value while the unchanged
 * native method establishes the next transaction. Native queue, closing,
 * exact watchers, module reload and disposal retain their original semantics.
 *
 * The mutable token rejects nesting only while its operation is still active;
 * resources created by that operation can initiate later transactions.
 * A native implementation change fails initialization explicitly instead of
 * silently dropping queue or lifecycle guarantees.
 */
export default class BetterHmr extends Hmr {
  private readonly nativeTransactions: AsyncLocalStorage<boolean>
  private readonly liveTransactions = new AsyncLocalStorage<{ active: boolean }>()

  constructor(ctx: Context, config: HmrConfig) {
    super(ctx, config)
    const storage: unknown = (this as unknown as { executing?: unknown }).executing
    if (!(storage instanceof AsyncLocalStorage)
      || typeof storage.getStore !== 'function' || typeof storage.exit !== 'function'
      || typeof storage.run !== 'function') {
      throw new Error('Better Dash HMR cannot reset this native HMR transaction context: expected executing AsyncLocalStorage')
    }
    this.nativeTransactions = storage
  }

  override runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.liveTransactions.getStore()?.active) {
      return Promise.reject(new Error('HMR transactions cannot be nested'))
    }
    return this.nativeTransactions.exit(() => super.runExclusive(() => {
      const token = { active: true }
      return this.liveTransactions.run(token, async () => {
        try {
          return await operation()
        } finally {
          token.active = false
        }
      })
    }))
  }
}
