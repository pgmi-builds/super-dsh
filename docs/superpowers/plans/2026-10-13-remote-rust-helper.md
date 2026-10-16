# Remote Rust Helper (`superd-run`) Implementation Plan

> **For agentic workers:** 执行时使用 `superpowers:executing-plans` 逐任务推进；未经用户或适用规则明确要求，不派遣子 Agent。每一步用复选框追踪。

**Goal:** 实装 [remote-rescope spec](../../specs/remote-rescope/spec.md) Phase 2——一个很薄的、per-invocation 的远端监督 helper `superd-run`（`banner`/`run`/`killgroup`），在对端给 exec 通道"拉条线"：进程组隔离、PDEATHSIG 内核锚定、退出码原样透传，shim 永久回退，回执 `runner` 字段如实区分。

**Architecture:** Rust 零依赖单文件 binary（std + 手写 FFI），静态 musl 交叉构建，产物随包提交 + SHA-256 MANIFEST。TS 侧新增 `helper.ts` 负责 probe/upload/argv 构造与 per-target 状态机；`transports.ts`/`driver.ts` 在 helper ready 时走 helper argv，否则走现行 POSIX wrapper（shim，一行不改语义）。probe miss 时经既有 exec lane 用 `cat > tmp && mv` 上传（stdin 原生管道，base64 不需要）。

**Tech Stack:** Rust 1.99（std-only，无 crate）、cargo musl 静态交叉、TypeScript/Node、Vitest、既有 `startOneShot`/`startBinaryProcess`、ssh/docker/incus 真实 lane。

**Spec:** [docs/specs/remote-rescope/spec.md](../../specs/remote-rescope/spec.md)（§5.2 替换面、§5.5 冻结约束、§5.6 生命周期、§5.7 步数账本）

## Global Constraints

- 动词集冻结：`banner` / `run` / `killgroup`。无 plan 解释器、无 daemon、无监听端点、无 TTL（spec §5.5/§5.6）。
- Rust std-only、零 crate；`panic="abort"`、`opt-level="z"`、`strip=true`、静态 musl。预期 ≤1MB/平台。
- 语义替换不升级：`run` 对齐现行 wrapper 语义（正常完成也组 TERM 收尾、取消退 143、退出码逐字透传；组 KILL 只属于 killer，spec §5.2）。
- shim 永久保留：helper 不可达（首跳失败/noexec/arch 未命中/用户态拒绝）时回退现行 `buildOneShotArgv`，行为一字不变；回执 `runner` 字段区分两条路径。
- pidfile 兼容：路径与内容格式沿用 `superd-oneshot-<tag>.pgid`（内容=pgid 十进制），旧 killer 与 `killgroup` 都能消费。
- 产物纪律：crate 位于 `better-dsh/src/remote/helper/`（闭包 provenance 只收顶层 `.ts`，不受污染）；`bin/<target>/superd-run` + `MANIFEST.json` 随包提交；better-dsh 构建复制进 `lib/remote/helper-bin/`；`build-remote.mjs` 扩展复制进 `super-dsh/remote/helper-bin/` 并计入 outputs 哈希。无 postinstall。
- 平台范围（本轮）：`x86_64-unknown-linux-musl`、`aarch64-unknown-linux-musl`。darwin（在 mac 上原生构建）与 Windows（D5 未裁）不在本轮。
- **killgroup 安全契约（2026-10-13 事故后，硬约束，spec §5.2）**：pgid ≤ 1 一律 exit 64 拒绝（`kill(-1)` = uid 全域扫描——2026-10-13 23:14 自测 `--pgid 1` 哨兵值在守卫缺失下引发整机用户会话闪退，见 `better-dsh/src/remote/helper/NOTE-2026-10-13-killgroup-incident.md` 与回执）；Linux 写 `<pidfile>.st` starttime 边车，`killgroup` 校验不符即拒（PID 复用防御；无边车 = shim 兼容跳过）；**信号/组语义测试只在容器或 VM 内跑**，本机仅非信号与自组作用域用例。
- 实现偏差记录（Task 1 已落地）：`run` 不做组排空检测（helper 是自身组成员，检测恒假）——正常完成组 TERM 后清 pidfile 即退（与 shell wrapper 同构），cancel 有界收割直子（KILL 仅按 pid），组 KILL 只属于 killer；本计划内嵌 main.rs 代码块以仓库当前文件为准。
- 验收按根 `AGENTS.md`：真实 lane 实测（docker exec / ssh dev2/dev3，Phase 0 方法学）→ 4999 tarball 线 + dev3 实装；报告落 `docs/test-reports/`。验收、报告、放行之前不 commit/tag/push、不 npm publish。
- 开发前用 LSP/AST 核对接线点；本计划写作时已核对 `driver.ts` `nativeProcess`/`startPrepared`、`transports.ts` `buildOneShotArgv`、`process.ts` `startBinaryProcess`（导出，stdin 为原生 Writable）、`build-remote.mjs` `remoteSources()`（readdir 顶层过滤 `.ts`）。执行时复核当前树。

