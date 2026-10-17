#!/bin/sh
# Build every helper target and refresh bin/<target>/ artifacts + MANIFEST.json.
# Local: x86_64-unknown-linux-musl, aarch64-unknown-linux-musl, x86_64-pc-windows-gnu.
# Darwin: built on the `mac` host over ssh (Apple Silicon; needs rustup there once).
# A target whose toolchain is missing is reported and SKIPPED (existing artifact kept)
# — never silently dropped from MANIFEST: only targets with fresh or kept artifacts are listed.
set -eu
cd "$(dirname "$0")"
PKG_VER="$(node -p 'require("../../../package.json").version' 2>/dev/null || echo 0.1.0)"
# Monotonic stamp (2026-10-17 close-out ruling): the package version gets
# rebased across letter rounds (0.3.1-h once became 0.3.1-c), which made a
# lexically-"newer" stale helper indistinguishable from the current one in
# receipts. The git commit count never decreases, so <pkg>.b<count> orders
# every build that ever existed. Within-round rebuilds share the stamp by
# design (per-round identity); darwin builds receive VER via env (no git on
# the remote build host).
COUNT="$(git rev-list --count HEAD 2>/dev/null || echo 0)"
VER="${SUPERD_RUN_VER:-${PKG_VER}.b${COUNT}}"
export PATH="$HOME/.cargo/bin:$PATH"
echo "superd-run build: ver=$VER (pkg ${PKG_VER}, commits ${COUNT})"

build_local() {
  triple=$1; extra=$2
  echo "== $triple"
  if [ -n "$extra" ]; then
    RUSTFLAGS="$extra" SUPERD_RUN_VER="$VER" SUPERD_RUN_TARGET="$triple" cargo build --release --target "$triple"
  else
    SUPERD_RUN_VER="$VER" SUPERD_RUN_TARGET="$triple" cargo build --release --target "$triple"
  fi
}

build_darwin() {
  triple=aarch64-apple-darwin
  echo "== $triple (remote build host: mac)"
  ssh -o BatchMode=yes -o ConnectTimeout=8 mac 'mkdir -p /tmp/superd-run-build/src' || return 1
  scp -q -o BatchMode=yes Cargo.toml build.rs mac:/tmp/superd-run-build/
  scp -q -o BatchMode=yes src/main.rs src/unix.rs src/windows.rs mac:/tmp/superd-run-build/src/
  ssh -o BatchMode=yes mac "cd /tmp/superd-run-build && PATH=\"\$HOME/.cargo/bin:\$PATH\" SUPERD_RUN_VER='$VER' SUPERD_RUN_TARGET='$triple' \$HOME/.cargo/bin/cargo build --release" || return 1
  mkdir -p "target/$triple/release"
  scp -q -o BatchMode=yes "mac:/tmp/superd-run-build/target/release/superd-run" "target/$triple/release/superd-run"
}

collect() {
  triple=$1; file=$2
  mkdir -p "bin/$triple"
  cp "target/$triple/release/$file" "bin/$triple/$file"
  chmod 0755 "bin/$triple/$file"
  printf '%s' "$VER" > "bin/$triple/BUILT-VER"
}

staged=""
try_local() {
  triple=$1; extra=$2; file=$3
  if build_local "$triple" "$extra" 2>/dev/null; then collect "$triple" "$file"; staged="$staged $triple"; else echo "SKIP $triple (toolchain unavailable)"; fi
}
try_local x86_64-unknown-linux-musl '' superd-run
try_local aarch64-unknown-linux-musl '-C linker=rust-lld -C link-self-contained=yes' superd-run
try_local x86_64-pc-windows-gnu '' superd-run.exe
if build_darwin 2>/dev/null; then collect aarch64-apple-darwin superd-run; staged="$staged aarch64-apple-darwin"
else
  echo "SKIP aarch64-apple-darwin (mac host unreachable)"
  # A kept artifact from an earlier round carries that round's embedded ver and would
  # fail its own banner check (registry parseReady) — never ship an unverifiable binary.
  if [ -f bin/aarch64-apple-darwin/BUILT-VER ] && [ "$(cat bin/aarch64-apple-darwin/BUILT-VER)" = "$VER" ]; then
    staged="$staged aarch64-apple-darwin"
  else
    rm -rf bin/aarch64-apple-darwin
    echo "dropped stale darwin artifact (BUILT-VER mismatch/absent)"
  fi
fi

echo "== MANIFEST"
node - "$VER" <<'EOF'
const { createHash } = require('crypto');
const { readFileSync, readdirSync, writeFileSync } = require('fs');
const ver = process.argv[2];
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const targets = {};
for (const triple of readdirSync('bin').filter(t => t !== 'MANIFEST.json').sort()) {
  let file = 'superd-run';
  try { readFileSync(`bin/${triple}/${file}`); } catch { file = 'superd-run.exe'; }
  const data = readFileSync(`bin/${triple}/${file}`);
  targets[triple] = { file, bytes: data.length, sha256: sha(`bin/${triple}/${file}`) };
}
const sources = {};
for (const f of ['Cargo.toml', 'build.rs', 'src/main.rs', 'src/unix.rs', 'src/windows.rs']) {
  sources[f] = sha(f);
}
writeFileSync('bin/MANIFEST.json', JSON.stringify({ format: 1, name: 'superd-run', ver, protocol: 1, targets, sources }, null, 2) + '\n');
console.log(JSON.stringify({ ver, targets: Object.keys(targets) }));
EOF
echo "done."
