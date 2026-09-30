# cf CLI を試す

[Cloudflare の発表記事](https://blog.cloudflare.com/cloudflare-cf-cli-launch/)に沿って、`cf` のベータ版で生成した Worker に Vite フロントエンドを追加した例です。`cf dev` ひとつで画面と API を開発できます。形式手法の解説は [Cloudflare の非同期処理とデータ同期はどこで破れるか？](docs/README.md) にまとめました。Workers Cache・Durable Objects・`waitUntil`・Queues とその Consumer・D1・R2 のモデル、反例、修正、実装テストの範囲を一続きで読めます。

Quint のモデルは [`models/`](models/) に置き、予約と Queue メッセージの共通操作は [`models/lib/`](models/lib/) に分けています。

## 試した環境

- Node.js 24、pnpm 10
- `cf` 1.0.0-beta.5
- `@cloudflare/vite-plugin` 2.0.0-beta.sha-ad79608dd
- Quint 0.33.0、TLC モデル検査には Java が必要

## 実行

```sh
just install
pnpm exec playwright install chromium
just check
just dev
curl http://localhost:5173/
curl http://localhost:5173/api/hello
curl http://localhost:5173/api/documents/demo
```

`/` は `index.html` から始まる画面を返し、画面は同じ origin の `/api/hello` にアクセスします。API の JSON は `{"message":"Hello World!"}` です。`WORLD` は `cloudflare.config.ts` の `bindings.text("World")` で定義され、Worker の `src/index.ts` から参照しています。

フロントエンドは `src/client.ts`、API は `src/index.ts` にあります。両者は `src/contract.ts` のレスポンス型を共有します。開発時は一つのコマンドと URL で操作できますが、内部では Vite と Workers ランタイムの `workerd` が動きます。

文書同期の契約は `src/document-contract.ts` にあります。`/api/documents/demo` への POST は `{"value":"new value"}` を受け取り、版番号を増やします。GET は Workers Cache の対象、保存は Durable Object の transaction で行います。ローカルの `cf dev` では Workers Cache purge API が使えないため、キャッシュの実動作は再現せず、E2E が応答の到着順を制御します。

## 確認した機能

| 機能 | 実行例 | 結果 |
| --- | --- | --- |
| コマンド検索 | `pnpm exec cf cli search 'list D1 databases in an account'` | `cf d1 list` などを JSON で提示 |
| API 定義の確認 | `pnpm exec cf schema d1 list` | `GET /accounts/{account_id}/d1/database` と引数を表示 |
| アカウントの読み取り | `pnpm exec cf d1 list --per-page 2`、`pnpm exec cf workers scripts search --per-page 2` | 認証済みアカウントから JSON 配列を取得 |
| TypeScript 設定 | `just typecheck` | Worker、フロントエンド、binding の型をチェック |
| Vite によるローカル実行 | `just dev` | `/` で画面、`/api/hello` で JSON API を提供 |
| E2E テスト | `just test` | Playwright が同時保存と古い GET の遅延到着を確認し、DO の成功応答数を Quint の ITF と照合 |
| 形式モデル | `just model-check` | Cache 同期・DO・`waitUntil`・Queues の再配信と Consumer batch・D1・R2 の各反例と修正後の不変条件を Quint + TLC で確認 |
| Local Explorer | `curl http://localhost:5173/cdn-cgi/local/explorer/api/local/workers` | ローカル Worker と binding を JSON で確認 |
| デプロイ前の確認 | `just deploy-dry-run` | Worker と静的ファイル 4 件、`WORLD`・`DOCUMENT`・`CLAIM` binding を確認し、公開せず終了 |

`cf --help` はコマンド探索に `cf cli search` を勧めます。検索文にはアカウント名、ドメイン、ID、トークンなどを含めず、操作とリソースの種類だけを書きます。検索結果のコマンドで `--help` を実行すると引数を確認できます。

ビルドと dry run は成功しましたが、この環境では Docker デーモンへの接続警告が出ました。公開デプロイと、既存リソースを変更する操作は試していません。
