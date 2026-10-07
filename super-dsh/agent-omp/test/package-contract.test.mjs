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

test("the RPC line ships no sidecar; the only sidecar is the opt-in SDK adapter's", () => {
  // 2026-10-03: the RPC line still bundles no runtime (that was the point of the
  // transport swap). The OPT-IN `agent-omp-sdk` row — disabled by default, its
  // runtime fetched on first use — deliberately ships its own bun sidecar
  // source, so this guard now pins the exception rather than the absence.
  const files = JSON.parse(readFileSync(root, "utf8")).files;
  const sidecars = files.filter((f) => f.includes("sidecar"));
  assert.deepEqual(sidecars, ["agent-omp-sdk/sidecar"], "only agent-omp-sdk may ship a sidecar");
  assert.equal(files.some((f) => f.startsWith("agent-omp/sidecar")), false);
});
