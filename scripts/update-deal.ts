/**
 * GitHub Actions から呼ばれる GoCoo フィールド更新スクリプト
 * 環境変数: DEAL_ID, FIELD_KEY, FIELD_VALUE (JSON), GOCOO_REFRESH_TOKEN, GOCOO_CLIENT_ID
 */

const DEAL_ID = process.env.DEAL_ID!;
const FIELD_KEY = process.env.FIELD_KEY!;
const FIELD_VALUE_RAW = process.env.FIELD_VALUE!;
const REFRESH_TOKEN = process.env.GOCOO_REFRESH_TOKEN!;
const CLIENT_ID = process.env.GOCOO_CLIENT_ID!;

const OAUTH_BASE = "https://sfa.salesgo.jp";
const API_BASE = "https://sfa.salesgo.jp/api/v1";
const DEAL_OBJECT_ID = 5;

async function getAccessToken(): Promise<string> {
  const res = await fetch(`${OAUTH_BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: REFRESH_TOKEN,
      client_id: CLIENT_ID,
    }).toString(),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`トークン更新失敗: ${res.status} ${body}`);
  }
  const data = await res.json() as { access_token: string };
  return data.access_token;
}

async function main() {
  if (!DEAL_ID || !FIELD_KEY || !FIELD_VALUE_RAW || !REFRESH_TOKEN || !CLIENT_ID) {
    throw new Error("必要な環境変数が不足しています");
  }

  let fieldValue: unknown;
  try {
    fieldValue = JSON.parse(FIELD_VALUE_RAW);
  } catch {
    fieldValue = FIELD_VALUE_RAW;
  }

  console.log(`Deal ${DEAL_ID}: ${FIELD_KEY} = ${JSON.stringify(fieldValue)}`);

  const token = await getAccessToken();
  const res = await fetch(`${API_BASE}/custom-objects/${DEAL_OBJECT_ID}/values/${DEAL_ID}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ [FIELD_KEY]: fieldValue }),
  });

  const responseText = await res.text();
  if (!res.ok) {
    throw new Error(`PATCH失敗: ${res.status} ${responseText}`);
  }
  console.log(`✅ 更新成功: ${res.status}`);
}

main().catch(e => { console.error(e); process.exit(1); });
