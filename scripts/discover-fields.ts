/**
 * GoCoo カスタムオブジェクトのフィールドIDを確認するスクリプト
 * npm run discover
 * → scripts/field-map.json に出力
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { apiGet } from "./gocoo-client.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEAL_OBJECT_ID = 5;

interface Field {
  id: number;
  field_name: string;
  display_name: string;
  field_type: string;
  options?: Array<{ id: number; name: string }>;
}

interface FieldsResponse {
  fields: Field[];
  results: { next_page_url: string | null; per_page: number; total: number };
}

interface ValuesResponse {
  records: Array<{ id: number; name: string; [key: string]: unknown }>;
  results: { next_page_url: string | null; per_page: number; total: number };
}

async function main() {
  const fieldsRes = await apiGet<FieldsResponse>(`/custom-objects/${DEAL_OBJECT_ID}/fields`);
  console.log("\n=== フィールド一覧 ===");
  for (const f of fieldsRes.fields) {
    console.log(`[${f.field_name}] ${f.display_name} (${f.field_type})`);
    if (f.options) {
      console.log("  選択肢:", f.options.map(o => `${o.id}:${o.name}`).join(", "));
    }
  }

  const sample = await apiGet<ValuesResponse>(
    `/custom-objects/${DEAL_OBJECT_ID}/values`,
    { per_page: 1 }
  );
  if (sample.records.length > 0) {
    console.log("\n=== サンプルレコード構造 ===");
    console.log(JSON.stringify(sample.records[0], null, 2));
  }

  const fieldMap: Record<string, string> = {};
  for (const f of fieldsRes.fields) {
    fieldMap[f.display_name] = f.field_name;
  }
  fs.writeFileSync(
    path.join(__dirname, "field-map.json"),
    JSON.stringify(fieldMap, null, 2)
  );
  console.log("\n✅ scripts/field-map.json に保存しました");
}

main().catch(e => { console.error(e); process.exit(1); });
