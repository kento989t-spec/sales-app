/**
 * コミット表 I列(NAアクション日) / J列(NA) → GoCoo next_action / next_action_date 一括移行
 * npm run tsx scripts/migrate-na.ts
 */
import { getAllPages, apiPatch } from "./gocoo-client.ts";

const DEAL_OBJECT_ID = 5;
const F_NEXT_ACTION      = "field_2b2fbca9-15f1-43b7-9ad6-516d48904c4a";
const F_NEXT_ACTION_DATE = "field_ad8208e4-0e79-4ba8-88f3-773e20aa4fb6";

// スプレッドシートから取得した I列・J列データ（会社名 / NAアクション日 / NA内容）
const SHEET_DATA = [
  { company: "株式会社ヒッツカンパニー",          date: "2026-06-01", na: "6月初旬キックオフ" },
  { company: "ジェイズ・コミュニケーション株式会社", date: "2026-06-19", na: "6/19　社内稟議状況の確認" },
  { company: "百年計画株式会社",                  date: "2026-08-03", na: "8月頃に連絡" },
  { company: "株式会社サイバーセキュリティクラウド", date: "2026-05-26", na: "電話/メール" },
  { company: "STARUP",                           date: "2026-05-26", na: "電話" },
  { company: "DDR",                              date: "2026-09-07", na: "新製品リリース発表確認後再度ナーチャリング" },
  { company: "株式会社AI shift",                  date: "2026-05-28", na: "ケビンさん：契約書の巻き取り / 佐竹：キックオフ資料作り" },
  { company: "シャープエネルギーソリューションズ", date: "2026-06-01", na: "次回商談日入力督促" },
  { company: "AI inside",                        date: "2026-06-01", na: "社内会議状況の確認" },
  { company: "株式会社タイムワールド",             date: "2026-05-26", na: "岡本さんに契約締結までの期限切りTEL" },
  { company: "マクロズ",                          date: "2026-06-25", na: "定期フォロー / 先方の方で子会社設立後判断が可能に" },
  { company: "Hubble",                           date: "2026-06-03", na: "先方の温度感・予算状況確認" },
  { company: "イトーキ",                          date: "2026-05-28", na: "メール/電話（所感確認）" },
  { company: "ファイナンシャルスタンダード",        date: "2026-05-27", na: "検証状況確認、追加活用事例共有" },
  { company: "FAST BPO",                         date: "2026-05-28", na: "Paidの請求金額入力" },
  { company: "ボルテックス",                      date: "2026-06-01", na: "今後の進め方の合意（次回の営業責任者プレゼン、支援詳細詰めのアポとり）" },
  { company: "ベルシステム",                      date: "2026-06-02", na: "クライアントへの説明結果の確認" },
  { company: "PROLEXT",                          date: "2026-06-03", na: "キックオフMTG" },
  { company: "scene live",                       date: "2026-06-01", na: "フォロー連絡" },
  { company: "LOOV",                             date: "2026-05-27", na: "ケビンさんより提案書送付" },
  { company: "理想科学",                          date: "2026-05-28", na: "先方へ要件すり合わせの商談" },
  { company: "UNNAMED SERVICE",                  date: "2026-06-01", na: "先方へのリマインド連絡" },
  { company: "最適でんき",                        date: "2026-06-01", na: "6月1日契約" },
  { company: "ライフアップ",                      date: "2026-05-26", na: "社内展開いつ頃になるか確認連絡" },
  { company: "ICA",                              date: "2026-05-26", na: "見積もり検討状況確認" },
  { company: "i-plug",                           date: "2026-06-03", na: "NDA確認（先方ボール督促）" },
  { company: "ユイコモンズ",                      date: "2026-07-01", na: "7月から本格始動に向け再度提案" },
  { company: "キョウエイアド",                    date: "2026-05-27", na: "CoPASS運用に関しての提案内容整理" },
  { company: "南陽吉久",                          date: "2026-05-25", na: "日程調整の追いかけ / デモ環境発行 ＋ デモ会" },
  { company: "ブレス",                            date: "2026-06-04", na: "会食" },
  { company: "スターティア（CoPASS）",             date: "2026-05-28", na: "デモ環境発行追いかけ連絡 / 6月上旬に方向性決定追いかけ" },
  { company: "インクレイブ",                      date: "2026-06-03", na: "商談" },
  { company: "ナビタイムジャパン",                 date: "2026-05-27", na: "2回目商談" },
  // スターティア(BPO)は計上月5月・佐竹担当
  { company: "スターティア（BPO）",               date: "2026-06-17", na: "CoPASSを進めていく中で個出しして定期的にフォロー" },
];

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

