import { apiGet } from "./gocoo-client.ts";
const r: any = await apiGet("/custom-objects/5/paths");
console.log(JSON.stringify(r, null, 2));