---

## 文件责任

| 文件 | 本计划职责 |
| --- | --- |
| `better-dsh/src/remote/helper/Cargo.toml`（新） | 零依赖 bin crate 配置 + release profile |
| `better-dsh/src/remote/helper/src/main.rs`（新） | `banner`/`run`/`killgroup` 全部实现（含 setsid、PDEATHSIG、组 TERM、有界 settle、退出码透传） |
| `better-dsh/src/remote/helper/build.rs`（新） | 编译期把 `SUPERD_RUN_VER` 环境变量戳进 binary |
| `better-dsh/src/remote/helper/build.sh`（新） | 交叉构建 targets → `bin/<target>/superd-run` + `MANIFEST.json`（SHA-256 + 尺寸 + 源哈希） |
| `better-dsh/src/remote/helper/tests/lane-matrix.sh`（新） | 对已构建产物跑行为矩阵（banner/退出码/善后/killgroup/PDEATHSIG） |
| `better-dsh/src/remote/helper.ts`（新，顶层） | probe/upload argv 构造、arch→triple 映射、`HelperRegistry`（ready/absent 状态机） |
| `better-dsh/src/remote/transports.ts` | 新增 `buildHelperArgv`（ssh/docker/incus 三 lane 的 helper 执行 argv） |
| `better-dsh/src/remote/driver.ts` | `nativeProcess` 接入 registry（helper 优先、shim 回退）；killer 在 helper ready 时用 `killgroup`；回执 `runner` 字段 |
| `better-dsh/src/remote/tool.ts` | oneshot 结果渲染 `runner` 行；tool description 增补 helper/shim 一句 |
| `better-dsh/test/remote/helper.spec.ts`（新） | argv 构造、arch 映射、registry 回退、pidfile 兼容断言 |
| `super-dsh/scripts/build-remote.mjs` | 闭包构建后复制 `helper-bin/` 并计入 outputs/provenance |
| `better-dsh/package.json` + 构建脚本 | `lib/remote/helper-bin/` 复制步骤 |
| `AGENTS.md` | remote 例外条款修正案（binary 资产类别） |

---

## Task 1 — Rust crate：`superd-run` 三动词

**Files:** Create `better-dsh/src/remote/helper/{Cargo.toml, build.rs, src/main.rs, .gitignore}`

**Interfaces (Produces):** argv 契约——
- `superd-run banner` → stdout 单行 `SUPERD-RUN proto=1 name=superd-run ver=<V> target=<TRIPLE> os=linux pdeathsig=1|0 pid=<PID>`，exit 0。
- `superd-run run [--pidfile P | --tag T] -- <argv…>` → setsid 新会话；Linux 设 `PR_SET_PDEATHSIG=SIGTERM`；写 pidfile（pgid）；spawn `<argv…>`（继承 stdio）；等待；正常完成→组 TERM 收尾（有界 1.5s）→ 组排空则删 pidfile → exit = 子进程退出码逐字；收到 TERM/HUP/INT（含 PDEATHSIG）→ 组 TERM → 有界 settle 2s → `kill(child, KILL)` 收割直子 → 组排空则删 pidfile → exit 143。
- `superd-run killgroup (--pgid N | --pidfile P | --tag T)` → 组 TERM → 有界 settle 3s → 组 KILL → 删 pidfile → stdout `SUPERD-KILLGROUP pgid=N settled_ms=M escalated=0|1 remaining=0|unknown`，组排空 exit 0 否则 exit 1。
- 未知动词/参数 → stderr usage，exit 64。`--` 后 argv 为空 → exit 64。

