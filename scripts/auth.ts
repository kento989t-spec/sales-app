/**
 * GoCoo OAuth 認証セットアップ（初回のみ実行）
 * npm run auth
 */
import fs from "fs";
import path from "path";
import readline from "readline";
import { exec } from "child_process";
import { fileURLToPath } from "url";
import { CLIENT_ID, CLIENT_SECRET, TENANT_BASE, OAUTH_BASE } from "./gocoo-client.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKENS_FILE = path.join(__dirname, ".tokens.json");

const REDIRECT_URI = "http://localhost:3456/callback";
const AUTH_URL = `${OAUTH_BASE}/oauth/authorize`;
const TOKEN_URL = `${OAUTH_BASE}/oauth/token`;

async function main() {
  const authorizeUrl = new URL(AUTH_URL);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", CLIENT_ID);
  authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);

  console.log("\n========================================");
  console.log("GoCoo 認証セットアップ");
  console.log("========================================");
  console.log("\n1. 以下のURLをブラウザで開いてGoCooにログインしてください:");
  console.log("\n" + authorizeUrl.toString() + "\n");
  exec(`open "${authorizeUrl.toString()}"`);

  console.log("2. ログイン後、ブラウザのアドレスバーに表示されるURL全体を");
  console.log("   コピーしてここに貼り付けてください:");
  console.log("   (例: http://localhost:3456/callback?code=XXXXXXXX)\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const redirectUrl = await new Promise<string>(resolve => {
    rl.question("リダイレクトURL: ", answer => {
      rl.close();
      resolve(answer.trim());
    });
  });

  let code: string;
  try {
    const parsed = new URL(redirectUrl);

    // GoCooが認可段階でエラーを返した場合
    const err = parsed.searchParams.get("error");
    if (err) {
      const desc = parsed.searchParams.get("error_description") ?? "";
      console.error(`\n❌ GoCoo認可エラー: ${err}`);
      console.error(`   詳細: ${desc}`);
      console.error("\n考えられる原因:");
      console.error("  - GoCooのOAuthアプリ設定でリダイレクトURIが未登録");
      console.error("  - client_idが無効または承認待ち");
      console.error("  - このOAuthアプリがGoCooで有効化されていない");
      process.exit(1);
    }

    const c = parsed.searchParams.get("code");
    if (!c) {
      console.error("URLにcodeパラメータがありません。貼り付けたURL:", redirectUrl);
      process.exit(1);
    }
    code = c;
    console.log("  コード取得: OK");
  } catch (e) {
    console.error("URLの解析に失敗しました:", e);
    process.exit(1);
  }

  console.log("\n3. 認証コード取得成功。アクセストークンを取得中...");

  // 試すURL × フォーマットの組み合わせ
  const GLOBAL_TOKEN_URL = TOKEN_URL;
  const TENANT_TOKEN_URL = `${TENANT_BASE}/oauth/token`;

  type Attempt = { url: string; label: string; req: RequestInit };
  const attempts: Attempt[] = [
    {
      label: "テナントURL + form + body credentials",
      url: TENANT_TOKEN_URL,
      req: {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: REDIRECT_URI }).toString(),
      },
    },
    {
      label: "グローバルURL + form + body credentials",
      url: GLOBAL_TOKEN_URL,
      req: {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: REDIRECT_URI }).toString(),
      },
    },
    {
      label: "テナントURL + JSON",
      url: TENANT_TOKEN_URL,
      req: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grant_type: "authorization_code", code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: REDIRECT_URI }),
      },
    },
    {
      label: "テナントURL + form + Basic auth",
      url: TENANT_TOKEN_URL,
      req: {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: "Basic " + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64") },
        body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI }).toString(),
      },
    },
  ];

  let tokenRes: Response | null = null;
  for (const attempt of attempts) {
    console.log(`  試行中: ${attempt.label}`);
    const res = await fetch(attempt.url, attempt.req);
    const text = await res.text();
    console.log(`  → ${res.status}: ${text.slice(0, 120)}`);
    if (res.ok) {
      tokenRes = new Response(text, { status: res.status, headers: res.headers });
      break;
    }
  }

  if (!tokenRes || !tokenRes.ok) {
    console.error("\n全パターン失敗。上記ログをオーナーに共有してください。");
    process.exit(1);
  }

  const data = await tokenRes.json() as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  const tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in - 60) * 1000,
  };

  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
  console.log("\n✅ トークンを保存しました:", TOKENS_FILE);
  console.log("\n次のステップ:");
  console.log("  npm run discover   # フィールド構造確認");
  console.log("  npm run fetch      # データ取得テスト");
}

main().catch(e => { console.error(e); process.exit(1); });
