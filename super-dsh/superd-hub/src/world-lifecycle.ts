import { randomUUID } from 'node:crypto'
import { registerAgent, unregisterAgent, setReady } from './roster.js'
import { getTarget, registerForeignTarget, unregisterForeignTarget, type ForeignTarget, type GatewayFace } from './targets.js'
import { registerHostMount } from './world-host.js'

/** Cordis owns the effect and awaits its disposer when the row unloads. */
interface WorldOwner {
  effect(callback: () => () => Promise<void>, label?: string): unknown
}

interface OwnedWorld {
  get(name: string): unknown
  effect(callback: () => () => void, label?: string): unknown
  fiber: { dispose(): Promise<void> }
}

/**
 * One row owns its roster membership, mount, target and sibling world. Install
 * cleanup before starting boot: completion can arrive after the owner unloads.
 */
export function ownWorld<T extends OwnedWorld>(
  ctx: WorldOwner,
  entry: { key: string, label: string },
  spawn: (ownerId: string) => Promise<T>,
  onFailure: (cause: unknown) => void,
): Promise<T | null> {
  const { key } = entry
  const ownerId = randomUUID()
  let active = true
  let target: ForeignTarget | undefined
  let world: T | undefined
  let teardown: Promise<void> | undefined
  let started: Promise<T | null>
  let dropMount: () => void
  const disposeWorld = () => teardown ??= world?.fiber.dispose() ?? Promise.resolve()
  ctx.effect(() => {
    registerAgent({ ...entry, ready: false })
    dropMount = registerHostMount({ key, labelPath: `/${key}`, ownerId })
    return async () => {
      // Remove addressability synchronously. Old boot/teardown must never
      // mutate a later activation's maps or readiness, even while it awaits.
      active = false
      dropMount()
      if (target && getTarget(key) === target) unregisterForeignTarget(key)
      unregisterAgent(key)
      await started
      await disposeWorld()
    }
  }, `superd.world.${key}: ownership`)
  started = (async () => {
    try {
      world = await spawn(ownerId)
      if (!active) {
        await disposeWorld()
        return null
      }
      // A sibling root can also be disposed independently. The loaded owner
      // remains in the roster, but its gateway must cease being addressable.
      world.effect(() => () => {
        if (!active) return
        dropMount()
        if (target && getTarget(key) === target) unregisterForeignTarget(key)
        setReady(key, false)
      }, `superd.world.${key}: availability`)
      target = { key, gateway: world.get('typertGateway') as GatewayFace }
      registerForeignTarget(target)
      setReady(key, true)
      return world
    } catch (cause) {
      // Disposal failure must reach the owner's async disposer. Swallowing it
      // as a cancelled boot would hide a transport that could still be alive.
      if (!active && teardown !== undefined) throw cause
      // A cancelled boot cannot mark a replacement ready/failed or recreate
      // its routing entry. Active failures remain observable and fail-soft.
      if (active) onFailure(cause)
      return null
    }
  })()
  return started
}