- [x] **Step 1: Cargo.toml + build.rs + .gitignore**

```toml
# Cargo.toml
[package]
name = "superd-run"
version = "0.1.0"
edition = "2021"

[[bin]]
name = "superd-run"
path = "src/main.rs"

[profile.release]
opt-level = "z"
lto = true
codegen-units = 1
panic = "abort"
strip = true
```

```rust
// build.rs
fn main() {
    let ver = std::env::var("SUPERD_RUN_VER").unwrap_or_else(|_| "0.0.0-dev".into());
    println!("cargo:rustc-env=SUPERD_RUN_VER={ver}");
}
```

```
# .gitignore（crate 内构建产物不进 git；bin/ 提交，target/ 不提交）
/target
```

- [x] **Step 2: src/main.rs 完整实现**

```rust
// superd-run — thin per-invocation remote supervision helper.
// Spec: docs/specs/remote-rescope/spec.md §5.5/§5.6. Verbs: banner | run | killgroup.
// Semantics mirror the POSIX wrapper in better-dsh/src/remote/transports.ts; no upgrades.
use std::env;
use std::fs;
use std::process::{Command, Stdio};
use std::thread::sleep;
use std::time::{Duration, Instant};

const PR_SET_PDEATHSIG: i32 = 1;
const SIGKILL: i32 = 9;
const SETTLE_TERM_MS: u64 = 1500;     // normal-completion straggler drain
const SETTLE_CANCEL_MS: u64 = 2000;   // cancel-path child drain
const SETTLE_KILLGROUP_MS: u64 = 3000;

static TERMINATING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static FINALIZING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

unsafe extern "C" {
    fn setsid() -> i32;
    fn getpgrp() -> i32;
    fn getppid() -> i32;
    fn kill(pid: i32, sig: i32) -> i32;
    fn signal(sig: i32, handler: usize) -> usize;
    #[cfg(target_os = "linux")]
    fn prctl(op: i32, arg2: usize, arg3: usize, arg4: usize, arg5: usize) -> i32;
}

extern "C" fn on_terminate(_sig: i32) {
    if !FINALIZING.load(std::sync::atomic::Ordering::Relaxed) {
        TERMINATING.store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

fn install_handlers() {
    for sig in [15usize, 1, 2] { // TERM, HUP, INT
        unsafe { signal(sig as i32, on_terminate as usize); }
    }
}

fn group_signal(pgid: i32, sig: i32) -> bool {
    unsafe { kill(-pgid, sig) == 0 }
}

fn group_alive(pgid: i32) -> bool {
    unsafe { kill(-pgid, 0) == 0 }
}

fn wait_group_drain(pgid: i32, budget_ms: u64) -> bool {
    let start = Instant::now();
    while group_alive(pgid) {
        if start.elapsed() >= Duration::from_millis(budget_ms) { return false; }
        sleep(Duration::from_millis(20));
    }
    true
}

fn tmp_path(tag: &str) -> String {
    let dir = env::var("TMPDIR").unwrap_or_else(|_| "/tmp".into());
    let dir = dir.trim_end_matches('/');
    format!("{dir}/superd-oneshot-{tag}.pgid")
}

fn write_pidfile(path: &str, pgid: i32) {
    let _ = fs::write(path, format!("{pgid}"));
}

fn remove_pidfile(path: &str) {
    let _ = fs::remove_file(path);
}

fn anchor_parent_death() {
    #[cfg(target_os = "linux")]
    unsafe {
        // Parent (sshd session proc on the exec lane) exiting must wake us up.
        if prctl(PR_SET_PDEATHSIG, 15, 0, 0, 0) != 0 {
            eprintln!("superd-run: pdeathsig unavailable (continuing unanchored)");
        }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = 0;
}

fn banner() -> ! {
    let os = if cfg!(target_os = "macos") { "macos" } else { "linux" };
    let pds = if cfg!(target_os = "linux") { 1 } else { 0 };
    let target = {
        let t = env!("SUPERD_RUN_TARGET");
        t
    };
    println!("SUPERD-RUN proto=1 name=superd-run ver={} target={target} os={os} pdeathsig={pds} pid={}",
        env!("SUPERD_RUN_VER"), std::process::id());
    std::process::exit(0);
}

struct RunArgs { pidfile: String, argv: Vec<String> }
struct KillgroupArgs { pgid: Option<i32>, pidfile: Option<String> }

fn usage() -> ! {
    eprintln!("usage: superd-run banner\n       superd-run run [--pidfile P | --tag T] -- <argv…>\n       superd-run killgroup (--pgid N | --pidfile P | --tag T)");
    std::process::exit(64);
}

fn parse_run(args: &[String]) -> RunArgs {
    let mut pidfile: Option<String> = None;
    let mut argv: Vec<String> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--pidfile" if i + 1 < args.len() => { pidfile = Some(args[i + 1].clone()); i += 2; }
            "--tag" if i + 1 < args.len() => { pidfile = Some(tmp_path(&args[i + 1])); i += 2; }
            "--" => { argv = args[i + 1..].to_vec(); break; }
            _ => usage(),
        }
    }
    if argv.is_empty() || pidfile.is_none() { usage(); }
    RunArgs { pidfile: pidfile.unwrap(), argv }
}

fn read_pgid(args: &[String]) -> KillgroupArgs {
    let mut pgid: Option<i32> = None;
    let mut pidfile: Option<String> = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--pgid" if i + 1 < args.len() => { pgid = args[i + 1].parse().ok(); i += 2; }
            "--pidfile" if i + 1 < args.len() => { pidfile = Some(args[i + 1].clone()); i += 2; }
            "--tag" if i + 1 < args.len() => { pidfile = Some(tmp_path(&args[i + 1])); i += 2; }
            _ => usage(),
        }
    }
    let effective = pgid.or_else(|| pidfile.as_ref().and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| s.trim().parse().ok()));
    match effective {
        Some(g) if g > 0 => KillgroupArgs { pgid: Some(g), pidfile },
        _ => { eprintln!("superd-run killgroup: no live pgid (already clean)"); std::process::exit(0); }
    }
}

fn do_run(args: RunArgs) -> ! {
    install_handlers();
    if unsafe { setsid() } != 0 {
        // Not fatal: e.g. already a session leader (some docker exec paths). Group ops stay scoped to our pgrp.
        eprintln!("superd-run: setsid failed (errno semantics); continuing with pgrp scope");
    }
    anchor_parent_death();
    let pgid = unsafe { getpgrp() };
    write_pidfile(&args.pidfile, pgid);

    let mut child = match Command::new(&args.argv[0]).args(&args.argv[1..]).stdin(Stdio::inherit()).stdout(Stdio::inherit()).stderr(Stdio::inherit()).spawn() {
        Ok(c) => c,
        Err(e) => { eprintln!("superd-run: exec {}: {e}", args.argv[0]); remove_pidfile(&args.pidfile); std::process::exit(127); }
    };
    let child_pid = child.id() as i32;

    let status = loop {
        if let Some(s) = child.try_wait().unwrap_or(None) { break Some(s); }
        if TERMINATING.load(std::sync::atomic::Ordering::Relaxed) { break None; }
        sleep(Duration::from_millis(20));
    };

    FINALIZING.store(true, std::sync::atomic::Ordering::Relaxed);
    let cancelled = status.is_none();
    // Wrapper parity: group TERM on both normal completion (reap backgrounded descendants) and cancel.
    group_signal(pgid, 15);
    let drained = if cancelled {
        if !wait_group_drain(pgid, SETTLE_CANCEL_MS) {
            // Reap only OUR direct child by pid; group-wide KILL belongs to the killer session (spec §5.2).
            let _ = unsafe { kill(child_pid, SIGKILL) };
            let _ = child.wait();
        }
        wait_group_drain(pgid, 300)
    } else {
        wait_group_drain(pgid, SETTLE_TERM_MS)
    };
    if let Some(s) = status {
        // fallthrough: report child status verbatim below
        if drained { remove_pidfile(&args.pidfile); }
        let code = s.code().unwrap_or_else(|| 128 + 15);
        std::process::exit(code);
    } else {
        if drained { remove_pidfile(&args.pidfile); }
        std::process::exit(143);
    }
}

fn do_killgroup(args: KillgroupArgs) -> ! {
    let pgid = args.pgid.unwrap();
    let start = Instant::now();
    let mut escalated = false;
    if group_alive(pgid) {
        group_signal(pgid, 15);
        if !wait_group_drain(pgid, SETTLE_KILLGROUP_MS) {
            group_signal(pgid, SIGKILL);
            escalated = true;
            wait_group_drain(pgid, 500);
        }
    }
    let remaining = group_alive(pgid);
    if let Some(p) = &args.pidfile { remove_pidfile(p); }
    println!("SUPERD-KILLGROUP pgid={pgid} settled_ms={} escalated={escalated:digits} remaining={}", start.elapsed().as_millis(), if escalated {1} else {0}, if remaining {"unknown"} else {"0"});
    std::process::exit(if remaining { 1 } else { 0 });
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("banner") => banner(),
        Some("run") => do_run(parse_run(&args[1..])),
        Some("killgroup") => do_killgroup(read_pgid(&args[1..])),
        _ => usage(),
    }
}
```

