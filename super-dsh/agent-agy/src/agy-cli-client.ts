/**
 * agy-cli-client.ts — primary live path: the agy CLI headless stream-json
 * session (`agy --print --input-format stream-json --output-format stream-json`).
 *
 * Auth: GEMINI_API_KEY env (adapter stores the key; never written to native
 * home) + `modelProvider: "gemini"` merged into the CLI's own settings file
 * (~/.gemini/antigravity-cli/settings.json — single-key merge, user-sanctioned
 * 2026-09-18). Geofenced deployments pass HTTPS_PROXY via AGY_PROXY.
 *
 * Event mapping (superset of the SDK bridge — CLI is richer):
 *   init            → tools list + permission mode (trace)
 *   step_update     → system_message | agent_response (text deltas) |
 *                     tool (ACTIVE→tool_call, DONE→tool_result w/ output)
 *   result          → done (conversation_id for resume via --conversation)
 *
 * Same surface as AgyBridgeClient so AgyAgent needs no changes.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ForeignHubBinding } from "@pgmi-builds/superd-hub/foreign-hub";
import { prepareAgyNativePlugin } from "@pgmi-builds/superd-hub/foreign-agy";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  authChildEnv,
  authSettingsMutation,
  nativeSettingsPath,
  type AgyAuthMode,
  type AgySettingsMutation,
} from "./agy-auth.js";

export interface AgyCliOptions {
  /** Key or a resolver (onboarding-saved keys become visible at first spawn). */
  apiKey: string | (() => string | undefined);
  model?: string;
  /** CLI --effort (low|medium|high) — required by 3.x flash models. */
  effort?: string;
  cwd: string;
  /** Resume an existing conversation id (second+ spawn of the same session). */
  conversationId?: string;
  /** Forward proxy for the geo-fenced Gemini API (dev3 gost et al). */
  proxy?: string;
  /**
   * danger-full-access preset → append --dangerously-skip-permissions
   * (headless has no interactive approval; workspace-write/read-only keep
   * the CLI default request-review, whose headless soft-deny is honest).
   */
  skipPermissions?: boolean;
  /** agy binary override (tests point at a mock). */
  agyBin?: string;
  /**
   * The USER's real home. The CLI always runs against it (never an isolated
   * override), and this is where the native Antigravity settings we maintain
   * live — see the module header for the 2026-10-02 「拥抱用户自己的使用环境」
   * ruling.
   */
  realHome?: string;
  /**
   * The resolved auth form (agy-auth.ts). Absent defaults to `apiKey`, so an
   * unconfigured machine still reaches the §17 onboarding path.
   */
  authMode?: AgyAuthMode;
  spawnAttempts?: number;
  trace?: (...parts: unknown[]) => void;
  hubBinding?: ForeignHubBinding;
  hubStagingDirectory?: string;
  prepareHub?: () => Promise<string | undefined>;
}

export type CliEvent =
  | { event: "ready"; tools: number; permissionMode?: string }
  | { event: "system_message"; text: string }
  | { event: "chunk"; text: string }
  | { event: "tool_call"; id: string; name: string; args: string }
  | { event: "tool_result"; id: string; name: string; is_error: boolean; result: string }
  | { event: "usage"; input_tokens: number; output_tokens: number; thinking_tokens: number; total_tokens: number }
  | { event: "done"; conversation_id: string; turn_ms: number }
  | { event: "error"; error: string; recoverable: boolean };

/**
 * Apply one auth form's mutation to the user's LOCAL Antigravity settings.
 *
 * user ruling 2026-10-02 (「拥抱用户自己的使用环境」): this adapter is
 * deliberately the configuration surface for the user's own Antigravity, so it
 * really does rewrite their `~/.gemini/antigravity-cli/settings.json` — pick
 * Gemini API key here and their TUI runs on the Gemini API key too; pick ADC or
 * OAuth and the `modelProvider` pin is REMOVED so the TUI falls back to the
 * default backend. Idempotent, and a no-op when the file already matches.
 *
 * @param realHome - the user's real `$HOME` (never an isolated override).
 * @param mutation - keys to set and keys to remove.
 * @returns `true` when the file changed on disk.
 */
export function applyAgySettings(realHome: string, mutation: AgySettingsMutation): boolean {
  const p = nativeSettingsPath(realHome);
  let settings: Record<string, unknown> = {};
  if (existsSync(p)) {
    try {
      settings = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    } catch {
      settings = {};
    }
  }
  const before = JSON.stringify(settings);
  for (const key of mutation.remove) delete settings[key];
  Object.assign(settings, mutation.set);
  if (JSON.stringify(settings) === before) return false;
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, JSON.stringify(settings, null, 2) + "\n");
  return true;
}

