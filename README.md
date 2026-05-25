# deex 営業管理ダッシュボード

GoCoo → GitHub Pages 営業読み管理システム

**URL**: https://kento989t-spec.github.io/sales-app/

---

## セットアップ手順

### 1. 初回認証（一度だけ）

```bash
cd /Users/knt/sales-app
npm install
npm run auth    # ブラウザでGoCooにログイン → 自動でトークン保存
```

### 2. フィールド確認（一度だけ）

```bash
npm run discover   # GoCooのフィールド構造を確認 → scripts/field-map.json 生成
```

### 3. 月次目標を設定

`config.json` を編集:

```json
{
  "monthly_targets": {
    "CoPASS": 1500000,
    "CoPASS BPO": 500000,
    "Partner Boost": 800000
  },
  "password": "営業チーム共有パスワード"
}
```

### 4. 動作確認

```bash
npm run fetch    # GoCooからデータ取得 → docs/data/sales-data.json 生成
npm run sync     # GitHub Pages に push
```

### 5. 自動実行 cron 登録（Mac Mini）

```bash
bash scripts/setup-cron.sh   # 毎時0分に自動同期
```

---

## ファイル構成

```
sales-app/
├── config.json          ← 月次目標・ヨミ係数・パスワード（Git管理外不要）
├── scripts/
│   ├── auth.ts          ← GoCoo OAuth 初回認証
│   ├── discover-fields.ts ← フィールドID確認
│   ├── fetch.ts         ← データ取得・JSON生成
│   ├── gocoo-client.ts  ← GoCoo API クライアント
│   ├── sync.sh          ← GitHub Pages push
│   ├── setup-cron.sh    ← launchd 登録
│   └── .tokens.json     ← OAuth トークン（gitignore済み）
└── docs/                ← GitHub Pages 配信ディレクトリ
    ├── index.html
    ├── app.js
    ├── style.css
    └── data/
        └── sales-data.json  ← 暗号化済みデータ（自動生成）
```

---

## セキュリティ

- `config.json` の `password` でデータをAES-GCM暗号化
- JSONはGitHubに公開されるが、パスワードなしでは読めない
- OAuthトークンは `.tokens.json`（gitignore済み）にローカル保存
- Phase 3: Cloudflare Access + Google SSO に移行予定

## GoCoo API

- Client ID: `a1d2317b-3927-4143-8b17-0dd8565229fd`
- API: `https://sfa.salesgo.jp/v1/`
- 案件 Object ID: `5`
