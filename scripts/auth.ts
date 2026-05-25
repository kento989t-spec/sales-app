/**
 * GoCoo OAuth 認証セットアップ（PKCE / ネイティブアプリ）
 * npm run auth
 */
import fs from "fs";
import path from "path";
import readline from "readline";
import { exec } from "child_process";
import { fileURLToPath } from "url";
import { webcrypto } from "crypto";
import { OAUTH_BASE, NATIVE_CLIENT_ID } from "./gocoo-client.ts";

const crypto = webcrypto as unknown as Crypto;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKENS_FILE = path.join(__dirname, ".tokens.json");

// PKCE ユーティリティ
function base64url(buf: ArrayBuffer): string {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function generateCodeVerifier(): string {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return base64url(arr.buffer);
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(buf);
}

async function main() {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  const authorizeUrl = new URL(`${OAUTH_BASE}/oauth/authorize`);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", NATIVE_CLIENT_ID);
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  console.log("\n========================================");
  console.log("GoCoo 認証セットアップ（PKCE）");
  console.log("========================================");
  console.log("\n1. ブラウザでGoCooにログインしてください:");
  console.log("\n" + authorizeUrl.toString() + "\n");
  exec(`open "${authorizeUrl.toString()}"`);

  console.log("2. 承認後、ブラウザに表示された認証コード（code）を貼り付けてください");
  console.log("   アドレスバーのURL全体でも可（?code=XXX の部分を抽出します）\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const input = await new Promise<string>(resolve => {
    rl.question("コード: ", answer => { rl.close(); resolve(answer.trim()); });
  });

  let code: string;
  if (input.startsWith("http")) {
    const parsed = new URL(input);
    const err = parsed.searchParams.get("error");
    if (err) {
      console.error(`\n❌ 認可エラー: ${err} - ${parsed.searchParams.get("error_description")}`);
      process.exit(1);
    }
    code = parsed.searchParams.get("code") ?? "";
    if (!code) { console.error("URLにcodeが見つかりません"); process.exit(1); }
  } else {
    code = input;
  }
  console.log("コード取得: OK\nアクセストークンを取得中...");

  const tokenUrl = `${OAUTH_BASE}/oauth/token`;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: NATIVE_CLIENT_ID,
    code_verifier: codeVerifier,
  });

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const text = await res.text();
  if (!res.ok) {
    console.error(`\n❌ トークン取得失敗: ${res.status}`);
    console.error(text);
    process.exit(1);
  }

  const data = JSON.parse(text) as {
    access_token: string; refresh_token: string; expires_in: number;
  };
  const tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in - 60) * 1000,
    client_id: NATIVE_CLIENT_ID,
  };

  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
  console.log("\n✅ トークンを保存しました:", TOKENS_FILE);
  console.log("\n次: npm run discover → npm run fetch");
}

main().catch(e => { console.error(e); process.exit(1); });
