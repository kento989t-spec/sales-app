// 実行スクリプト（要 --apply フラグ）
// ① 旧FS-05デモ環境利用(path_id=8) → FS-05推進合意(path_id=7) に付け替え
// ② FS-01〜FS-12に該当する全案件のヨミを新ルールに合わせて再計算
// 失敗はリトライせず一覧として最後に出力する。
import { apiGet, apiPatch, getAllPages } from "./gocoo-client.ts";
import fs from "fs";

const APPLY = process.argv.includes("--apply");
const FS_PATH_TO_LABEL: Record<number, string> = {
  4: "FS-01", 5: "FS-02", 32: "FS-03", 6: "FS-04", 7: "FS-05推進合意",
  8: "FS-05デモ環境利用(旧)", 33: "FS-06", 35: "FS-07", 36: "FS-08",
  9: "FS-09", 37: "FS-10", 10: "FS-11", 11: "FS-12",
};
const PHASE_TO_YOMI_ID: Record<number, number> = {
  // GoCoo yomi choice IDs: A=120, B=121, C=122, D=123
  4: 123, 5: 123, 32: 123, 6: 123,      // FS-01〜04 → D
  7: 122, 8: 122, 33: 122,               // FS-05推進合意 / FS-05デモ環境利用(旧) / FS-06 → C
  35: 121, 36: 121,                      // FS-07 / FS-08 → B
  9: 120, 37: 120, 10: 120, 11: 120,     // FS-09〜FS-12 → A
};
const YOMI_LABEL = { 120: "A", 121: "B", 122: "C", 123: "D" } as Record<number, string>;
const F_YOMI = "field_ed6f5306-135c-4105-a915-17e554dc5be2";

interface DealRow {
  id: number;
  name?: any;
  path_id?: { value: number };
  [key: string]: any;
}

const all = await getAllPages<DealRow>("/custom-objects/5/values", { per_page: 100 });
console.log(`案件総数: ${all.length}  (APPLY=${APPLY})`);

const log: any[] = [];
const fails: any[] = [];

async function patchDeal(dealId: number, body: any, action: string) {
  log.push({ dealId, action, body, applied: APPLY });
  if (!APPLY) return;
  try {
    await apiPatch(`/custom-objects/5/values/${dealId}`, body);
    console.log(`  ✓ ${action} deal=${dealId}`);
  } catch (e: any) {
    console.error(`  ✗ ${action} deal=${dealId}: ${e.message?.slice(0,200)}`);
    fails.push({ dealId, action, error: e.message });
  }
  // rate limit guard
  await new Promise(r => setTimeout(r, 150));
}

// ===== ① path_id=8 → 7 =====
console.log("\n=== ① 旧FS-05デモ環境利用(id=8) → FS-05推進合意(id=7) 付替 ===");
let phaseMigrated = 0;
for (const d of all) {
  if (d.path_id?.value !== 8) continue;
  phaseMigrated++;
  await patchDeal(d.id, { path_id: 7 }, "phase 8→7");
}
console.log(`対象: ${phaseMigrated}件`);

// ===== ② ヨミ一括再計算 =====
console.log("\n=== ② ヨミ再計算 (FS-01〜FS-12) ===");
let yomiUpdated = 0;
for (const d of all) {
  // path_id=8 だった案件は ①で7に変わっている前提で、新値で判定
  const pid = (phaseMigrated && d.path_id?.value === 8) ? 7 : d.path_id?.value;
  if (pid === undefined || !(pid in PHASE_TO_YOMI_ID)) continue;
  const targetYomi = PHASE_TO_YOMI_ID[pid];
  const curYomi = d[F_YOMI]?.value;
  if (curYomi === targetYomi) continue;
  yomiUpdated++;
  await patchDeal(d.id, { [F_YOMI]: targetYomi }, `yomi ${YOMI_LABEL[curYomi]||"未"}→${YOMI_LABEL[targetYomi]} (path=${FS_PATH_TO_LABEL[pid]})`);
}
console.log(`書き換え対象: ${yomiUpdated}件`);

// ===== ログ書き出し =====
const ts = "2026-06-20T0000";  // fixed timestamp to avoid sandbox restriction
const logPath = `/Users/knt/.company/operations/logs/migrate-fs-phases-${ts}.json`;
try { fs.mkdirSync("/Users/knt/.company/operations/logs", { recursive: true }); } catch {}
fs.writeFileSync(logPath, JSON.stringify({ apply: APPLY, summary: { phaseMigrated, yomiUpdated, fails: fails.length }, log, fails }, null, 2));
console.log(`\nログ: ${logPath}`);
console.log(`失敗: ${fails.length}件`);
