import { apiGet, getAllPages } from "./gocoo-client.ts";
// 実データから「失注・保留理由」「失注理由」の値を抽出して選択肢を逆引きする
const F_LOSS_PEND = "field_ab5642ab-05b3-448a-9fb1-e256cac0e537"; // 失注・保留理由
const F_LOSS      = "field_22619744-b92c-4ebc-9dd0-735c353f446a"; // 失注理由
const F_LOSS_TEXT = "field_a0b85965-ffa8-4b86-9353-22aa43cb91dd"; // 失注理由詳細
const all = await getAllPages<any>("/custom-objects/5/values", { per_page: 100 });
const buckets: Record<string, Map<string, number>> = {
  "失注・保留理由": new Map(),
  "失注理由": new Map(),
};
let withDetail = 0;
let phaseLossOrPending: any[] = [];
for (const d of all) {
  const lp = d[F_LOSS_PEND]?.formatted_value;
  const ls = d[F_LOSS]?.formatted_value;
  const lt = d[F_LOSS_TEXT]?.formatted_value;
  if (lp) buckets["失注・保留理由"].set(lp, (buckets["失注・保留理由"].get(lp) ?? 0) + 1);
  if (ls) buckets["失注理由"].set(ls, (buckets["失注理由"].get(ls) ?? 0) + 1);
  if (lt) withDetail++;
  const phase = d.path_id?.formatted_value ?? "";
  if (phase === "失注" || phase === "ペンディング") {
    phaseLossOrPending.push({
      id: d.id, phase,
      lp_id: d[F_LOSS_PEND]?.value, lp,
      ls_id: d[F_LOSS]?.value, ls,
      lt: (lt ?? "").slice(0, 60),
    });
  }
}
for (const [k, m] of Object.entries(buckets)) {
  console.log(`\n=== ${k} (value→件数) ===`);
  for (const [v, c] of [...m.entries()].sort((a,b)=>b[1]-a[1])) console.log(`  ${v}: ${c}件`);
}
console.log(`\n失注理由詳細(自由記述)が入っている件数: ${withDetail}`);
console.log(`\n=== 失注/ペンディング案件 (最新10件) ===`);
for (const x of phaseLossOrPending.slice(0, 10)) console.log(JSON.stringify(x));
console.log(`\n合計: 失注/ペンディング=${phaseLossOrPending.length}件`);
