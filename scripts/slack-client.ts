/**
 * Frictio 議事録チャンネルから GoCoo登録_営業 プレイブックのスレッドを読み取り
 * ネクストアクションを抽出する
 *
 * 累積保存方式:
 *   取得結果を slack-tasks-archive.json に永続化し、毎回マージする。
 *   conversations.history の窓（最新N件）から落ちた古いNAも、過去に取得済みなら残り続ける。
 *   shrink-block: 既存archiveから大きく減る書き込みは拒否してログに保存（誤上書き防止）。
 *
 * ロギング:
 *   logs/slack-tasks-fetch.jsonl にfetchごとの before/after/added/removed を記録。
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVE_FILE = path.join(__dirname, "slack-tasks-archive.json");
const LOG_DIR = path.join(__dirname, "..", "logs");
const LOG_FILE = path.join(LOG_DIR, "slack-tasks-fetch.jsonl");
const SHRINK_BLOCK_THRESHOLD = 5;

export interface SlackTask {
  id: string;
  type: "slack";
  owner: string | null;
  company: string | null;
  title: string;
  source_ts: string;
  fetched_at?: string; // 累積保存: 初回取得時刻
}

interface ArchiveShape {
  version: 1;
  tasks: Record<string, SlackTask>; // id -> task
}

function extractBotToken(): string {
  const secretFile = path.join(__dirname, ".slack-secret.json");
  if (fs.existsSync(secretFile)) {
    const secret = JSON.parse(fs.readFileSync(secretFile, "utf-8")) as { slack_bot_token?: string };
    if (secret.slack_bot_token) return secret.slack_bot_token;
  }
  return process.env.SLACK_BOT_TOKEN ?? "";
}

async function slackGet<T>(token: string, method: string, params: Record<string, string>): Promise<T> {
  const url = new URL(`https://slack.com/api/${method}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
  return res.json() as Promise<T>;
}

// Frictio スレッドの構造化フィールドをパース（*フィールド名*\n- 値 の形式）
function parseStructuredFields(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const regex = /\*([^*\n]+)\*\n-\s*([\s\S]*?)(?=\n\*[^*\n]+\*\n|$)/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    fields[m[1].trim()] = m[2].trim();
  }
  return fields;
}

// 親メッセージから担当者名を抽出
function extractOwner(text: string): string | null {
  const m = text.match(/:office_worker:\s+([^\n<>]+)/);
  if (!m) return null;
  return m[1].trim().replace(/\s+/g, " ") || null;
}

function loadArchive(): ArchiveShape {
  try {
    const raw = fs.readFileSync(ARCHIVE_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.tasks && typeof parsed.tasks === "object") return parsed as ArchiveShape;
  } catch {
    /* ファイルなし or 不正 → 空アーカイブで開始 */
  }
  return { version: 1, tasks: {} };
}

function saveArchiveAtomic(arc: ArchiveShape) {
  if (!fs.existsSync(path.dirname(ARCHIVE_FILE))) fs.mkdirSync(path.dirname(ARCHIVE_FILE), { recursive: true });
  const tmp = ARCHIVE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(arc, null, 2), "utf-8");
  fs.renameSync(tmp, ARCHIVE_FILE);
}

function appendLog(entry: Record<string, unknown>) {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n", "utf-8");
}

/**
 * Slackチャンネルから対象スレッドを取得しタスクへ変換。
 * opts.limit: conversations.history の1リクエストあたり取得数 (デフォルト 50)
 * opts.maxPages: 最大何ページpaginateするか (デフォルト 1)
 * opts.oldest: タイムスタンプ(秒.マイクロ秒)、これより古いメッセージは取らない
 */