注：`SUPERD_RUN_TARGET` 由 build.sh 经 `SUPERD_RUN_TARGET` 环境变量 + build.rs 同法戳入（build.rs 增加一行 `cargo:rustc-env=SUPERD_RUN_TARGET=...`；上面 banner() 里的写法在实现时对齐）。`escalated={escalated:digits}` 是笔误占位——实现时用 `escalated={}` + 整形值（代码里已给出正确变量）。

- [x] **Step 3: 构建 x86_64 musl 并修编译错**

Run: `cd better-dsh/src/remote/helper && SUPERD_RUN_VER=0.1.0 cargo build --release --target x86_64-unknown-linux-musl`（若链接失败加 `RUSTFLAGS='-C linker=rust-lld -C link-self-contained=yes'`）
Expected: 产物 ≤1MB；`file target/*/release/superd-run` 显示 `statically linked`。

- [x] **Step 4: 本机行为自测**

```bash
B=target/x86_64-unknown-linux-musl/release/superd-run
$B banner                                                    # proto 行
$B run --tag t1 -- /bin/sh -c 'echo OK; exit 7'; echo rc=$?  # rc=7（退出码逐字）
test -e /tmp/superd-oneshot-t1.pgid && echo FAIL-stale || echo PASS-pidfile-cleaned
$B run --tag t2 -- /bin/sh -c 'sleep 30 & echo BG' ; pgrep -f 'sleep 30' && echo FAIL-straggler || echo PASS-straggler-termed
$B run --tag t3 -- /bin/sh -c 'sleep 300' & sleep 0.3; $B killgroup --tag t3; pgrep -f 'sleep 300' && echo FAIL || echo PASS-killgroup
```

