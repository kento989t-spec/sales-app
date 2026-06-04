import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKENS_FILE = path.join(__dirname, ".tokens.json");
export const TENANT_BASE = "https://deex.sfa.salesgo.jp/organizations/deex";
export const OAUTH_BASE = "https://sfa.salesgo.jp";
const API_BASE = "https://sfa.salesgo.jp/api/v1";

export const CLIENT_ID = "a1d2317b-3927-4143-8b17-0dd8565229fd";       // Webアプリ（未使用）
export const CLIENT_SECRET = "fNs1ulqqP27vJBkGeZiPCocGCtT6n3z1YKYxZJgl"; // Webアプリ（未使用）
export const NATIVE_CLIENT_ID = "a1dc4943-903c-4f50-9cec-c46f24e62eaf";  // ネイティブアプリ（PKCE）

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
  const saved = loadTokens();
  const clientId = (saved as { client_id?: string }).client_id ?? NATIVE_CLIENT_ID;
  const res = await fetch(`${OAUTH_BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token,
      client_id: clientId,
    }).toString(),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`トークン更新失敗: ${res.status} ${body}`);
  }
  const data = await res.json() as { access_token: string; refresh_token: string; expires_in: number };
  const refreshed: Tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in - 60) * 1000,
    ...(saved as { client_id?: string }).client_id ? { client_id: (saved as { client_id?: string }).client_id } : {},
  };
  saveTokens(refreshed);
  // GitHub Actions との競合防止: Mac Mini でトークンが更新されたら GitHub Secret も同期
  try {
    const { execSync } = await import("child_process");
    execSync(
      `printf '%s' '${refreshed.refresh_token}' | gh secret set GOCOO_REFRESH_TOKEN --repo kento989t-spec/sales-app`,
      { stdio: "pipe" }
    );
  } catch { /* gh CLI 未認証環境（CI等）では無視 */ }
  return refreshed;
}

async function getAccessToken(): Promise<string> {
  let tokens = loadTokens();
  if (Date.now() >= tokens.expires_at) {
    console.log("アクセストークンを更新中...");
    tokens = await refreshAccessToken(tokens.refresh_token);
  }
  return tokens.access_token;
}

async function fetchWithTokenRetry(
  url: string,
  init: RequestInit,
  isRetry = false
): Promise<Response> {
  const res = await fetch(url, init);
  if (res.status === 401 && !isRetry) {
    // access_token が期限切れ → 強制リフレッシュして1回リトライ
    const tokens = loadTokens();
    const refreshed = await refreshAccessToken(tokens.refresh_token);
    const newInit = {
      ...init,
      headers: {
        ...(init.headers as Record<string, string>),
        Authorization: `Bearer ${refreshed.access_token}`,
      },
    };
    return fetchWithTokenRetry(url, newInit, true);
  }
  return res;
}

export async function apiGet<T>(path: string, params?: Record<string, string | number>): Promise<T> {
  const token = await getAccessToken();
  const url = new URL(`${API_BASE}${path}`);
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  }
  const res = await fetchWithTokenRetry(url.toString(), {
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
  const res = await fetchWithTokenRetry(`${API_BASE}${path}`, {
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

// GoCoo API のレスポンス型（records / fields / paths キーで返る）
interface GoCooPagedResponse<T> {
  records?: T[];
  fields?: T[];
  paths?: T[];
  results: { next_page_url: string | null; per_page: number; total: number };
}

export async function getAllPages<T>(
  path: string,
  extraParams?: Record<string, string | number>
): Promise<T[]> {
  const items: T[] = [];
  let page = 1;
  while (true) {
    const data = await apiGet<GoCooPagedResponse<T>>(path, { page, per_page: 100, ...extraParams });
    const chunk = data.records ?? data.fields ?? data.paths ?? [];
    items.push(...(chunk as T[]));
    if (!data.results.next_page_url) break;
    page++;
  }
  return items;
}
