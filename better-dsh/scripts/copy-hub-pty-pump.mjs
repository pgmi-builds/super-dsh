/**
 * 把 hub PTY 泵（hub-pty-pump.mjs，原样资产）拷进 lib/remote（发布面）。必须在 tsdown
 * 之后运行 —— tsdown 会清空 lib/。运行时 driver 的 hubPtyAssets() 按
 * `dirname(import.meta.url)/hub-pty-pump.mjs` 定位（npm 包与 Super 闭包同构，
 * helper-bin 同款纪律；0.3.2-c hub-remote-parity §4.1）。
 */
import { copyFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(process.cwd(), 'src/remote/hub-pty-pump.mjs')
const OUT = join(process.cwd(), 'lib/remote/hub-pty-pump.mjs')

copyFileSync(SRC, OUT)
console.log(`hub-pty-pump: 1 file, ${(statSync(OUT).size / 1024).toFixed(1)} kB -> lib/remote/hub-pty-pump.mjs`)
