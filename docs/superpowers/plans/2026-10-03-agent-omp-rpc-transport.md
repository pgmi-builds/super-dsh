# OMP Adapter RPC Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `@pgmi-builds/agent-omp` 的传输层从内置 Bun sidecar SDK 换回 `omp --mode rpc` NDJSON，直接用用户本机已装的 `omp` binary，并从交付包里删掉 838M 的 `@oh-my-pi` + `bun`。

**Architecture:** 新增 `src/rpc-client.ts`（从 `git show 6d2fbe1:apps/multi-agent/agent-omp/src/rpc.ts` 移植，加 binary 解析与 ready 载荷容忍），`lazy-rpc.ts` 由驱动 `OmpSdkClient` 改为驱动 `OmpRpcClient`（lazy 铁律不变），`omp-cli.ts` 数据面回到 `execFile("omp", …)`，SDK sidecar 全套（`sdk-client.ts` / `sidecar-client.ts` / `protocol.ts` / `sidecar/`）删除，打包面同步瘦身。传输停在 **协议 v1（纯 NDJSON）不协商**。

**Tech Stack:** TypeScript (strict, ESM, `tsc`)、Node 22 `node:child_process`、Cordis/DSH AgentFactory 契约、`node --test`（测试导入 `dist/`）、pnpm hoisted profile 安装。

**Spec:** `docs/specs/omp-rpc-transport/spec.md`

## Global Constraints

- 所有路径相对仓根 `/home/u1/workspaces/superd`；工作目录 `super-dsh/`。
- 构建唯一入口 `node super-dsh/scripts/pack.mjs`；禁止手搓 dist/tarball。
- 测试一律 `npm run build && node --test test/*.test.mjs`（测试导入 `dist/`）；测试 home 用 `.tests/*` 或 tmpdir，**绝不触碰 `~/.dsh` / `~/.superd`**（`~/.omp` 只读可，写一律经 `OMP_HOME`/`--session-dir` 重定向到 tmpdir）。
- 版本纪律：本轮迭代版本号用字母后缀（当前 `super-dsh@0.1.9` → `0.1.9-a`），**不 publish**，走 tarball 通道。
- `~/.omp` 是 OMP 唯一 app home，子进程 spawn **零重定向**。
- 协议：**不发 `negotiate_protocol`**（停在 v1）；`ready` 载荷只记录不校验。
- 旧代码取用命令：`git show 6d2fbe1:apps/multi-agent/agent-omp/src/<file>`。

---

### Task 1: OMP binary 解析 + RPC 传输客户端

**Files:**
- Create: `super-dsh/agent-omp/src/rpc-client.ts`
- Create: `super-dsh/agent-omp/test/fixtures/mock-omp-rpc.mjs`
- Test: `super-dsh/agent-omp/test/rpc-client.test.mjs`

**Interfaces:**
- Consumes: 无（本任务不依赖其他任务）
- Produces（Task 3/4 依赖这些确切签名）:
  - `export function resolveOmpExecutable(): string`
  - `export class OmpRpcClient`
    - `static spawn(args?: string[], cwd?: string): Promise<OmpRpcClient>`
    - `on(listener: (event: RpcEvent) => void): () => void`
    - `onTitle(listener: (title: string) => void): () => void`
    - `onFailure(listener: (error: Error) => void): () => void`
    - `sendRaw(command: Record<string, unknown>): void`
    - `send(command: Record<string, unknown>, timeoutMs?: number): Promise<RpcResponse>`
    - `getState(): Promise<OmpState>`
    - `getMessages(): Promise<OmpMessage[]>`
    - `getSessionStats(): Promise<OmpSessionStats>`
    - `getSubagents(): Promise<unknown[]>`
    - `getSystemPrompt(): Promise<string | undefined>`
    - `contextUsage(): Promise<{ tokens?: number; percent?: number } | undefined>`
    - `prompt(message: string): Promise<RpcResponse>`
    - `followUp(message: string): Promise<RpcResponse>`
    - `steer(message: string): Promise<RpcResponse>`
    - `compact(customInstructions?: string): Promise<RpcResponse>`
    - `setModel(provider: string, modelId: string): Promise<RpcResponse>`
    - `abort(): Promise<RpcResponse>`
    - `newSession(): Promise<RpcResponse>`
    - `close(): void`
  - 类型全部 `import type { RpcEvent, RpcResponse, OmpState, OmpMessage, OmpSessionStats } from "./rpc-types.js"`（已存在，不改）

