import { apiGet } from "./gocoo-client.ts";
const r: any = await apiGet("/custom-objects/5/fields", { per_page: 200 });
const TARGETS = ["失注", "保留", "ペンディング"];
for (const f of r.fields ?? []) {
  if (TARGETS.some(t => (f.display_name ?? "").includes(t))) {
    console.log(`---\nid=${f.id} field_name=${f.field_name}`);
    console.log(`display_name=${f.display_name}`);
    console.log(`field_type=${f.field_type}`);
    if (f.options) console.log(`options=${JSON.stringify(f.options.map((o:any)=>({id:o.id, name:o.name})), null, 2)}`);
  }
}
