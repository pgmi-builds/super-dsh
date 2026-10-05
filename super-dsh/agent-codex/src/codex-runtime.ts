/** Resolve an installed Codex runtime at first use, without modifying its home. */
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export interface CodexRuntime {
  readonly command: string;
  readonly nodeScript: boolean;
  readonly source: "override" | "desktop" | "cli" | "package";
}

/** Installation boundaries are injectable; selection never needs a desktop in tests. */
export interface CodexRuntimeDiscovery {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly homeDir: string;
  readonly desktopCandidates?: readonly string[];
  readonly isFile: (path: string) => boolean;
  readonly isExecutable: (path: string) => boolean;
  readonly realpath: (path: string) => string;
  readonly findCommand: (name: string) => string | undefined;
  readonly resolvePackageEntry: () => string;
}

function readableFile(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function desktopPaths(discovery: CodexRuntimeDiscovery): readonly string[] {
  if (discovery.desktopCandidates !== undefined) return discovery.desktopCandidates;
  const explicit = discovery.env.CODEX_DESKTOP_BIN?.trim();
  const paths = explicit ? [explicit] : [];
  if (discovery.platform === "linux") {
    paths.push("/usr/lib/chatgpt/resources/codex", "/usr/lib/codex/resources/codex", "/opt/Codex/resources/codex", "/opt/codex/resources/codex");
  } else if (discovery.platform === "darwin") {
    for (const root of ["/Applications", posix.join(discovery.homeDir, "Applications")]) {
      for (const app of ["Codex.app", "ChatGPT.app"]) paths.push(posix.join(root, app, "Contents/Resources/codex"));
    }
  } else if (discovery.platform === "win32") {
    const local = discovery.env.LOCALAPPDATA;
    if (local) {
      for (const app of ["Codex", "ChatGPT"]) paths.push(win32.join(local, "Programs", app, "resources", "codex.exe"));
    }
  }
  return paths;
}

function isNodeScript(command: string, discovery: CodexRuntimeDiscovery): boolean {
  let target = command;
  try {
    target = discovery.realpath(command);
  } catch {
    // Explicit nonexistent paths are rejected by the file check below.
  }
  return /\.(?:[cm]?js)$/i.test(target);
}

export function resolveCodexRuntime(options: Partial<CodexRuntimeDiscovery> = {}): CodexRuntime {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const isFile = options.isFile ?? readableFile;
  const isExecutable = options.isExecutable ?? executable;
  const path = platform === "win32" ? win32 : posix;
  const shellWrapper = (command: string): boolean => platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
  const discovery: CodexRuntimeDiscovery = {
    platform,
    env,
    homeDir: options.homeDir ?? homedir(),
    ...(options.desktopCandidates === undefined ? {} : { desktopCandidates: options.desktopCandidates }),
    isFile,
    isExecutable,
    realpath: options.realpath ?? realpathSync,
    findCommand: options.findCommand ?? ((name) => {
      const suffixes = platform === "win32" ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")] : [""];
      for (const directory of (env.PATH ?? "").split(platform === "win32" ? ";" : ":")) {
        if (directory === "") continue;
        for (const suffix of suffixes) {
          const candidate = path.join(directory, `${name}${suffix}`);
          if (shellWrapper(candidate)) continue;
          if (isFile(candidate) && isExecutable(candidate)) return candidate;
        }
      }
      return undefined;
    }),
    resolvePackageEntry: options.resolvePackageEntry ?? (() => createRequire(import.meta.url).resolve("@openai/codex/bin/codex.js")),
  };
  const usable = (command: string): boolean => !shellWrapper(command) && isFile(command) && (isNodeScript(command, discovery) || isExecutable(command));
  const selected = (command: string, source: CodexRuntime["source"]): CodexRuntime => ({ command, nodeScript: isNodeScript(command, discovery), source });

  const override = env.CODEX_BIN?.trim();
  if (override) {
    const command = /[\\/]/.test(override) ? override : discovery.findCommand(override) ?? override;
    if (shellWrapper(command)) throw new Error(`CODEX_BIN ${override} is a Windows .cmd/.bat shell wrapper. Set CODEX_BIN to the native codex.exe executable or the @openai/codex JavaScript entry instead.`);
    if (!usable(command)) throw new Error(`CODEX_BIN ${override} is not a readable JavaScript entry or executable Codex runtime. Fix CODEX_BIN or remove the override.`);
    return selected(command, "override");
  }
  for (const candidate of desktopPaths(discovery)) {
    if (!shellWrapper(candidate) && isFile(candidate) && isExecutable(candidate)) return selected(candidate, "desktop");
  }
  const cli = discovery.findCommand("codex");
  if (cli !== undefined && usable(cli)) return selected(cli, "cli");
  try {
    const entry = discovery.resolvePackageEntry();
    if (isFile(entry)) return { command: entry, nodeScript: true, source: "package" };
  } catch {
    // Installation fallback only; authentication/generation never reaches here.
  }
  throw new Error("cannot locate a Codex runtime: install Codex desktop or a user CLI on PATH, restore the exact-pin @openai/codex package, or set CODEX_BIN to its executable or JavaScript entry.");
}

/** Compatibility interface for callers that need only the selected path. */
export function resolveCodexCommand(options: Partial<CodexRuntimeDiscovery> = {}): string {
  return resolveCodexRuntime(options).command;
}
