import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const register = fileURLToPath(new URL("./hooks/fs-isolation-register.mjs", import.meta.url));

/**
 * `resolveOmpExecutable()` checks `~/.local/bin/omp` and `/usr/local/bin/omp`,
 * neither of which can be steered through the environment. The other four
 * branches are pinned against the real filesystem in `rpc-client.test.mjs`;
 * this file covers the final absolute candidate by running one child process
 * with a mocked `node:fs`, so the assertion never depends on what happens to be
 * installed on the host at a machine-specific system path.
 */
test("resolveOmpExecutable falls back to /usr/local/bin/omp when earlier candidates miss", () => {
  const emptyHome = mkdtempSync(join(tmpdir(), "omp-usrot-"));
  const script = [
    `const { resolveOmpExecutable } = await import(${JSON.stringify(new URL("rpc-client.js", `file://${dist}`).href)});`,
    `process.stdout.write(resolveOmpExecutable());`,
  ].join("\n");
  const child = spawnSync(
    process.execPath,
    ["--import", register, "--input-type=module", "-e", script],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        FS_ISOLATION: "1",
        FS_ISOLATION_HITS: JSON.stringify(["/usr/local/bin/omp"]),
        OMP_EXECUTABLE: undefined,
        PATH: join(emptyHome, "no-bin"),
        HOME: emptyHome,
      },
    },
  );
  assert.equal(child.status, 0, `child failed:\n${child.stderr}`);
  assert.equal(child.stdout, "/usr/local/bin/omp");
});
