import { getAllPages } from "./gocoo-client.ts";
const CF = "field_a860ea33-f028-4d7e-9180-120baa01d84b";
interface FV { formatted_value: string }
interface D { id: number; name: unknown; [k:string]: unknown }
const all = await getAllPages<D>("/custom-objects/5/values");
const hits = all.filter(d => ((d[CF] as FV)?.formatted_value ?? String(d.name)).includes("スターティア"));
hits.forEach(d => {
  const co = (d[CF] as FV)?.formatted_value ?? String(d.name);
  const billing = (d["field_d8fd26b2-a857-450b-9f93-9cd44d0bb811"] as FV)?.formatted_value ?? "";
  console.log(`ID=${d.id} ${co} billing=${billing}`);
});
