# Claude SDK Runtime 出包 + Multi-Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `@anthropic-ai/claude-agent-sdk` 从依赖面整体摘除（运行时自取进 world home，本地 binary 优先），并为 `agent-claude` 加上 codex 同构的 Multi-Provider 面（`claudeProviders` RPC + hub 面板 + DeepSeek/GLM 测试种子）。

**Architecture:** 单线不动名（world key `claude` 不变）。两条工作面：① `sdk-runtime.ts` 零依赖自取（marker/lock/error-log 同 `agent-codex-sdk` 形态，双模式：host-binary 默认 `--omit=optional` / bundled-payload 兜底）；② provider 五模块（`claude-providers/native-config/route/launch/provider-gateway`）逐字移植 codex 同名模块的形状，注入走 SDK `Options.env`（REPLACE 语义，spread `process.env`），provider 切换 = 轮间换子进程 + `resumeSessionId` 续会话，model 切换 = `setModel` live。

**Tech Stack:** TypeScript (tsc, ESM), node --test, npm runtime fetch, DSH TypertRemoteService `@Remote`。

**Spec:** `docs/specs/claude-sdk-runtime-and-multi-provider/spec.md`（本计划从 spec 论证；执行者两份都读）

## Global Constraints

- `agent-claude` 包名 / world key `claude` / world home `agents/claude` / preset id / route id / join 行：**全部不动**（spec §2.3）。
- `@anthropic-ai/claude-agent-sdk` 不进任何 `dependencies`/`optionalDependencies`/`peerDependencies`（agent-claude 与主 pack 双摘）。
- lazy spawn 铁律：`create()` 零 IO；runtime 自取与 binary 解析只发生在首个真 prompt 的 `ensureStarted()`。
- 原生 `~/.claude` 零写入；provider 只走子进程 env。
- SDK 平台载荷（206MB optional）只在 `bundled-payload` 模式（本地无 binary）安装。
- 单实例纪律：任何 `npm install` 后跑 `find super-dsh/node_modules/@deepseek-ai -maxdepth 1 -mindepth 1 ! -type l`（应无新物理目录）。
- 测试：`cd super-dsh/agent-claude && npm run build && node --test test/*.test.mjs`（测试导入 `dist/`）；测试 home 一律 tmpdir 或 `.tests/hub-test-home`，绝不写 `.tests/superd`（在役线）与 `~/.claude`。
- 隔离 env：本会话 env 自带 `DSH_HOME=/home/u1/.dsh`——测试代码读 `DSH_HOME` 的地方必须以注入值为准（provider store / sdk-runtime 全部显式传 `worldHome`，无 ambient 读取）。
- 提交在仓根 git；每 Task 一 commit；message 惯例 `agent-claude: …`。
- 场景级验证只走 4999 pack 线（`node super-dsh/scripts/pack.mjs` 是唯一打包入口），无 per-agent 场景 rig。

---

### Task 1: `sdk-runtime.ts` — 零依赖自取运行时

**Files:**
- Create: `super-dsh/agent-claude/src/sdk-runtime.ts`
- Test: `super-dsh/agent-claude/test/sdk-runtime.test.mjs`

**Interfaces:**
- Consumes: nothing（新模块；node:fs / node:child_process / 动态 import）。
- Produces（后续 Task 依赖的精确签名）:

```ts
export const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";
export const SDK_PACKAGE_VERSION = "0.3.263";
export type SdkRuntimeMode = "host-binary" | "bundled-payload";
export interface SdkRuntimeLayout { dir: string; marker: string; lock: string; errorLog: string }
export function sdkRuntimeLayout(worldHome: string): SdkRuntimeLayout;
export interface SdkRuntimeRecord { sdkPackage: string; sdkVersion: string; mode: SdkRuntimeMode; createdAt: number }
export function readSdkRuntimeRecord(worldHome: string): SdkRuntimeRecord | undefined;
export function resolveClaudeBinary(): string | undefined;   // CLAUDE_EXECUTABLE > PATH > ~/.local/bin/claude > /usr/local/bin/claude
export function sdkInstallArgv(version: string, mode: SdkRuntimeMode): string[];
export interface SdkRuntimeDeps {
  install(cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<void>;
  now(): number;
}
export function ensureSdkRuntime(worldHome: string, deps?: Partial<SdkRuntimeDeps>): Promise<SdkRuntimeRecord>;
export function loadClaudeQuery(worldHome: string): Promise<(o: { prompt: unknown; options: unknown }) => unknown>;
```

- [ ] **Step 1: 写失败测试**（tmpdir home；注入 deps 捕获 install 调用）

