import { afterEach, describe, expect, it } from 'vitest'
import { applySuperdHomeEnv, resolveSuperdHome } from '../src/home.ts'

describe('superd home', () => {
  afterEach(() => {
    delete process.env.SUPERD_HOME
    delete process.env.DSH_HOME
  })

  it('defaults to ~/.superd', () => {
    const home = resolveSuperdHome()
    expect(home.endsWith('/.superd')).toBe(true)
  })

  it('explicit flag wins over env', () => {
    process.env.SUPERD_HOME = '/from-env'
    expect(resolveSuperdHome('/from-flag')).toBe('/from-flag')
    expect(resolveSuperdHome()).toBe('/from-env')
  })

  it('applySuperdHomeEnv ALWAYS overrides DSH_HOME (never inherits a user dsh home)', () => {
    process.env.DSH_HOME = '/users-real-dsh-home'
    const home = applySuperdHomeEnv('/tmp/superd-x')
    expect(home).toBe('/tmp/superd-x')
    expect(process.env.SUPERD_HOME).toBe('/tmp/superd-x')
    expect(process.env.DSH_HOME).toBe('/tmp/superd-x')
  })
})
