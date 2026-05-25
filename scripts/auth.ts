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

const REDIRECT_URI = "https://httpbin.org/get";
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

  console.log('2. ログイン・承認後、ブラウザに表示されるJSONの中の "code" の値をコピー');
  console.log('   (例: {"args":{"code":"XXXXXXXX",...}} の中の code の値)\n');
  console.log("   ※ ブラウザのアドレスバーのURL全体でも可\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const input = await new Promise<string>(resolve => {
    rl.question("codeの値（またはURL全体）: ", answer => {
      rl.close();
      resolve(answer.trim());
    });
  });

  let code: string;
  // URL全体が貼られた場合はcodeパラメータを抽出、そうでなければそのままcode
  if (input.startsWith("http")) {
    try {
      const parsed = new URL(input);
      const err = parsed.searchParams.get("error");
      if (err) {
        console.error(`\n❌ GoCoo認可エラー: ${err} - ${parsed.searchParams.get("error_description")}`);
        process.exit(1);
      }
      const c = parsed.searchParams.get("code");
      if (!c) { console.error("URLにcodeが見つかりません:", input); process.exit(1); }
      code = c;
    } catch (e) {
      console.error("URL解析失敗:", e);
      process.exit(1);
    }
  } else {
    // code値そのものを貼った場合
    code = input;
  }
  console.log("  コード取得: OK");

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
