import { apiGet } from "./gocoo-client.ts";
// 全フィールド取得 (with choices) - GoCooは別エンドポイントの場合あり
const r: any = await apiGet("/custom-objects/5/fields/871");
console.log("=== 失注・保留理由 (id=871) ===");
console.log(JSON.stringify(r, null, 2).slice(0, 3000));
const r2: any = await apiGet("/custom-objects/5/fields/326");
console.log("\n=== 失注理由 (id=326) ===");
console.log(JSON.stringify(r2, null, 2).slice(0, 3000));