```js
// test/sdk-runtime.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sdkRuntimeLayout, readSdkRuntimeRecord, resolveClaudeBinary,
  sdkInstallArgv, ensureSdkRuntime,
} from "../dist/sdk-runtime.js";

function tmpHome() { return mkdtempSync(join(tmpdir(), "cc-sdkrt-")); }

test("layout paths sit under worldHome", () => {
  const h = tmpHome();
  const l = sdkRuntimeLayout(h);
  assert.equal(l.dir, join(h, "sdk-runtime"));
  assert.equal(l.marker, join(h, "sdk-runtime.json"));
  assert.equal(l.lock, join(h, "sdk-runtime.lock"));
  assert.equal(l.errorLog, join(h, "sdk-runtime.error.log"));
});

test("install argv: host-binary mode omits optional, bundled keeps it", () => {
  const host = sdkInstallArgv("0.3.263", "host-binary");
  assert.ok(host.includes("--omit=optional"));
  assert.ok(host.includes("--ignore-scripts"));
  assert.ok(host.includes("@anthropic-ai/claude-agent-sdk@0.3.263"));
  const bundled = sdkInstallArgv("0.3.263", "bundled-payload");
  assert.ok(!bundled.includes("--omit=optional"));
});

test("ensureSdkRuntime host-binary mode: installs without optional, writes marker last", async () => {
  const h = tmpHome();
  const calls = [];
  const rec = await ensureSdkRuntime(h, {
    install: async (cmd, args, opts) => { calls.push({ cmd, args, cwd: opts.cwd }); },
    now: () => 1234,
  });
  assert.equal(rec.mode, "host-binary");
  assert.equal(rec.sdkVersion, "0.3.263");
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.includes("--omit=optional"));
  assert.equal(calls[0].cwd, join(h, "sdk-runtime"));
  const marker = JSON.parse(await import("node:fs").then(fs => fs.readFileSync(sdkRuntimeLayout(h).marker, "utf8")));
  assert.equal(marker.mode, "host-binary");
  assert.equal(marker.createdAt, 1234);
  // idempotent second call: no second install
  const rec2 = await ensureSdkRuntime(h, {
    install: async () => { throw new Error("must not reinstall"); },
    now: () => 5678,
  });
  assert.equal(rec2.createdAt, 1234);
});

test("ensureSdkRuntime reinstalls when mode flips (binary appeared)", async () => {
  const h = tmpHome();
  await ensureSdkRuntime(h, {
    install: async () => {},
    now: () => 1,
    // force bundled on first call
  });
  // simulate marker written as bundled-payload, then binary mode requested
  const l = sdkRuntimeLayout(h);
  writeFileSync(l.marker, JSON.stringify({ sdkPackage: "@anthropic-ai/claude-agent-sdk", sdkVersion: "0.3.263", mode: "bundled-payload", createdAt: 1 }));
  const calls = [];
  await ensureSdkRuntime(h, { install: async (c, a) => { calls.push(a); }, now: () => 2 });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes("--omit=optional"), "reinstall in host-binary mode");
});

test("failed install writes error log and throws", async () => {
  const h = tmpHome();
  await assert.rejects(ensureSdkRuntime(h, {
    install: async () => { throw new Error("ECONNREFUSED"); },
    now: () => 1,
  }), /ECONNREFUSED/);
  const log = await import("node:fs").then(fs => fs.readFileSync(sdkRuntimeLayout(h).errorLog, "utf8"));
  assert.match(log, /ECONNREFUSED/);
  assert.equal(readSdkRuntimeRecord(h), undefined, "no marker on failure");
});

test("resolveClaudeBinary honors CLAUDE_EXECUTABLE and returns undefined when absent", () => {
  // on this machine a binary exists; the undefined branch is exercised via
  // PATH= empty + HOME=tmp (see acceptance), here only the env override:
  const prev = process.env.CLAUDE_EXECUTABLE;
  process.env.CLAUDE_EXECUTABLE = "/nonexistent/claude";
  // CLAUDE_EXECUTABLE wins verbatim only if it exists — resolver checks existsSync
  // so a nonexistent override falls through to PATH/native paths.
  const r = resolveClaudeBinary();
  if (r === undefined) { /* fine on a machine without claude */ }
  process.env.CLAUDE_EXECUTABLE = prev;
});
```