> **执行顺序（controller ruling，优先于下面的 Step 编号）**：Step 1 取回旧文件 → **先**写 fixture + 测试 → 跑一次确认 FAIL（缺 `resolveOmpExecutable` / `onTitle` / `compact` / `contextUsage` / `getSystemPrompt` 导出）→ **再**打四个 delta → 跑一次确认 PASS → commit。下面的 delta 块虽然编号在测试之前，物理上必须在测试写完后再应用。

- [ ] **Step 1: 取回旧实现作为基底**

```bash
cd /home/u1/workspaces/superd
git show 6d2fbe1:apps/multi-agent/agent-omp/src/rpc.ts > super-dsh/agent-omp/src/rpc-client.ts
```

- [ ] **Step 2: 打四个 delta（这是本任务的全部改动，勿做第五个）**

D1 — 文件头替换为：

```ts
/**
 * OmpRpcClient — NDJSON client over `omp --mode rpc` stdio (RPC transport line).
 *
 * Ported from `git show 6d2fbe1:apps/multi-agent/agent-omp/src/rpc.ts`.
 *
 * Protocol: `ready` is a plain event; the current binary announces
 * `{type:"ready",protocolVersion:1,supportedProtocolVersions:[1,2],
 *   maxFrameBytes:1048576,maxReassembledFrameBytes:67108864}`.
 * We deliberately DO NOT call `negotiate_protocol`: v1 is plain NDJSON, which
 * is exactly what this reader implements. Negotiating 2 would switch the peer
 * to >1MiB frame chunking and require a reassembler (registered gap, spec §4).
 */
```

D2 — 在 import 区后插入 binary 解析（照 `agent-claude/src/claude-client.ts:67-80` 先例）：

```ts
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** `$OMP_EXECUTABLE` wins; else PATH, else the common native-installer spots. */
export function resolveOmpExecutable(): string {
  const configured = process.env.OMP_EXECUTABLE?.trim();
  if (configured !== undefined && configured !== "") return configured;
  for (const dir of (process.env.PATH ?? "").split(":").filter(Boolean)) {
    if (existsSync(join(dir, "omp"))) return "omp";
  }
  for (const candidate of [join(homedir(), ".local/bin/omp"), "/usr/local/bin/omp"]) {
    if (existsSync(candidate)) return candidate;
  }
  return "omp";
}
```

D3 — 构造函数里的 spawn 改为用解析结果（其余参数不动：`detached: true`、`stdio` 三管、`cwd`）：

```ts
  private constructor(args: string[], cwd?: string) {
    this.#proc = spawn(resolveOmpExecutable(), ["--mode", "rpc", ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      ...(cwd === undefined ? {} : { cwd }),
    });
```

D4 — 补 SDK 线独有的四个面（放在 `newSession()` 之后、`close()` 之前），并把 `#titleListeners` 加进字段区：

```ts
  readonly #titleListeners = new Set<(title: string) => void>();

  /** Title frames (OMP `session_info_update.title`, plus `setTitle` when the
   *  child runs with `PI_RPC_EMIT_TITLE=1`). Returns the unsubscriber. */
  onTitle(listener: (title: string) => void): () => void {
    this.#titleListeners.add(listener);
    return () => { this.#titleListeners.delete(listener); };
  }

  /** System prompt as OMP renders it (v18 `get_state.systemPrompt`). */
  async getSystemPrompt(): Promise<string | undefined> {
    try {
      const state = await this.getState();
      return (state as { systemPrompt?: string }).systemPrompt;
    } catch {
      return undefined;
    }
  }

  /** Context-usage snapshot for pre/post compact metering (fail-soft). */
  async contextUsage(): Promise<{ tokens?: number; percent?: number } | undefined> {
    try {
      const state = await this.getState();
      return (state as { contextUsage?: { tokens?: number; percent?: number } }).contextUsage;
    } catch {
      return undefined;
    }
  }

  /** Compact the live conversation (RPC `compact` command). */
  compact(customInstructions?: string): Promise<RpcResponse> {
    return this.send(
      customInstructions === undefined
        ? { type: "compact" }
        : { type: "compact", customInstructions },
    );
  }
```

并在 `#onLine` 的 response 分支**之前**插入 title 分派（`session_info_update` 与 `setTitle` 两种帧都要认）：

