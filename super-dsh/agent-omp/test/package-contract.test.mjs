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