注：`resolveClaudeBinary` 的语义钉死为——`CLAUDE_EXECUTABLE` **存在性检查通过**才用；否则 PATH 扫 `claude`；再否则 `~/.local/bin/claude`、`/usr/local/bin/claude`；全落空返回 `undefined`（这是与现 `claude-client.ts` 版本的关键差异：不再回落 `"claude"` 裸名，因为回落裸名 = 假装 host-binary 模式）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd super-dsh/agent-claude && npm run build 2>&1 | head -5; node --test test/sdk-runtime.test.mjs`
Expected: FAIL（`Cannot find module '../dist/sdk-runtime.js'`）

- [ ] **Step 3: 实现 `src/sdk-runtime.ts`**

要点（完整实现，对照 `agent-codex-sdk/src/sdk-runtime.ts` 的 marker/lock/error-log 机制）：

```ts
/**
 * sdk-runtime.ts — the lazy, durable Claude Agent SDK runtime (2026-10-04 spec §2.1).
 *
 * Zero declared dependency: the FIRST real prompt fetches
 * `@anthropic-ai/claude-agent-sdk` into <worldHome>/sdk-runtime/ and it stays
 * durable there. Two modes (user ruling 2026-10-04): host-binary (default,
 * `--omit=optional` — the 206 MB platform payload is never downloaded; the CLI
 * is the user's own binary) and bundled-payload (no local binary: the SDK's
 * own platform payload IS the CLI). A mode flip re-installs with the other
 * flag set (idempotent heal); a FAILED fetch writes sdk-runtime.error.log and
 * throws — never a silent degradation.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

export const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";
export const SDK_PACKAGE_VERSION = "0.3.263";
export type SdkRuntimeMode = "host-binary" | "bundled-payload";
// layout/record/read/marker-last/lock(mkdir)-with-stale-recovery 逐字对照
// agent-codex-sdk/src/sdk-runtime.ts 的同名机制（lock 目录存在即他人进行中；
// wait + re-check marker；崩溃残留 lock 按 mtime > 10min 抢占）。
export function sdkInstallArgv(version: string, mode: SdkRuntimeMode): string[] {
  const argv = ["install", "--exact", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund",
    `${SDK_PACKAGE}@${version}`];
  if (mode === "host-binary") argv.push("--omit=optional");
  return argv;
}
export function resolveClaudeBinary(): string | undefined {
  const override = process.env.CLAUDE_EXECUTABLE;
  if (override && existsSync(override)) return override;
  for (const dir of (process.env.PATH ?? "").split(":").filter(Boolean)) {
    if (existsSync(join(dir, "claude"))) return join(dir, "claude");
  }
  for (const candidate of [join(homedir(), ".local/bin/claude"), "/usr/local/bin/claude"]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}
// ensureSdkRuntime(worldHome, deps?): mkdir worldHome; lock; record = read;
//   wantedMode = resolveClaudeBinary() ? "host-binary" : "bundled-payload";
//   if (record && record.sdkVersion === SDK_PACKAGE_VERSION && record.mode === wantedMode
//       && existsSync(entryPath(worldHome))) return record;
//   try { install npm; write marker LAST } catch (e) { append errorLog; rm -rf dir; throw }
export function sdkEntryPath(worldHome: string): string {
  return join(sdkRuntimeLayout(worldHome).dir, "node_modules", "@anthropic-ai", "claude-agent-sdk", "sdk.mjs");
}
export async function loadClaudeQuery(worldHome: string) {
  await ensureSdkRuntime(worldHome);
  return await import(pathToFileURL(sdkEntryPath(worldHome)).href);
}
```

默认 deps：`install` = `promisify(execFile)(cmd, args, { cwd, env, maxBuffer: 64MB })`，cmd = `process.env.SUPERD_SDK_NPM ?? "npm"`（可注入换 pnpm/corepack）；`now` = `Date.now`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd super-dsh/agent-claude && npm run build && node --test test/sdk-runtime.test.mjs`
Expected: PASS（全绿）

- [ ] **Step 5: Commit**

```bash
git add super-dsh/agent-claude/src/sdk-runtime.ts super-dsh/agent-claude/test/sdk-runtime.test.mjs
git commit -m "agent-claude: sdk-runtime — zero-dep runtime self-fetch (host-binary/bundled-payload)"
```

---

### Task 2: claude-client 接到自取运行时（保持同步工厂不变量）

**Files:**
- Modify: `super-dsh/agent-claude/src/claude-client.ts`
- Test: `super-dsh/agent-claude/test/claude-client.test.mjs`（已存在，改注入路径相关断言）

**Interfaces:**
- Consumes: Task 1 的 `loadClaudeQuery(worldHome)`、`resolveClaudeBinary()`。
- Produces: `ClaudeClientConfig` 增加 `worldHome?: string`（生产路径必填——index.ts 两处构造点传入；缺省时 `ensureStarted` 抛 `agent-claude: client needs worldHome to fetch its SDK runtime`，测试注入 factory 不受影响）。`probeClaudeModels(config)` 增加 `worldHome`。

关键不变量（现有头注钉死）：`ClaudeFactory` 保持**同步**——`ensureStarted` 里先 `await` 解析出 factory，**再**同步 construct + 赋值 `this.query`，并发首 prompt 仍不可能建两个 Query。

- [ ] **Step 1: 改测试**——现有测试用 `setClaudeFactory(fake)` 注入，不受影响；补两条：

```js
test("ensureStarted without worldHome and without injected factory throws", async () => {
  resetClaudeClientState(); // factory 回到 default（自取路径）
  const client = new ClaudeSdkClient({ cwd: "/tmp" });
  await assert.rejects(() => client.ensureStarted(), /worldHome/);
});

test("module top-level has no bare claude-agent-sdk import", async () => {
  const src = await import("node:fs").then(fs => fs.readFileSync(new URL("../dist/claude-client.js", import.meta.url), "utf8"));
  assert.ok(!src.includes('from "@anthropic-ai/claude-agent-sdk"'), "bare specifier must not survive");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd super-dsh/agent-claude && npm run build && node --test test/claude-client.test.mjs`
Expected: 新两条 FAIL

- [ ] **Step 3: 实现**

`claude-client.ts` 的改动（全部局部，接口面不变）：
1. 删文件顶 `import { query as officialQuery } from "@anthropic-ai/claude-agent-sdk"` 与 `import type { CanUseTool, Options, SDKUserMessage }`（类型改本地结构类型：`CanUseTool` 形状以 `interaction.ts` 现用面为准 Duck-type；`SDKUserMessage` 在 `input-queue.ts` 同步替换为 `{ type: "user"; message: { role: "user"; content: unknown }; parent_tool_use_id?: unknown; session_id?: string }`）。
2. `defaultFactory` 改为**非模块常量**：

```ts
let factory: ClaudeFactory | undefined;   // test injection only
async function resolveFactory(worldHome: string | undefined): Promise<ClaudeFactory> {
  if (factory) return factory;
  if (worldHome === undefined) throw new Error("agent-claude: client needs worldHome to fetch its SDK runtime (the provider passes dshHomePath)");
  const sdk = await loadClaudeQuery(worldHome);
  return (o) => sdk.query({ prompt: o.prompt, options: o.options });
}
```

3. `ensureStarted()`：

```ts
const f = await resolveFactory(this.worldHome);   // await BEFORE the sync section
const queue = new InputQueue();
const query = f({ prompt: queue, options: this.buildOptions() });
this.queue = queue;
this.query = query;   // 同步段：赋值前零 await（不变量保持）
```

4. `buildOptions()`：`pathToClaudeCodeExecutable` 从 `executableResolver()` 保留（测试 seam 不动）；生产 resolver 改指 `resolveClaudeBinary()`（Task 1），返回 `undefined` 时不设该键（bundled-payload 模式让 SDK 自解析载荷）。
5. `probeClaudeModels`：同款 `await resolveFactory(config.worldHome)` 前置；config 类型加 `worldHome?`。
6. `resetClaudeClientState()` 保持复位 `factory = undefined`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd super-dsh/agent-claude && npm run build && node --test test/claude-client.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add super-dsh/agent-claude/src/claude-client.ts super-dsh/agent-claude/src/input-queue.ts super-dsh/agent-claude/test/claude-client.test.mjs
git commit -m "agent-claude: client loads SDK via runtime self-fetch (sync factory invariant kept)"
```

---

### Task 3: 依赖摘除 + 包契约测试 + 预热脚本

**Files:**
- Modify: `super-dsh/agent-claude/package.json`（删 `dependencies."@anthropic-ai/claude-agent-sdk"`；scripts 加 `"fetch-sdk-runtime": "node scripts/fetch-sdk-runtime.mjs"`）
- Modify: `super-dsh/package.json`（`dependencies` 删 `@anthropic-ai/claude-agent-sdk`；**顺带删 `@openai/codex`**——codex-sdk 零依赖裁决的同类遗留，2026-10-04 spec §1 已登记）
- Create: `super-dsh/agent-claude/scripts/fetch-sdk-runtime.mjs`
- Create: `super-dsh/agent-claude/test/package-contract.test.mjs`

- [ ] **Step 1: 写失败测试**

```js
// test/package-contract.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("package.json declares no claude-agent-sdk anywhere", () => {
  const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
  for (const section of ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"]) {
    assert.equal(pkg[section]?.["@anthropic-ai/claude-agent-sdk"], undefined, section);
  }
});

test("emitted dist never names the SDK as a module specifier", () => {
  for (const f of readdirSync(join(pkgRoot, "dist"))) {
    if (!f.endsWith(".js")) continue;
    const src = readFileSync(join(pkgRoot, "dist", f), "utf8");
    assert.ok(!/[^.\\w]from\s*["']@anthropic-ai\/claude-agent-sdk["']/.test(src), f);
  }
});
```

- [ ] **Step 2: 跑测试确认失败**（package.json 仍声明依赖 → 第一条 FAIL）

- [ ] **Step 3: 摘依赖 + 写预热脚本**

`scripts/fetch-sdk-runtime.mjs`：

```js
// Pre-warm the SDK runtime into a world home (CI / online machines).
// Usage: node scripts/fetch-sdk-runtime.mjs <worldHome>   (default: $SUPERD_WORLD_HOME or ./.sdk-runtime-preview)
import { mkdirSync } from "node:fs";
import { ensureSdkRuntime } from "../dist/sdk-runtime.js";
const worldHome = process.argv[2] ?? process.env.SUPERD_WORLD_HOME ?? join(process.cwd(), ".sdk-runtime-preview");
mkdirSync(worldHome, { recursive: true });
const rec = await ensureSdkRuntime(worldHome);
console.log(`sdk-runtime ready: ${rec.sdkPackage}@${rec.sdkVersion} mode=${rec.mode} at ${worldHome}`);
```

主 pack `super-dsh/package.json`：`dependencies` 删 `"@anthropic-ai/claude-agent-sdk"` 与 `"@openai/codex"` 两行。然后 `cd super-dsh && npm install --cache .npm-cache`（刷新 lock），**单实例检查**：

```bash
find super-dsh/node_modules/@deepseek-ai -maxdepth 1 -mindepth 1 ! -type l
```

Expected: 无新增物理目录（只允许历史遗留）。

- [ ] **Step 4: 全量构建 + 全测试绿**

Run: `cd super-dsh/agent-claude && npm run build && npm test`
Expected: PASS（含 Task 1/2 与契约测试）

- [ ] **Step 5: Commit**

```bash
git add super-dsh/agent-claude/package.json super-dsh/agent-claude/scripts super-dsh/agent-claude/test/package-contract.test.mjs super-dsh/package.json super-dsh/package-lock.json
git commit -m "agent-claude: SDK out of the dependency face — zero-dep contract + prewarm script"
```

---

### Task 4: `claude-providers.ts` — provider 正本 store

**Files:**
- Create: `super-dsh/agent-claude/src/claude-providers.ts`
- Test: `super-dsh/agent-claude/test/claude-providers.test.mjs`

**Interfaces（后续 Task 依赖，精确签名）:**

```ts
export type ClaudeProviderAuth = { readonly kind: "authToken"; readonly value: string } | { readonly kind: "apiKey"; readonly value: string };
export interface ClaudeProviderModel { readonly id: string; readonly displayName?: string; readonly contextWindow?: number }
export interface ClaudeProviderAliases { readonly sonnet?: string; readonly opus?: string; readonly haiku?: string }
export type ClaudeProviderOrigin = "native" | "user";
export interface ClaudeProviderEntry {
  readonly id: string; readonly label: string; readonly baseUrl: string;
  readonly auth: ClaudeProviderAuth;
  readonly models: readonly ClaudeProviderModel[];
  readonly aliases?: ClaudeProviderAliases;
  readonly origin: ClaudeProviderOrigin;
}
export interface ClaudeProviderStore { readonly providers: readonly ClaudeProviderEntry[]; readonly removed: readonly string[] } // removed = baseUrl 墓碑
export function providerStorePath(worldHome: string): string;                    // <worldHome>/claude-providers.json
export function readProviderStore(worldHome: string): ClaudeProviderStore;       // fail-soft；无效条目丢弃
export function writeProviderStore(worldHome: string, store: ClaudeProviderStore): void;  // 0600 + tmp+rename 原子
export function upsertProvider(store: ClaudeProviderStore, entry: ClaudeProviderEntry): ClaudeProviderStore;
export function removeProvider(store: ClaudeProviderStore, id: string): ClaudeProviderStore; // 并把其 baseUrl 记墓碑
export function isProviderId(value: unknown): value is string;                   // /^[a-z0-9][a-z0-9-]*$/
export interface NativeProviderImport { baseUrl: string; auth: ClaudeProviderAuth; models?: readonly ClaudeProviderModel[]; aliases?: ClaudeProviderAliases }
export function syncNativeProviders(store: ClaudeProviderStore, imported: readonly NativeProviderImport[]): { store: ClaudeProviderStore; added: string[]; updated: string[] };
```

- [ ] **Step 1: 写失败测试**（tmpdir；0600 断言 `statSync.mode & 0o777 === 0o600`；fail-soft：坏 JSON → 空 store；墓碑：remove 后 sync 同 URL 不复活；fold-in：同 URL 去重更新 auth/models、保留 user 条目原 id）

- [ ] **Step 2: 跑测试确认失败** — `node --test test/claude-providers.test.mjs` → `Cannot find module`

- [ ] **Step 3: 实现** — **移植源：`agent-codex/src/codex-providers.ts`**（全文件读一遍），逐字保留其头注释契约与结构，按替换表改名 + 两处语义差异：
  - 替换表：`Codex`→`Claude`、`codex-providers.json`→`claude-providers.json`、`CodexWireProtocol`/`protocol` 字段**整体删除**（claude 无协议下拉）、`CodexProviderAuth` 的 `{kind:"env"}` 分支删除 → 换成上签名（`authToken` = `ANTHROPIC_AUTH_TOKEN`(Bearer)，`apiKey` = `ANTHROPIC_API_KEY`(x-api-key)；两者都带 value，无 OAuth、无 env 形态——spec §2.2 user 裁决）。
  - 新增 `aliases?: ClaudeProviderAliases`（fold-in 从 `ANTHROPIC_DEFAULT_*_MODEL` 派生；手写条目可省略）。
  - fold-in 键 = endpoint URL（同 codex）；`syncNativeProviders` 对 URL 命中墓碑的 imported 条目**跳过**（codex 同款语义）。

- [ ] **Step 4: 跑测试确认通过**

- [ ] **Step 5: Commit**

```bash
git add super-dsh/agent-claude/src/claude-providers.ts super-dsh/agent-claude/test/claude-providers.test.mjs
git commit -m "agent-claude: claude-providers — canonical provider store (0600, tombstones, native fold)"
```

---

### Task 5: `claude-native-config.ts` — 原生 settings 只读来源

**Files:**
- Create: `super-dsh/agent-claude/src/claude-native-config.ts`
- Test: `super-dsh/agent-claude/test/claude-native-config.test.mjs`（夹具 = tmpdir 假 `~/.claude`，写 `settings.json`）

**Interfaces:**

```ts
export interface NativeProviderTable {
  baseUrl?: string; auth?: ClaudeProviderAuth;
  models: ClaudeProviderModel[];      // 从 DEFAULT_*_MODEL 别名去重派生
  aliases?: ClaudeProviderAliases;    // sonnet/opus/haiku ← ANTHROPIC_DEFAULT_{SONNET,OPUS,HAIKU}_MODEL
}
export function readNativeProviders(claudeHome: string): NativeProviderTable[]; // 0..1 条；settings.json env 段
export function readNativeModel(claudeHome: string): string | undefined;        // env.ANTHROPIC_MODEL
export function resolveClaudeHome(): string; // 从 claude-home.ts 移入或 re-export（现行实现：CLAUDE_CONFIG_DIR ?? ~/.claude）
```

- [ ] **Step 1: 写失败测试**——夹具按本机实测形状（spec §1）：`env: { ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY, ANTHROPIC_MODEL, ANTHROPIC_DEFAULT_SONNET_MODEL, ANTHROPIC_DEFAULT_OPUS_MODEL, ANTHROPIC_DEFAULT_HAIKU_MODEL, API_TIMEOUT_MS }`；断言：auth kind 按 key 名判（`ANTHROPIC_AUTH_TOKEN` → authToken 优先，其次 `ANTHROPIC_API_KEY` → apiKey）；models = 三个别名值去重序列；无 env 段/坏 JSON → 空表（fail-soft）；**缺 BASE_URL → 空表**（无端点不算 provider）。
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**（纯读函数；`JSON.parse` try/catch；零写入）——移植源 `agent-codex/src/codex-native-config.ts` 的结构（providerCatalogDir 等目录函数不需要，claude 无 per-provider catalog 文件）。
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: Commit** — `agent-claude: claude-native-config — read-only settings.json env source`

---

### Task 6: `claude-route.ts` — 路由解析 + 合成键

**Files:**
- Create: `super-dsh/agent-claude/src/claude-route.ts`
- Test: `super-dsh/agent-claude/test/claude-route.test.mjs`

**Interfaces:**

```ts
export interface RouteSelection { readonly provider: string; readonly model: string }
export function routeOf(value: unknown): RouteSelection | undefined;   // 结构校验；provider+model 都非空串才算完整
export function resolveRoute(candidates: { pending?: unknown; logged?: unknown; preferred?: unknown; fallback?: unknown }): RouteSelection | undefined;
export function compositeModelId(provider: string, model: string): string;   // `${provider}/${model}`
export function parseCompositeModelId(id: string): { provider: string; model: string } | undefined; // 首个 '/' 切分；无 '/' → undefined
export function routeSeed(options: { provider: string; model: string }): RouteSelection; // 新会话 log 种子（单参，防 codex 线踩过的双源坑）
```

- [ ] **Step 1: 写失败测试**——移植 `agent-codex/test/` 里 codex-route 的用例形状（pending 优先 / 半残值跳过 / fallback 兜底）+ 合成键 roundtrip + `parseCompositeModelId("deepseek/deepseek-flash")`、`parseCompositeModelId("sonnet") → undefined`。
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现** — **逐字移植 `agent-codex/src/codex-route.ts`**（`reasoningEffort` 字段删除——claude 线无 effort 路由面）+ 上签名的新增两函数。
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: Commit** — `agent-claude: claude-route — harness-precedence route + composite model keys`

---

### Task 7: `claude-launch.ts` — SDK Options 注入切片

**Files:**
- Create: `super-dsh/agent-claude/src/claude-launch.ts`
- Test: `super-dsh/agent-claude/test/claude-launch.test.mjs`

**Interfaces:**

```ts
export interface ClaudeLaunchSpec {
  readonly providerId: string | null;      // null = native（零注入）
  readonly env: Readonly<Record<string, string>>;  // ANTHROPIC_* 覆盖；调用方 spread 在 process.env 之后
  readonly model?: string;                 // 裸 model id（wire 面）
  readonly pathToClaudeCodeExecutable?: string;
}
export const NATIVE_LAUNCH: ClaudeLaunchSpec;   // { providerId: null, env: {} }
export function claudeLaunchFor(route: RouteSelection, entry: ClaudeProviderEntry, hostBinary?: string): ClaudeLaunchSpec;
```

- [ ] **Step 1: 写失败测试**——`claudeLaunchFor({provider:'glm',model:'glm-5.2'}, glmEntry, '/usr/bin/claude')` 断言 env 全形状：

```js
env: {
  ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
  ANTHROPIC_AUTH_TOKEN: "<value>",            // authToken kind
  ANTHROPIC_MODEL: "glm-5.2",
  ANTHROPIC_DEFAULT_SONNET_MODEL: "<aliases.sonnet>",  // 条目带 aliases 才注入
  ANTHROPIC_DEFAULT_OPUS_MODEL: "...", ANTHROPIC_DEFAULT_HAIKU_MODEL: "...",
}
model: "glm-5.2"; pathToClaudeCodeExecutable: "/usr/bin/claude"; providerId: "glm"
// apiKey kind → ANTHROPIC_API_KEY；无 aliases → 无 DEFAULT_* 键；hostBinary undefined → 无 path 键
```

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**（纯函数；对照 `agent-codex/src/codex-launch.ts` 的 env_key 合成变量思路——claude 不需要合成变量，token/key 本身就是标准 env 名）。
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: Commit** — `agent-claude: claude-launch — provider → Options.env injection slice`

---

### Task 8: `claude-provider-gateway.ts` — RPC 面

**Files:**
- Create: `super-dsh/agent-claude/src/claude-provider-gateway.ts`
- Test: `super-dsh/agent-claude/test/claude-provider-gateway.test.mjs`（纯函数层，无 Cordis Context——gateway 类是委托壳）

**Interfaces:**

```ts
export interface ClaudeProviderView { id; label; baseUrl; models; authKind: "authToken" | "apiKey"; hasKey: boolean }
export interface ClaudeProvidersView {
  providers: readonly ClaudeProviderView[];
  native: { baseUrl?: string; model?: string } | null;   // 只读展示用户的 settings.json 现状
  paths: { store: string; settings: string };
  syncedAt?: number; note?: string;
}
export function readProvidersView(worldHome: string, claudeHome: string, syncedAt?: number): ClaudeProvidersView; // 先 syncFromNative
export function saveProvider(worldHome: string, claudeHome: string, request: unknown, syncedAt?): ClaudeProvidersView;
export function removeProviderEntry(worldHome: string, claudeHome: string, request: unknown, syncedAt?): ClaudeProvidersView;
export class ClaudeProvidersGateway extends TypertRemoteService {
  constructor(ctx: Context, worldHome: string, claudeHome: () => string, onChange?: () => void);
  @Remote("get") get(): Promise<ClaudeProvidersView>;
  @Remote("save") save(request?: unknown): Promise<ClaudeProvidersView>;
  @Remote("remove") remove(request?: unknown): Promise<ClaudeProvidersView>;
}
```

- [ ] **Step 1: 写失败测试**——`normalizeSaveRequest` 语义（移植 codex 版）：id 正则 / baseUrl http(s) 校验 / models 数组 / **auth 只收 `authToken`|`apiKey`**（其它 kind 抛 TypeError 引用 spec）；编辑不回传 key（`value === ""`）保留存量；view 永不携带 key（`JSON.stringify(view)` 不含存值）；sync note 文案。
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现** — **移植源：`agent-codex/src/codex-provider-gateway.ts`** 全文，替换表：`Codex`→`Claude`、namespace `"codexProviders"`→`"claudeProviders"`、`PROTOCOL_OPTIONS`/`protocol` 面**整体删除**、`chatgptAuthMode`/`authJsonHasKey`/`shadowed` 逻辑**删除**（claude 无 auth manager 遮蔽问题——token/key 都走 env）、`paths` = `{store, settings}`、native 视图 = `readNativeProviders` 首条 + `readNativeModel`。
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: Commit** — `agent-claude: claudeProviders gateway — adapter-owned provider RPC (get/save/remove)`

---

### Task 9: client launch 面 + agent 路由对账（provider 切换 = 轮间换子进程）

**Files:**
- Modify: `super-dsh/agent-claude/src/claude-client.ts`（`ClaudeClientConfig.launch?: ClaudeLaunchSpec`；`buildOptions()` 合并；`appliedProvider` getter）
- Modify: `super-dsh/agent-claude/src/agent.ts`（`#resolveRoute` / `#applyRoute` 镜像 codex；reattach = 换 client 实例）
- Modify: `super-dsh/agent-claude/src/index.ts:283,:412`（两处 `new ClaudeSdkClient` 传 `worldHome: this.home` + `launch`，构造包一层工厂回调供 agent 换实例）
- Modify: `super-dsh/agent-claude/src/models.ts`（合成键铸造 + provider models 并入）
- Test: `super-dsh/agent-claude/test/claude-launch-reconcile.test.mjs`（新）

**Interfaces:**
- Consumes: Task 4/6/7 的 `ClaudeProviderStore`/`resolveRoute`/`claudeLaunchFor`/`NATIVE_LAUNCH`。
- Produces（client/agent 间精确契约）:

```ts
// claude-client.ts
export interface ClaudeClientConfig { /* 现有字段 + */
  worldHome?: string;
  launch?: ClaudeLaunchSpec;          // 缺省 = NATIVE_LAUNCH
}
export class ClaudeSdkClient {
  get appliedProvider(): string | null;   // 当前 launch 的 providerId（构造事实）
  setLaunch(launch: ClaudeLaunchSpec): void;  // 仅未 spawn 时合法；spawned 后抛
}

