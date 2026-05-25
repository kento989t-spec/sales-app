/**
 * GoCoo OAuth 認証セットアップ（初回のみ実行）
 * npm run auth
 */
import fs from "fs";
import path from "path";
import readline from "readline";
import { exec } from "child_process";
import { fileURLToPath } from "url";
import { CLIENT_ID, CLIENT_SECRET } from "./gocoo-client.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKENS_FILE = path.join(__dirname, ".tokens.json");

const REDIRECT_URI = "http://localhost:3456/callback";
const AUTH_URL = "https://sfa.salesgo.jp/oauth/authorize";
const TOKEN_URL = "https://sfa.salesgo.jp/oauth/token";

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
  const c = parsed.searchParams.get("code");
  if (!c) throw new Error("codeパラメータが見つかりません");
  code = c;
} catch (e) {
  console.error("URLの解析に失敗しました:", e);
  process.exit(1);
}

console.log("\n3. 認証コード取得成功。アクセストークンを取得中...");

// form-encoded + client credentials in body
async function tryExchange(format: "form_body" | "form_basic"): Promise<Response> {
  if (format === "form_body") {
    return fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
      }).toString(),
    });
  } else {
    return fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: "Basic " + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64"),
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
      }).toString(),
    });
  }
}

let tokenRes = await tryExchange("form_body");
if (!tokenRes.ok) {
  console.log("form_body 形式失敗、Basic auth 形式で再試行...");
  tokenRes = await tryExchange("form_basic");
}

if (!tokenRes.ok) {
  const body = await tokenRes.text();
  console.error("トークン取得失敗:", tokenRes.status, body);
  console.error("\n考えられる原因:");
  console.error("- コードの有効期限切れ（数分以内に使用してください）");
  console.error("- クライアントIDまたはシークレットが間違っている");
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