async function fetchTasksFromSlack(
  token: string,
  channel: string,
  opts: { limit?: number; maxPages?: number; oldest?: string } = {}
): Promise<SlackTask[]> {
  const limit = opts.limit ?? 50;
  const maxPages = opts.maxPages ?? 1;

  const tasks: SlackTask[] = [];
  const fetchedAt = new Date().toISOString();
  let cursor: string | undefined = undefined;

  for (let page = 0; page < maxPages; page++) {
    const params: Record<string, string> = { channel, limit: String(limit) };
    if (cursor) params.cursor = cursor;
    if (opts.oldest) params.oldest = opts.oldest;

    const history = await slackGet<{
      ok: boolean; error?: string;
      messages?: Array<{ ts: string; text: string; reply_count?: number }>;
      response_metadata?: { next_cursor?: string };
    }>(token, "conversations.history", params);

    if (!history.ok) {
      console.warn(`Slack取得スキップ (page ${page + 1}): ${history.error}`);
      break;
    }

    const targetMsgs = (history.messages ?? []).filter(
      m => m.text.includes("GoCoo登録_営業") && (m.reply_count ?? 0) > 0
    );

    for (const msg of targetMsgs) {
      const owner = extractOwner(msg.text);

      const thread = await slackGet<{
        ok: boolean;
        messages?: Array<{ ts: string; text: string }>;
      }>(token, "conversations.replies", { channel, ts: msg.ts });

      if (!thread.ok) continue;

      for (const reply of (thread.messages ?? []).slice(1)) {
        const fields = parseStructuredFields(reply.text);
        const na = fields["ネクストアクション"] ?? "";
        let company: string | null = fields["企業名"] ?? null;
        // 企業名フィールドが空のときに次フィールド見出し(*ヨミ確度* 等)を誤って拾ってしまう既存バグの抑制
        if (company && (company.includes("*") || company.length > 100)) company = null;

        if (!na) continue;

        const naItems = na
          .split(/(?<!\s)-\s+(?=[^\s])/)
          .map(s => s.replace(/^-\s*/, "").trim())
          .filter(s => s.length > 4);

        for (let i = 0; i < naItems.length; i++) {
          tasks.push({
            id: `slack-${msg.ts}-${i}`,
            type: "slack",
            owner,
            company,
            title: naItems[i],
            source_ts: msg.ts,
            fetched_at: fetchedAt,
          });
        }
        break;
      }
    }

    cursor = history.response_metadata?.next_cursor;
    if (!cursor) break;
  }

  return tasks;
}

export async function fetchSlackTasks(
  config: { slack_minutes_channel?: string },
  opts: { limit?: number; maxPages?: number; oldest?: string } = {}
): Promise<SlackTask[]> {
  const token = extractBotToken();
  const channel = config.slack_minutes_channel ?? "";
  if (!token || !channel) {
    appendLog({ op: "fetch", result: "skip:no-token-or-channel" });
    // archiveが既にあれば、それを返す（接続失敗で空にしない）
    const arc = loadArchive();
    return Object.values(arc.tasks);
  }

  const archive = loadArchive();
  const before = Object.keys(archive.tasks).length;

  let fetched: SlackTask[] = [];
  try {
    fetched = await fetchTasksFromSlack(token, channel, opts);
  } catch (e) {
    console.warn("Slack取得失敗（archiveを維持）:", e);
    appendLog({ op: "fetch", result: "error:exception", error: String(e), archiveSize: before });
    return Object.values(archive.tasks);
  }

  // マージ: 同IDがあれば上書き、なければ追加。既存ID は削除しない（過去NAを保持）
  let added = 0;
  let updated = 0;
  for (const t of fetched) {
    const existed = archive.tasks[t.id];
    if (!existed) {
      // 新規 → fetched_at は今回時刻のまま
      archive.tasks[t.id] = t;
      added++;
    } else {
      // 既存 → 内容差分があれば更新（fetched_atは元のまま保持）
      const merged = { ...t, fetched_at: existed.fetched_at ?? t.fetched_at };
      if (JSON.stringify(existed) !== JSON.stringify(merged)) {
        archive.tasks[t.id] = merged;
        updated++;
      }
    }
  }

  const after = Object.keys(archive.tasks).length;
  const removed = Math.max(0, before - after);

  // 防御: 大幅縮小は拒否（マージ加算前提なので通常発生しないが念のため）
  if (removed >= SHRINK_BLOCK_THRESHOLD) {
    appendLog({
      op: "fetch",
      result: "shrink-blocked",
      before, after, removed, added, updated,
      fetchedCount: fetched.length,
    });
    console.warn(`[slack-archive] shrink blocked: before=${before} after=${after} → archiveを維持`);
    return Object.values(loadArchive().tasks);
  }

  try {
    saveArchiveAtomic(archive);
  } catch (e) {
    appendLog({ op: "save", result: "error", error: String(e), before, after });
    console.warn("Slack archive保存失敗:", e);
  }

  appendLog({
    op: "fetch",
    result: "ok",
    before, after, added, updated, removed,
    fetchedCount: fetched.length,
    limit: opts.limit ?? 50,
    maxPages: opts.maxPages ?? 1,
    oldest: opts.oldest,
  });

  return Object.values(archive.tasks);
}
