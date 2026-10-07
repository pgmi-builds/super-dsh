#!/usr/bin/env node
/**
 * mock_agy_hub.mjs — test double for `agy --hub`.
 *
 * AGY_HUB_MODE selects the behaviour (default "ok"):
 *   ok       banner + /healthz + LanguageServerService echo (a healthy hub)
 *   no-flag  rejects `--hub` exactly like the desktop/IDE binaries do
 *   tty      the real symptom of a missing AGY_ENABLE_HUB: TUI, no TTY, die
 *   hang     prints the banner but never listens (startup-timeout path)
 *   silent   prints nothing, never listens, never exits
 *
 * AGY_MOCK_TRACE: file receiving {argv, env} on startup — the spawn contract
 * (AGY_ENABLE_HUB present, --hub-port forwarded) is asserted from here.
 * AGY_MOCK_PID_FILE: receives our pid, so tests can prove the supervisor
 * actually reaped us (kill(pid, 0) → ESRCH) instead of leaving an orphan.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

if (process.env.AGY_MOCK_PID_FILE) {
  writeFileSync(process.env.AGY_MOCK_PID_FILE, String(process.pid));
}


if (process.env.AGY_MOCK_TRACE) {
  appendFileSync(
    process.env.AGY_MOCK_TRACE,
    `${JSON.stringify({
      argv: process.argv.slice(2),
      env: {
        AGY_ENABLE_HUB: process.env.AGY_ENABLE_HUB ?? null,
        ANTIGRAVITY_VSCODE_HOST: process.env.ANTIGRAVITY_VSCODE_HOST ?? null,
        ANTIGRAVITY_AUTH_SUCCESS_APP: process.env.ANTIGRAVITY_AUTH_SUCCESS_APP ?? null,
        AGY_CLI_DISABLE_AUTO_UPDATE: process.env.AGY_CLI_DISABLE_AUTO_UPDATE ?? null,
        HOME: process.env.HOME ?? null,
      },
    })}\n`,
  );
}

const argv = process.argv.slice(2);
const portArg = argv.find((arg) => arg.startsWith("--hub-port="));
const port = portArg ? Number(portArg.slice("--hub-port=".length)) : 0;
const mode = process.env.AGY_HUB_MODE ?? "ok";

process.on("SIGTERM", () => process.exit(0));

switch (mode) {
  case "no-flag":
    process.stderr.write("flags provided but not defined: -hub -hub-port\nUsage of agy:\n");
    process.exit(1);
    break;
  case "tty":
    process.stderr.write(
      "CLI error: bubbletea: error opening TTY: bubbletea: could not open TTY: open /dev/tty: no such device or address\n",
    );
    process.exit(1);
    break;
  case "silent":
    // never listens, never exits
    setInterval(() => { }, 1 << 30);
    break;
  case "hang":
    process.stdout.write("\n  Antigravity server is running.\n\n  Server version:  2.19.1\n");
    setInterval(() => { }, 1 << 30);
    break;
  default: {
    process.stdout.write(
      `\n  Antigravity server is running.\n\n  Server version:  2.19.1\n  CLI version:  1.2.15\n\n` +
      `  \u279c  Open in your browser:  http://localhost:${port}\n\n  Press Ctrl-C to stop the server.\n`,
    );
    const server = createServer((request, response) => {
      if (request.url === "/healthz") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ instanceId: `mock-${port}`, status: "ok" }));
        return;
      }
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const method = request.url.split("/").pop();
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: method, body: body ? JSON.parse(body) : {} }));
      });
    });
    server.listen(port, "127.0.0.1");
  }
}
