import { apiGet } from "./gocoo-client.ts";
const r: any = await apiGet("/custom-objects/5/fields", { per_page: 200 });
for (const f of r.fields ?? []) {
  if (["失注・保留理由", "失注理由"].includes(f.display_name)) {
    console.log(`\n=== ${f.display_name} (id=${f.id}) ===`);
    console.log(JSON.stringify(f.options, null, 2));
  }
}
