// GoCoo API capability probe
// ① /custom-objects/5/paths への POST / PATCH / DELETE
// ② 自動化ルール API の存在
// 失敗時は本番に何も残さない。POST 成功時は即 DELETE を試行。
import { apiGet, apiPatch } from "./gocoo-client.ts";

const API_BASE = "https://sfa.salesgo.jp/api/v1";

async function getToken() {
  // gocoo-client が内部で持つ getAccessToken は export されていないので
  // apiGet を1回叩いてトークンキャッシュを温める
  await apiGet("/custom-objects/5/paths");
  const fs = await import("fs");
  const tokens = JSON.parse(fs.readFileSync(new URL("./.tokens.json", import.meta.url), "utf8"));
  return tokens.access_token as string;
}

async function rawFetch(method: string, path: string, body?: unknown) {
  const token = await getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text.slice(0, 400) };
}

console.log("=== ① PATCH 既存path id=4 を同じ名前で再保存（冪等）===");
try {
  const r = await apiPatch("/custom-objects/5/paths/4", { name: "【FS-01】初回商談日FIX" });
  console.log("OK:", JSON.stringify(r).slice(0, 300));
} catch (e: any) { console.log("FAIL:", e.message?.slice(0, 400)); }

console.log("\n=== ② POST 新規path作成 ===");
const postRes = await rawFetch("POST", "/custom-objects/5/paths", {
  name: "__probe_to_delete__",
  order: 9999,
});
console.log(`status=${postRes.status} body=${postRes.body}`);

// 作成成功なら id を抽出して DELETE
let probeId: number | null = null;
try {
  const parsed = JSON.parse(postRes.body);
  probeId = parsed?.path?.id ?? parsed?.id ?? null;
} catch {}

if (probeId) {
  console.log(`\n=== ③ DELETE probe path id=${probeId} ===`);
  const delRes = await rawFetch("DELETE", `/custom-objects/5/paths/${probeId}`);
  console.log(`status=${delRes.status} body=${delRes.body}`);
  if (delRes.status >= 300) {
    console.log(`⚠️  DELETE 不可。GoCoo UI で手動削除が必要: id=${probeId} "__probe_to_delete__"`);
  }
} else {
  console.log("\n(③ DELETE はPOST成功時のみ実行 — POST失敗のためスキップ)");
}

console.log("\n=== ④ 自動化ルール API 探索 ===");
const candidates = [
  "/automations",
  "/automation-rules",
  "/workflows",
  "/triggers",
  "/custom-objects/5/automations",
  "/custom-objects/5/automation-rules",
  "/custom-objects/5/workflows",
  "/custom-objects/5/rules",
  "/rules",
];
for (const p of candidates) {
  const r = await rawFetch("GET", p);
  const tag = r.status < 300 ? "✅" : r.status === 404 ? "✗404" : r.status === 405 ? "△405" : `?${r.status}`;
  console.log(`${tag} GET ${p}  ${r.body.slice(0, 120)}`);
}

console.log("\n=== 完了 ===");
