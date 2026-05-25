/**
 * GoCoo OAuth 認証セットアップ（PKCE / 2ステップ）
 * ステップ1: npm run auth          → ブラウザを開く・verifier保存
 * ステップ2: npm run auth -- CODE  → トークン取得
 */
import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { fileURLToPath } from "url";
import { webcrypto } from "crypto";
import { OAUTH_BASE, NATIVE_CLIENT_ID } from "./gocoo-client.ts";

const crypto = webcrypto as unknown as Crypto;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKENS_FILE = path.join(__dirname, ".tokens.json");
const STATE_FILE = path.join(__dirname, ".auth-state.json");

function base64url(buf: ArrayBuffer): string {
  return Buffer.from(buf).toString("base64")
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

function extractCode(input: string): string {
  if (input.startsWith("{")) return (JSON.parse(input) as { code: string }).code;
  if (input.startsWith("http")) return new URL(input).searchParams.get("code") ?? input;
  return input;
}

async function main() {
  const arg = process.argv[2];

  if (!arg) {
    // ===== ステップ1: ブラウザを開く =====
    const verifier = generateCodeVerifier();
    const challenge = await generateCodeChallenge(verifier);
    fs.writeFileSync(STATE_FILE, JSON.stringify({ verifier }));

    const url = new URL(`${OAUTH_BASE}/oauth/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", NATIVE_CLIENT_ID);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");

    console.log("\nブラウザを開いてGoCooにログイン・承認してください。");
    console.log("承認後、表示されたJSONまたはURLをコピーして以下を実行:\n");
    console.log(`  npm run auth -- 'ここにJSONまたはURLを貼り付け'\n`);
    exec(`open "${url.toString()}"`);

  } else {
    // ===== ステップ2: トークン取得 =====
    if (!fs.existsSync(STATE_FILE)) {
      console.error("先に npm run auth を実行してください（verifierがありません）");
      process.exit(1);
    }
    const { verifier } = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as { verifier: string };
    const code = extractCode(arg);

    console.log("アクセストークンを取得中...");
    const res = await fetch(`${OAUTH_BASE}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: NATIVE_CLIENT_ID,
        code_verifier: verifier,
      }).toString(),
    });

    const text = await res.text();
    if (!res.ok) {
      console.error(`❌ 失敗: ${res.status}\n${text}`);
      process.exit(1);
    }

    const data = JSON.parse(text) as { access_token: string; refresh_token: string; expires_in: number };
    fs.writeFileSync(TOKENS_FILE, JSON.stringify({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + (data.expires_in - 60) * 1000,
      client_id: NATIVE_CLIENT_ID,
    }, null, 2));
    fs.unlinkSync(STATE_FILE);

    console.log("✅ トークン保存完了");
    console.log("次: npm run discover → npm run fetch");
  }
}

main().catch(e => { console.error(e); process.exit(1); });
