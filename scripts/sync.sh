#!/bin/bash
# GoCoo → sales-data.json → GitHub Pages 同期
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
LOG="$ROOT/sync.log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

cd "$ROOT"

log "データ取得開始..."
npm run fetch 2>&1 | tee -a "$LOG"

log "GitHub Pages 同期中..."
if git diff --quiet docs/data/sales-data.json 2>/dev/null; then
  log "変更なし。スキップ。"
  exit 0
fi

git add docs/data/sales-data.json
git commit -m "sync: $(date '+%Y-%m-%d %H:%M:%S')"
git push origin main

log "✅ 同期完了"
