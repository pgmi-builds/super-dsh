import { describe, expect, it } from 'vitest'
import { superdWebCommand, type WebOptions } from '@pgmi-builds/superd-web-bundle/web-command'

function parse(args: string[]): WebOptions {
  const program = superdWebCommand()
  program.exitOverride() // 把 program.error/help 变 throw，测试可断言
  program.parse(args, { from: 'user' })
  return program.opts<WebOptions>()
}

describe('superd web command', () => {
  it('defaults: open true, no host/port, no trusted hosts', () => {
    const options = parse([])
    expect(options.open).toBe(true)
    expect(options.host).toBeUndefined()
    expect(options.port).toBeUndefined()
    expect(options.trustedHost).toBeUndefined()
  })

  it('parses host/port/trusted-host (repeatable) and --no-open', () => {
    const options = parse(['--host', '127.0.0.1', '--port', '4999', '--no-open',
      '--trusted-host', 'a.example', '--trusted-host', 'b.example'])
    expect(options.host).toBe('127.0.0.1')
    expect(options.port).toBe('4999')
    expect(options.open).toBe(false)
    expect(options.trustedHost).toEqual(['a.example', 'b.example'])
  })

  it('rejects non-numeric ports (fail loud at parse, via the shared factory)', () => {
    expect(() => parse(['--port', 'nope'])).toThrow(/number/)
  })
})
