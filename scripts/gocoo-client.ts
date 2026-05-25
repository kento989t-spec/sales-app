import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKENS_FILE = path.join(__dirname, ".tokens.json");
const BASE_URL = "https://sfa.salesgo.jp";
const API_BASE = `${BASE_URL}/v1`;

export const CLIENT_ID = "a1d2317b-3927-4143-8b17-0dd8565229fd";
export const CLIENT_SECRET = "fNs1ulqqP27vJBkGeZiPCocGCtT6n3z1YKYxZJgl";

interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

function loadTokens(): Tokens {
  if (!fs.existsSync(TOKENS_FILE)) {
    throw new Error(`トークンファイルが見つかりません。先に "npm run auth" を実行してください: ${TOKENS_FILE}`);
  }
  return JSON.parse(fs.readFileSync(TOKENS_FILE, "utf-8"));
}

function saveTokens(tokens: Tokens) {
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
}

async function refreshAccessToken(refresh_token: string): Promise<Tokens> {
  const res = await fetch(`${BASE_URL}/oauth/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`トークン更新失敗: ${res.status} ${body}`);
  }
  const data = await res.json() as { access_token: string; refresh_token: string; expires_in: number };
  const tokens: Tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in - 60) * 1000,
  };
  saveTokens(tokens);
  return tokens;
}

async function getAccessToken(): Promise<string> {
  let tokens = loadTokens();
  if (Date.now() >= tokens.expires_at) {
    console.log("アクセストークンを更新中...");
    tokens = await refreshAccessToken(tokens.refresh_token);
  }
  return tokens.access_token;
}

export async function apiGet<T>(path: string, params?: Record<string, string | number>): Promise<T> {
  const token = await getAccessToken();
  const url = new URL(`${API_BASE}${path}`);
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  }
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GET ${path} 失敗: ${res.status} ${body}`);
  }
  return res.json() as Promise<T>;
}

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(`${API_BASE}${path}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const body2 = await res.text();
    throw new Error(`PATCH ${path} 失敗: ${res.status} ${body2}`);
  }
  return res.json() as Promise<T>;
}

export async function getAllPages<T>(
  path: string,
  extraParams?: Record<string, string | number>
): Promise<T[]> {
  const results: T[] = [];
  let page = 1;
  while (true) {
    const data = await apiGet<{ data: T[]; meta?: { total_pages?: number; current_page?: number } }>(
      path,
      { page, per_page: 100, ...extraParams }
    );
    results.push(...data.data);
    const meta = data.meta;
    if (!meta || !meta.total_pages || page >= meta.total_pages) break;
    page++;
  }
  return results;
}