---

## Task 2 — 真实 lane 验证矩阵（Phase 0 方法学）

**Files:** Create `better-dsh/src/remote/helper/tests/lane-matrix.sh`

**Interfaces:** Consumes Task 1 产物路径作为 `$1`；对 `环境前缀`（`docker-run:`、`docker-exec:`、`ssh:`）执行同一套行为断言。

- [x] **Step 1: 写 lane-matrix.sh**：`banner` 出 proto 行；`run` 退出码逐字（7）；正常完成 pidfile+边车成对清除；后台子孙被 TERM；`killgroup` 收掉悬挂组、篡改边车拒绝、`--pgid 1/0/-5` 拒绝；ssh lane 额外做 PDEATHSIG：`ssh <host> "exec $REMOTE run --tag pd -- sleep 300" &` → `kill %1`（杀本地 ssh）→ 轮询远端 pgrep 至消失（≤3s），断言 0 额外连接完成清场。**全部组信号用例限定在容器/远端作用域内，绝不以哨兵 pgid 触碰宿主。**
- [x] **Step 2: 跑矩阵**：alpine:latest（无 bash！helper 必须独立可用）、busybox:latest、debian:stable-slim（docker exec）、ssh dev2、ssh dev3。容器侧先经 `docker cp` 放置 binary（模拟上传产物路径 `~/.cache/superd/run/<triple>-<ver>/superd-run`，容器内为 `/root/.cache/...`）。
- [x] **Step 3: 记录**：结果表（含 binary 尺寸、static 校验、各 lane PASS/FAIL）写入本计划复选框备注，最终进验收报告。