interface StepUpdate {
  step_index?: number;
  state?: string;
  step_type?: string;
  text_delta?: string;
  tool_name?: string;
  tool_info?: { name?: string; parameters?: Record<string, unknown>; output?: string };
  usage?: { input_tokens?: number; output_tokens?: number; thinking_tokens?: number; total_tokens?: number };
}

export class AgyCliClient {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = "";
  private readonly waiters: Array<(ev: CliEvent) => void> = [];
  private readonly pending: CliEvent[] = [];
  private readonly opts: AgyCliOptions;
  private dead = false;
  private conversationIdValue = "";
  private toolsSeen = 0;
  private hubPreparation?: Promise<void>;
  private hubSession?: string;

  private async prepare(): Promise<void> {
    if (this.dead) throw new Error("agy client is closed");
    this.hubPreparation ??= (async () => {
      if (this.opts.hubBinding === undefined) return;
      this.hubSession = await (this.opts.prepareHub?.() ?? prepareAgyNativePlugin(
        this.opts.hubBinding,
        join(this.realHome(), ".gemini", "antigravity-cli"),
        this.opts.hubStagingDirectory!,
        async directory => {
          const exec = promisify(execFile);
          await exec(this.opts.agyBin ?? "agy", ["plugin", "install", directory], { timeout: 60_000 });
          await exec(this.opts.agyBin ?? "agy", ["plugin", "enable", "superd-hub"], { timeout: 60_000 });
        },
      ));
    })();
    await this.hubPreparation;
    if (this.dead) throw new Error("agy client is closed");
  }

  onThinkingDelta?: (text: string) => void;
  onToolEvent?: (ev: { event: "tool_call"; id: string; name: string; args: string } | { event: "tool_result"; id: string; name: string; is_error: boolean; result: string }) => void;
  setApprovalHandler(_handler: (req: { id: string; tool: string; args: string }) => Promise<boolean>): void {
    // CLI ask-mode approval is not wired in this iteration (approval_mode
    // stays request-review; tools soft-deny in headless).
  }
  setSystemMessageHandler(handler: (text: string) => void): void {
    this.onSystemMessage = handler;
  }
  private onSystemMessage?: (text: string) => void;

  constructor(opts: AgyCliOptions) {
    this.opts = opts;
  }

  get conversationId(): string {
    return this.conversationIdValue;
  }

  get lastUsage(): { input_tokens: number; output_tokens: number; thinking_tokens: number; total_tokens: number } | undefined {
    return this.lastUsageValue;
  }
  private lastUsageValue: { input_tokens: number; output_tokens: number; thinking_tokens: number; total_tokens: number } | undefined;

  /** The user's real home (the CLI and the settings we maintain both live here). */
  private realHome(): string {
    return this.opts.realHome ?? process.env.HOME ?? "";
  }

