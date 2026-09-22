import { describe, expect, it } from 'vitest'
import {
  bashSupportsEngineFrames,
  buildDegradedCommand,
  buildEngineRc,
  capTail,
  createFrameParser,
  parseDegradedOutput,
  shellQuote,
  stripAnsi,
  wrapPtyCommand,
} from '../../src/remote/framing.ts'

describe('buildEngineRc', () => {
  it('wires OSC 133 C/D, stty -echo, empty PS1/PS2 and TERM=dumb', () => {
    const rc = buildEngineRc()
    expect(rc).toContain('133;C')
    expect(rc).toContain('133;D;%s')
    expect(rc).toContain('stty -echo')
    expect(rc).toContain("PS1=''")
    expect(rc).toContain("PS2=''") // 多行复合命令的续行提示符必须哑掉（PS2 文本会打进 C 前输出流）
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

describe('buildEngineRc — wire-baked env', () => {
  it('bakes call env into export lines AFTER profile sourcing (wire injection wins over profiles)', () => {
    const rc = buildEngineRc({ NODE_ENV: 'test', GREETING: "it's" })
    expect(rc).toContain(`export NODE_ENV='test'`)
    expect(rc).toContain(`export GREETING='it'\\''s'`)
    // 置于 profile sourcing 之后：显式 env 必赢，profile 不得反超
    expect(rc.indexOf('export NODE_ENV=')).toBeGreaterThan(rc.indexOf('[ -f "$f" ]'))
  })
  it('emits no export lines beyond TERM when env is absent (no wire change for env-less targets)', () => {
    const rc = buildEngineRc()
    expect(rc.split('\n').filter((line) => line.startsWith('export '))).toEqual(['export TERM=dumb'])
  })
})

describe('wrapPtyCommand', () => {
  it('wraps a single-line cmd as ONE `{\\ncmd\\n}` compound (one command-read → exactly one C…D pair)', () => {
    expect(wrapPtyCommand('echo hello world')).toBe('{\necho hello world\n}')
  })
  it('embeds every line of a multi-line cmd inside the compound (newlines no longer split the framing)', () => {
    expect(wrapPtyCommand('echo L1\necho L2\necho L3')).toBe('{\necho L1\necho L2\necho L3\n}')
  })
  it('keeps a trailing-; cmd correct: newline before } works with or without the final semicolon (no `;;` doubling)', () => {
    expect(wrapPtyCommand('echo hi;')).toBe('{\necho hi;\n}')
  })
  it('empty cmd → bare compound frame (unreachable via the tool, which guards empty cmd; kept simple)', () => {
    expect(wrapPtyCommand('')).toBe('{\n\n}')
  })
})

describe('bashSupportsEngineFrames', () => {
  it('4.2 → false (PS0 accepted but never expanded on 4.0–4.3: D arrives, C never comes)', () => {
    expect(bashSupportsEngineFrames('4.2.10(1)-release')).toBe(false)
    expect(bashSupportsEngineFrames('4.3.30')).toBe(false)
  })
  it('4.4 → true (PS0 floor) and 5.x → true', () => {
    expect(bashSupportsEngineFrames('4.4')).toBe(true)
    expect(bashSupportsEngineFrames('4.4.20(1)-release')).toBe(true)
    expect(bashSupportsEngineFrames('5.1.16(1)-release')).toBe(true)
    expect(bashSupportsEngineFrames('5.2.15')).toBe(true)
  })
  it('unparseable version → false (refuse the session; engine degrades loudly)', () => {
    expect(bashSupportsEngineFrames('')).toBe(false)
    expect(bashSupportsEngineFrames('bash')).toBe(false)
    expect(bashSupportsEngineFrames('4')).toBe(false)
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
  it('splits an ST marker mid-terminator: half ST holds with its body', () => {
    // 评审实证回归位：半截 ST 只扣 1 字节曾把 body 当文本放走 → D 帧丢失、
    // exit code 丢失、OSC 7 无处可挂、原始标记字节漏进模型可见输出
    const parser = createFrameParser()
    expect(parser.push('\x1b]133;C\x07out\x1b]133;D;42\x1b')).toEqual([
      { kind: 'command-start' },
    ]) // D 的 ST 只来了一半（\x1b 等 \），body + 半截 ST 整体滞留
    expect(parser.push('\\more')).toEqual([]) // \ 闭合 D 的 ST；'more' 是 D 后噪音
    expect(parser.push('\x1b]7;file:///w\x07')).toEqual([
      { kind: 'command-end', exitCode: 42, cwd: '/w' },
    ])
    expect(parser.takePendingOutput()).toBe('out') // 标记字节未漏进输出
  })
  it('splits an ST marker mid-body', () => {
    const parser = createFrameParser()
    expect(parser.push('\x1b]133;C\x07v')).toEqual([{ kind: 'command-start' }])
    expect(parser.push('al\x1b]133;D;5\x1b')).toEqual([]) // D 头 + 半截 ST 整体滞留
    expect(parser.push('\\\x1b]7;file:///x\x07')).toEqual([
      { kind: 'command-end', exitCode: 5, cwd: '/x' },
    ])
    expect(parser.takePendingOutput()).toBe('val')
  })
  it('splits an ST-terminated OSC 7 across chunks', () => {
    const parser = createFrameParser()
    expect(parser.push('\x1b]133;C\x07w\x1b]133;D;3\x07\x1b]7;file:///u\x1b')).toEqual([
      { kind: 'command-start' },
    ]) // D 的 BEL 已闭合；OSC 7 只剩半截 ST，整体滞留
    expect(parser.push('\\')).toEqual([{ kind: 'command-end', exitCode: 3, cwd: '/u' }])
    expect(parser.takePendingOutput()).toBe('w')
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
  it('bounds pending accumulation: 3 MiB between C and D keeps only the tail; true total via pendingTotalChars', () => {
    const parser = createFrameParser()
    parser.push(`\x1b]133;C\x07${'a'.repeat(1024 * 1024)}`)
    parser.push(`${'b'.repeat(2 * 1024 * 1024)}\x1b]133;D;0\x07`)
    // 真实累计先于 take 读取（take 会归零）；缓冲本体有界 — 跑飞命令不再无界累积
    expect(parser.pendingTotalChars()).toBe(3 * 1024 * 1024)
    expect(parser.takePendingOutput().length).toBeLessThanOrEqual(2 * 1024 * 1024)
    expect(parser.takePendingOutput()).toBe('')
    expect(parser.pendingTotalChars()).toBe(0) // take 归零（per-command 记账）
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
  it('prefixes wire-baked exports before the cd/bash-lc wrapper when env is given', () => {
    const script = buildDegradedCommand('pnpm test', '/srv/app', { NODE_ENV: 'test', B: "it's" })
    expect(script).toContain(`export NODE_ENV='test'; export B='it'\\''s'; `)
    expect(script.indexOf('export NODE_ENV=')).toBeLessThan(script.indexOf('cd '))
    expect(script).toContain(`bash -lc 'pnpm test'`) // 本体不变
  })
  it('stays wire-identical when env is absent or empty', () => {
    expect(buildDegradedCommand('pnpm test', '/srv/app', {})).toBe(buildDegradedCommand('pnpm test', '/srv/app'))
    expect(buildDegradedCommand('pnpm test', '/srv/app')).toBe(buildDegradedCommand('pnpm test', '/srv/app'))
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