// agent.ts（ClaudeAgent 内，镜像 codex agent.ts:808-870）
#resolveRoute(): RouteSelection | undefined
  // pending  = ctx sessionProjections.stateOf(session, "modelSelection")?.pending
  // logged   = session.requestHeader()?.config
  // preferred= (ctx.get("agentDefaultModel") as {currentSelection?()})?.currentSelection()
  // fallback = seedRoute(this.#reconciledOptions)   // native fold model 或首 provider 首 model
async #applyRoute(route: RouteSelection | undefined): Promise<void>
  // 1) client 未 spawn → setLaunch + ensureStarted（lazy-spawn 门：选模型零进程代价）
  // 2) appliedProvider 相同 → client.setModel(rawModel)（live；失败 trace 不抛）
  // 3) appliedProvider 不同 → #reattach(launch, providerId, model)：
  //    旧 client.close() → 经 index 注入的 clientFactory 造新 client（同 canUseTool 接线、
  //    resumeSessionId = 旧 client.threadId、listeners 重新挂）→ ensureStarted
```

- [ ] **Step 1: 写失败测试**（fake client + fake store）：

```js
test("applyRoute case 3: provider flip closes and replaces the client, resume keeps threadId", async () => {
  // old client spawned threadId "u1", appliedProvider "deepseek"
  // route = { provider: "glm", model: "glm-5.2" }
  await agent.#applyRouteForTest(route);   // 测试暴露的薄壳（仅测试导出）
  assert.ok(oldClient.closed);
  assert.equal(replacement.config.resumeSessionId, "u1");
  assert.equal(replacement.config.launch.providerId, "glm");
  assert.equal(replacement.config.launch.env.ANTHROPIC_AUTH_TOKEN, "<glm key>");
});
test("applyRoute case 2: same provider routes to live setModel with raw id", ...)
test("composite id resolution: selection 'glm/glm-5.2' → provider glm, model glm-5.2", ...)
test("unknown provider id in a legacy selection → NATIVE_LAUNCH (no injection)", ...)
```

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**——按上面 Interfaces 逐条落。`models.ts` 的目录铸造：`setModelCatalog` 条目 id 全部走 `compositeModelId`（observed 模型归当轮 provider——agent 记录 `#turnRoute?.provider ?? "native"`）；`agentDefaultModel.saveSelection` 的 fallback selection 同步合成键。`index.ts` 两处构造点改为经 `#clientFactory(config)` 闭包（agent 持有），并把 `launch` 的初值留给 agent 首个 `#applyRoute` 决定。
- [ ] **Step 4: 跑全测试确认通过** — `npm run build && npm test`
- [ ] **Step 5: Commit**