```ts
    if (record.type === "session_info_update" && typeof record.title === "string" && record.title !== "") {
      for (const listener of [...this.#titleListeners]) {
        try { listener(record.title); } catch { /* contained */ }
      }
    }
    if (record.type === "setTitle" && typeof record.title === "string" && record.title !== "") {
      for (const listener of [...this.#titleListeners]) {
        try { listener(record.title); } catch { /* contained */ }
      }
    }
```

- [ ] **Step 3: 写 mock `omp`，先让测试失败**

`super-dsh/agent-omp/test/fixtures/mock-omp-rpc.mjs`（shebang + `chmod +x`；读 stdin 的 NDJSON，按 `type` 回帧）：

```js
#!/usr/bin/env node
// Mock `omp --mode rpc` for transport tests. Speaks protocol v1 only.
process.stdout.write(JSON.stringify({
  type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864,
}) + "\n");
process.stdout.write(JSON.stringify({ type: "extension_ui_request", id: "u1", method: "notify", message: "hi" }) + "\n");

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (line.trim() === "") continue;
    const cmd = JSON.parse(line);
    const ok = (data) => process.stdout.write(JSON.stringify({ id: cmd.id, type: "response", command: cmd.type, success: true, data }) + "\n");
    const bad = (error) => process.stdout.write(JSON.stringify({ id: cmd.id, type: "response", command: cmd.type, success: false, error }) + "\n");
    switch (cmd.type) {
      case "negotiate_protocol":
        if (cmd.protocolVersion !== 2) bad(`Unsupported RPC protocol version: ${cmd.protocolVersion}`);
        else ok({ protocolVersion: 2 });
        break;
      case "get_state":
        ok({ isStreaming: false, sessionId: "s1", systemPrompt: "SP", contextUsage: { tokens: 7, percent: 1 } });
        break;
      case "get_messages": ok({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }); break;
      case "get_session_stats": ok({ tokens: 7 }); break;
      case "get_subagents": ok({ subagents: [] }); break;
      case "prompt":
        ok();
        process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\n");
        process.stdout.write(JSON.stringify({ type: "session_info_update", title: "mock title", sessionId: "s1" }) + "\n");
        process.stdout.write(JSON.stringify({ type: "agent_end" }) + "\n");
        break;
      case "compact": ok(); break;
      case "set_model":
        ok({ provider: cmd.provider, id: cmd.modelId });
        process.stdout.write(JSON.stringify({ type: "config_update", model: `${cmd.provider}/${cmd.modelId}` }) + "\n");
        break;
      case "abort": ok(); break;
      case "new_session": ok({ cancelled: false }); break;
      default: bad(`Unknown command: ${cmd.type}`);
    }
  }
});
process.stdin.on("end", () => process.exit(0));
```

`super-dsh/agent-omp/test/rpc-client.test.mjs`：

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/mock-omp-rpc.mjs", import.meta.url));
chmodSync(fixture, 0o755);

const { OmpRpcClient, resolveOmpExecutable } = await import(join(dist, "rpc-client.js"));

process.env.OMP_EXECUTABLE = fixture; // every spawn in this file hits the mock
const cwd = mkdtempSync(join(tmpdir(), "omp-rpc-"));

test("ready handshake tolerates the v18 payload and any extra fields", async () => {
  const client = await OmpRpcClient.spawn([], cwd);
  assert.ok(client);
  client.close();
});

test("resolveOmpExecutable honours $OMP_EXECUTABLE", () => {
  assert.equal(resolveOmpExecutable(), fixture);
});

test("get_state / get_messages / get_subagents round-trip by correlation id", async () => {
  const client = await OmpRpcClient.spawn([], cwd);
  assert.equal((await client.getState()).isStreaming, false);
  assert.equal((await client.getMessages()).length, 1);
  assert.deepEqual(await client.getSubagents(), []);
  assert.equal(await client.getSystemPrompt(), "SP");
  assert.deepEqual(await client.contextUsage(), { tokens: 7, percent: 1 });
  client.close();
});

test("events reach listeners; prompt emits agent_start/agent_end; title is dispatched", async () => {
  const client = await OmpRpcClient.spawn([], cwd);
  const events = [];
  const titles = [];
  client.on((e) => events.push(e.type));
  client.onTitle((t) => titles.push(t));
  await client.prompt("hi");
  await new Promise((r) => setTimeout(r, 100)); // frames are async
  assert.ok(events.includes("agent_start"));
  assert.ok(events.includes("agent_end"));
  assert.deepEqual(titles, ["mock title"]);
  client.close();
});

