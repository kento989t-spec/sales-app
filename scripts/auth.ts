/**
 * GoCoo OAuth 認証セットアップ（初回のみ実行）
 * npm run auth
 */
import http from "http";
import { exec } from "child_process";
import fs from "fs";
import path from "path";
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

console.log("ブラウザでGoCooにログインしてください...");
console.log("URL:", authorizeUrl.toString());
exec(`open "${authorizeUrl.toString()}"`);

const server = http.createServer(async (req, res) => {
  if (!req.url?.startsWith("/callback")) return;

  const params = new URL(req.url, "http://localhost:3456").searchParams;
  const code = params.get("code");

  if (!code) {
    res.end("エラー: codeが取得できませんでした");
    server.close();
    return;
  }

  res.end("認証成功！このウィンドウを閉じてください。");
  server.close();

  console.log("認証コード取得成功。アクセストークンを取得中...");

  const tokenRes = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code,
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
    }),
  });

  if (!tokenRes.ok) {
    const body = await tokenRes.text();
    console.error("トークン取得失敗:", tokenRes.status, body);
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
  console.log("✅ トークンを保存しました:", TOKENS_FILE);
  process.exit(0);
});

server.listen(3456, () => {
  console.log("コールバックを待機中... (port 3456)");
});