```bash
git add super-dsh/agent-claude/src/claude-client.ts super-dsh/agent-claude/src/agent.ts super-dsh/agent-claude/src/index.ts super-dsh/agent-claude/src/models.ts super-dsh/agent-claude/test/claude-launch-reconcile.test.mjs
git commit -m "agent-claude: route reconciliation — provider flip = child swap between turns, model = live setModel"
```

---

### Task 10: index.ts 装配 gateway + 周期 sync

**Files:**
- Modify: `super-dsh/agent-claude/src/index.ts`（镜像 `agent-codex/src/index.ts:143-180`：构造期 `syncFromNative(this.home, resolveClaudeHome())` trace added/updated；`setInterval(600_000)` syncNow（dispose 清理）；`new ClaudeProvidersGateway(ctx, this.home, () => resolveClaudeHome(), () => this.refreshRoutes())`；ctx.effect 卸载清理 interval——守 super-dsh/AGENTS 卸载契约）

**Interfaces:** Consumes Task 4/5/8。 Produces: 无（装配）。

- [ ] **Step 1: 构建绿 + 现有 index 相关测试不回归** — `npm run build && npm test`
- [ ] **Step 2: boot 冒烟（进程内，tmpdir home）**——临时 node 脚本 boot 该 bundle（照 `docs/07` §boot 直调纪律，world 无解析表 → 夹具自投影），断言 ctx 上可取 `claudeProviders` 服务且 `get()` 返回 view（store 文件生成在 tmp world home）。此步是临时验证脚本，不入库。
- [ ] **Step 3: Commit** — `agent-claude: assemble provider gateway + 10min native sync (fiber-scoped cleanup)`