test("an unsupported command surfaces as a failed response, not a hang", async () => {
  const client = await OmpRpcClient.spawn([], cwd);
  const res = await client.send({ type: "definitely_not_a_command" });
  assert.equal(res.success, false);
  assert.match(String(res.error), /Unknown command/);
  client.close();
});

test("close() rejects in-flight commands and is idempotent", async () => {
  const client = await OmpRpcClient.spawn([], cwd);
  client.close();
  client.close();
  await assert.rejects(() => client.send({ type: "get_state" }));
});
```

- [ ] **Step 4: 跑测试，确认失败**

Run: `cd super-dsh/agent-omp && npm run build && node --test test/rpc-client.test.mjs`
Expected: FAIL（按上面的 controller ruling，此时四个 delta 尚未应用）—— `SyntaxError`/`TypeError`：`resolveOmpExecutable`、`onTitle`、`compact`、`contextUsage`、`getSystemPrompt` 尚未导出

- [ ] **Step 5: 跑测试，确认通过**

Run: `cd super-dsh/agent-omp && npm run build && node --test test/rpc-client.test.mjs`
Expected: PASS（6/6）

- [ ] **Step 6: Commit**

```bash
cd /home/u1/workspaces/superd
git add super-dsh/agent-omp/src/rpc-client.ts super-dsh/agent-omp/test/rpc-client.test.mjs super-dsh/agent-omp/test/fixtures/mock-omp-rpc.mjs
git commit -m "feat(agent-omp): OmpRpcClient transport over the host omp binary (RPC line, protocol v1)"
```

---

### Task 2: 数据面回到 `omp` 子进程

**Files:**
- Modify: `super-dsh/agent-omp/src/omp-cli.ts`（整体替换实现段）
- Test: `super-dsh/agent-omp/test/omp-cli-rpc.test.mjs`（新建）
- Reference: `git show 6d2fbe1:apps/multi-agent/agent-omp/src/omp-cli.ts`

**Interfaces:**
- Consumes: `resolveOmpExecutable(): string`（Task 1）
- Produces（签名与现在完全一致，`models.ts` / `index.ts` 不需改）:
  - `ompAvailableModelsSync(): OmpCliModel[] | undefined`
  - `ompAvailableModels(): Promise<OmpCliModel[] | undefined>`
  - `ompModelRolesSync(): OmpModelRoles | undefined`
  - `ompModelRoles(): Promise<OmpModelRoles | undefined>`
  - `ompSetModelRoles(roles: OmpModelRoles): Promise<boolean>`

- [ ] **Step 1: 写失败测试**

`test/omp-cli-rpc.test.mjs`：

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));

// A fake `omp` whose `models|config` subcommands answer --json.
const home = mkdtempSync(join(tmpdir(), "omp-cli-home-"));
const bin = join(home, "fake-omp");
writeFileSync(bin, `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0] === "models" && a.includes("--json")) {
  process.stdout.write(JSON.stringify({ models: [{ provider: "deepseek", id: "deepseek-flash" }] }));
} else if (a[0] === "config" && a[1] === "get") {
  process.stdout.write(JSON.stringify({ default: "deepseek/deepseek-flash" }));
} else if (a[0] === "config" && a[1] === "set") {
  process.stdout.write(JSON.stringify({ ok: true, argv: a }));
} else { process.exit(2); }
`);
chmodSync(bin, 0o755);
process.env.OMP_EXECUTABLE = bin;
process.env.OMP_HOME = home;

const cli = await import(join(dist, "omp-cli.js"));

test("ompAvailableModels reads `omp models --json`", async () => {
  const models = await cli.ompAvailableModels();
  assert.equal(models?.[0]?.id, "deepseek-flash");
});

test("ompModelRoles reads `omp config get modelRoles --json`", async () => {
  assert.deepEqual(await cli.ompModelRoles(), { default: "deepseek/deepseek-flash" });
});

test("ompSetModelRoles writes the whole object through `omp config set`", async () => {
  assert.equal(await cli.ompSetModelRoles({ default: "deepseek/deepseek-flash" }), true);
});

test("a failing binary fails soft (undefined), never throws", async () => {
  process.env.OMP_EXECUTABLE = "/nonexistent/omp";
  assert.equal(await cli.ompAvailableModels(), undefined);
  process.env.OMP_EXECUTABLE = bin;
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd super-dsh/agent-omp && npm run build && node --test test/omp-cli-rpc.test.mjs`
Expected: FAIL（当前实现走 sidecar `callShared`，无 sidecar 时返回 undefined → 第一个断言失败）

