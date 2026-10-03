#!/usr/bin/env node
// Pre-warm the SDK runtime into a world home (CI / online machines).
// Usage: node scripts/fetch-sdk-runtime.mjs <worldHome>   (default: $SUPERD_WORLD_HOME or ./.sdk-runtime-preview)
//
// The adapter fetches the SDK lazily on the first real prompt (src/sdk-runtime.ts);
// this script exists for pre-provisioning a machine and for recovering from a
// recorded failure (<worldHome>/sdk-runtime.error.log). It is a dev/ops tool, NOT
// part of the test suite: it performs a network install on a cache miss.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ensureSdkRuntime } from "../dist/sdk-runtime.js";
const worldHome = process.argv[2] ?? process.env.SUPERD_WORLD_HOME ?? join(process.cwd(), ".sdk-runtime-preview");
mkdirSync(worldHome, { recursive: true });
const rec = await ensureSdkRuntime(worldHome);
console.log(`sdk-runtime ready: ${rec.sdkPackage}@${rec.sdkVersion} mode=${rec.mode} at ${worldHome}`);
