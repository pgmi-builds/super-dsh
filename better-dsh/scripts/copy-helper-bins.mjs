/**
 * 把 superd-run helper 的 bin 资产（bin/<triple>/superd-run* + bin/MANIFEST.json）拷进
 * lib/remote/helper-bin（发布面）。必须在 tsdown 之后运行 —— tsdown 会清空 lib/。
 * 运行时 helper.ts 按 `dirname(import.meta.url)/helper-bin` 定位（npm 包与 Super 闭包同构）。
 */
import { cpSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(process.cwd(), 'src/remote/helper/bin')
const OUT = join(process.cwd(), 'lib/remote/helper-bin')

if (!existsSync(join(SRC, 'MANIFEST.json'))) {
  console.warn('copy-helper-bins: src/remote/helper/bin/MANIFEST.json missing — run src/remote/helper/build.sh first; shipping shim-only')
  process.exit(0)
}
cpSync(SRC, OUT, { recursive: true })
let files = 0, bytes = 0
const walk = dir => { for (const entry of readdirSync(join(OUT, dir), { withFileTypes: true })) { const rel = dir ? `${dir}/${entry.name}` : entry.name; if (entry.isDirectory()) walk(rel); else { files += 1; bytes += statSync(join(OUT, rel)).size } } }
walk('')
console.log(`helper-bins: ${files} files, ${(bytes / 1048576).toFixed(1)} MB -> lib/remote/helper-bin`)
