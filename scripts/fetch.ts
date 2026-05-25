/**
 * GoCoo 案件データを取得してdocs/data/sales-data.jsonを生成
 * npm run fetch
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getAllPages } from "./gocoo-client.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf-8"));

const DEAL_OBJECT_ID = 5;
const CATEGORIES = ["CoPASS", "CoPASS BPO", "Partner Boost"] as const;
type Category = typeof CATEGORIES[number];

// GoCoo API レスポンス型（フィールドマッピングは実API確認後に調整）
interface RawDeal {
  id: number;
  name: string;
  custom_field_values?: Array<{ field_name: string; value: unknown }>;
  [key: string]: unknown;
}

function extractField(deal: RawDeal, fieldName: string): unknown {
  // custom_field_values 配列形式
  if (deal.custom_field_values) {
    const found = deal.custom_field_values.find(f => f.field_name === fieldName);
    return found?.value ?? null;
  }
  // フラット形式（field_nameがキーになっている場合）
  return deal[fieldName] ?? null;
}

function toNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") return parseFloat(v.replace(/[^\d.]/g, "")) || 0;
  return 0;
}

function toString(v: unknown): string {
  return v != null ? String(v) : "";
}

// 今月の期間（見込み計上月フィルタ）
const now = new Date();
const thisMonthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
const thisMonthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0)
  .toISOString().slice(0, 10);

console.log(`対象月: ${thisMonthStart} 〜 ${thisMonthEnd}`);

// 全案件取得（失注・ペンディング以外）
const allDeals = await getAllPages<RawDeal>(`/custom-objects/${DEAL_OBJECT_ID}/values`);
console.log(`取得件数: ${allDeals.length}件`);

// 今月分フィルタ + 失注除外
const filtered = allDeals.filter(d => {
  const billingMonth = toString(extractField(d, "見込み計上月"));
  if (!billingMonth) return false;
  const phase = toString(extractField(d, "フェーズ"));
  if (phase === "失注" || phase === "ペンディング") return false;
  // 見込み計上月が今月内
  return billingMonth >= thisMonthStart && billingMonth <= thisMonthEnd;
});
console.log(`今月対象: ${filtered.length}件`);

const yomiCoeff: Record<string, number> = CONFIG.yomi_coefficients;
const wonPhases: string[] = CONFIG.won_phases;

// 案件データ整形
const deals = filtered.map(d => {
  const yomi = toString(extractField(d, "ヨミ確度")).split(":")[0] as string;
  const amount = toNumber(extractField(d, "見込み金額（税抜）"));
  const coeff = yomiCoeff[yomi] ?? 0;
  const phase = toString(extractField(d, "フェーズ"));
  const rawCategories = extractField(d, "提案商材");
  const categories: string[] = Array.isArray(rawCategories)
    ? rawCategories.map(String)
    : rawCategories ? [toString(rawCategories)] : [];

  return {
    id: d.id,
    name: d.name,
    company: toString(extractField(d, "企業名")),
    categories: categories.length > 0 ? categories : ["未分類"],
    yomi,
    amount,
    weighted_amount: Math.round(amount * coeff),
    phase,
    is_won: wonPhases.includes(phase),
    billing_month: toString(extractField(d, "見込み計上月")),
    owner: toString(extractField(d, "営業主担当者")),
    next_action: toString(extractField(d, "ネクストアクション")),
  };
});

// カテゴリ別集計
type CategorySummary = {
  target: number;
  yomi_weighted: number;
  actual: number;
  gap: number;
};
const summary: Record<string, CategorySummary> = {};

for (const cat of CATEGORIES) {
  const target = CONFIG.monthly_targets[cat] ?? 0;
  const catDeals = deals.filter(d => d.categories.includes(cat));
  const yomi_weighted = catDeals.reduce((s, d) => s + d.weighted_amount, 0);
  const actual = catDeals.filter(d => d.is_won).reduce((s, d) => s + d.amount, 0);
  summary[cat] = { target, yomi_weighted, actual, gap: yomi_weighted - target };
}

// 合計
const total = {
  target: CATEGORIES.reduce((s, c) => s + (CONFIG.monthly_targets[c] ?? 0), 0),
  yomi_weighted: Object.values(summary).reduce((s, v) => s + v.yomi_weighted, 0),
  actual: Object.values(summary).reduce((s, v) => s + v.actual, 0),
  gap: 0,
};
total.gap = total.yomi_weighted - total.target;

const output = {
  generated_at: new Date().toISOString(),
  month: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`,
  targets: CONFIG.monthly_targets,
  yomi_coefficients: CONFIG.yomi_coefficients,
  categories: CATEGORIES,
  summary,
  total,
  deals,
};

const outPath = path.join(ROOT, "docs", "data", "sales-data.json");
fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
console.log(`✅ ${outPath} を生成しました`);
