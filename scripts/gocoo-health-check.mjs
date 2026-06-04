/**
 * GoCoo 連携ヘルスチェック
 * - GoCoo API への認証付き読み取りを試し、失敗したらオーナーへ Slack DM
 * - スパム防止: 壊れている間は2時間に1回だけ再通知。回復したら回復通知を1回。
 * launchd (com.deex.gocoo-health-check) から15分ごとに実行。
 */
import { apiGet } from "/Users/knt/sales-app/scripts/gocoo-client.ts";
import { execSync } from "child_process";
import fs from "fs";

const STATE_FILE = "/Users/knt/sales-app/scripts/.health-state.json";
const NOTIFY = "/Users/knt/.company/operations/scripts/notify-slack-dm.sh";
const REALERT_MS = 2 * 60 * 60 * 1000; // 2時間

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")); }
  catch { return { status: "healthy", last_alert: 0 }; }
}
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s)); }

function slackDM(msg) {
  try {
    execSync(`${NOTIFY} ${JSON.stringify(msg)}`, { stdio: "pipe" });
  } catch (e) {
    console.error("Slack DM送信失敗:", e.message);
  }
}

async function main() {
  const state = loadState();
  const now = Date.now();
  let healthy = false;
  let errMsg = "";

  try {
    await apiGet("/custom-objects/5/values", { per_page: 1 });
    healthy = true;
  } catch (e) {
    errMsg = String(e.message || e).slice(0, 200);
  }

  if (healthy) {
    if (state.status === "broken") {
      slackDM("✅ *営業ダッシュボード: GoCoo連携が回復しました*\n書き込みが正常に動作しています。");
    }
    saveState({ status: "healthy", last_alert: 0 });
    console.log("healthy");
  } else {
    const firstBreak = state.status !== "broken";
    const shouldAlert = firstBreak || (now - (state.last_alert || 0) > REALERT_MS);
    if (shouldAlert) {
      slackDM(
        "🚨 *営業ダッシュボード: GoCoo連携が切れています*\n" +
        "ダッシュボードからの案件更新が GoCoo に反映されない状態です。\n\n" +
        "*対処（Mac Miniで実行）:*\n" +
        "```cd ~/sales-app && npm run auth```\n" +
        "→ ブラウザでGoCoo承認 → 表示されたコードで `npm run auth -- 'コード'`\n\n" +
        "エラー: `" + errMsg + "`"
      );
    }
    saveState({ status: "broken", last_alert: shouldAlert ? now : (state.last_alert || 0) });
    console.log("broken:", errMsg);
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