- [ ] **Step 3: 用旧实现替换（保留现有导出名与类型）**

以 `git show 6d2fbe1:apps/multi-agent/agent-omp/src/omp-cli.ts` 为基底，应用两个 delta：
D1 — `const OMP_BIN = process.env.OMP_BIN ?? "omp";` → `import { resolveOmpExecutable } from "./rpc-client.js";` 并在每次调用前取 `resolveOmpExecutable()`（令 `$OMP_EXECUTABLE` 生效）。
D2 — 保留旧文件的 `execFile` / `execFileSync` 路径与 `cwd = OMP_HOME` 约束，但 `OMP_HOME` 改从现行 `knobs.ts` 取（`import { OMP_HOME } from "./knobs.js"`，native `~/.omp` 派生态），不再因缺 env 而早退返回 `undefined`；测试用 `OMP_HOME`/`OMP_EXECUTABLE` env 覆盖。
数据面三条命令保持不变：`["models","--json"]`、`["config","get","modelRoles","--json"]`、`["config","set","modelRoles","--json",JSON.stringify(roles)]`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd super-dsh/agent-omp && npm run build && node --test test/omp-cli-rpc.test.mjs`
Expected: PASS（4/4）

- [ ] **Step 5: Commit**

```bash
git add super-dsh/agent-omp/src/omp-cli.ts super-dsh/agent-omp/test/omp-cli-rpc.test.mjs
git commit -m "feat(agent-omp): data plane back on omp CLI subprocesses (models/config --json)"
```

---

### Task 3: `lazy-rpc.ts` 改驱动 `OmpRpcClient`

**Files:**
- Modify: `super-dsh/agent-omp/src/lazy-rpc.ts`（3 处类型/import + `#ensure` 的 spawn 调用）
- Test: `super-dsh/agent-omp/test/lazy-rpc.test.mjs`（新建）

**Interfaces:**
- Consumes: `OmpRpcClient`（Task 1）、`resolveOmpExecutable`（Task 1）
- Produces: `LazyOmpRpc` 与 `OmpAgentRpc` 保持现有签名不变（`agent.ts` 零改动）

- [ ] **Step 1: 写失败测试（lazy 铁律 + 预置模型）**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/mock-omp-rpc.mjs", import.meta.url));
chmodSync(fixture, 0o755);
process.env.OMP_EXECUTABLE = fixture;

const { LazyOmpRpc } = await import(join(dist, "lazy-rpc.js"));
const cwd = mkdtempSync(join(tmpdir(), "omp-lazy-"));

test("construction spawns nothing; passive queries answer synthetically", async () => {
  const rpc = new LazyOmpRpc([], cwd);
  assert.equal(rpc.spawned, false);
  assert.deepEqual(await rpc.getState(), { isStreaming: false });
  assert.deepEqual(await rpc.getSubagents(), []);
  rpc.close();
});

test("the first prompt materializes the child", async () => {
  const rpc = new LazyOmpRpc([], cwd);
  await rpc.ensureStarted();
  assert.equal(rpc.spawned, true);
  rpc.close();
});

