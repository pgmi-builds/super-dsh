#!/usr/bin/env bash
# check-leaks.sh — 提交/CI 泄露守门。公开侧零敏感串：本机真实模式放
# scripts/leak-patterns.local.txt（gitignore，每行一个 ERE，# 为注释）。
# 用法：
#   scripts/check-leaks.sh              # 检查 staged 文件（pre-commit）
#   scripts/check-leaks.sh <file...>    # 检查指定文件
#   scripts/check-leaks.sh --all        # 检查全部 tracked 文件（CI）
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

GENERIC='npm_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9]{20,}|-----BEGIN (RSA |EC |ECDSA |OPENSSH |PGP )?PRIVATE KEY-----'

if [ "${1:-}" = "--all" ]; then
  mapfile -t FILES < <(git ls-files | while IFS= read -r f; do [ -L "$f" ] || printf "%s\n" "$f"; done)
elif [ $# -gt 0 ]; then
  FILES=("$@")
else
  mapfile -t FILES < <(git diff --cached --name-only --diff-filter=ACMR)
fi
[ ${#FILES[@]} -eq 0 ] && exit 0

status=0
hits=$(grep -REln -- "$GENERIC" "${FILES[@]}" 2>/dev/null || true)
if [ -n "$hits" ]; then echo "✗ generic credential shape:"; echo "$hits"; status=1; fi

LP=scripts/leak-patterns.local.txt
if [ -f "$LP" ]; then
  while IFS= read -r pat; do
    [ -z "$pat" ] && continue
    case "$pat" in \#*) continue ;; esac
    hits=$(grep -REln -- "$pat" "${FILES[@]}" 2>/dev/null | grep -v '^AGENTS\.local\.md:' || true)
    if [ -n "$hits" ]; then echo "✗ local pattern: $pat"; echo "$hits"; status=1; fi
  done < "$LP"
fi
[ $status -eq 0 ] && echo "✓ check-leaks: clean"
exit $status
