import { getAllPages } from "./gocoo-client.ts";
const COMPANY_FIELD = "field_a860ea33-f028-4d7e-9180-120baa01d84b";
interface FieldValue { formatted_value: string }
interface RawDeal { id: number; name: unknown; [k:string]: unknown }
function getField(d: RawDeal, key: string) { return (d[key] as FieldValue)?.formatted_value ?? ""; }
const all = await getAllPages<RawDeal>("/custom-objects/5/values");
const hits = all.filter(d => getField(d, COMPANY_FIELD).includes("インクレ") || String(d.name).includes("インクレ"));
hits.forEach(d => console.log(d.id, getField(d, COMPANY_FIELD) || String(d.name)));
