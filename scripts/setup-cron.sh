#!/bin/bash
# Mac Mini launchd 登録スクリプト（一度だけ実行）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/com.deex.sales-app-sync.plist"

cat > "$PLIST" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.deex.sales-app-sync</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${ROOT}/scripts/sync.sh</string>
  </array>
  <key>StartCalendarInterval</key>
  <array>
    <!-- 毎時0分に実行 -->
    <dict>
      <key>Minute</key>
      <integer>0</integer>
    </dict>
  </array>
  <key>StandardOutPath</key>
  <string>${ROOT}/sync.log</string>
  <key>StandardErrorPath</key>
  <string>${ROOT}/sync.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
EOF

launchctl load "$PLIST"
echo "✅ launchd 登録完了: $PLIST"
echo "   動作確認: launchctl list | grep sales-app"
echo "   手動実行: launchctl start com.deex.sales-app-sync"
