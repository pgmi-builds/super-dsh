// Client-half build for @pgmi-builds/superd-hub: closure-factory
// CJS artifact the browser module loader consumes (mirror of the omp-web-sdk
// recipe). Run: npm run build-client
import { build } from 'tsdown'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ID = '@pgmi-builds/superd-hub'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(root, 'lib/client')
const OUT_FILE = 'index.js'

// The loader-table entries the bundle may require at runtime; everything
// else inlines. Type-only peers stay type-only (purity gate below).
// `dsh-client-ui-primitives` is a browser platform module (the shell's
// PLATFORM_MODULES seed), so requiring it hands the plugin the SAME module
// instance the native chrome uses — never a vendored copy. The Hub row's
// selector uses the native Menu from it.
const CLIENT_EXTERNALS = [
  'react',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-store',
]

mkdirSync(OUT_DIR, { recursive: true })

await build({
  config: false,
  // Pin the anchor (see build-superd-client.mjs for the full story): the
  // emitted module ids must not vary with the invoking process's cwd.
  cwd: root,
  name: `${ID}/client`,
  entry: { index: join(root, 'src/client/index.ts') },
  outDir: OUT_DIR,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  clean: false,
  external: [...CLIENT_EXTERNALS],
  noExternal: (id) => !CLIENT_EXTERNALS.includes(id),
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  outputOptions: {
    entryFileNames: OUT_FILE,
    // Closure-factory handoff (mirror of the dsh tsdown recipe): `intro`
    // lands inside the factory body (after `banner`) and declares
    // `module`/`exports` because the bundler's cjs emission assigns
    // module.exports itself; the factory returns that surface to the loader.
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

const outFile = join(OUT_DIR, OUT_FILE)
if (!existsSync(outFile)) {
  throw new Error(`client build did not produce ${outFile}`)
}
console.log(`build-client: src/client/index.ts -> ${join('lib/client', OUT_FILE)} (closure-factory CJS, tsdown)`)
