#!/bin/bash
# Mac Mini 起動時に cloudflared のトンネル URL を検出し、
# sales-app の api-config.json を更新して GitHub Pages に push する。
# LaunchAgent (com.knt.sales-app-update-tunnel.plist) から呼ばれる。

set -e

SALES_APP="/Users/knt/sales-app"
LOG_FILE="/Users/knt/project-dashboard/logs/cloudflared-stderr.log"
CONFIG_FILE="$SALES_APP/docs/api-config.json"
LOGDIR="/Users/knt/project-dashboard/logs"
MYLOG="$LOGDIR/update-tunnel-url.log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$MYLOG"; }

log "=== update-tunnel-url.sh 開始 ==="

# cloudflared が起動するまで最大60秒待機
URL=""
for i in $(seq 1 60); do
  # ログファイルから最新の trycloudflare URL を取得
  URL=$(grep -o "https://[a-z0-9\-]*\.trycloudflare\.com" "$LOG_FILE" 2>/dev/null | tail -1)
  if [ -n "$URL" ]; then
    break
  fi
  sleep 1
done

if [ -z "$URL" ]; then
  log "ERROR: trycloudflare URL が取得できませんでした"
  exit 1
fi

log "取得した URL: $URL"

# 現在の api-config.json と比較
CURRENT=$(cat "$CONFIG_FILE" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('apiUrl',''))" 2>/dev/null || echo "")

if [ "$CURRENT" = "$URL" ]; then
  log "URL 変更なし: $URL"
  exit 0
fi

# api-config.json を更新
echo "{\"apiUrl\": \"$URL\"}" > "$CONFIG_FILE"
log "api-config.json 更新: $CURRENT -> $URL"

# git push
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export HOME="/Users/knt"

cd "$SALES_APP"
git add docs/api-config.json
if git diff --cached --quiet; then
  log "git: 差分なし"
else
  git commit -m "chore: update cloudflare tunnel URL [auto]"
  git push origin main
  log "git push 完了"
fi

log "=== update-tunnel-url.sh 完了 ==="
