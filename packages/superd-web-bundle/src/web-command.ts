/** superd web 子命令的 flag 家族（commander 程序工厂；usage 文本/测试/插件共用）。 */
import { Command, InvalidArgumentError } from 'commander'

/** commander 解析后的 web options（trustedHost 对应可重复的 --trusted-host）。 */
export interface WebOptions {
  host?: string
  port?: string
  open: boolean
  trustedHost?: string[]
}

/** flag 程序工厂：每次返回新鲜实例（一进程可多次解析，上游同款）。 */
export function superdWebCommand(): Command {
  return new Command()
    .name('superd web')
    .description('Serve the superD web surface.')
    .helpOption('-h, --help', 'show this help')
    .option('--host <host>', 'bind host (default 127.0.0.1)')
    .option('--no-open', 'accepted for upstream parity; superd never auto-opens a browser')
    .option('--port <port>', 'listen port (default 3090)', (value: string) => {
      if (!/^\d+$/.test(value)) throw new InvalidArgumentError('must be a number')
      return value
    })
    .option('--trusted-host <authority...>', 'extra authority the /api browser-trust fence accepts (repeatable)')
    .addHelpText('after', '\nExamples:\n  superd web --port 4999 --home .superd-test\n')
}