  private spawnCli(): void {
    if (this.child || this.dead) return;
    this.pending.length = 0;
    this.buffer = "";
    const mode: AgyAuthMode = this.opts.authMode ?? "apiKey";
    // Only key mode patches settings (`modelProvider: "gemini"`); ADC and OAuth
    // need the DEFAULT backend, where that key must be ABSENT — the binary
    // documents the flip: "To switch back to signing in, remove modelProvider
    // from settings.json and restart the CLI". Per the 2026-10-02 ruling this
    // lands in the USER's real native settings, so their TUI behaves the same
    // way afterwards (「拥抱用户自己的使用环境」).
    applyAgySettings(this.realHome(), authSettingsMutation(mode));
    const attempts = this.opts.spawnAttempts ?? 3;
    const agyBin = this.opts.agyBin ?? "agy";
    // Order matters: --print swallows the next token as a prompt value
    // (flag-collision, A2A skill) — keep it LAST, after all value flags.
    // = form everywhere: bare value flags swallow the next token (collision).
    const args = [
      "--input-format=stream-json", "--output-format=stream-json",
      "--disable-slash-commands",
    ];
    const conversationId = this.conversationIdValue || this.opts.conversationId;
    if (conversationId) args.push(`--conversation=${conversationId}`);
    if (this.opts.model) args.push(`--model=${this.opts.model}`);
    if (this.opts.effort) args.push(`--effort=${this.opts.effort}`);
    if (this.opts.skipPermissions) args.push("--dangerously-skip-permissions");
    // NOTE: no --print — stream-json input mode reads prompts from stdin
    // (verified); --print would demand a prompt argument and exit code 2.
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const key = typeof this.opts.apiKey === "function" ? this.opts.apiKey() : this.opts.apiKey;
        if (mode === "apiKey" && !key) throw new Error("agy cli: no GEMINI_API_KEY resolved");
        // The auth ladder rides the child env (agy-auth.ts): AGY_ADC_AUTH for
        // ADC, the key for key mode, and the auto-update pin on EVERY mode.
        // NO_PROXY keeps the dev3 loopback bridge reachable.
        const env: NodeJS.ProcessEnv = { ...process.env, NO_PROXY: "127.0.0.1,localhost", ...authChildEnv(mode, key) };
        delete env.SUPERD_HUB_SESSION;
        if (this.hubSession !== undefined) env.SUPERD_HUB_SESSION = this.hubSession;
        // No HOME override, ever: the settings we just maintained live at
        // `$HOME/.gemini`, ADC at `$HOME/.config/gcloud`, and the sign-in token
        // in the keyring — isolating HOME destroys all three. That was the
        // 2026-10-02 bug behind "the CLI cannot use ADC".
        if (this.opts.proxy) { env.HTTPS_PROXY = this.opts.proxy; env.HTTPS_PROXY = this.opts.proxy; }
        this.child = spawn(agyBin, args, { cwd: this.opts.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
        break;
      } catch (err) {
        lastError = err;
        this.opts.trace?.(`spawn attempt ${attempt} failed:`, err);
      }
    }
    if (!this.child) throw lastError ?? new Error("agy spawn failed");
    const child = this.child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => this.consume(d));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => {
      this.opts.trace?.("[agy stderr]", d.trimEnd());
      this.noteDiagnostic(d);
    });
    child.on("exit", (code) => {
      this.child = undefined;
      this.readyReceived = false;
      this.buffer = "";
      // The CLI reports its refusals on stderr / as non-JSON stdout lines and
      // then exits non-zero. Those lines ARE the diagnosis ("--effort is not
      // supported for model …", "Eligibility check failed: …"), so the exit
      // error carries them: an opaque "exited code=1" leaves the user with a
      // dead turn and nothing to act on.
      this.dispatch({ event: "error", error: this.withDiagnostics(`agy exited code=${code}`), recoverable: !this.dead });
    });
  }

  /**
   * Bounded tail of what the CLI said OUTSIDE its structured stream: stderr,
   * plus stdout lines that were not JSONL frames. The CLI announces refusals
   * this way and then exits (or reports a failed result), so dropping these
   * lines is what turns every failure into "unknown error".
   */
  private diagnostics: string[] = [];

  /** Record one diagnostic line, keeping only a short tail. */
  private noteDiagnostic(chunk: string): void {
    for (const raw of chunk.split("\n")) {
      const line = raw.trim();
      if (line === "") continue;
      this.diagnostics.push(line);
    }
    // A chatty child must not grow this without bound mid-turn.
    if (this.diagnostics.length > 12) this.diagnostics = this.diagnostics.slice(-12);
  }

  /** Append the recorded CLI diagnostics to a failure message, once. */
  private withDiagnostics(message: string): string {
    const tail = this.diagnostics.join(" | ");
    this.diagnostics = [];
    return tail === "" ? message : `${message}: ${tail}`;
  }
  private consume(data: string): void {
    this.buffer += data;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch (err) {
        this.noteDiagnostic(line);
        this.opts.trace?.("bad agy json:", line.slice(0, 120), err);
        continue;
      }
      if (parsed.event === "init") {
        if (typeof parsed.conversation_id === "string") this.conversationIdValue = parsed.conversation_id;
        const init = parsed.init as { tools?: string[]; permission_mode?: string } | undefined;
        this.toolsSeen = Array.isArray(init?.tools) ? init.tools.length : 0;
        this.dispatch({ event: "ready", tools: this.toolsSeen, permissionMode: init?.permission_mode });
      } else if (parsed.event === "step_update") {
        this.consumeStep(parsed.step_update as StepUpdate);
      } else if (parsed.event === "result") {
        const r = parsed.result as { conversation_id?: string; status?: string; error?: string } | undefined;
        if (r?.conversation_id) this.conversationIdValue = r.conversation_id;
        if (r?.status !== "SUCCESS") {
          this.dispatch({ event: "error", error: this.withDiagnostics(r?.error ?? `agy result status=${r?.status}`), recoverable: false });
        } else {
          this.dispatch({ event: "done", conversation_id: this.conversationIdValue, turn_ms: 0 });
        }
      }
    }
  }

  private consumeStep(su: StepUpdate): void {
    const st = su.step_type;
    if (st === "system_message") {
      this.onSystemMessage?.(su.text_delta ?? "");
      return;
    }
    if (st === "agent_response") {
      // Short turns carry their delta on the DONE frame — dispatch any delta.
      if (su.text_delta) {
        this.dispatch({ event: "chunk", text: su.text_delta });
      }
      if (su.usage) {
        this.lastUsageValue = {
          input_tokens: su.usage.input_tokens ?? 0,
          output_tokens: su.usage.output_tokens ?? 0,
          thinking_tokens: su.usage.thinking_tokens ?? 0,
          total_tokens: su.usage.total_tokens ?? 0,
        };
        this.dispatch({
          event: "usage",
          input_tokens: this.lastUsageValue.input_tokens,
          output_tokens: this.lastUsageValue.output_tokens,
          thinking_tokens: this.lastUsageValue.thinking_tokens,
          total_tokens: this.lastUsageValue.total_tokens,
        });
      }
      return;
    }
    if (st === "tool") {
      const name = su.tool_name ?? su.tool_info?.name ?? "unknown";
      const id = `${this.conversationIdValue}:${su.step_index ?? 0}`;
      if (su.state === "ACTIVE") {
        this.dispatch({
          event: "tool_call", id, name,
          args: JSON.stringify(su.tool_info?.parameters ?? {}),
        });
      } else if (su.state === "DONE" || su.state === "ERROR") {
        const output = su.tool_info?.output ?? "";
        const isError = su.state === "ERROR";
        this.dispatch({
          event: "tool_result", id, name, is_error: isError,
          result: output || (isError ? "tool failed" : "[agy CLI reported no output summary]"),
        });
      }
    }
  }

  private dispatch(ev: CliEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(ev);
    else this.pending.push(ev);
  }

  private nextEvent(): Promise<CliEvent> {
    const pending = this.pending.shift();
    if (pending) return Promise.resolve(pending);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private send(obj: Record<string, unknown>): void {
    if (!this.child) throw new Error("agy not running");
    this.child.stdin.write(JSON.stringify(obj) + "\n");
  }

  /** One turn. First call spawns the CLI (lazy per §14-i) and keeps it resident. */
  async *turn(text: string): AsyncGenerator<string, string, void> {
    await this.prepare();
    this.spawnCli();
    await this.expectReady();
    this.send({ event: "user", message: { content: text } });
    let full = "";
    for (;;) {
      const ev = await this.nextEvent();
      if (ev.event === "chunk") {
        full += ev.text;
        yield ev.text;
      } else if (ev.event === "system_message") {
        this.onSystemMessage?.(ev.text);
      } else if (ev.event === "tool_call" || ev.event === "tool_result") {
        this.onToolEvent?.(ev);
      } else if (ev.event === "usage") {
        this.lastUsageValue = {
          input_tokens: ev.input_tokens, output_tokens: ev.output_tokens,
          thinking_tokens: ev.thinking_tokens, total_tokens: ev.total_tokens,
        };
      } else if (ev.event === "done") {
        return full;
      } else if (ev.event === "error") {
        throw new Error(`agy cli: ${ev.error}`);
      }
    }
  }

  private readyReceived = false;

  private async expectReady(): Promise<void> {
    if (this.readyReceived) return;
    for (;;) {
      const ev = await this.nextEvent();
      if (ev.event === "ready") {
        this.readyReceived = true;
        return;
      }
      if (ev.event === "error") throw new Error(`agy cli: ${ev.error}`);
    }
  }

  async ping(): Promise<void> {
    await this.prepare();
    this.spawnCli();
    await this.expectReady();
  }

  /** Stop one CLI execution, preserving its conversation and Hub capability. */
  async interrupt(): Promise<void> {
    const child = this.child;
    if (child === undefined) return;
    this.readyReceived = false;
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
    timer.unref();
    try { await exited } finally { clearTimeout(timer) }
  }

  async close(): Promise<void> {
    if (this.dead) return;
    this.dead = true;
    await this.opts.hubBinding?.dispose();
    if (!this.child) return;
    const child = this.child;
    try { child.stdin.end(); } catch { /* already gone */ }
    setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
    }, 2000).unref();
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));
    this.child = undefined;
  }
}
