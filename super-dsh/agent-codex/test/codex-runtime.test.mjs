import assert from "node:assert/strict";
import { test } from "node:test";
import * as wire from "../dist/app-server-wire.js";

// Inject the filesystem/installation boundary so a desktop on the test host
// cannot hide a broken fallback. The production selection algorithm stays real.
function discovery({ platform = "linux", env = {}, files = [], executables = [], cli, packageEntry, desktopCandidates, realpaths = {} } = {}) {
  return {
    platform,
    env,
    homeDir: "/users/test",
    isFile: (path) => files.includes(path),
    isExecutable: (path) => executables.includes(path),
    realpath: (path) => realpaths[path] ?? path,
    findCommand: () => cli,
    resolvePackageEntry: () => {
      if (packageEntry === undefined) throw new Error("package absent");
      return packageEntry;
    },
    ...(desktopCandidates === undefined ? {} : { desktopCandidates }),
  };
}

function resolve(options) {
  assert.equal(typeof wire.resolveCodexRuntime, "function", "transport must expose the desktop-first runtime resolver");
  return wire.resolveCodexRuntime(options);
}

test("CODEX_BIN wins over an installed desktop and user CLI", () => {
  const result = resolve(discovery({
    env: { CODEX_BIN: "/override/codex" },
    files: ["/override/codex", "/usr/lib/chatgpt/resources/codex"],
    executables: ["/override/codex", "/usr/lib/chatgpt/resources/codex"],
    cli: "/user/bin/codex",
  }));
  assert.deepEqual(result, { command: "/override/codex", nodeScript: false, source: "override" });
});

test("an invalid explicit override fails instead of silently choosing another runtime", () => {
  assert.throws(() => resolve(discovery({ env: { CODEX_BIN: "/missing/codex" }, cli: "/user/bin/codex" })), /CODEX_BIN.*\/missing\/codex/);
});

test("an executable Linux desktop core wins over a user CLI", () => {
  const result = resolve(discovery({
    files: ["/usr/lib/chatgpt/resources/codex"],
    executables: ["/usr/lib/chatgpt/resources/codex"],
    cli: "/user/bin/codex",
  }));
  assert.deepEqual(result, { command: "/usr/lib/chatgpt/resources/codex", nodeScript: false, source: "desktop" });
});

test("a missing or non-executable desktop falls back to the user CLI", () => {
  for (const files of [[], ["/usr/lib/chatgpt/resources/codex"]]) {
    const result = resolve(discovery({ files: [...files, "/user/bin/codex"], executables: ["/user/bin/codex"], cli: "/user/bin/codex" }));
    assert.deepEqual(result, { command: "/user/bin/codex", nodeScript: false, source: "cli" });
  }
});

test("an npm CLI symlink to JavaScript runs through Node", () => {
  const result = resolve(discovery({
    cli: "/user/bin/codex", files: ["/user/bin/codex"], executables: ["/user/bin/codex"],
    realpaths: { "/user/bin/codex": "/user/node_modules/@openai/codex/bin/codex.js" },
  }));
  assert.deepEqual(result, { command: "/user/bin/codex", nodeScript: true, source: "cli" });
});

test("without desktop or CLI the exact-pin package JavaScript entry is selected", () => {
  const result = resolve(discovery({ packageEntry: "/package/@openai/codex/bin/codex.js", files: ["/package/@openai/codex/bin/codex.js"] }));
  assert.deepEqual(result, { command: "/package/@openai/codex/bin/codex.js", nodeScript: true, source: "package" });
});

test("a readable JS override needs no executable bit because Node launches it", () => {
  const result = resolve(discovery({ env: { CODEX_BIN: "/override/fake.mjs" }, files: ["/override/fake.mjs"] }));
  assert.deepEqual(result, { command: "/override/fake.mjs", nodeScript: true, source: "override" });
});

