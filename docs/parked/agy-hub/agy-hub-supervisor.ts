/**
 * agy-hub-supervisor.ts — owns the lifetime of one `agy --hub` instance.
 *
 * Why this file exists separately from agy-hub-client.ts: `--hub` is an
 * undocumented, probed capability, so *starting* it is a decision with
 * failure modes a caller must be able to tell apart. Falling back to the
 * documented stream-json transport is correct when the binary has no hub
 * face at all, and wrong when we merely lost a race or a port. Hence
 * AgyHubUnavailableError carries a `reason`.
 *
 * ── Measured 2026-10-03, agy 1.2.15 (engine "Antigravity server 2.19.1") ───
 *
 * The startup banner on stdout is the ONLY place the engine names its
 * version; the HTTP surface reports just an instanceId:
 *
 *     Antigravity server is running.
 *
 *     Server version:  2.19.1
 *     CLI version:  1.2.15
 *
 *     ➜  Open in your browser:  http://localhost:5395
 *
 * Two spawn facts that are easy to get wrong:
 *
 *   - `--hub` alone is NOT enough. Without `AGY_ENABLE_HUB=1` the binary
 *     ignores the mode and falls through to the interactive TUI, which dies
 *     as `CLI error: bubbletea: error opening TTY` (stdin is "ignore" here,
 *     exactly like the official VS Code extension's spawn). That is why the
 *     env block below is part of the contract, not a nicety.
 *   - `ANTIGRAVITY_VSCODE_HOST=1` + `ANTIGRAVITY_AUTH_SUCCESS_APP` are what
 *     the extension sets; the hub branch/feature gating reads them, so they
 *     are kept identical to the official argv/env pair.
 *
 * Lifecycle: stdin ignored, stdout/stderr piped, SIGTERM then SIGKILL. The
 * child stays in our process group, so a normal parent exit reaps it; the
 * engine also accepts `-parent_pipe_path` (parent-liveness pipe) which would
 * cover a SIGKILLed parent — deliberately not wired yet, unverified.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  AgyHubClient,
  agyHubBaseUrl,
  type AgyHubEndpoint,
  type FetchLike,
} from "./agy-hub-client.js";

/** Env the hub mode requires; mirrors the official VS Code extension. */
export const HUB_ENV: Readonly<Record<string, string>> = {
  AGY_ENABLE_HUB: "1",
  ANTIGRAVITY_VSCODE_HOST: "1",
  ANTIGRAVITY_AUTH_SUCCESS_APP: "vscode",
  // a hub that self-updates mid-session would swap the binary under us
  AGY_CLI_DISABLE_AUTO_UPDATE: "1",
};

export const DEFAULT_HUB_STARTUP_TIMEOUT_MS = 30_000;
export const DEFAULT_HUB_STOP_GRACE_MS = 3_000;

export type AgyHubUnavailableReason = "no-hub-flag" | "exited-early" | "startup-timeout";

export class AgyHubUnavailableError extends Error {
  readonly reason: AgyHubUnavailableReason;
  readonly output: string;

  constructor(reason: AgyHubUnavailableReason, message: string, output = "") {
    super(message);
    this.name = "AgyHubUnavailableError";
    this.reason = reason;
    this.output = output;
  }

  /** True when retrying can never help on this binary. */
  get permanent(): boolean {
    return this.reason === "no-hub-flag";
  }
}

export interface HubBanner {
  serverVersion?: string;
  cliVersion?: string;
  url?: string;
}

const BANNER_TIMEOUT = /Antigravity server is running/;

/** Parses the startup banner; tolerates the box-drawing and ANSI noise. */
export function parseHubBanner(output: string): HubBanner {
  if (!BANNER_TIMEOUT.test(output)) return {};
  const capture = (label: string): string | undefined => {
    const match = output.match(new RegExp(`${label}:\\s+(\\S+)`));
    return match?.[1];
  };
  const url = output.match(/Open in your browser:\s+(\S+)/)?.[1];
  return {
    serverVersion: capture("Server version"),
    cliVersion: capture("CLI version"),
    url,
  };
}

export interface BuildHubArgsOptions {
  port: number;
  csrfToken: string;
  appDataDir?: string;
  extraArgs?: readonly string[];
}

/** argv exactly as measured, in order. */
export function buildHubArgs(options: BuildHubArgsOptions): string[] {
  const args = [
    "--hub",
    `--hub-port=${options.port}`,
    `--app_data_dir=${options.appDataDir ?? "antigravity"}`,
    `--csrf_token=${options.csrfToken}`,
  ];
  if (options.extraArgs?.length) args.push(...options.extraArgs);
  return args;
}

/** Async variant — kept for callers that only poll. */
export function buildHubEnv(
  base: NodeJS.ProcessEnv = process.env,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, HUB_ENV, extra);
  return env;
}

/** Binds :0, reads the assigned port, releases it. */
export async function pickFreePort(host = "127.0.0.1"): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, host, () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => {
        if (port > 0) resolve(port);
        else reject(new Error("could not obtain a free port"));
      });
    });
  });
}

export interface HubDiscovery {
  pid?: number;
  httpsPort?: number;
  httpPort?: number;
  lspPort?: number;
  lsVersion?: string;
  csrfToken?: string;
}

