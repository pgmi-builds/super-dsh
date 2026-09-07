#!/usr/bin/env node
/**
 * superd CLI 薄壳：在任何可能（传递地）读 harness home 的模块加载前，
 * 先把 superd home 写入环境。ESM 静态 import 先于 main 体执行——所以
 * home 模块只准 import node: 内建，其余全部走动态 import。
 */
import { applySuperdHomeEnv } from './home.ts'

const args = process.argv.slice(2)
const homeIdx = args.indexOf('--home')
applySuperdHomeEnv(homeIdx !== -1 ? args[homeIdx + 1] : undefined)

void import('./superd.ts')
