/**
 * @pgmi-builds/superd-web-bundle — superD web 面 bundle 的运行时胶水插件
 * （bundle patch 由同包 cordis.patch.yml 声明）。职责：bind 后提供
 * webRuntime（LAN 信任快照）、以 frontend-static fallback owner 伺服中性
 * 底座 dist、Loader 收敛后打印带 token 的 URL 行。
 * 蓝本：upstream dsh-web-app 的 web-runtime 行（锁版 0.1.3-alpha.2），
 * 砍掉 DSH 特有面（systemPrompt/shellEnv/SSH 探测/浏览器拉起）。
 */
import { createRequire } from 'node:module'
import { networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import * as FrontendStatic from '@deepseek-ai/dsh-host-frontend-static'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-client-connection'

export const name = 'superd-web-bundle'

export const inject = ['webServer']

export interface Config {
  /** Loader 收敛后打印 URL 行（supervisor 就绪信号）。 */
  printUrl: boolean
  /** 显式 --trusted-host 追加权威。 */
  trustedHosts: string[]
}

export const Config: z<Config> = z.object({
  printUrl: z.boolean().default(true),
  trustedHosts: z.array(String).default([]),
})

/** bind 依赖的 Web 运行值：connection 行的信任栅栏消费。 */
export interface WebRuntimeValues {
  lanAddresses: string[]
  trustedHosts: string[]
}

const ALL_INTERFACES_HOST = '0.0.0.0'
const LOOPBACK_HOST = '127.0.0.1'

/** 从实际 bind 推导一份 LAN 信任快照（IP 字面量免端口，防 DNS rebinding）。 */
export function resolveLanTrust(bindHost: string, extra: readonly string[]): WebRuntimeValues {
  const lanAddresses = bindHost === ALL_INTERFACES_HOST
    ? Object.values(networkInterfaces()).flat()
      .filter((iface): iface is NonNullable<typeof iface> => iface !== undefined && iface.family === 'IPv4' && !iface.internal)
      .map(iface => iface.address)
    : []
  return { lanAddresses, trustedHosts: [...lanAddresses, ...extra] }
}

/**
 * dist 定位是本 bundle 的装配事实而非用户配置：锚在 frontend 包 manifest 上。
 * 存在性是请求期问题（fallback owner 按请求读盘）。
 */
export function resolveDistIndex(): string {
  const override = process.env.DSH_WEB_FRONTEND_DIR
  if (override !== undefined && override !== '') return join(override, 'index.html')
  const require = createRequire(import.meta.url)
  try {
    return join(dirname(require.resolve('@deepseek-ai/dsh-web-frontend/package.json')), 'dist', 'index.html')
  } catch {
    throw new Error('superd-web-bundle: @deepseek-ai/dsh-web-frontend is not resolvable from this composition')
  }
}

/** 测试钩子（生产不改）。 */
export const internals = { resolveDistIndex }

export function apply(ctx: Context, config: Config): void {
  const runtime = resolveLanTrust(ctx.webServer.host, config.trustedHosts)
  // bind 依赖值采样一次后放行 connection 行
  ctx.provide('webRuntime', runtime)
  ctx.plugin(FrontendStatic, { distIndex: internals.resolveDistIndex() })
  if (config.printUrl) {
    ctx.inject(['connection'], (connectionCtx) => {
      const announce = (): void => {
        const port = connectionCtx.webServer.port
        const authenticatedUrl = connectionCtx.connection.authenticatedUrl(`http://${LOOPBACK_HOST}:${String(port)}`)
        const lanCandidate = runtime.lanAddresses[0]
        const lanUrl = lanCandidate === undefined
          ? undefined
          : connectionCtx.connection.authenticatedUrl(`http://${lanCandidate}:${String(port)}`)
        console.log(`superd: ${authenticatedUrl}${lanUrl === undefined ? '' : ` (LAN: ${lanUrl})`}`)
      }
      // URL 行是就绪信号：必须等 Loader 全树收敛（上游同款纪律）
      const settled = connectionCtx.get('loader')?.await()
      if (settled === undefined) announce()
      else void settled.then(() => {
        if (connectionCtx.get('webServer') !== undefined && connectionCtx.get('connection') !== undefined) announce()
      }, () => {})
    })
  }
}
