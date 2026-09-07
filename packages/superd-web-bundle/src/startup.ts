/**
 * superd-web-startup — cmdlineArgs → webStartup 提供者（上游 web-startup 同款形态）：
 * commander 程序声明 flag 家族，action 发布服务，parseCmdline 接管解析、
 * --help 与错误退出（经 appExit）。host/port 未指定时省略——默认值在
 * bundle patch 行的 !!js 表达式里（127.0.0.1 / 3090）。
 * 参照 upstream/deepseek-harness/packages/bundle/web-app/src/startup.ts（0.1.3-alpha.2）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import { superdWebCommand, type WebOptions } from './web-command.ts'

export const name = 'superd-web-startup'

export const inject = ['cmdlineArgs']

/** web 面启动值：webserver / superd-runtime 行的 !!js 表达式消费。 */
export interface WebStartup {
  host?: string
  port?: number
  openBrowser: boolean
  trustedHosts: string[]
}

export function apply(ctx: Context): void {
  const program = superdWebCommand()
  program.action(() => {
    const options = program.opts<WebOptions>()
    ctx.provide('webStartup', {
      openBrowser: false, // superd 从不自动开浏览器（--no-open 仅为上游形位兼容）
      ...options.host !== undefined && { host: options.host },
      ...options.port !== undefined && { port: Number(options.port) },
      trustedHosts: options.trustedHost ?? [],
    } satisfies WebStartup)
  })
  parseCmdline(ctx, program)
}