test("a model selected before spawn is applied ahead of the prompt", async () => {
  const rpc = new LazyOmpRpc([], cwd);
  const events = [];
  rpc.on((e) => events.push(e));
  await rpc.setModel("deepseek", "deepseek-flash"); // parked: no child exists yet
  assert.equal(rpc.spawned, false);
  await rpc.prompt("hi");
  await new Promise((r) => setTimeout(r, 100));
  const modelAt = events.findIndex((e) => e.type === "config_update");
  const turnAt = events.findIndex((e) => e.type === "agent_start");
  assert.equal(rpc.spawned, true);
  assert.notEqual(modelAt, -1, "the parked set_model must reach the child");
  assert.ok(modelAt < turnAt, "set_model must be applied ahead of the prompt turn");
  rpc.close();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd super-dsh/agent-omp && npm run build && node --test test/lazy-rpc.test.mjs`
Expected: FAIL —— 仍 `import { OmpSdkClient } from "./sdk-client.js"`：`set_model` 走 sidecar 的 `session.setModel`，**不会**发出 mock 的 `config_update` 帧，故第三个用例的 `modelAt !== -1` 断言失败（且会真起一个 bun sidecar，该用例较慢；这是预期的红）

- [ ] **Step 3: 改三处绑定**

```ts
import { OmpRpcClient } from "./rpc-client.js";
```
`#client: OmpRpcClient | undefined`、`#spawn: Promise<OmpRpcClient> | undefined`、`#onSpawned: ((client: OmpRpcClient) => void) | undefined`、`#ensure(): Promise<OmpRpcClient>`，以及：

```ts
      this.#spawn = OmpRpcClient.spawn(this.#spawnArgs, this.#cwd).then((client) => {
```
文件头 doc 的 "shared-sidecar session materializes" 改为 "the `omp --mode rpc` child materializes"。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd super-dsh/agent-omp && npm run build && node --test test/lazy-rpc.test.mjs`
Expected: PASS（3/3）

- [ ] **Step 5: Commit**

```bash
git add super-dsh/agent-omp/src/lazy-rpc.ts super-dsh/agent-omp/test/lazy-rpc.test.mjs
git commit -m "refactor(agent-omp): LazyOmpRpc drives OmpRpcClient (no sidecar)"
```

---

### Task 4: `index.ts` 重接线 + 删除 SDK sidecar 面

**Files:**
- Modify: `super-dsh/agent-omp/src/index.ts`（import + type 引用）
- Modify: `super-dsh/agent-omp/src/world-plugin.ts`（`apply()` 里的缺失二进制诊断）
- Delete: `super-dsh/agent-omp/src/sdk-client.ts`、`src/sidecar-client.ts`、`src/protocol.ts`、`sidecar/`
- **Keep** `scripts/build-client.ts`（controller 已确认：它是 client 半边的 tsdown bundle 构建器，`src/client` + `src/mobile` 靠它出 `lib/client/index.js`，与 sidecar/SDK 传输无关；删了会毁 client lane）。`src/protocol.ts` 可删（全仓只有 `sidecar-client.ts` 引它）。
- Delete: `super-dsh/agent-omp/test/sidecar-decouple.test.mjs`、`test/sidecar-singleton.test.mjs`、`test/modelroles.test.mjs`
- Test: `super-dsh/agent-omp/test/no-sidecar.test.mjs`（新建的守卫）

**Interfaces:**
- Consumes: `LazyOmpRpc`（Task 3）
- Produces: `OmpProvider` 导出面不变

- [ ] **Step 1: 写守卫测试（先失败）**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = fileURLToPath(new URL("..", import.meta.url));

test("the SDK sidecar surface is gone", () => {
  for (const p of ["src/sdk-client.ts", "src/sidecar-client.ts", "src/protocol.ts", "sidecar"]) {
    assert.equal(existsSync(join(pkg, p)), false, `${p} must be deleted`);
  }
});

test("no source file mentions the sidecar/SDK client", () => {
  const offenders = [];
  for (const f of readdirSync(join(pkg, "src"))) {
    if (!f.endsWith(".ts")) continue;
    const text = readFileSync(join(pkg, "src", f), "utf8");
    if (/OmpSdkClient|OmpSdkSidecar|callShared/.test(text)) offenders.push(f);
  }
  assert.deepEqual(offenders, []);
});

test("index.ts spawns through LazyOmpRpc only", () => {
  const index = readFileSync(join(pkg, "src", "index.ts"), "utf8");
  assert.doesNotMatch(index, /OmpRpcClient\.spawn\(/);
  assert.match(index, /new LazyOmpRpc\(/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd super-dsh/agent-omp && node --test test/no-sidecar.test.mjs`
Expected: FAIL（sidecar 文件仍在）

- [ ] **Step 3: 改 `index.ts` 并删除**

`src/index.ts` 三处：

1. `import { OmpSdkClient } from "./sdk-client.js";`（index.ts:38）删除；加 `import type { OmpRpcClient } from "./rpc-client.js";`。
2. **真正的编译断点**：`adoptSpawnedChild(id, header, client: OmpSdkClient, preset)`（index.ts:524，函数体只用到 `client.getState()`）→ `client: OmpRpcClient`。它由两处 `rpc.onSpawned((client) => adoptSpawnedChild(...))`（index.ts:384-385、457）喂入，这两处因此报 `TS2345`。
3. `setupAndPublish(..., rpc: OmpAgentRpc, ...)`（index.ts:556）**本来就是对的，不要动** —— 它收的是 `LazyOmpRpc` 实例，不是 transport client。

> **controller ruling（2026-10-03，Task 3 + Task 3 reviewer 两轮证据）**：本节原文把类型归因写错位了（说 `setupAndPublish` 是 `OmpSdkClient`、要改成 `OmpAgentRpc`）：`setupAndPublish` 早已是 `OmpAgentRpc`，而**唯一**的断点是 `adoptSpawnedChild` 的 `OmpSdkClient`。改 `adoptSpawnedChild` 为 `OmpRpcClient` 后 `npm run build` 退出 0（Task 3 探针实测：改完 build 绿，随后回退）。**不要**把 `adoptSpawnedChild` 改成 `OmpAgentRpc`——`OmpRpcClient` 没有 `ensureStarted`/`spawned`。若只想表达「只用到 getState」，可用 `Pick<OmpAgentRpc, "getState">`。

文件头 doc 的 "in-process OMP SDK sidecar" 段改为 "spawns `omp --mode rpc` per session (RPC transport)"。

**同时必须恢复 tick 不变量（Task 2 的 parked Important，load-bearing）**：`index.ts:262` 的 reconcile tick 现在每 30s 无条件 spawn 一次真实 `omp models --json`（`refreshOmpModelsCli`），而 sidecar 线是 live-gated（`callSharedIfLive`），且 `agent-omp/AGENTS.md` §五·五 把「tick 永不 spawn」写成不变量。改成：**只有存在活跃 OMP 会话时才刷新目录**（空闲 daemon 一个子进程都不拉；有活跃会话时保持 30s 新鲜度）。盘上模型缓存继续承担 boot 时的兜底。守卫测试追加一条：源码级断言 `index.ts` 里的目录刷新被活跃会话判定包住（照 `sidecar-decouple.test.mjs` 的源码断言风格）。

同时加一段**启动诊断**（非致命，spec §3.5）：`apply()` 里用 `resolveOmpExecutable()` 检查候选路径是否真实存在，缺失时打一行 `[super-dsh] omp binary not found (checked $OMP_EXECUTABLE, PATH, ~/.local/bin/omp) — the OMP world will fail at first prompt`；readiness 语义不变（仍由 world mount 成功决定）。守卫测试追加：

```js
test("apply() diagnoses a missing omp binary instead of failing silently", () => {
  const src = readFileSync(join(pkg, "src", "world-plugin.ts"), "utf8");
  assert.match(src, /resolveOmpExecutable/, "world-plugin must probe the host binary");
  assert.match(src, /omp binary not found/, "world-plugin must log the missing-binary diagnostic");
});
```

- [ ] **Step 4: 全包测试**

Run: `cd super-dsh/agent-omp && npm run build && node --test test/*.test.mjs`
Expected: PASS（含 `no-sidecar`、`rpc-client`、`lazy-rpc`、`omp-cli-rpc`、`omp-store`、`agent-preset-roster`、`mobile-*`、`omp-*discovery*`）

- [ ] **Step 5: Commit**

```bash
git add -A super-dsh/agent-omp
git commit -m "refactor(agent-omp): drop the bun sidecar + SDK line; omp world runs the host binary over RPC"
```

---

### Task 5: 打包瘦身

**Files:**
- Modify: `super-dsh/package.json`（`dependencies` / `files`）
- Modify: `super-dsh/agent-omp/package.json`（`dependencies` / `files`）
- Modify: `super-dsh/test/start-4999.sh`（`pnpm-workspace.yaml` 的 `onlyBuiltDependencies` + bun 回填段）
- Test: `super-dsh/agent-omp/test/package-contract.test.mjs`（新建）

**Interfaces:**
- Consumes: 无
- Produces: 交付 tarball 不再声明/携带 `@oh-my-pi/pi-coding-agent` 与 `bun`

- [ ] **Step 1: 写失败测试（清单守卫）**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../package.json", import.meta.url));
const pkg = fileURLToPath(new URL("../package.json", import.meta.url));

test("the delivery manifest no longer pulls the OMP SDK or bun", () => {
  for (const p of [root, pkg]) {
    const deps = JSON.parse(readFileSync(p, "utf8")).dependencies ?? {};
    assert.equal(deps["@oh-my-pi/pi-coding-agent"], undefined, `${p} still declares the OMP SDK`);
    assert.equal(deps["bun"], undefined, `${p} still declares bun`);
  }
});

test("the tarball files list no longer ships a sidecar", () => {
  const files = JSON.parse(readFileSync(root, "utf8")).files;
  assert.equal(files.some((f) => f.includes("sidecar")), false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd super-dsh/agent-omp && node --test test/package-contract.test.mjs`
Expected: FAIL

- [ ] **Step 3: 改三个文件**

根 `package.json`：`dependencies` 删 `"@oh-my-pi/pi-coding-agent"`、`"bun"`；`files` 删 `"agent-omp/sidecar"`。
`agent-omp/package.json`：`dependencies` 删 `"@oh-my-pi/pi-coding-agent"`、`"bun"`；`files` 删 `"sidecar"`。
`test/start-4999.sh`：删掉 `pnpm-workspace.yaml` heredoc 的 `onlyBuiltDependencies: [bun]` 段与随后的 "bun ordering quirk" 回填块（`BUN_DIR=… node install.js`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd super-dsh/agent-omp && node --test test/package-contract.test.mjs`
Expected: PASS（2/2）

- [ ] **Step 5: 全仓构建 + 全测**

Run: `cd /home/u1/workspaces/superd && node super-dsh/scripts/pack.mjs`
Expected: 全组件 tsc 绿 + tarball 落在 `.scratch/superd-pack/`
Run: `cd super-dsh && for p in superd-hub agent-omp agent-pi; do (cd $p && node --test test/*.test.mjs); done`
Expected: 全绿

- [ ] **Step 6: Commit**

```bash
git add super-dsh/package.json super-dsh/agent-omp/package.json super-dsh/test/start-4999.sh super-dsh/agent-omp/test/package-contract.test.mjs
git commit -m "build(agent-omp): drop @oh-my-pi + bun from the delivery manifest (~838M)"
```

---

### Task 6: 4999 pack 线实机验收 + 报告

**Files:**
- Run: `super-dsh/test/start-4999.sh`
- Create: `docs/test-reports/2026-10-03-agent-omp-rpc-transport.md`

**Interfaces:**
- Consumes: Task 1–5 的产物（tarball）
- Produces: 验收报告 + 给 user 的 token URL（**保持运行**，不自行 kill）

- [ ] **Step 1: 起 4999 交付形态线**

Run: `cd /home/u1/workspaces/superd && bash super-dsh/test/start-4999.sh`
Expected: 端口预检通过 → pack → tarball `pnpm add file:` 进全新 profile → boot 日志 `world failed` 计数 0 → 打印 token URL

- [ ] **Step 2: 探针（拿到 URL 后）**

```bash
curl -s -o /dev/null -w '%{http_code}\n' '<token-url>'            # 期望 303/200
curl -s '<base>/hub' | head -c 400                                # roster
```
Expected: shell 200；roster 含 `OMP`；`/hub` 家族语义不变

- [ ] **Step 3: OMP world 一轮真会话（本任务的核心证据）**

在浏览器里对 OMP world：新建会话 → 发一轮 prompt（如 "只回复 OK"）→ 观察流式输出 → 再 resume 同一会话发第二轮。
Expected: 两轮都有 assistant 输出；`journalctl --user -u superd-4999-test` 无 `omp` spawn 失败；`ps` 里可见 `omp --mode rpc` 子进程，且**没有 bun sidecar 进程**

- [ ] **Step 4: 重量核对**

```bash
du -sh /home/u1/.dsh/profiles/web/node_modules/@oh-my-pi 2>/dev/null   # 期望：不存在（新 profile）
du -sh <line-home>/profiles/<profile>/node_modules/bun 2>/dev/null     # 期望：不存在
```
Expected: 两者都不再被安装

- [ ] **Step 5: 写报告 + commit**

`docs/test-reports/2026-10-03-agent-omp-rpc-transport.md`：记录 4999 探针读数、两轮会话证据、进程快照、重量对比、以及 spec §4 的 gap 现状。

```bash
git add docs/test-reports/2026-10-03-agent-omp-rpc-transport.md
git commit -m "test(agent-omp): 4999 pack-line acceptance for the RPC transport"
```

- [ ] **Step 6: 停下交给 user**

给出 token URL + LAN URL，**保持实例运行**等 user 亲手验收（根 AGENTS §三·验收模式）。dev3 实装验收待 user 下令后进行。
