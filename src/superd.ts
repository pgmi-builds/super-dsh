/**
 * superd CLI：P1 只有 web 子命令。
 * 启动器 = 上游 profile-boot.ts 的 P1 简化：profile 组装 → heal module
 * fallback → boot(prepare 提供 cmdlineArgs)。patchReload 定 'startup'
 * （无 live watcher；改 patch 重启生效）。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  boot, composeEntries, healProfilesModuleFallback, initProfile, installFailLoud, loadProfile,
  PROFILE_PATCH_FILENAME,
} from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'

const NAME = 'superd'
const PROFILE_NAME = 'web'
const PROFILE_ROOT_FILENAME = 'cordis.yml'
const DEFAULT_BUNDLES = ['@pgmi-builds/superd-web-bundle']
const PROFILE_ROOT_CONFIG = '# superd profile root — composition is patch layers.\n[]\n'

const require = createRequire(import.meta.url)
const INSTALL_ANCHOR = require.resolve('../package.json')

function ensureProfile(home: string): string {
  const dir = join(home, 'profiles', PROFILE_NAME)
  initProfile(dir, DEFAULT_BUNDLES, 'startup')
  // 根配置每跑必重写：整棵树是 patch 层（上游同款纪律，防 loader 写回烘焙行）
  writeFileSync(join(dir, PROFILE_ROOT_FILENAME), PROFILE_ROOT_CONFIG)
  return dir
}

async function runWeb(): Promise<void> {
  const home = process.env.DSH_HOME!
  const profileDir = ensureProfile(home)
  const profile = loadProfile(NAME, PROFILE_NAME, INSTALL_ANCHOR, home)
  await healProfilesModuleFallback({ installAnchor: INSTALL_ANCHOR, profile, home })

  if (process.argv.includes('--dump-config')) {
    const layers = profile.layers.map(layer => layer.patches)
    console.log(JSON.stringify(composeEntries(structuredClone(layers)), undefined, 2))
    return
  }

  let app: Context | undefined
  installFailLoud(NAME, process, async () => {
    await app?.fiber.dispose()
  })
  const patches = structuredClone([
    ...profile.layers.flatMap(layer => layer.patches),
    ...profile.patches,
  ])
  app = await boot(NAME, join(profileDir, PROFILE_ROOT_FILENAME), patches, (hostCtx) => {
    provideCmdline(hostCtx, {
      args: process.argv.slice(2),
      exit: code => process.exit(code),
    })
  })
  const shutdown = (code: number): void => {
    void app?.fiber.dispose().finally(() => process.exit(code))
  }
  process.on('SIGTERM', () => shutdown(0))
  process.on('SIGINT', () => shutdown(130))
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const command = argv[0]
  if (command === 'web') {
    await runWeb()
  } else if (command === undefined || command === '--help' || command === '-h') {
    console.log('usage: superd <command> [flags]\n\ncommands:\n  web    start the superD web surface\n\nflags:\n  --home <path>            superd home (default ~/.superd)\n  --host <addr>            bind host (default 127.0.0.1)\n  --port <n>               port (default 3090)\n  --trusted-host <name>    extra trust-fence authority (repeatable)\n  --dump-config            print the composed entry list and exit')
  } else {
    console.error(`superd: unknown command ${command}; try --help`)
    process.exitCode = 2
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exitCode = 1
})