---

### Task 11: hub 面板映射

**Files:**
- Modify: `super-dsh/superd-hub/src/client/agent-settings.ts:83-93`（`SETTINGS_PANELS` += `claude: { namespace: 'claudeProviders', kind: 'providers' }`）
- Verify/Modify: providers 面板体对 `ClaudeProvidersView` 的容错（无 `protocols` 字段、`authKind` 两值 'authToken'|'apiKey'、`native` 形状不同）——读 `runtime-settings-api.ts` 与面板组件，把 codex 专属渲染（protocols 下拉）改成按 view 缺省降级
- Test: `super-dsh/superd-hub/test/`（现有 client 纯函数测试文件追加映射断言）

- [ ] **Step 1: 写失败测试** — `settingsPanelFor('claude')` 返回 `{namespace:'claudeProviders', kind:'providers'}`；面板纯函数对无 `protocols` 的 view 渲染不抛、authKind 下拉两值。
- [ ] **Step 2: 跑确认失败**
- [ ] **Step 3: 实现**（hub client lane）——构建走 `superd-hub` 的 client build（`tsconfig.client.json` 串 build）。
- [ ] **Step 4: `node super-dsh/scripts/pack.mjs` 全绿**（首次整包验证点）
- [ ] **Step 5: Commit** — `hub: claude joins the providers settings panel (claudeProviders)`

