import { apiGet } from "./gocoo-client.ts";

async function probe(path: string) {
  try {
    const r = await apiGet(path);
    return { ok: true, body: JSON.stringify(r).slice(0, 2000) };
  } catch (e: any) {
    return { ok: false, body: e.message?.slice(0, 200) };
  }
}

// 候補エンドポイント探索
const targets = [
  "/custom-objects/5/fields/871/choices",
  "/custom-objects/5/fields/871/options",
  "/custom-objects/5/fields/326/choices",
  "/custom-objects/5/fields/326/options",
  "/choices?field_id=871",
  "/field-choices?field_id=871",
  "/custom-objects/5/field-choices/871",
  "/custom-objects/5/fields/871/values",
];
for (const p of targets) {
  const r = await probe(p);
  console.log(`${r.ok ? "✅" : "✗"} ${p}\n  ${r.body}\n`);
}

// fields 一覧の中に choices が含まれてないか別パラメータで再取得
console.log("\n=== fields one-by-one (paging大) ===");
const r: any = await apiGet("/custom-objects/5/fields", { per_page: 200, include: "choices" });
for (const f of r.fields ?? []) {
  if (f.id === 871 || f.id === 326) {
    console.log(`\nid=${f.id} ${f.display_name}`);
    console.log(JSON.stringify(f, null, 2));
  }
}
