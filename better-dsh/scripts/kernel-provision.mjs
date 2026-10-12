#!/usr/bin/env node
/** Explicit compatibility command: prepare only a stdlib Python environment, never pip packages. */
const { resolveKernelEnv } = await import(new URL('../lib/kernel-env.js', import.meta.url).href)
const env = await resolveKernelEnv({ log: (level, message) => console[level === 'warn' ? 'warn' : 'log'](message) })
console.log(`Better Python REPL ready: Python ${env.version} at ${env.python}`)
