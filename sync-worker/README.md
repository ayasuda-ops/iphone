# ☁️ 友メシ帳 同期サーバー

友メシ帳のリストを複数の iPhone（例: 夫婦）で共有するための、Cloudflare Workers + Durable Objects (SQLite) の小さなサーバーです。

- 合言葉（`SYNC_KEY`）が一致するリクエストだけを受け付けます。合言葉はコードには書かず、Cloudflare のシークレットに保存します。
- 同じお店が両方で編集された場合は、後から保存した方（`updatedAt` が新しい方）が残ります。削除も相手に伝わります。
- Cloudflare の無料プランで動きます。

## セットアップ（Cloudflare の GitHub 連携）

1. [Cloudflare](https://dash.cloudflare.com/sign-up) の **Workers & Pages** で、GitHub の `ayasuda-ops/iphone` を接続して Worker `iphone` を作成
2. Worker の **Settings → Build** で **Root directory** を `sync-worker` にする（Deploy command は `npx wrangler deploy` のまま）
3. **Settings → Variables and Secrets → Add** で種類 **Secret**、名前 `SYNC_KEY`、値に合言葉を登録
4. 以後は `main` に push すると Cloudflare が自動でデプロイします

公開 URL: `https://iphone.yasuda-97c.workers.dev`（アプリの既定のサーバー URL）。
`wrangler.toml` の `name` は Cloudflare 上の Worker 名（`iphone`）と一致させてください。

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
