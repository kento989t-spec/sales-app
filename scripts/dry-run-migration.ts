// 影響範囲集計（READ-ONLY）
// ① 旧FS-05デモ環境利用(path_id=8) を使ってる案件の件数
// ② FS-01〜FS-12の各フェーズの案件数とヨミ分布（再計算で何件が書き換わるか把握）
import { apiGet, getAllPages } from "./gocoo-client.ts";

const FS_PATH_TO_LABEL: Record<number, string> = {
  4: "FS-01", 5: "FS-02", 32: "FS-03", 6: "FS-04", 7: "FS-05推進合意",
  8: "FS-05デモ環境利用(旧)", 33: "FS-06", 35: "FS-07", 36: "FS-08",
  9: "FS-09", 37: "FS-10", 10: "FS-11", 11: "FS-12",
};
// 自動ヨミルール
const PHASE_TO_YOMI: Record<number, string> = {
  4: "D", 5: "D", 32: "D", 6: "D",      // FS-01〜04 → D
  7: "C", 8: "C", 33: "C",              // FS-05推進合意 / FS-05デモ環境利用(旧) / FS-06 → C
  35: "B", 36: "B",                     // FS-07 / FS-08 → B
  9: "A", 37: "A", 10: "A", 11: "A",    // FS-09〜FS-12 → A
};
// ヨミ choice id (GoCoo)
const YOMI_LABEL = { 120: "A", 121: "B", 122: "C", 123: "D" } as Record<number, string>;

interface DealRow {
  id: number;
  name?: string;
  path_id?: { value: number; formatted_value: string };
  field_ed6f5306_135c_4105_a915_17e554dc5be2?: { value: number; formatted_value: string };
}

const all = await getAllPages<DealRow>("/custom-objects/5/values", { per_page: 100 });
console.log(`案件総数: ${all.length}`);

const byPhase: Record<number, { total: number; needYomiChange: number; current: Record<string, number> }> = {};
let id8Deals: Array<{id: number; name: string}> = [];

for (const d of all) {
  const pid = d.path_id?.value;
  if (pid === undefined) continue;
  if (pid === 8) id8Deals.push({ id: d.id, name: d.name ?? String(d.id) });
  if (!(pid in FS_PATH_TO_LABEL)) continue;

  // GoCoo response uses key "field_<id>" with hyphens replaced; need raw access via index
  const yomiObj = (d as any)["field_ed6f5306-135c-4105-a915-17e554dc5be2"];
  const yomiId = yomiObj?.value;
  const curYomi = YOMI_LABEL[yomiId] ?? "（未設定）";
  const targetYomi = PHASE_TO_YOMI[pid];

  if (!byPhase[pid]) byPhase[pid] = { total: 0, needYomiChange: 0, current: {} };
  byPhase[pid].total++;
  byPhase[pid].current[curYomi] = (byPhase[pid].current[curYomi] ?? 0) + 1;
  if (curYomi !== targetYomi) byPhase[pid].needYomiChange++;
}

console.log("\n=== フェーズ別 件数 / 現状ヨミ分布 / 再計算で書き換わる件数 ===");
const sorted = Object.entries(byPhase).sort((a,b) => Number(a[0]) - Number(b[0]));
for (const [pid, info] of sorted) {
  const label = FS_PATH_TO_LABEL[Number(pid)];
  const target = PHASE_TO_YOMI[Number(pid)];
  const dist = Object.entries(info.current).map(([k,v]) => `${k}:${v}`).join(", ");
  console.log(`path_id=${pid} ${label.padEnd(20)} 件数=${String(info.total).padStart(3)}  目標ヨミ=${target}  現状[${dist}]  書換=${info.needYomiChange}件`);
}

console.log(`\n=== 旧FS-05デモ環境利用(id=8) → FS-05推進合意(id=7) 付替対象 ===`);
console.log(`件数: ${id8Deals.length}`);
for (const d of id8Deals) console.log(`  - id=${d.id} ${d.name}`);