test("missing runtimes produce installation and override guidance", () => {
  assert.throws(() => resolve(discovery()), /cannot locate.*Codex.*desktop.*CLI.*@openai\/codex.*CODEX_BIN/i);
});

test("desktop discovery accepts macOS app resources and Windows LocalAppData", () => {
  for (const entry of [
    { platform: "darwin", path: "/Applications/Codex.app/Contents/Resources/codex", env: {} },
    { platform: "win32", path: "C:\\Users\\test\\AppData\\Local\\Programs\\Codex\\resources\\codex.exe", env: { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" } },
  ]) {
    const result = resolve(discovery({ platform: entry.platform, env: entry.env, files: [entry.path], executables: [entry.path] }));
    assert.deepEqual(result, { command: entry.path, nodeScript: false, source: "desktop" });
  }
});

test("a supplied desktop candidate is checked before choosing it", () => {
  const result = resolve(discovery({ desktopCandidates: ["/custom/desktop/codex"], files: ["/custom/desktop/codex"], executables: ["/custom/desktop/codex"] }));
  assert.deepEqual(result, { command: "/custom/desktop/codex", nodeScript: false, source: "desktop" });
});

test("blank override leaves desktop discovery active", () => {
  const result = resolve(discovery({ env: { CODEX_BIN: "  " }, files: ["/usr/lib/chatgpt/resources/codex"], executables: ["/usr/lib/chatgpt/resources/codex"] }));
  assert.equal(result.source, "desktop");
});

test("PATH lookup uses the injected environment and skips non-executable entries", () => {
  const options = discovery({
    env: { PATH: "/blocked:/custom/bin" },
    files: ["/blocked/codex", "/custom/bin/codex"],
    executables: ["/custom/bin/codex"],
  });
  delete options.findCommand;
  assert.deepEqual(resolve(options), { command: "/custom/bin/codex", nodeScript: false, source: "cli" });
});

test("the compatibility command interface returns the selected runtime path", () => {
  assert.equal(wire.resolveCodexCommand(discovery({
    env: { CODEX_BIN: "/override/test.mjs" }, files: ["/override/test.mjs"],
  })), "/override/test.mjs");
});

test("Windows PATH skips cmd/bat wrappers and continues to a directly executable CLI", () => {
  const options = discovery({
    platform: "win32", env: { PATH: "C:\\wrappers;C:\\native", PATHEXT: ".CMD;.BAT;.EXE" },
    files: ["C:\\wrappers\\codex.CMD", "C:\\wrappers\\codex.BAT", "C:\\native\\codex.EXE"],
    executables: ["C:\\wrappers\\codex.CMD", "C:\\wrappers\\codex.BAT", "C:\\native\\codex.EXE"],
  });
  delete options.findCommand;
  assert.deepEqual(resolve(options), { command: "C:\\native\\codex.EXE", nodeScript: false, source: "cli" });
});

test("Windows PATH with only cmd/bat wrappers falls back to package JS", () => {
  const options = discovery({
    platform: "win32", env: { PATH: "C:\\wrappers", PATHEXT: ".CMD;.BAT" },
    files: ["C:\\wrappers\\codex.CMD", "C:\\package\\bin\\codex.js"], executables: ["C:\\wrappers\\codex.CMD"],
    packageEntry: "C:\\package\\bin\\codex.js",
  });
  delete options.findCommand;
  assert.deepEqual(resolve(options), { command: "C:\\package\\bin\\codex.js", nodeScript: true, source: "package" });
});

test("an explicit Windows wrapper override errors with executable/JS guidance", () => {
  for (const command of ["C:\\cli\\codex.cmd", "C:\\cli\\codex.bat"]) {
    assert.throws(() => resolve(discovery({ platform: "win32", env: { CODEX_BIN: command }, files: [command], executables: [command] })), /CODEX_BIN.*(?:wrapper|\.cmd|\.bat).*executable.*JavaScript/i);
  }
});
