import { describe, expect, it } from 'vitest'
import {
  buildDegradedCommand,
  buildEngineRc,
  capTail,
  createFrameParser,
  parseDegradedOutput,
  shellQuote,
  stripAnsi,
} from '../../src/remote/framing.ts'

describe('buildEngineRc', () => {
  it('wires OSC 133 C/D, stty -echo, empty PS1 and TERM=dumb', () => {
    const rc = buildEngineRc()
    expect(rc).toContain('133;C')
    expect(rc).toContain('133;D;%s')
    expect(rc).toContain('stty -echo')
    expect(rc).toContain("PS1=''")
    expect(rc).toContain('TERM=dumb')
  })
  it('sources each of the three profiles only when present', () => {
    const rc = buildEngineRc()
    for (const profile of ['~/.profile', '~/.bash_profile', '~/.bashrc']) {
      expect(rc).toContain(profile)
    }
    expect(rc).toContain('[ -f "$f" ]') // 存在才 source 的守卫
  })
  it('reports cwd via a separate standard OSC 7 in PROMPT_COMMAND', () => {
    const rc = buildEngineRc()
    expect(rc).toContain('\\033]7;file://%s\\007')
    expect(rc).toContain('"$PWD"')
  })
})

describe('createFrameParser', () => {
  it('pairs C/D across two chunks and attaches the OSC 7 cwd', () => {
    const parser = createFrameParser()
    const first = parser.push('\x1b]133;C\x07hello ')
    const second = parser.push('world\x1b]133;D;42\x07\x1b]7;file:///srv/app\x07')
    expect(first).toEqual([{ kind: 'command-start' }])
    expect(second).toEqual([{ kind: 'command-end', exitCode: 42, cwd: '/srv/app' }])
    expect(parser.takePendingOutput()).toBe('hello world')
    expect(parser.takePendingOutput()).toBe('') // take 清空
  })
  it('recovers when a chunk splits inside an OSC sequence', () => {
    const parser = createFrameParser()
    const frames = [
      ...parser.push('\x1b]13'),
      ...parser.push('3;C\x07some output'),
      ...parser.push('\x1b]133;D;'),
      ...parser.push('7\x07\x1b]7;fi'),
      ...parser.push('le:///a/b\x07'),
    ]
    expect(frames).toEqual([
      { kind: 'command-start' },
      { kind: 'command-end', exitCode: 7, cwd: '/a/b' },
    ])
    expect(parser.takePendingOutput()).toBe('some output')
  })
  it('recovers from a split right after the OSC 7 discriminator (before ";")', () => {
    // fuzz 实证的回归位：'\x1b]7' + ';' 切缝曾把 marker 头当文本放走
    const parser = createFrameParser()
    const frames = [
      ...parser.push('\x1b]133;C\x07x'),
      ...parser.push('\x1b]133;D;42\x07\x1b]7'),
      ...parser.push(';file://'),
      ...parser.push('/w\x07'),
    ]
    expect(frames).toEqual([
      { kind: 'command-start' },
      { kind: 'command-end', exitCode: 42, cwd: '/w' },
    ])
    expect(parser.takePendingOutput()).toBe('x')
  })
  it('splits mid-exit-code digits without losing the frame', () => {
    const parser = createFrameParser()
    parser.push('\x1b]133;C\x07')
    expect(parser.push('x\x1b]133;D;4')).toEqual([]) // D 头部悬置，等待余下数字
    expect(parser.push('2\x07\x1b]7;file:///w\x07')).toEqual([
      { kind: 'command-end', exitCode: 42, cwd: '/w' },
    ])
    expect(parser.takePendingOutput()).toBe('x')
  })
  it('accepts ST terminators alongside BEL', () => {
    const parser = createFrameParser()
    const frames = [
      ...parser.push('\x1b]133;C\x1b\\'),
      ...parser.push('out\x1b]133;D;0\x1b\\\x1b]7;file:///st\x1b\\'),
    ]
    expect(frames).toEqual([
      { kind: 'command-start' },
      { kind: 'command-end', exitCode: 0, cwd: '/st' },
    ])
  })
  it('holds a D until its OSC 7 arrives in a later chunk', () => {
    const parser = createFrameParser()
    expect(parser.push('\x1b]133;C\x07out\x1b]133;D;3\x07')).toEqual([
      { kind: 'command-start' },
    ]) // D 悬置等 OSC 7
    expect(parser.push('\x1b]7;file:///late\x07')).toEqual([
      { kind: 'command-end', exitCode: 3, cwd: '/late' },
    ])
    expect(parser.takePendingOutput()).toBe('out')
  })
  it('flushes a held D without cwd when the next C arrives', () => {
    const parser = createFrameParser()
    parser.push('\x1b]133;C\x07a\x1b]133;D;5\x07')
    const next = parser.push('\x1b]133;C\x07')
    expect(next[0]).toEqual({ kind: 'command-end', exitCode: 5 })
    expect('cwd' in next[0]!).toBe(false) // 无 cwd 键，而非 cwd: undefined
    expect(next[1]).toEqual({ kind: 'command-start' })
  })
  it('orphan D at session start emits no dangling output and keeps pairing', () => {
    const parser = createFrameParser()
    // 会话刚建立的首个 prompt：PROMPT_COMMAND 先发 D（前面没有 C）
    const first = parser.push('motd\r\n\x1b]133;D;0\x07\x1b]7;file:///~\x07')
    expect(first).toEqual([{ kind: 'command-end', exitCode: 0, cwd: '/~' }])
    expect(parser.takePendingOutput()).toBe('') // 不产生悬挂输出
    const second = parser.push('\x1b]133;C\x07real\x1b]133;D;1\x07\x1b]7;file:///~\x07')
    expect(second).toEqual([
      { kind: 'command-start' },
      { kind: 'command-end', exitCode: 1, cwd: '/~' },
    ])
    expect(parser.takePendingOutput()).toBe('real')
  })
  it('sequences multiple commands; prompt noise between D and C is dropped', () => {
    const parser = createFrameParser()
    parser.push('\x1b]133;C\x07one\x1b]133;D;0\x07\x1b]7;file:///d\x07')
    expect(parser.takePendingOutput()).toBe('one')
    expect(parser.push('\r\n\x1b]133;C\x07two\x1b]133;D;2\x07\x1b]7;file:///d\x07')).toEqual([
      { kind: 'command-start' },
      { kind: 'command-end', exitCode: 2, cwd: '/d' },
    ])
    expect(parser.takePendingOutput()).toBe('two') // \r\n 噪音未混入
  })
  it('never silently drops output on a late drain (segments merge, not vanish)', () => {
    const parser = createFrameParser()
    parser.push('\x1b]133;C\x07one\x1b]133;D;0\x07\x1b]7;file:///d\x07')
    parser.push('\x1b]133;C\x07two\x1b]133;D;2\x07\x1b]7;file:///d\x07')
    // 调用方两条命令都取走才排干：合并而非丢失（按命令排干是调用方职责）
    expect(parser.takePendingOutput()).toBe('onetwo')
  })
})

