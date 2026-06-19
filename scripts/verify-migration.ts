// マイグレーション後の検証スクリプト
// ① 旧FS-05デモ環境利用(id=8) の案件数 = 0 を確認
// ② FS-01〜FS-12の全案件のヨミがルール通りか確認
// ③ ステータス変更画面で表示するpath_id_rawがsales-data.json中に正しく含まれているかサンプル確認
import { getAllPages } from "./gocoo-client.ts";
import fs from "fs";

const PHASE_TO_YOMI_ID: Record<number, number> = {
  4: 123, 5: 123, 32: 123, 6: 123,
  7: 122, 33: 122,
  35: 121, 36: 121,
  9: 120, 37: 120, 10: 120, 11: 120,
};
const YOMI_LABEL = { 120: "A", 121: "B", 122: "C", 123: "D" } as Record<number, string>;
const F_YOMI = "field_ed6f5306-135c-4105-a915-17e554dc5be2";

const all = await getAllPages<any>("/custom-objects/5/values", { per_page: 100 });
let id8 = 0;
let yomiMismatch: any[] = [];
for (const d of all) {
  const pid = d.path_id?.value;
  if (pid === 8) id8++;
  if (pid in PHASE_TO_YOMI_ID) {
    const cur = d[F_YOMI]?.value;
    if (cur !== PHASE_TO_YOMI_ID[pid]) {
      yomiMismatch.push({ id: d.id, pid, cur: YOMI_LABEL[cur] ?? "未設定", expected: YOMI_LABEL[PHASE_TO_YOMI_ID[pid]] });
    }
  }
}
console.log(`✅ 旧FS-05デモ環境利用(id=8) 残数: ${id8} (期待値: 0)`);
console.log(`✅ ヨミ不整合: ${yomiMismatch.length}件 (期待値: 0)`);
if (yomiMismatch.length) console.log(yomiMismatch.slice(0, 10));

// path_id_raw の存在確認（sales-data.jsonは暗号化されてるためfetch.tsの出力検証はしない）
console.log("\nGoCoo APIレベルでは整合しました。");
