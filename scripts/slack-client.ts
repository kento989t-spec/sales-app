import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface SlackTask {
  id: string;
  type: "slack";
  owner: string | null;
  title: string;
  source_ts: string;
  raw: string;
}

interface SlackMessage {
  ts: string;
  text: string;
}

interface SlackHistoryResponse {
  ok: boolean;
  messages?: SlackMessage[];
  error?: string;
}

function extractBotToken(): string {
  const secretFile = path.join(__dirname, ".slack-secret.json");
  if (fs.existsSync(secretFile)) {
    const secret = JSON.parse(fs.readFileSync(secretFile, "utf-8")) as { slack_bot_token?: string };
    if (secret.slack_bot_token) return secret.slack_bot_token;
  }
  return process.env.SLACK_BOT_TOKEN ?? "";
}

export async function fetchSlackTasks(config: {
  slack_minutes_channel?: string;
  slack_na_patterns?: string[];
}): Promise<SlackTask[]> {
  const token = extractBotToken();
  const channel = config.slack_minutes_channel ?? "";
  const patterns = config.slack_na_patterns ?? ["NA:", "ネクストアクション:"];

  if (!token || !channel) return [];

  try {
    const url = `https://slack.com/api/conversations.history?channel=${encodeURIComponent(channel)}&limit=50`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json() as SlackHistoryResponse;

    if (!data.ok || !data.messages) {
      console.warn(`Slack取得スキップ: ${data.error ?? "unknown error"}`);
      return [];
    }

    const tasks: SlackTask[] = [];
    for (const msg of data.messages) {
      const lines = msg.text.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!patterns.some(p => trimmed.includes(p))) continue;
        // @mention または [名前] から担当者抽出
        const ownerMatch = trimmed.match(/<@[A-Z0-9]+>\s*([^\s:：]+)|【([^】]+)】|\[([^\]]+)\]/);
        const owner = ownerMatch
          ? (ownerMatch[1] ?? ownerMatch[2] ?? ownerMatch[3] ?? null)
          : null;
        tasks.push({
          id: `slack-${msg.ts}-${tasks.length}`,
          type: "slack",
          owner,
          title: trimmed,
          source_ts: msg.ts,
          raw: trimmed,
        });
      }
    }
    return tasks;
  } catch (e) {
    console.warn("Slack取得失敗（スキップ）:", e);
    return [];
  }
}
