import { homedir } from 'node:os'
import { join } from 'node:path'

export const SUPERD_HOME_ENV = 'SUPERD_HOME'
export const SUPERD_HOME_DIR_NAME = '.superd'
export const DSH_HOME_ENV = 'DSH_HOME'

/** superd home 解析：显式 flag > SUPERD_HOME env > ~/.superd。 */
export function resolveSuperdHome(explicit?: string): string {
  return explicit ?? process.env[SUPERD_HOME_ENV] ?? join(homedir(), SUPERD_HOME_DIR_NAME)
}

/**
 * 在任何上游模块 import 前，把 superd home 写入环境。
 * DSH_HOME 一律覆盖：上游所有 home-paths 消费者（credentials store、
 * profiles 目录）随之落到 superd home；用户的 ~/.dsh 全程不被触碰、
 * 也不被继承。
 */
export function applySuperdHomeEnv(explicit?: string): string {
  const home = resolveSuperdHome(explicit)
  process.env[SUPERD_HOME_ENV] = home
  process.env[DSH_HOME_ENV] = home
  return home
}