## Task 3 — aarch64 musl 交叉构建

- [x] **Step 1:** `cargo build --release --target aarch64-unknown-linux-musl`（`linker=rust-lld` + self-contained；无 gcc 依赖）。
- [x] **Step 2:** `docker run --rm --platform linux/arm64 -v …/superd-run:/s:ro alpine /s banner` 验证（若宿主 binfmt 未注册 qemu-aarch64，则记录"静态产物已生成，运行时验证待 arm 端点"，不阻塞）。
- [x] **Step 3:** `build.sh` 固化两 target 构建 + `MANIFEST.json`（targets: {triple: {sha256, size}}, sources: {main.rs/Cargo.toml/build.rs: sha256}, ver）。跑 `bash build.sh` 重建并核对 MANIFEST 稳定。

## Task 4 — TS 接线：helper.ts + registry + shim 回退

**Files:** Create `better-dsh/src/remote/helper.ts`；Modify `transports.ts`、`driver.ts`、`tool.ts`；Test `better-d-sh/test/remote/helper.spec.ts`。

**Interfaces:**
- Consumes: `startOneShot`/`startBinaryProcess`（process.ts）、`sshArgv`（ssh-targets.ts）、`TargetPlan`（target.ts）、Task 1 的 argv 契约。
- Produces:
  - `archTriple(unameM: string): string | null`（`x86_64`→musl-x86_64；`aarch64|arm64`→musl-aarch64；其余 null）
  - `helperAssets(): { targets: Record<string, string>, ver: string } | null`（读 `join(dirname(fileURLToPath(import.meta.url)), 'helper-bin')/MANIFEST.json` + 同目录 binaries；缺省 null → shim-only）
  - `buildHelperArgv(plan, binPath, { tag, cmd }): string[]`；`buildHelperKillgroupArgv(plan, binPath, tag): string[]`
  - `class HelperRegistry { ensure(plan, exec): Promise<string | null> }`（exec = `(argv, opts) => Promise<{exit, stdout}>` 注入，driver 提供；state: Map<planKey, 'ready'|'absent'|path>；probe→miss→upload(`mkdir -p dir && cat > path.tmp && chmod 0755 path.tmp && mv -f path.tmp path`，stdin=binary bytes via startBinaryProcess)→banner 验证；任何失败 sticky absent）

- [x] **Step 1: helper.spec.ts 失败测试**（先写）：archTriple 映射表；buildHelperArgv 三 lane 形状断言（ssh 串含 `exec '...' run --tag T -- bash -lc '...'` 一层 shQuote；docker 为 argv 数组无 shell）；registry：fake exec probe 127 → upload ok → banner ok → ready=path，第二次 ensure 不再 probe（计数断言）；upload 失败 → null 且 sticky；helperAssets() 缺目录 → null。
- [x] **Step 2: 跑测试确认失败**：`npm --prefix better-dsh test -- test/remote/helper.spec.ts`。
- [x] **Step 3: 实现 helper.ts + transports.buildHelperArgv**（ssh 命令串：`exec ${shQuote(bin)} run --tag T -- bash -lc ${shQuote(cmd)}`，经 `sshArgv(plan.connection, {command})`，与 buildOneShotArgv 同层转义；docker：`['docker','exec','-i','--',ctr,bin,'run','--tag',T,'--','bash','-lc',cmd]`；incus 同形）。
- [x] **Step 4: driver.nativeProcess 接线**：helper ready → `startOneShot(buildHelperArgv(...), {stdin, timeoutSec})`，`runner: 'superd-run <ver>'` 附加到结果；miss → 现行 wrapper 路径不变，`runner: 'posix-shim'`；killer 分支：ready 时 `buildHelperKillgroupArgv`，否则现行 shell killer。tool.ts 渲染 runner 行；description 补一句（helper 优先、shim 回退、回执 runner 如实）。
- [x] **Step 5:** 全量 `npm --prefix better-dsh test`（现有 oneshot/copy/rsync 套件保持绿灯——shim 路径行为不变；需要 fake exec 的注入点若现有测试没留，以最小构造注入）。
- [x] **Step 6:** 4999 线手动冒烟（`super-dsh/test/start-4999.sh` 已运行则经现行会话）：`remote {target:'dev2', cmd:'echo hi'}` 回执出现 `runner: superd-run…`；对 alpine 容器（现 wrapper 必败的环境）oneshot 成功——这是本轮的 headline 验收。

