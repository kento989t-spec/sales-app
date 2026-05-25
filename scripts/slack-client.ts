/**
 * Frictio 議事録チャンネルから GoCoo登録_営業 プレイブックのスレッドを読み取り
 * ネクストアクションを抽出する
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface SlackTask {
  id: string;
  type: "slack";
  owner: string | null;
  company: string | null;
  title: string;
  source_ts: string;
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

export async function fetchSlackTasks(config: {
  slack_minutes_channel?: string;
}): Promise<SlackTask[]> {
  const token = extractBotToken();
  const channel = config.slack_minutes_channel ?? "";
  if (!token || !channel) return [];

  try {
    const history = await slackGet<{
      ok: boolean; error?: string;
      messages?: Array<{ ts: string; text: string; reply_count?: number }>;
    }>(token, "conversations.history", { channel, limit: "50" });

    if (!history.ok) {
      console.warn(`Slack取得スキップ: ${history.error}`);
      return [];
    }

    const tasks: SlackTask[] = [];

    // GoCoo登録_営業 プレイブックのメッセージのみ対象
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
        const company = fields["企業名"] ?? null;

        if (!na) continue;

        // "- テキスト- テキスト" 形式を個別タスクに分割
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
          });
        }
        break;
      }
    }

    return tasks;
  } catch (e) {
    console.warn("Slack取得失敗（スキップ）:", e);
    return [];
  }
}
