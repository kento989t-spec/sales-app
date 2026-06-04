/**
 * GoCoo カスタムオブジェクトの全レコード・全項目を CSV 出力する
 *
 * 使い方:
 *   npx tsx scripts/export-csv.ts                 # 企業・個人・案件を出力
 *   npx tsx scripts/export-csv.ts 2 4 5 11        # オブジェクトIDを明示指定
 *
 * 出力先: ~/.company/_workspace/gocoo-export/<オブジェクト名>.csv
 * 文字コード: UTF-8 (BOM付き) ＝ Excel で文字化けしない
 */
import fs from "fs";
import path from "path";
import os from "os";
import { apiGet, getAllPages } from "./gocoo-client.ts";

interface Field {
  field_name: string;
  display_name: string;
  field_type: string;
}
interface FieldsResponse {
  fields: Field[];
}
interface FieldValue {
  display_name: string;
  value: unknown;
  formatted_value: string;
}
interface Record_ {
  id: number;
  [key: string]: unknown;
}

// 既定の対象オブジェクト（id=名前）
const DEFAULT_OBJECTS: Record<number, string> = {
  2: "企業",
  4: "個人",
  5: "案件",
};

const OUT_DIR = path.join(os.homedir(), ".company", "_workspace", "gocoo-export");

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  // ダブルクォート・カンマ・改行を含む場合はクォートで囲む
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function cellValue(rec: Record_, field: Field): string {
  const fv = rec[field.field_name] as FieldValue | undefined;
  if (fv == null) return "";
  // 表示用の整形値を優先。なければ生値を文字列化
  if (fv.formatted_value != null && fv.formatted_value !== "") return fv.formatted_value;
  if (fv.value == null) return "";
  if (typeof fv.value === "object") return JSON.stringify(fv.value);
  return String(fv.value);
}

async function exportObject(objectId: number, name: string): Promise<void> {
  const fieldsRes = await apiGet<FieldsResponse>(`/custom-objects/${objectId}/fields`);
  const fields = fieldsRes.fields;
  const records = await getAllPages<Record_>(`/custom-objects/${objectId}/values`);

  // ヘッダ: id + 各フィールドの表示名
  const header = ["id", ...fields.map(f => f.display_name)];
  const lines = [header.map(csvCell).join(",")];
  for (const rec of records) {
    const row = [String(rec.id), ...fields.map(f => cellValue(rec, f))];
    lines.push(row.map(csvCell).join(","));
  }

  const outPath = path.join(OUT_DIR, `${name}.csv`);
  // BOM付きUTF-8（Excel対策）
  fs.writeFileSync(outPath, "﻿" + lines.join("\r\n") + "\r\n", "utf8");
  console.log(`✅ ${name}: ${records.length}件 / ${fields.length}項目 → ${outPath}`);
}

async function main() {
  const argIds = process.argv.slice(2).map(Number).filter(n => !Number.isNaN(n));
  fs.mkdirSync(OUT_DIR, { recursive: true });

  let targets: Array<[number, string]>;
  if (argIds.length > 0) {
    // 名前はオブジェクト一覧から引く
    const list = await apiGet<{ "custom-objects": Array<{ id: number; name: string }> }>("/custom-objects");
    const byId = new Map(list["custom-objects"].map(o => [o.id, o.name]));
    targets = argIds.map(id => [id, byId.get(id) ?? `object-${id}`]);
  } else {
    targets = Object.entries(DEFAULT_OBJECTS).map(([id, n]) => [Number(id), n]);
  }

  for (const [id, name] of targets) {
    await exportObject(id, name);
  }
  console.log(`\n出力先フォルダ: ${OUT_DIR}`);
}

main().catch(e => { console.error(e); process.exit(1); });
