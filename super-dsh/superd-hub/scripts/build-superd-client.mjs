// Client-half build for the super-dsh PACKAGE face: same closure-factory
// recipe as superd-hub/scripts/build-client.mjs, but the registration id is
// the SUPER-DSH package name — the browser module loader pairs registrations
// with graph rows by this baked id (pendingQueue match), and the graph row's
// id is the manifest package name of the composed bundle. When super-dsh is
// the composed package, the bundle must register as "super-dsh" (the hub's
// own lib/client with id "@pgmi-builds/superd-hub" is for the dev line where
// the hub itself is the bundle). Run: node scripts/build-superd-client.mjs
// (invoked by scripts/pack.mjs).
//
// The emitter is exported: test/client-bundle-drift.test.mjs runs the SAME
// config into a temp dir and byte-compares it against the delivered
// super-dsh/client/index.js, so the delivered artifact can never go stale
// relative to src/client (only pack.mjs refreshes that file today — the
// drift guard turns forgetting into a red test instead of a shipped mystery).
// The emitted bytes are pinned to NODE_ENV=production regardless of the
// invoking environment: a delivered browser artifact must not vary with who
// ran the build (the hub dev-line build keeps the env-facing spelling).
import { build } from 'tsdown'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ID = 'super-dsh'
const hubRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const DELIVERED_DIR = join(hubRoot, '..', 'client')
const OUT_FILE = 'index.js'

// The loader-table entries the bundle may require at runtime; everything
// else inlines. Type-only peers stay type-only (purity gate below).
// `dsh-client-ui-primitives` is a browser platform module (the shell's
// PLATFORM_MODULES seed): the Hub row's selector uses the native Menu, so the
// bundle must share that module instance rather than inline its own copy.
const CLIENT_EXTERNALS = [
  'react',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-store',
]

/**
 * Build the delivered super-dsh client bundle. Byte-deterministic: the same
 * src/client tree always emits the same bytes, whatever the output directory
 * AND whatever the invoking process's cwd (tsdown cwd is pinned to the hub
 * root — rolldown renders module ids relative to that anchor) — which is what
 * makes the drift guard's byte-compare meaningful.
 * @param {{ outDir?: string }} [opts] - output directory (default: the
 *   delivered super-dsh/client/).
 * @returns {Promise<string>} the emitted file path.
 */
export async function buildSuperdClient({ outDir = DELIVERED_DIR } = {}) {
  mkdirSync(outDir, { recursive: true })
  await build({
    // Pin the anchor: rolldown renders module ids (the //#region path
    // comments) relative to this cwd. Unpinned, the emitted bytes vary with
    // the INVOKING lane's process.cwd() (pack lane: hub root; pack test
    // lane: super-dsh/; a bare run from the repo root: yet another prefix),
    // which made the drift guard fail only in lanes that happened to start
    // elsewhere — the "load-dependent flake" of 2026-09-29 was exactly this
    // (110112B vs 110244B = 'superd-hub/' × 12 region comments). Byte
    // determinism is only true with the anchor pinned to the hub root.
    cwd: hubRoot,
    name: `${ID}/client`,
    config: false,
    name: `${ID}/client`,
    entry: { index: join(hubRoot, 'src/client/index.ts') },
    outDir,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    clean: false,
    external: [...CLIENT_EXTERNALS],
    noExternal: (id) => !CLIENT_EXTERNALS.includes(id),
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
    },
    outputOptions: {
      entryFileNames: OUT_FILE,
      // Closure-factory handoff (mirror of the dsh tsdown recipe).
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
    plugins: [
      {
        name: 'dsh-client-bundle-purity',
        resolveId(source) {
          if (source.startsWith('@deepseek-ai/') && !CLIENT_EXTERNALS.includes(source)) {
            throw new Error(
              `client bundle purity: value import of ${source} is not in CLIENT_EXTERNALS — type-only peers must stay type-only (use \`import type\`)`,
            )
          }
          return null
        },
      },
    ],
  })
  const outFile = join(outDir, OUT_FILE)
  if (!existsSync(outFile)) {
    throw new Error(`client build did not produce ${outFile}`)
  }
  return outFile
}

// CLI face: only when invoked directly (pack.mjs / manual), never on import.
const self = fileURLToPath(import.meta.url)
const isMain = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(self)
  } catch {
    return false
  }
})()
if (isMain) {
  await buildSuperdClient()
  console.log(`build-client:superd: superd-hub/src/client/index.ts -> super-dsh/client/${OUT_FILE} (closure-factory CJS, id=${ID})`)
}