---

### Task 12: 测试种子（DeepSeek + GLM）

**Files:**
- Create: `super-dsh/test/seed-claude-providers.mjs`
- Modify: `super-dsh/test/start-4999.sh`（bootstrap 段：pack 线 home 就绪后、world 启动前，若 `agents/claude` 存在且 store 缺两条种子则写入——幂等）

- [ ] **Step 1: 实现种子脚本**

```js
// seed-claude-providers.mjs — 测试装配（spec §2.4）：4999 线 world home 的两条 provider。
// key 来源 = 线环境（prod .env copy 惯例）：DEEPSEEK_API_KEY / ZAI_PLAN_API_KEY。零硬编码 key。
// 用法: node seed-claude-providers.mjs <worldHome>   （worldHome = <lineHome>/agents/claude）
// 缺 key 时跳过对应条目并 stderr 提示（不失败——无 key 的机器线照常起）。
```

条目：`deepseek`（`https://api.deepseek.com/anthropic`，apiKey，models `deepseek-flash`/`deepseek-v4-pro`）+ `glm`（`https://api.z.ai/api/anthropic`，authToken=`ZAI_PLAN_API_KEY`，models `glm-5.3`/`glm-5.3-flash`/`glm-5.2` ctx 1000000）。复用 `dist/claude-providers.js` 的 `readProviderStore/writeProviderStore/upsertProvider`（import 走相对 `../agent-claude/dist/claude-providers.js`）。

