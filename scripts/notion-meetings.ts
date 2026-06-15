/**
 * カレンダー→Notion議事録 自動作成のログ（~/.company/operations/logs/slack-posted-events.json）から
 * 「企業名 → Notion議事録ページ」のマップを生成する。
 *
 * 対象は現状カレンダーから自動作成している議事録（page_id を持つもの）のみ。
 * 過去案件・手動作成の古い議事録はこのログに乗らないため対象外（別途対応）。
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HOME = process.env.HOME || "/Users/knt";
const LOG_FILE = path.join(HOME, ".company/operations/logs/slack-posted-events.json");
// 過去分の一括スナップショット（Notion「顧客アポ_議事」DBをタイトルからパースして生成）。
// 今後の新規分はカレンダー自動作成ログに乗るため、このアーカイブは過去分の補完用。
const ARCHIVE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "notion-meetings-archive.json");

export interface NotionMeeting {
  date: string; // YYYY-MM-DD
  url: string;
  page_id: string;
}

interface PostedEvent {
  company?: string;
  event_date?: string;
  notion_page_id?: string | null;
  notion_url?: string | null;
}

/** page_id（ダッシュ有無どちらでも）から Notion ページURLを生成 */
function pageUrl(pageId: string): string {
  return `https://www.notion.so/${pageId.replace(/-/g, "")}`;
}

/** 企業名を表記揺れ吸収のため正規化（マッチングキー用） */
export function normalizeCompany(raw: string): string {
  if (!raw) return "";
  let s = raw;
  // 全角英数→半角、空白除去
  s = s.replace(/[Ａ-Ｚａ-ｚ０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  s = s.replace(/\s+/g, "");
  // 法人格・敬称トークンを除去
  s = s.replace(/(株式会社|有限会社|合同会社|合名会社|合資会社|一般社団法人|一般財団法人|公益社団法人|公益財団法人|特定非営利活動法人|\(株\)|（株）|\(有\)|（有）)/g, "");
  s = s.replace(/様$/g, "");
  return s.toLowerCase();
}

/** 判別不能・要確認系の社名（マッチング対象外） */
function isUnresolved(name: string): boolean {
  return /判別|UNNAMED|困難|要社名|面談・判別/.test(name);
}

/**
 * 正規化社名キー → 議事録リスト（日付降順）のマップを返す。
 * 同一ページの重複は除外。
 */
export function loadMeetingMap(): Map<string, NotionMeeting[]> {
  const map = new Map<string, NotionMeeting[]>();
  if (!fs.existsSync(LOG_FILE)) {
    console.warn(`議事録ログが見つかりません（スキップ）: ${LOG_FILE}`);
    return map;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(LOG_FILE, "utf-8"));
  } catch (e) {
    console.warn("議事録ログのパース失敗（スキップ）:", e);
    return map;
  }

  const items: PostedEvent[] = Array.isArray(parsed)
    ? (parsed as PostedEvent[])
    : Object.values(parsed as Record<string, PostedEvent>);

  for (const e of items) {
    const company = (e.company ?? "").trim();
    const pageId = e.notion_page_id;
    if (!company || !pageId || isUnresolved(company)) continue;

    const key = normalizeCompany(company);
    if (!key) continue;

    const meeting: NotionMeeting = {
      date: e.event_date ?? "",
      url: e.notion_url || pageUrl(pageId),
      page_id: pageId,
    };

    if (!map.has(key)) map.set(key, []);
    const list = map.get(key)!;
    if (list.some(m => m.page_id === meeting.page_id)) continue; // 同一ページ重複除外
    list.push(meeting);
  }

  // 過去分アーカイブをマージ（page_id 重複は除外）
  mergeArchive(map);

  // 各社内を日付降順ソート
  for (const list of map.values()) {
    list.sort((a, b) => b.date.localeCompare(a.date));
  }
  return map;
}

/** 過去分スナップショット（notion-meetings-archive.json）を既存マップに追記する */
function mergeArchive(map: Map<string, NotionMeeting[]>): void {
  if (!fs.existsSync(ARCHIVE_FILE)) return;
  let archive: Record<string, NotionMeeting[]>;
  try {
    archive = JSON.parse(fs.readFileSync(ARCHIVE_FILE, "utf-8"));
  } catch (e) {
    console.warn("議事録アーカイブのパース失敗（スキップ）:", e);
    return;
  }
  for (const [key, meetings] of Object.entries(archive)) {
    if (!key || !Array.isArray(meetings)) continue;
    if (!map.has(key)) map.set(key, []);
    const list = map.get(key)!;
    for (const m of meetings) {
      if (!m?.page_id || list.some(x => x.page_id === m.page_id)) continue;
      list.push({ date: m.date ?? "", url: m.url || `https://www.notion.so/${m.page_id.replace(/-/g, "")}`, page_id: m.page_id });
    }
  }
}
