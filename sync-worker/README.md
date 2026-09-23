# ☁️ 友メシ帳 同期サーバー

友メシ帳のリストを複数の iPhone（例: 夫婦）で共有するための、Cloudflare Workers + Durable Objects (SQLite) の小さなサーバーです。

- 合言葉（`SYNC_KEY`）が一致するリクエストだけを受け付けます。合言葉はコードには書かず、Cloudflare のシークレットに保存します。
- 同じお店が両方で編集された場合は、後から保存した方（`updatedAt` が新しい方）が残ります。削除も相手に伝わります。
- Cloudflare の無料プランで動きます。

## 初回セットアップ

1. [Cloudflare](https://dash.cloudflare.com/sign-up) の無料アカウントを作る
2. ダッシュボードの **Workers & Pages** を一度開き、`workers.dev` のサブドメインを決める
3. **My Profile → API Tokens → Create Token** で「**Edit Cloudflare Workers**」テンプレートを使ってトークンを作る
4. ダッシュボード右側などに表示される **Account ID** をコピー
5. GitHub のリポジトリ **Settings → Secrets and variables → Actions → New repository secret** で次の 3 つを登録
   | 名前 | 値 |
   |---|---|
   | `CLOUDFLARE_API_TOKEN` | 手順 3 のトークン |
   | `CLOUDFLARE_ACCOUNT_ID` | 手順 4 の Account ID |
   | `SYNC_KEY` | 合言葉 |
6. **Actions → Deploy sync worker (Cloudflare) → Run workflow** で実行（以後は `sync-worker/` を変更して `main` に入れると自動デプロイ）
7. デプロイされた URL `https://tomomeshi-sync.<サブドメイン>.workers.dev` を、アプリの 設定 → 共有 → サーバー URL に入れる

## API

`POST /sync`（`Authorization: Bearer <合言葉>`）

```json
{ "since": 12, "changes": [{ "id": "abc", "updatedAt": 1727000000000, "data": { "id": "abc", "name": "…" } },
                           { "id": "def", "updatedAt": 1727000000001, "deleted": true }] }
```

送った変更を保存し、`since` より後に変わったお店をすべて返します: `{ "cursor": 14, "changes": [...] }`

`GET /health` で稼働確認できます。

## ローカルで動かす

```sh
cd sync-worker
npm install
printf 'SYNC_KEY=local-test-key\nALLOWED_ORIGINS=http://localhost:8770\n' > .dev.vars
npx wrangler dev
```
