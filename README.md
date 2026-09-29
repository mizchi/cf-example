# cf CLI を試す

[Cloudflare の発表記事](https://blog.cloudflare.com/cloudflare-cf-cli-launch/)に沿って、`cf` のベータ版で生成した Hello World Worker です。

## 試した環境

- Node.js 24、pnpm 10
- `cf` 1.0.0-beta.5
- `@cloudflare/vite-plugin` 2.0.0-beta.sha-ad79608dd

## 実行

```sh
just install
just check
just dev
curl http://localhost:5173/
```

最後のリクエストは `Hello World!` を返します。`WORLD` は `cloudflare.config.ts` の `bindings.text("World")` で定義され、Worker の `src/index.ts` から参照しています。

## 確認した機能

| 機能 | 実行例 | 結果 |
| --- | --- | --- |
| コマンド検索 | `pnpm exec cf cli search 'list D1 databases in an account'` | `cf d1 list` などを JSON で提示 |
| API 定義の確認 | `pnpm exec cf schema d1 list` | `GET /accounts/{account_id}/d1/database` と引数を表示 |
| アカウントの読み取り | `pnpm exec cf d1 list --per-page 2`、`pnpm exec cf workers scripts search --per-page 2` | 認証済みアカウントから JSON 配列を取得 |
| TypeScript 設定 | `just typecheck` | Worker の型と binding の型を生成してチェック |
| Vite によるローカル実行 | `just dev` | `http://localhost:5173/` が HTTP 200 を返す |
| Local Explorer | `curl http://localhost:5173/cdn-cgi/local/explorer/api/local/workers` | ローカル Worker と binding を JSON で確認 |
| デプロイ前の確認 | `just deploy-dry-run` | 生成物のサイズと `WORLD` binding を表示し、公開せず終了 |

`cf --help` はコマンド探索に `cf cli search` を勧めます。検索文にはアカウント名、ドメイン、ID、トークンなどを含めず、操作とリソースの種類だけを書きます。検索結果のコマンドで `--help` を実行すると引数を確認できます。

ビルドと dry run は成功しましたが、この環境では Docker デーモンへの接続警告が出ました。公開デプロイと、既存リソースを変更する操作は試していません。
