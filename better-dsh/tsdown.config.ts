import { defineConfig } from 'tsdown'

/**
 * Pure-JS runtime deps inlined into the host bundle (zero-npm-runtime-deps).
 * The published package must resolve nothing from a consumer's node_modules:
 * every one of these carries no native code, so inlining is lossless.
 *
 * These are build inputs, not runtime deps — they are declared in
 * `devDependencies` (see docs/specs/zero-npm-runtime-deps/spec.md).
 */
const BUNDLED_RUNTIME = [
  'diff',
  'file-type',
  'xxhash-wasm',
  // file-type's pure-JS closure
  '@borewit/text-codec',
  '@tokenizer/inflate',
  '@tokenizer/token',
  'debug',
  'ieee754',
  'strtok3',
  'token-types',
  'uint8array-extras',
  'ignore',
  'web-tree-sitter',
  '@ast-grep/wasm',
]
export default defineConfig({
  // One entry per Plugins-page component row (spec docs/specs/plugins-page-
  // components/spec.md): the bundle patch inserts one row per subpath export.
  // Modules imported by several entries (native-capture, fs-aware/wrap,
  // py-sdk, kernel-env) code-split into shared chunks, so their module state
  // (the per-agent capture WeakMap) stays a single runtime instance.
  entry: [
    'src/index.ts',
    'src/py-sdk.ts',
    'src/kernel-env.ts',
    'src/fs-aware/sandbox-plugin.ts',
    'src/url-schemes/index.ts',
    'src/failover/index.ts',
    'src/compaction/index.ts',
    'src/web-trust.ts',
    'src/web-password.ts',
    'src/welcome-notice.ts',
    'src/mobile/plugin.ts',
    'src/remote/plugin.ts',
  ],
  // Pin the output beside the package.json `main`/`types` declarations (the
  // default dist/ would leave the exports map dangling on a published tarball).
  outDir: 'lib',
  // Do NOT bundle dependency types into the declaration: inlined copies
  // create duplicate type identities in a consumer's program (schemastery's
  // generics appear twice and stop unifying). External imports resolve from
  // each consumer's own tree — one identity per package there.
  // Reproducibility mitigations (2026-10-17, discovered during 0.3.1-c):
  // clean output + hashless chunk names (below) fixed stale-chunk accumulation
  // and filename churn — the JS side is now byte-stable across builds.
  // RESIDUAL: rolldown-plugin-dts 0.17.8 assigns d.ts module ids
  // nondeterministically (6 clean builds → 5 distinct d.ts hashes; the
  // externals-vs-inline form of host-peer types flips at random; isolated +
  // parallel:false narrow but do not remove it). Each pack is one valid,
  // self-consistent sample — identity is pinned by the round's recorded
  // SHA-256; full determinism needs an upstream fix/upgrade (toolchain debt,
  // remote-rescope backlog). super-dsh's remote closure is single-entry and
  // unaffected.
  dts: { resolve: false, isolated: true, parallel: false },
  // Zero-npm-runtime-deps (docs/specs/zero-npm-runtime-deps/spec.md): the
  // pure-JS runtime deps above are inlined instead of resolving from the
  // consumer's tree; the prefix match also covers subpath imports.
  noExternal: (id: string) => BUNDLED_RUNTIME.some(name => id === name || id.startsWith(`${name}/`)),
  platform: 'node',
  format: 'esm',
  // Reproducible builds (2026-10-17): the default chunk name "[name]-[hash]"
  // is NOT content-stable on the dts side (rolldown-plugin-dts inherits it),
  // so every clean rebuild emitted differently-named web-trust-<hash>.d.ts
  // chunks and no two tarballs matched. Plain [name] chunk names for both JS
  // and d.ts + clean output make pack byte-reproducible.
  clean: true,
  outputOptions: { exports: 'named', chunkFileNames: '[name].js' },
})
