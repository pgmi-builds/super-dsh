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
