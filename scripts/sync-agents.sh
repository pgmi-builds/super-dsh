#!/usr/bin/env bash
# sync-agents.sh — 重新生成本机 AGENTS.md（runtime 自动加载的真身）：
#   AGENTS.md = AGENTS.template.md（Git 上的公开原则模板） + AGENTS.local.md（本机事实，不入库）
# AGENTS.md 本身 gitignored，永不入库。模板更新后重跑本脚本即可。
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
if [ ! -f AGENTS.local.md ]; then
  echo "缺 AGENTS.local.md —— 先 cp AGENTS.local.example.md AGENTS.local.md 并填入本机事实。" >&2
  exit 1
fi
{
  cat AGENTS.template.md
  printf '\n---\n\n# 本机事实注入段（来源 AGENTS.local.md；本文件由 scripts/sync-agents.sh 生成，勿手改）\n\n'
  cat AGENTS.local.md
} > AGENTS.md
echo "✓ AGENTS.md 已重新生成（template + local facts）"
