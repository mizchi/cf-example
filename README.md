# cf CLI を試す

[Cloudflare の発表記事](https://blog.cloudflare.com/cloudflare-cf-cli-launch/)に沿って、`cf` のベータ版で生成した Worker に Vite フロントエンドを追加した例です。`cf dev` ひとつで画面と API を開発できます。形式手法の解説は [Cloudflare の非同期処理とデータ同期はどこで破れるか？](docs/README.md) にまとめました。Workers Cache・Durable Objects・`waitUntil`・Queues とその Consumer・D1・R2・K2 のモデル、反例、修正、実装テストの範囲を一続きで読めます。

Quint のモデルは [`models/`](models/) に置き、予約・Queue メッセージ・K2 subscription の共通操作は [`models/lib/`](models/lib/) に分けています。文書更新から検索と監査を作るイベント処理のサンプルも含みます。

Queues と K2 の使い分けは、[ack・独立した読者・再構築を図で追う資料](docs/queues-vs-k2/README.md)にまとめました。`just dev` を起動したまま `just explain-check` で図と実行結果の引用を検査できます。

[保存 API の再送・処理不能イベントの隔離・保持期限切れからの復旧](docs/recovery-patterns.md)もモデル化しました。画面で保存応答の喪失、隔離前の停止、ログの期限切れを試せます。検索は現在の登録文書から復旧し、監査は履歴欠落を明示します。`just model-check saveRequest poisonEvents retentionRecovery` で検査できます。

## 試した環境

- Node.js 24、pnpm 10
- `cf` 1.0.0-beta.10
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

## 文書イベント → 検索・監査のサンプル

`just dev` の後に <http://localhost:5173/?project=demo> を開き、**文書を保存 → イベントを発行 → 検索を更新／監査を更新**と操作します。`project` を変えると文書・outbox・検索・監査を分離できます。画面は `article` 一件を扱い、API は文書 ID を指定できます。

- 文書と未発行イベントを同じ DO transaction で保存します。発行失敗でもイベントが outbox に残ります。
- 送信後の応答を失うと再送でログが重複します。検索と監査はそれぞれイベント ID の記録と更新を同じ transaction で確定し、二重計上を防ぎます。
- 検索は文書ごとの version を比較するので、古い更新が後から届いても巻き戻りません。監査はすべての更新を数えます。
- batch の一件目で停止した後に再実行すると、同じ worker が batch を再取得します。全件反映してから ack します。
- 検索の再構築は新しい subscription を earliest で開始します。監査の進捗と保持ログはそのままです。

画面の障害設定を「なし」に戻して再実行すると回復を試せます。API からも同じ手順を実行できます。

```sh
curl -X POST http://localhost:5173/api/pipeline/demo/documents/article \
  -H 'Content-Type: application/json' -d '{"value":"検索できる文書"}'
curl -X POST http://localhost:5173/api/pipeline/demo/documents/article/publish \
  -H 'Content-Type: application/json' -d '{"fault":"after-send"}' # 503、outbox は残る
curl -X POST http://localhost:5173/api/pipeline/demo/documents/article/publish
curl -X POST http://localhost:5173/api/pipeline/demo/consume/search
curl -X POST http://localhost:5173/api/pipeline/demo/consume/audit
curl http://localhost:5173/api/pipeline/demo/projections
```

契約は [`src/event-contract.ts`](src/event-contract.ts)、K2 HTTP アダプターは [`src/k2-client.ts`](src/k2-client.ts)、形式モデルは [`models/document-events.qnt`](models/document-events.qnt) です。`just test tests/pipeline.spec.ts tests/k2-contract.spec.ts` と `just model-check documentEvents k2` で検査できます。

既定では [`LocalK2Stream`](src/local-k2-stream.ts) が DO storage にログを保持します。K2 の produce・subscription・consume・ack の JSON を使うローカル代替で、一 subscription 一 lease に絞っています。保持期限切れは手動で全保持ログを削除して再現します。実時間での期限処理、128 並列 lease、遅延・容量制限は再現しません。発行・consumer はボタン/API で手動実行し、一回につき最大 100 件を扱います。outbox の自動再試行や常駐 consumer はありません。検索は部分文字列検索、監査と処理済み ID はこの小規模デモ用に全件保持します。

### 実 K2 へ切り替える

HTTP input を有効にした専用の K2 ストリームと、K2 Produce / K2 Consume 権限を持つ API token を用意します。[公式 produce 手順](https://developers.cloudflare.com/k2/features/produce/)と[consume 手順](https://developers.cloudflare.com/k2/features/consume/)に対応します。

```sh
cp .dev.vars.example .dev.vars
# .dev.vars の K2_API_TOKEN を設定してから起動
K2_ENDPOINT='https://<STREAM_ID>.k2.cloudflarestorage.com' just dev
```

endpoint の `<...>` は実 ID に置き換えてください。token は Worker 側の secret binding で読み、ブラウザーへ渡しません。`K2_ENDPOINT` を省略するとローカルへ戻ります。実 K2 では障害注入を無効にします。新しい project と検索の再構築は subscription を追加するので、不要になったものは K2 側で削除してください。再構築できるのは保持期間内の、このサンプルの `document.updated` 形式のログです。保存の冪等化には同じ `requestId` を再送します。HTTP API の認証、バックグラウンド処理は本番利用時に追加する必要があります。

## 確認した機能

| 機能 | 実行例 | 結果 |
| --- | --- | --- |
| コマンド検索 | `pnpm exec cf cli search 'list D1 databases in an account'` | `cf d1 list` などを JSON で提示 |
| API 定義の確認 | `pnpm exec cf schema d1 list` | `GET /accounts/{account_id}/d1/database` と引数を表示 |
| アカウントの読み取り | `pnpm exec cf d1 list --per-page 2`、`pnpm exec cf workers scripts search --per-page 2` | 認証済みアカウントから JSON 配列を取得 |
| TypeScript 設定 | `just typecheck` | Worker、フロントエンド、binding の型をチェック |
| Vite によるローカル実行 | `just dev` | `/` で画面、`/api/hello` で JSON API を提供 |
| E2E テスト | `just test` | 同時保存、古い GET、イベント再送・処理途中の停止・独立した検索と監査・再構築を確認。DO の成功応答数と文書イベントの最終状態を Quint ITF と照合 |
| 形式モデル | `just model-check` | Cache 同期・DO・`waitUntil`・Queues の再配信と Consumer batch・D1・R2・K2 の各反例と修正後の不変条件を Quint + TLC で確認 |
| K2 モデル | `just model-check k2` | lease 期限切れ後の重複処理と早すぎる batch ack の反例、修正版の安全性、subscription の独立性・再配送完了・古い ack・lease 回復と延長の到達例を確認 |
| 文書イベントモデル | `just model-check documentEvents` | outbox を持たない保存の喪失、古い版の上書き、監査の重複の反例と修正版・再送後の完了経路を確認 |
| Local Explorer | `curl http://localhost:5173/cdn-cgi/local/explorer/api/local/workers` | ローカル Worker と binding を JSON で確認 |
| デプロイ前の確認 | `just deploy-dry-run` | Worker、静的ファイル、五つの DO namespace とテキスト binding を確認し、公開せず終了 |

`cf --help` はコマンド探索に `cf cli search` を勧めます。検索文にはアカウント名、ドメイン、ID、トークンなどを含めず、操作とリソースの種類だけを書きます。検索結果のコマンドで `--help` を実行すると引数を確認できます。

ビルドと dry run は成功しましたが、この環境では Docker デーモンへの接続警告が出ました。公開デプロイと、既存リソースを変更する操作は試していません。

K2 は Workers Paid 向け公開ベータです。`cf` beta.10 の管理コマンドに対応していますが、現在の認証で `cf k2 streams list` は 403 でした。実ストリームは作成せず、実 K2 との疎通は未検証です。検査済みの範囲は、公式仕様の形式モデル、HTTP 契約テスト、ローカル代替を使った実装の E2E です。
