/**
 * GoCoo カスタムオブジェクトのフィールドIDを確認するスクリプト
 * npm run discover
 * → scripts/field-map.json に出力
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { apiGet, getAllPages } from "./gocoo-client.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEAL_OBJECT_ID = 5;

interface Field {
  id: number;
  name: string;
  field_type: string;
  options?: Array<{ id: number; name: string }>;
}

interface CustomObjectRecord {
  id: number;
  name: string;
  [key: string]: unknown;
}

// フィールド一覧取得
const fieldsRes = await apiGet<{ data: Field[] }>(`/custom-objects/${DEAL_OBJECT_ID}/fields`);
console.log("\n=== フィールド一覧 ===");
for (const f of fieldsRes.data) {
  console.log(`[${f.id}] ${f.name} (${f.field_type})`);
  if (f.options) {
    console.log("  選択肢:", f.options.map(o => `${o.id}:${o.name}`).join(", "));
  }
}

// サンプルレコード1件取得して構造確認
const sample = await apiGet<{ data: CustomObjectRecord[] }>(
  `/custom-objects/${DEAL_OBJECT_ID}/values`,
  { per_page: 1 }
);
if (sample.data.length > 0) {
  console.log("\n=== サンプルレコード構造 ===");
  console.log(JSON.stringify(sample.data[0], null, 2));
}

// field-map.json に保存
const fieldMap: Record<string, number> = {};
for (const f of fieldsRes.data) {
  fieldMap[f.name] = f.id;
}
fs.writeFileSync(
  path.join(__dirname, "field-map.json"),
  JSON.stringify(fieldMap, null, 2)
);
console.log("\n✅ scripts/field-map.json に保存しました");