- [ ] **Step 2: 手动验证种子** — `SUPERD_WORLD_HOME=$(mktemp -d) DEEPSEEK_API_KEY=sk-test ZAI_PLAN_API_KEY=k node seed…` → 检查 JSON 0600、两条目、再跑一次幂等。
- [ ] **Step 3: start-4999.sh 接线**（在 world provision 之前调用；`agents/claude` 目录由 provisionWorldProfile 创建，故 hook 放 provision 之后的首次启动前——读脚本现结构定位）
- [ ] **Step 4: Commit** — `test: seed claude providers (deepseek + glm) for the 4999 pack line`

---

### Task 13: 验收（运行时行为）+ 报告

**Files:**
- Create: `docs/test-reports/2026-10-04-claude-sdk-runtime-and-multi-provider.md`

- [ ] **Step 1: 单测全绿 + pack** — `agent-claude npm test`、`node super-dsh/scripts/pack.mjs`、tarball 内确认**无** `@anthropic-ai` 目录（`tar -tf | grep -c @anthropic` = 0）。
- [ ] **Step 2: 4999 pack 线启动**（`bash super-dsh/test/start-4999.sh`；499x 口占用按端口纪律处置）——roster 出 `Claude`、world boot 零解析错误（`journalctl --user -u superd-4999-test` 零 `world failed`）。
- [ ] **Step 3: 交付形态契约** — 线上 world home `.tests/superd/agents/claude/sdk-runtime/node_modules/@anthropic-ai/` **只有 `claude-agent-sdk`**（无 `-linux-x64` 载荷目录 = host-binary 模式证毕）；probe/首轮后 marker JSON `mode=host-binary`。
- [ ] **Step 4: 真 turn 链**（浏览器，token URL 交 user 或按验收模式停下交用户前先自测）：
  1. create 会话 → 选 `deepseek/deepseek-flash` → prompt → 回答到达；`approval` 桥真卡一次（如 Bash 类工具）；
  2. live 换 model：同 provider 内选 `deepseek/deepseek-v4-pro` → 下一轮回答来自新模型（`request/header` 快照 + 回答内容判别）；
  3. 轮间切 provider：选 `glm/glm-5.3` → 下一轮**新子进程**（旧 claude 子进程消失：`ps` 核对）+ 同 session 续上下文（问「我上一句话说了什么」答对）；
  4. 重启 4999 线 → 会话 list/replay/resume 正常，provider 归属随 logged selection；
  5. hub 面板：claude 行展开 `claudeProviders`，增删改一条 provider 落盘 0600，key 不回显。
- [ ] **Step 5: bundled-payload 兜底单验**（一次性，隔离 home）：`CLAUDE_EXECUTABLE=`、PATH 剥离、`HOME=<tmp>` 下 `SUPERD_WORLD_HOME=<tmp> npm run fetch-sdk-runtime` → 载荷目录出现、`loadClaudeQuery` 可 import（不跑真 turn，只证装通+可加载）。
- [ ] **Step 6: 报告落盘**（`docs/test-reports/2026-10-04-claude-sdk-runtime-and-multi-provider.md`：证据 = 上述每步的探针输出/日志行/文件树），停线交 user 复核 → 报告通过后按版本纪律走 dev3 实装轮（另一轮次，不在本计划）。
- [ ] **Step 7: Commit** — `docs: claude sdk-runtime + multi-provider acceptance report`

---

## Self-Review

**Spec coverage：** spec §2.1→Task 1/2/3；§2.2 五模块→Task 4/5/6/7/8/9/10；切换语义→Task 9；合成键→Task 6/9；§2.3 hub→Task 11；§2.4 种子→Task 12；§3 红线→Global Constraints + Task 3 Step 3 单实例检查；§5 验收→Task 13（含 §5 双模式）。§4 不做项无任务（正确）。**缺口检查：** spec §5.3 提到的「重启线 resume」在 Task 13.4；spec §2.1「失败响亮」在 Task 1 测试第 5 条 + Task 13。无缺口。

**Placeholder scan：** Task 4/5/6/8 为「移植 + 替换表」式任务——替换表显式列出每个语义差异，移植源为仓内现存文件（非其它 Task），符合 DRY 且无 TBD。Task 9 的 `#applyRouteForTest` 是显式声明的测试薄壳（有名字有行为）。无「类似 Task N」。

**Type consistency：** `ClaudeProviderAuth`（Task 4 定义）= Task 5 `NativeProviderTable.auth` = Task 7 `claudeLaunchFor` 消费 = Task 8 `authKind` 视图（视图用串 `"authToken"|"apiKey"`，存储用判别联合——与 codex 同款）。`RouteSelection`（Task 6）= Task 7/9 消费。`ClaudeLaunchSpec`（Task 7 定义）= Task 9 `ClaudeClientConfig.launch`。`ClaudeProvidersView`（Task 8）= Task 11 面板容错对象。一致。
