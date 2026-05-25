/**
 * GoCoo 案件データを取得してdocs/data/sales-data.jsonを生成
 * npm run fetch
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { webcrypto } from "crypto";
import { getAllPages } from "./gocoo-client.ts";
import { fetchSlackTasks } from "./slack-client.ts";

const crypto = webcrypto as unknown as Crypto;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf-8"));

const DEAL_OBJECT_ID = 5;
const CATEGORIES = ["CoPASS", "CoPASS BPO", "Partner Boost"] as const;

// フィールドUUID定数
const F = {
  YOMI:        "field_ed6f5306-135c-4105-a915-17e554dc5be2",
  CATEGORIES:  "field_00c5a3dc-ea3e-4a19-84b2-d50dd44dcad0",
  AMOUNT:      "field_76f2b2f7-af26-44bc-a4db-7817c1a07dcc",
  BILLING:     "field_d8fd26b2-a857-450b-9f93-9cd44d0bb811",
  OWNER:       "field_8fbb7b46-95c0-4268-833a-f65e9a8d09da",
  COMPANY:     "field_a860ea33-f028-4d7e-9180-120baa01d84b",
  NEXT_ACTION: "field_2b2fbca9-15f1-43b7-9ad6-516d48904c4a",
};

interface FieldValue {
  display_name: string;
  value: unknown;
  formatted_value: string;
}

interface RawDeal {
  id: number;
  name: unknown;
  path_id?: FieldValue;
  [key: string]: unknown;
}

function getField(deal: RawDeal, fieldKey: string): FieldValue | null {
  return (deal[fieldKey] as FieldValue) ?? null;
}

function toNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") return parseFloat(v.replace(/[^\d.]/g, "")) || 0;
  return 0;
}

const now = new Date();
const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
const thisMonthStart = `${currentMonth}-01`;
const thisMonthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0)
  .toISOString().slice(0, 10);

console.log(`対象月: ${thisMonthStart} 〜 ${thisMonthEnd}`);

const yomiCoeff: Record<string, number> = CONFIG.yomi_coefficients;

// 案件を整形する共通関数
function mapDeal(d: RawDeal) {
  const rawName = d.name as unknown;
  const dealName = typeof rawName === "object" && rawName !== null
    ? ((rawName as FieldValue).formatted_value ?? (rawName as FieldValue).value as string)
    : String(rawName ?? "");

  const yomiRaw = getField(d, F.YOMI)?.formatted_value ?? "";
  const yomi = yomiRaw.charAt(0).match(/[A-D]/) ? yomiRaw.charAt(0) : "";

  const amount = toNumber(getField(d, F.AMOUNT)?.value);
  const coeff = yomi ? (yomiCoeff[yomi] ?? 0) : 0;

  const phase = d.path_id?.formatted_value ?? "";
  const isWon = phase.includes("CS-");

  const catRaw = getField(d, F.CATEGORIES)?.value;
  const categories: string[] = Array.isArray(catRaw)
    ? (catRaw as Array<{ name: string }>).map(c => c.name)
    : [];

  const billingVal = (getField(d, F.BILLING)?.value as string) ?? "";

  return {
    id: d.id,
    name: dealName,
    company: getField(d, F.COMPANY)?.formatted_value ?? dealName,
    categories: categories.length > 0 ? categories : ["未分類"],
    yomi,
    amount,
    weighted_amount: Math.round(amount * coeff),
    phase,
    path_id_raw: (d.path_id?.value as number) ?? null,
    is_won: isWon,
    billing_month: billingVal,
    owner: getField(d, F.OWNER)?.formatted_value ?? "",
    next_action: (getField(d, F.NEXT_ACTION)?.value as string) ?? "",
    updated_at: (d.updated_at as FieldValue)?.value as string ?? "",
  };
}

async function main() {
  // 全件取得
  const allRaw = await getAllPages<RawDeal>(`/custom-objects/${DEAL_OBJECT_ID}/values`);
  console.log(`取得件数: ${allRaw.length}件`);

  // アクティブ案件（失注・ペンディング除外）
  const allActive = allRaw.filter(d => {
    const phase = d.path_id?.formatted_value ?? "";
    return !phase.includes("失注") && !phase.includes("ペンディング");
  });

  // 全アクティブ案件を整形
  const allDeals = allActive.map(mapDeal);
  console.log(`アクティブ件数: ${allDeals.length}件`);

  // 今月分
  const deals = allDeals.filter(d =>
    d.billing_month >= thisMonthStart && d.billing_month <= thisMonthEnd
  );
  console.log(`今月対象: ${deals.length}件`);

  // カテゴリ別集計（今月分ベース）
  type CategorySummary = { target: number; yomi_weighted: number; actual: number; gap: number };
  const summary: Record<string, CategorySummary> = {};

  for (const cat of CATEGORIES) {
    const target = CONFIG.monthly_targets[cat] ?? 0;
    const catDeals = deals.filter(d => d.categories.includes(cat));
    const yomi_weighted = catDeals.reduce((s, d) => s + d.weighted_amount, 0);
    const actual = catDeals.filter(d => d.is_won).reduce((s, d) => s + d.amount, 0);
    summary[cat] = { target, yomi_weighted, actual, gap: yomi_weighted - target };
  }

  const total = {
    target: CATEGORIES.reduce((s, c) => s + (CONFIG.monthly_targets[c] ?? 0), 0),
    yomi_weighted: Object.values(summary).reduce((s, v) => s + v.yomi_weighted, 0),
    actual: Object.values(summary).reduce((s, v) => s + v.actual, 0),
    gap: 0,
  };
  total.gap = total.yomi_weighted - total.target;

  // ===== タスク集約 =====

  // 定常タスク
  const standingTasks = ((CONFIG.standing_tasks ?? []) as string[]).map((title, i) => ({
    id: `standing-${i}`,
    type: "standing" as const,
    title,
    owner: null as string | null,
  }));

  // GoCoo Next Action
  const naTasks = allDeals
    .filter(d => d.next_action && d.next_action.trim().length > 0)
    .map(d => ({
      id: `na-${d.id}`,
      type: "next_action" as const,
      owner: d.owner,
      company: d.company,
      deal_name: d.name,
      next_action: d.next_action,
      phase: d.phase,
      yomi: d.yomi,
    }));

  // 管理対象会社一覧（タスク管理の起点として全案件会社を列挙）
  const seenCompanies = new Set<string>();
  const dealCompanies = allDeals
    .filter(d => {
      if (!d.company || seenCompanies.has(d.company)) return false;
      seenCompanies.add(d.company);
      return true;
    })
    .map(d => ({
      company: d.company,
      owner: d.owner,
      yomi: d.yomi,
      billing_month: d.billing_month,
      updated_at: d.updated_at ?? "",
    }));

  // Slack議事録
  console.log("Slackタスク取得中...");
  const slackTasks = await fetchSlackTasks(CONFIG);
  console.log(`Slackタスク: ${slackTasks.length}件`);

  // ===== 出力 =====
  const output = {
    generated_at: new Date().toISOString(),
    month: currentMonth,
    targets: CONFIG.monthly_targets,
    yomi_coefficients: CONFIG.yomi_coefficients,
    categories: [...CATEGORIES],
    summary,
    total,
    deals,
    all_deals: allDeals,
    tasks: {
      standing: standingTasks,
      next_action: naTasks,
      slack: slackTasks,
      deal_companies: dealCompanies,
    },
  };

  const outPath = path.join(ROOT, "docs", "data", "sales-data.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const password = CONFIG.password as string | undefined;

  if (password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const keyMaterial = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]
    );
    const key = await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt"]
    );
    const plaintext = new TextEncoder().encode(JSON.stringify(output));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);

    const toHex = (buf: ArrayBuffer) =>
      [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");

    const encrypted = {
      encrypted: true,
      salt: toHex(salt.buffer),
      iv: toHex(iv.buffer),
      ciphertext: toHex(ciphertext),
    };
    fs.writeFileSync(outPath, JSON.stringify(encrypted));
    console.log(`✅ ${outPath} を暗号化して生成しました`);
  } else {
    fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
    console.log(`✅ ${outPath} を生成しました（非暗号化モード）`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
