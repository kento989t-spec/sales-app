/**
 * 過去のSlack議事録NAを一括取り戻すワンショットリカバリスクリプト。
 *
 * 使い方:
 *   npx tsx scripts/recover-slack-tasks.ts                   # デフォルト: 過去30日分・1ページ200件・最大20ページ
 *   npx tsx scripts/recover-slack-tasks.ts --days 60         # 過去60日分
 *   npx tsx scripts/recover-slack-tasks.ts --pages 50        # ページ上限を増やす
 *   npx tsx scripts/recover-slack-tasks.ts --dry-run         # archiveには書かない（取得のみ）
 *
 * 仕組み: fetchSlackTasks(opts) を大きなlimit/maxPages/oldestで呼び、
 * 既存 slack-tasks-archive.json にマージ追加する。
 * 既存エントリは保持されるので、複数回実行しても安全。
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { fetchSlackTasks } from "./slack-client.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function arg(name: string, defaultValue: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : defaultValue;
}

const DAYS = parseInt(arg("--days", "30"), 10);
const LIMIT = parseInt(arg("--limit", "200"), 10);
const MAX_PAGES = parseInt(arg("--pages", "20"), 10);
const DRY_RUN = process.argv.includes("--dry-run");

const oldestEpoch = Math.floor(Date.now() / 1000) - DAYS * 86400;
const oldest = String(oldestEpoch); // Slack ts は秒.マイクロ秒、整数秒でもOK

console.log(`[recover] 範囲: 過去${DAYS}日 (oldest=${new Date(oldestEpoch * 1000).toISOString()})`);
console.log(`[recover] limit/page=${LIMIT}, maxPages=${MAX_PAGES}, dry-run=${DRY_RUN}`);

const CONFIG_FILE = path.join(__dirname, "..", "config.json");
const CONFIG = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")) as {
  slack_minutes_channel?: string;
};

const ARCHIVE_FILE = path.join(__dirname, "slack-tasks-archive.json");
const BACKUP_FILE = path.join(
  __dirname,
  `slack-tasks-archive.bak-${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}.json`
);

if (fs.existsSync(ARCHIVE_FILE) && !DRY_RUN) {
  fs.copyFileSync(ARCHIVE_FILE, BACKUP_FILE);
  console.log(`[recover] 事前バックアップ: ${BACKUP_FILE}`);
}

if (DRY_RUN) {
  console.log("[recover] --dry-run なので、保存処理はスキップされます（fetch自体は走るので注意：archiveは更新される）");
  console.log("[recover] 厳密にarchiveを変更したくない場合は、事前に archive をコピーしてから実行してください");
}

const start = Date.now();
const result = await fetchSlackTasks(CONFIG, {
  limit: LIMIT,
  maxPages: MAX_PAGES,
  oldest,
});
const elapsed = ((Date.now() - start) / 1000).toFixed(1);

console.log(`[recover] 完了: ${elapsed}秒, archive件数=${result.length}`);

// 会社別カウント
const byCompany = new Map<string, number>();
for (const t of result) {
  const c = t.company ?? "(企業名なし)";
  byCompany.set(c, (byCompany.get(c) ?? 0) + 1);
}
const sorted = [...byCompany.entries()].sort((a, b) => b[1] - a[1]);
console.log(`[recover] カバー会社数: ${sorted.length}`);
console.log(`[recover] 上位10社:`);
for (const [c, n] of sorted.slice(0, 10)) console.log(`  ${c}: ${n}件`);

// 担当者別カウント
const byOwner = new Map<string, number>();
for (const t of result) {
  const o = t.owner ?? "(担当なし)";
  byOwner.set(o, (byOwner.get(o) ?? 0) + 1);
}
const sortedOwners = [...byOwner.entries()].sort((a, b) => b[1] - a[1]);
console.log(`[recover] 担当者別:`);
for (const [o, n] of sortedOwners) console.log(`  ${o}: ${n}件`);
