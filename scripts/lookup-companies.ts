import { getAllPages } from "./gocoo-client.ts";
const targets = ["Hubble", "PROLEXT", "CSE", "LisB", "スマートキャンプ", "AI shift", "AIshift"];
const F_COMPANY = "field_a860ea33-f028-4d7e-9180-120baa01d84b";
const all = await getAllPages<any>("/custom-objects/5/values", { per_page: 100 });
const want = new Set([699, 761, 776, 804, 846, 882, 921, 934, 939]);
console.log("== 既存paid_statusの会社名 ==");
for (const d of all) {
  if (!want.has(d.id)) continue;
  const c = d[F_COMPANY]?.formatted_value ?? d.name?.formatted_value ?? d.name ?? "";
  console.log(`  deal=${d.id}  company=${c}`);
}
console.log("\n== 指定会社の検索 ==");
for (const t of targets) {
  const hits = all.filter(d => {
    const c = d[F_COMPANY]?.formatted_value ?? "";
    return c.includes(t);
  });
  console.log(`\n[${t}] ${hits.length}件`);
  for (const h of hits) {
    const c = h[F_COMPANY]?.formatted_value;
    const phase = h.path_id?.formatted_value;
    console.log(`  deal=${h.id} ${c}  phase=${phase}`);
  }
}
