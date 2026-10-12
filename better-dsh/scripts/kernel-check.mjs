#!/usr/bin/env node
/** Check an existing interpreter; never install Python or create an environment. */
const { resolveKernelEnv } = await import(new URL('../lib/kernel-env.js', import.meta.url).href)
const env = await resolveKernelEnv({ python: process.env.DASHR_KERNEL_PYTHON })
console.log(`Better Python REPL ready: Python ${env.version} at ${env.python}`)