describe('stripAnsi', () => {
  it("strips residual CSI: 'a\\x1b[31mred\\x1b[0mb' → 'aredb'", () => {
    expect(stripAnsi('a\x1b[31mred\x1b[0mb')).toBe('aredb')
  })
  it('strips residual OSC with BEL and ST terminators', () => {
    expect(stripAnsi('x\x1b]0;title\x07y\x1b]2;screen\x1b\\z')).toBe('xyz')
  })
})

describe('shellQuote', () => {
  it("escapes single quotes: shellQuote(\"it's\") === 'it'\\''s'", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`)
  })
  it('wraps plain strings in single quotes', () => {
    expect(shellQuote('pnpm test')).toBe(`'pnpm test'`)
    expect(shellQuote('')).toBe(`''`)
  })
})

describe('buildDegradedCommand', () => {
  it('cd-guards the cwd, runs bash -lc and prints both sentinels', () => {
    const script = buildDegradedCommand('pnpm test', '/srv/app')
    expect(script).toContain(`cd '/srv/app' >/dev/null 2>&1`)
    expect(script).toContain(`bash -lc 'pnpm test'`)
    expect(script).toContain(`printf '\\x1eCWD_GONE\\x1e'; exit 127;`)
    expect(script).toContain(`printf '\\x1e%d\\x1e%s\\x1e' "$rc" "$PWD"`)
  })
})

describe('parseDegradedOutput', () => {
  it('parses the tail sentinel: exit code, cwd and preceding output', () => {
    expect(parseDegradedOutput('out\x1e3\x1e/tmp/x\x1e')).toEqual({
      exitCode: 3,
      cwd: '/tmp/x',
      output: 'out',
    })
  })
  it('flags CWD_GONE with the guard exit code 127', () => {
    expect(parseDegradedOutput('\x1eCWD_GONE\x1e')).toEqual({
      exitCode: 127,
      cwd: '',
      output: '',
      cwdGone: true,
    })
  })
  it('keeps the raw text as output when the sentinel is missing (killed channel)', () => {
    expect(parseDegradedOutput('partial')).toEqual({ exitCode: -1, cwd: '', output: 'partial' })
  })
})

describe('capTail', () => {
  it('keeps the tail maxChars characters and reports the original length', () => {
    expect(capTail('abcdef', 4)).toEqual({ text: 'cdef', truncatedFrom: 6 })
  })
  it('returns the text unchanged when under the cap', () => {
    expect(capTail('abc', 4)).toEqual({ text: 'abc', truncatedFrom: undefined })
  })
})