function getField(deal: RawDeal, key: string): FieldValue | null {
  return (deal[key] as FieldValue) ?? null;
}

const COMPANY_FIELD = "field_a860ea33-f028-4d7e-9180-120baa01d84b";

function normalize(s: string): string {
  return s.replace(/[\s　株式会社（）()]/g, "").toLowerCase();
}

async function main() {
  console.log("GoCoo全案件取得中...");
  const allRaw = await getAllPages<RawDeal>(`/custom-objects/${DEAL_OBJECT_ID}/values`);
  console.log(`取得: ${allRaw.length}件`);

  // 会社名 → deal[] のマップ
  const dealsByCompany = new Map<string, RawDeal[]>();
  for (const d of allRaw) {
    const company = getField(d, COMPANY_FIELD)?.formatted_value ?? String(d.name ?? "");
    const key = normalize(company);
    if (!dealsByCompany.has(key)) dealsByCompany.set(key, []);
    dealsByCompany.get(key)!.push(d);
  }

  let updated = 0, skipped = 0, notFound = 0;

  for (const row of SHEET_DATA) {
    // スターティアは社名から（BPO）（CoPASS）を除いてマッチ
    const searchName = row.company.replace(/（BPO）|（CoPASS）/, "");
    const key = normalize(searchName);

    // 部分マッチ検索
    let matches: RawDeal[] = dealsByCompany.get(key) ?? [];
    if (matches.length === 0) {
      // 部分一致フォールバック
      for (const [k, v] of dealsByCompany) {
        if (k.includes(key) || key.includes(k)) {
          matches = v;
          break;
        }
      }
    }

    if (matches.length === 0) {
      console.log(`❌ 未マッチ: ${row.company}`);
      notFound++;
      continue;
    }

    // スターティアのみ billing_month で絞り込み（5月=BPO / 6月=CoPASS）
    let target = matches[0];
    if (matches.length > 1 && row.company.includes("スターティア")) {
      const isBPO = row.company.includes("BPO");
      const billing_field = "field_d8fd26b2-a857-450b-9f93-9cd44d0bb811";
      const bpo = matches.find(d => {
        const bm = String(getField(d, billing_field)?.value ?? "");
        return isBPO ? bm.startsWith("2026-05") : bm.startsWith("2026-06");
      });
      if (bpo) target = bpo;
    }

    const currentNA = String(getField(target, F_NEXT_ACTION)?.value ?? "").trim();
    const newNA = row.na.trim();

    if (currentNA === newNA) {
      console.log(`✅ スキップ（変更なし）: ${row.company}`);
      skipped++;
      continue;
    }

    console.log(`📝 更新: ${row.company} (ID=${target.id})`);
    console.log(`   NA: "${currentNA}" → "${newNA}"`);
    console.log(`   日付: ${row.date}`);

    await apiPatch(`/custom-objects/${DEAL_OBJECT_ID}/values/${target.id}`, {
      [F_NEXT_ACTION]:      newNA,
      [F_NEXT_ACTION_DATE]: row.date,
    });
    updated++;

    await new Promise(r => setTimeout(r, 300)); // rate limit
  }

  console.log(`\n完了: ${updated}件更新 / ${skipped}件スキップ / ${notFound}件未マッチ`);
}

main().catch(e => { console.error(e); process.exit(1); });