/** `<gemini_dir>/<app_data_dir>/daemon/` — written only in persistent mode. */
export function hubDiscoveryDir(geminiDir: string, appDataDir: string): string {
  return join(geminiDir, appDataDir, "daemon");
}

/** Best-effort read of the `ls_*.json` discovery file; never throws. */
export function readHubDiscovery(
  geminiDir: string,
  appDataDir: string,
): HubDiscovery | undefined {
  try {
    const dir = hubDiscoveryDir(geminiDir, appDataDir);
    const file = readdirSync(dir).find((name) => name.startsWith("ls_") && name.endsWith(".json"));
    if (!file) return undefined;
    return JSON.parse(readFileSync(join(dir, file), "utf8")) as HubDiscovery;
  } catch {
    return undefined;
  }
}

export interface AgyHubSupervisorOptions {
  /** agy binary; tests point at a mock. Defaults to `agy` on PATH. */
  agyBin?: string;
  /** Fixed port (tests); omitted ⇒ a free one is picked. */
  port?: number;
  appDataDir?: string;
  csrfToken?: string;
  /** Overrides on top of HUB_ENV (tests inject AGY_MOCK_*). */
  env?: Readonly<Record<string, string>>;
  extraArgs?: readonly string[];
  startupTimeoutMs?: number;
  stopGraceMs?: number;
  pollIntervalMs?: number;
  fetchImpl?: FetchLike;
  /** Trace hook — the banner and every failure tail come through here. */
  onOutput?: (chunk: string) => void;
  /** Where the discovery file lives; defaults to `$HOME/.gemini`. */
  geminiDir?: string;
}

export interface AgyHubHandle {
  endpoint: AgyHubEndpoint;
  client: AgyHubClient;
  banner: HubBanner;
  discovery?: HubDiscovery;
  pid?: number;
  stop(): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function tail(text: string, limit = 800): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `…${trimmed.slice(-limit)}`;
}

export class AgyHubSupervisor {
  constructor(private readonly options: AgyHubSupervisorOptions = {}) { }

  async start(): Promise<AgyHubHandle> {
    const {
      agyBin = "agy",
      appDataDir = "antigravity",
      startupTimeoutMs = DEFAULT_HUB_STARTUP_TIMEOUT_MS,
      stopGraceMs = DEFAULT_HUB_STOP_GRACE_MS,
      pollIntervalMs = 250,
      fetchImpl,
      onOutput,
    } = this.options;

    const port = this.options.port ?? (await pickFreePort());
    const csrfToken = this.options.csrfToken ?? randomUUID();
    const args = buildHubArgs({
      port,
      csrfToken,
      appDataDir,
      extraArgs: this.options.extraArgs,
    });
    const baseUrl = agyHubBaseUrl(port);

    let output = "";
    const child: ChildProcess = spawn(agyBin, args, {
      env: buildHubEnv(process.env, this.options.env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const record = (chunk: Buffer): void => {
      const text = chunk.toString();
      output += text;
      onOutput?.(text);
    };
    child.stdout?.on("data", record);
    child.stderr?.on("data", record);

    let exitCode: number | null = null;
    let exited = false;
    child.once("exit", (code) => {
      exited = true;
      exitCode = code;
    });

    const stop = async (): Promise<void> => {
      if (exited) return;
      child.kill("SIGTERM");
      const deadline = Date.now() + stopGraceMs;
      while (!exited && Date.now() < deadline) await sleep(50);
      if (!exited) {
        child.kill("SIGKILL");
        while (!exited) await sleep(25);
      }
    };

    const unavailable = (): AgyHubUnavailableError | undefined => {
      if (!exited) return undefined;
      const noFlag = /not defined:\s*-hub/.test(output);
      return new AgyHubUnavailableError(
        noFlag ? "no-hub-flag" : "exited-early",
        noFlag
          ? `${agyBin} has no --hub face (it rejects the flag); hub transport unavailable`
          : `${agyBin} --hub exited with code ${exitCode} before serving: ${tail(output)}`,
        output,
      );
    };

    const startedAt = Date.now();
    const probe = new AgyHubClient({ baseUrl, csrfToken }, fetchImpl);
    let instanceId: string | undefined;
    for (; ;) {
      const exitedError = unavailable();
      if (exitedError) throw exitedError;
      try {
        instanceId = (await probe.healthz()).instanceId;
        break;
      } catch {
        // not up yet — the loop's exit/timeout branches decide the outcome
      }
      if (Date.now() - startedAt >= startupTimeoutMs) {
        await stop();
        throw new AgyHubUnavailableError(
          "startup-timeout",
          `${agyBin} --hub did not answer /healthz on ${baseUrl} within ${startupTimeoutMs}ms: ${tail(output)}`,
          output,
        );
      }
      await sleep(pollIntervalMs);
    }

    const geminiDir = this.options.geminiDir ?? join(homedir(), ".gemini");
    const discovery = readHubDiscovery(geminiDir, appDataDir);
    const banner = parseHubBanner(output);
    const endpoint: AgyHubEndpoint = {
      baseUrl,
      csrfToken,
      instanceId,
      lsVersion: discovery?.lsVersion,
    };

    return {
      endpoint,
      banner,
      discovery,
      pid: child.pid,
      client: new AgyHubClient(endpoint, fetchImpl),
      stop,
    };
  }
}