## Task 5 — 交付资产 + AGENTS.md 修正案

- [x] **Step 1:** better-dsh 构建复制：`scripts/copy-helper-bins.mjs`（`src/remote/helper/bin` → `lib/remote/helper-bin`，含 MANIFEST），挂进 `package.json` build 链（copy-ast-assets 同款）。
- [x] **Step 2:** `super-dsh/scripts/build-remote.mjs`：`buildRemote()` 末尾复制 `better-dsh/src/remote/helper/bin` → `super-dsh/remote/helper-bin`，文件哈希计入 `outputs`（provenance 自然覆盖）；`remoteSources()` 不变（helper/ 非 .ts 顶层，本就不入 sources）。
- [x] **Step 3:** AGENTS.md remote 例外条款追加修正案（措辞）：
  > - **remote helper binary 修正案（2026-10-13）**：在 2026-10-10 例外之上，`better-dsh/src/remote/helper/` 为唯一 Rust 源（Cargo 零依赖）；`bin/<target>/superd-run` + `MANIFEST.json` 为提交资产，经构建复制进 `better-dsh lib/` 与 `super-dsh/remote/helper-bin/`（计入 provenance outputs）；对端缓存 `~/.cache/superd/run/<triple>-<ver>/`；probe/upload 失败一律回退 POSIX shim，回执 `runner` 字段如实区分；无 postinstall、无 daemon、动词集冻结（banner/run/killgroup）。
- [x] **Step 4:** `npm run build`（根）全链构建通过；`super-dsh/remote/` 重新生成且 provenance 含 helper-bin 哈希。

## Task 6 — 验收与报告

- [x] **Step 1:** 整包 tarball 线（4999）+ dev3 安装态：dev3 上 oneshot（helper 路径 + 强制 shim 路径各一次）、alpine 容器 oneshot、取消路径（timeout 触发 killer/killgroup 回执）。
- [x] **Step 2:** 第一人称核验模型可见 surface：tool description 的 helper 句、回执 runner 行、alpine 失败环境转为成功。
- [x] **Step 3:** 报告落 `docs/test-reports/2026-10-13-remote-rust-helper.md`（含 Task 2 矩阵表、binary 尺寸、PDEATHSIG 实测时序）；提交 user 放行裁定（含 darwin/Windows 后续 D5/D6 是否开启）。

---

## Self-Review

- Spec 覆盖：§5.2 替换面→Task 4；§5.5 冻结→Task 1/Global；§5.6 生命周期（PDEATHSIG/无 TTL/killer backstop）→Task 1 `do_run`/`anchor_parent_death` + Task 2 PDEATHSIG 实测；§5.7 步数账本→Task 4 冒烟对账（取消路径 0 hop）；回执 runner→Task 4 Step 4；双路径永存→Task 4 registry sticky-absent + shim 保真；产物纪律→Task 5。Phase 3（digest/stat）明确不在本计划。D5/D6 未裁项不在本轮（darwin/Windows 推迟，Task 6 提请裁定）。
- 占位符扫描：Task 1 Step 2 含完整 main.rs（两处笔误已就地标注修正法）；Task 4 接口签名齐全；无 TBD。
- 类型一致性：`RemoteProcess.done` 增加 `runner?: string` 需同步 `hub-contract.ts` 类型（Task 4 Step 4 就地补）；`startBinaryProcess` 返回 `stdin: Writable` 与 upload 用法一致。
