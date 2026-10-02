# Cloudflare の非同期処理とデータ同期はどこで破れるか？

Durable Object に状態を集めても、同じ仕事を二件とも獲得できてしまう。外部 I/O の `await` を一つ挟むだけで起きる。

このリポジトリには、その競合を起こす実装と、修正した実装の両方がある。自分が確かめたいのは「たまたまテストが通った」から一歩進んで、**どの順序で壊れ、その順序をどう塞ぐか**だ。

> 想定読者は TypeScript と HTTP が読めて、Quint は初めての人。Worker の基本構文は省く。本文は約 10 分。例は Quint のモデル検査と、対応するローカルの Playwright テストで照合する。

| 読み終えて判断したいこと | このサンプルの答え |
| --- | --- |
| 同じ DO に集めたのに、なぜ二件とも成功するのか？ | 外部 I/O を待つ間に次の要求が入る。待つ前に予約を確定する |
| 保存成功や再試行だけで、画面・検索・監査は正しくなるか？ | 古い応答と重複は届き得る。宛先で版と ID を判定する |
| モデル検査が緑なら、どこまで安心できるか？ | 書いた状態と操作の範囲で、指定した条件が破れない。実装との対応は別に確かめる |

## 同じ DO でも、外部 I/O の間には割り込める

一つの仕事に A と B が POST する。API の約束は、`{ claimed: true }` を返すのは高々一件、というものにする。

Worker は同じ ID の要求を同じ `ClaimStore` に送る。ところが、[DO は storage 以外の I/O を待つ間に別の要求を処理できる](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/#avoid-race-conditions-with-non-storage-io)。

壊れる方の実装はこれ。`scheduler.wait(100)` は外部 API の応答待ちの代役で、待ってから `claimed` を保存している。

<!-- source: ../src/claim-store.ts -->
```ts
			const claimed = (await this.ctx.storage.get<boolean>("claimed")) ?? false;
			if (claimed) return Response.json({ claimed: false });
			// Represents an external fetch: other requests may enter while it is awaited.
			await scheduler.wait(100);
			await this.ctx.storage.put("claimed", true);
			return Response.json({ claimed: true });
```

A が `claimed=false` を読んで待つ。その間に B も `false` を読むので、待ち終えた二件はどちらも `true` を返す。

![A と B が未予約を読んでから順に成功し、成功件数が 2 になる](figures/claim-counterexample.svg)

図の `readA` / `readB` が未予約の確認、`finishA` / `finishB` が待機後の保存と成功応答に当たる。最後の `accepted=2` が成功件数で、この時点で約束を破っている。

CPU が同時に二つの処理を実行する必要はない。A が止まっている間に B が進めば十分だ。

### 待つ前に予約する

修正版は、未予約かの確認と予約の保存を一つの storage transaction にまとめる。その transaction を終えてから外部 I/O を待つ。

<!-- source: ../src/claim-store.ts -->
```ts
		const reserved = await this.ctx.storage.transaction(async (transaction) => {
			const claimed = (await transaction.get<boolean>("claimed")) ?? false;
			if (claimed) return false;
			await transaction.put("claimed", true);
			return true;
		});
		if (!reserved) return Response.json({ claimed: false });
		await scheduler.wait(100);
		return Response.json({ claimed: true });
```

A が予約した後なら、B は `claimed=true` を読んで `false` を返す。これで二重獲得は止まる。

ただし、予約直後に A が停止したらどうするか。この実装は予約を回収しないので、「高々一件が成功する」と「誰かが必ず完了する」は別の約束になる。

## この順序を Quint で探す

この例なら、A → B の順序は手でも思いつく。保存・送信・応答喪失・再試行が増えてくると、自分で並べた数本のテストだけでは、どの順序を見落としたかがわからなくなる。

[Quint](https://github.com/quint-co/quint) には、状態と、その状態を変える操作を書く。このサンプルでは [TLC](https://github.com/tlaplus/tlaplus) を検査器に使い、操作の実行可能な順序を探索する。

### 実装から何を残すか

[DO のモデル](../models/durable-object.qnt)に残したのは、一つの仕事と二つの要求だけ。URL、JSON、待機のミリ秒数は消し、外部 I/O の前後を別の操作にする。

| 実装で起きること | モデルの状態・操作 |
| --- | --- |
| 誰かが予約したか | `Claim::done`。図では `claimed` と略記 |
| A/B が開始前・待機中・成功・拒否のどこにいるか | `phaseA` / `phaseB` |
| 未予約を確認して待つ | `readA` / `readB` |
| 未予約を確認し、その場で予約して待つ | `reserveA` / `reserveB` |
| 待機を終えて成功を返す | `finishA` / `finishB`。`accepted` を増やす |

`accepted` は保存データの数ではなく、`claimed: true` の応答数だ。守りたい条件は一行で書ける。

<!-- source: ../models/durable-object.qnt -->
```quint
  val atMostOneClaim = accepted <= 1
```

どの操作の後でも、この式が真であってほしい。このように各状態で守りたい条件を**不変条件**と呼ぶ。

Quint の `var` は状態変数、`action` は一回の状態変化、`x'` は変化後の値を表す。`all` に書いた条件をすべて満たすと、その操作が可能になる。

たとえば `readA` は、A が開始前で、まだ誰も予約していない時だけ進める。`Claim::hold` は予約状態を変えず、A だけを待機中の `1` に進める。

<!-- source: ../models/durable-object.qnt -->
```quint
  action readA = all {
    phaseA == 0,
    Claim::done == false,
    Claim::hold,
    phaseA' = 1,
    phaseB' = phaseB,
    accepted' = accepted,
  }
```

`any` は、実行可能な操作から一つを選ぶ。修正前の `stepNaive` は `readA` などを選び、修正後の `stepSafe` は代わりに `reserveA` などを選ぶ。

### 反例は「壊れる順序」そのもの

検査器が不変条件を破る状態までの列を見つけたら、それが反例になる。この DO では、A/B とも未予約を見てから成功する列が得られる。

次は固定 seed で生成した操作列を、図と照合するスクリプトの実出力。`naive` は修正前、`safe` は修正後を指す。

<!-- output: claim-figures -->
```text
naive: init → readA → readB → finishA → finishB; accepted=2
safe: init → reserveA → finishA → rejectB; accepted=1
```

この一本の `safe` の列だけで、すべての順序が安全とは言えない。`just model-check durableObject` は、TLC で修正前の反例を探した後、修正版の到達可能な状態を検査する。

### モデルと実装の間もテストする

モデルは TypeScript を実行しない。実装の `await` の前後を一つの操作に潰してしまえば、検査器はその間への割り込みを探せない。

だから、実装を読む時には「外部 I/O の前後を分けたか」「transaction の外で状態を変えていないか」を照合する。[Playwright のテスト](../tests/durable-object.spec.ts)でも、実際の Worker に同じ ID の POST を二つ同時に送る。

テストは Quint の操作列から成功件数を取り出し、実 API の応答数と比べる。修正前は 2、修正後は 1。操作列そのものを再生するテストではなく、同じ観測値になるかの確認だ。

## purge しても、古い GET は後から届く

文書を保存したら、画面も新しい内容になるはずだ。ところが、保存前に読み始めた GET が遅れて届くと、保存直後の画面を古い内容で上書きできてしまう。

このサンプルは DO に文書を保存し、GET 応答を [Workers Cache](https://developers.cloudflare.com/workers/cache/) の対象にする。保存後にはタグで purge を試みるが、**purge は配送中の応答を取り消さない**。

![版 0 の GET が配送中に版 1 を保存し、遅れて届いた GET で画面が巻き戻る](figures/cache-counterexample.svg)

たとえば版 0 の GET を取得した後で、版 1 の POST が完了する。画面に版 1 を表示してから、保留していた GET が届くと、無条件の反映では版 0 に戻ってしまう。

[画面の反映関数](../src/document-contract.ts)は、すでに見た版より新しい時だけ置き換える。GET と POST の両方に同じ関数を使う。

<!-- source: ../src/document-contract.ts -->
```ts
export function acceptSnapshot(current: DocumentSnapshot | null, incoming: DocumentSnapshot): DocumentSnapshot {
	return current === null || incoming.version > current.version ? incoming : current;
}
```

[同期モデル](../models/sync.qnt)も「画面は一度見た最大の版から戻らない」を検査する。purge の成否と GET の到着を別の操作にして、purge が成功しても巻き戻る反例を探す。

[対応する E2E](../tests/sync.spec.ts)は GET の配送を保留し、保存応答を画面に反映してから古い GET を届ける。ローカルでは Cache の HIT/MISS や purge 伝播を再現できないため、検査しているのは応答順序に対する画面の挙動だ。

この比較で守れるのは、その画面が古い版へ戻らないこと。初めて開いた別の画面が、いつ最新版を読めるかまでは保証しない。

## 仕事を受け付けたことと、終わったことを分ける

画面の問題では、保存完了と GET の到着がずれていた。バックグラウンド処理でも、HTTP の成功、仕事の永続化、副作用の完了はそれぞれ別の時点になる。

ここでいう副作用は、検索の更新や監査件数の加算など、処理先に残る変更のこと。どの時点で何を約束するかが曖昧だと、仕事を失ったり二回実行したりする。

### waitUntil は、仕事を永続化しない

`ctx.waitUntil(job())` を呼んで 202 を返すと、応答後も Promise を実行できる。ただし、[HTTP Worker では応答後の実行に最大 30 秒の期限がある](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil)。

[モデル](../models/wait-until.qnt)の反例は、仕事開始 → 202 → 失敗または中断、という順序だ。202 を「受け付けた仕事は失われない」と解釈すると、この順序で約束を破る。

修正版は仕事の完了を `await` してから 200 を返す。早く応答したい場合は、Queue への `send()` 成功を待ってから 202 を返し、「処理完了」ではなく「キューに登録した」を約束する。

Queue に入れても、再試行上限や保持期限はある。登録できたことと、最終的に副作用が成功することは、やはり別だ。[Queues の再試行と DLQ](https://developers.cloudflare.com/queues/configuration/batching-retries/#delivery-failure)をその契約に含める必要がある。

### 再配信されても、副作用を二回にしない

[Queues は少なくとも一回の配送を基本にする](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)。Consumer が副作用を実行した後、ack の前に失敗すると、同じ仕事が届き直す。ack は、配送元へ「この処理は済んだ」と伝える操作だ。

[モデル](../models/queues.qnt)では、副作用を実行 → ack 前に失敗 → 再配信 → また実行、で `effectCount=2` になる。修正は、同じ ID で何度届いても宛先の結果を増やさないこと。これを冪等化と呼ぶ。

ただ「処理済み ID」を保存すればよいのだろうか。副作用だけ済んで ID を保存する前に止まれば二重実行になり、ID だけ保存して止まれば未実行の仕事を飛ばしてしまう。

モデルの修正版は、ID の記録と副作用を一つの原子的な操作にしている。実装でも、同じ DO の storage transaction で両方を確定するか、外部 API が冪等化キーを原子的に扱う必要がある。外部 API を呼んでから別途 ID を保存するだけでは、この前提を満たさない。

### batch をどこまで ack してよいか

Queues の push Consumer に A/B の二件が届き、A だけ成功したとする。B の例外を握りつぶして handler を正常終了すると、[明示的な retry がない B まで ack され得る](https://developers.cloudflare.com/queues/configuration/javascript-apis/#consumer)。

[Consumer のモデル](../models/queue-consumer.qnt)の修正版は、A に `ack()`、B に `retry()` を指定する。[Queues はメッセージ単位でこの指定ができる](https://developers.cloudflare.com/queues/configuration/batching-retries/#explicit-acknowledgement-and-retries)。

K2 は保持したイベントログを読む仕組みで、subscription は読者ごとの進捗を持つ。[K2 の ack は batch 単位](https://developers.cloudflare.com/k2/features/consume/#acknowledge-a-batch)なので、二件とも処理してから ack する。途中で止まれば、処理済みの一件も届き直す前提で冪等化する。

K2 が batch を worker に貸す期間を lease と呼ぶ。lease が切れて別の worker に再配信されても、古い worker の外部処理まで停止するわけではない。

[K2 のモデル](../models/k2.qnt)は、この二重実行と早すぎる ack を検査する。宛先の冪等化にはイベントの安定した ID を使う。[再配送で変わる `batch_id`](https://developers.cloudflare.com/k2/features/consume/#release-a-batch)は、そのキーにできない。

Queues と K2 をどちらにするかは、[仕事を分担するか、同じ履歴を別々に読むか](queues-vs-k2/README.md)の図解へ。ここまでの `waitUntil`・Queues・K2 の例はモデル検査までで、実サービスのジョブや Consumer は動かしていない。

## 文書を保存して、検索と監査を別々に更新する

前の二つの修正は、文書イベントのサンプルでも使える。検索は古い版で戻さず、監査は同じイベントで件数を増やさない。

画面では「文書を保存 → イベントを発行 → 検索を更新／監査を更新」と操作する。検索と監査は別々の subscription を持つので、検索が止まっても監査だけを進められる。

保存と発行の間にも、停止できる隙間がある。文書を保存した後、送るイベントをメモリーにだけ持っていると、発行前の停止でイベントを失う。

そこで、文書と未発行イベントを同じ DO transaction で保存する。この未発行イベントの保存場所が outbox だ。発行成功を確認できるまで残しておく。

| 保存後、どこで止まるか | 再開した時にどうなるか |
| --- | --- |
| ログへ送る前 | outbox が残っているので送れる |
| ログへ送れたが、応答を失った | outbox が残り、再送でログに重複ができ得る |
| 発行成功を確認して outbox を削除した後 | 同じ未発行イベントは残らない |

つまり、outbox は発行前の喪失を防ぐが、重複までは消さない。発行の再試行では `project:document:version` という同じイベント ID を使い、宛先で重複を処理する。

| 宛先 | 受け取ったイベントの扱い |
| --- | --- |
| 検索 | 文書ごとの最大 `version` を保持。v2 の後に v1 が来ても戻さない |
| 監査 | イベント ID の記録と件数の加算を同時に確定。同じ v1 が二回届いても一件 |

[文書保存](../src/event-document-store.ts)、[反映ロジック](../src/event-projection.ts)、[反映結果の永続化](../src/event-projection-store.ts)は分けてある。ID の確認と反映結果の保存は、宛先の DO の同じ transaction 内で行う。

[文書イベントのモデル](../models/document-events.qnt)は一文書・二つの版に絞り、発行前の喪失、検索の巻き戻り、監査の重複の反例をそれぞれ探す。[E2E](../tests/pipeline.spec.ts)では発行失敗・応答喪失・処理途中の停止を起こし、再実行後の保存版・検索版・監査件数をモデルの終端値と比べる。

既定のログは [LocalK2Stream](../src/local-k2-stream.ts) という DO の代替実装だ。[HTTP 契約テスト](../tests/k2-contract.spec.ts)は K2 の JSON やエラー処理を確認するが、実 K2 に接続して挙動を検査したものではない。発行と Consumer の実行も、このデモではボタンや API で手動にしている。

保存 API 自体の再送には別の `requestId` を使う。イベント ID は「一つの更新の再発行」、request ID は「一つの保存要求の再送」を識別する。保存の再送・処理不能イベントの隔離・ログ期限切れからの復旧は、[追加パターン](recovery-patterns.md)で扱う。

## モデル検査の緑で、何が言えるか

このサンプルの緑は、「定義した初期状態から、修正版の操作で到達できる状態では、指定した不変条件が破れない」という意味だ。**モデルに入れなかった障害や、実装とのずれは検査できない**。

DO のモデルには予約後のクラッシュを入れていない。Queue のモデルは一つの ID と最大二回の配送、K2 のモデルは二件と最大二世代の配送に絞る。小さくすることで反例を追えるが、その外側まで安全とは言えない。

また、何も処理しなければ「副作用は高々一回」を守れてしまう。そこで Queue や文書イベントなどには、修正後も再試行や完了まで進める経路が存在するかの検査を加えた。

完了する経路が一本あることと、どんな障害の下でも必ず完了することは違う。ここでは後者までは検査していない。

| 検査 | 確かめるもの | そこからは言えないもの |
| --- | --- | --- |
| TLC のモデル検査 | 有限モデルの到達可能な状態で、不変条件が破れないこと | TypeScript の実装がモデルと一致すること |
| 完了経路の検査 | 修正版でも仕事を終えられる経路があること | すべての実行がいずれ完了すること |
| ローカルの E2E | 実 API・画面が、注入した障害や応答順で期待値を返すこと | 実 Cloudflare の全地域・全障害で同じこと |

自分の実装をレビューするなら、まず次の三つを問う。

- 外部 I/O の `await` の前後で、誰が同じ状態を読んだり書いたりできるか。
- 成功応答と ack は、それぞれ何が永続化・完了したことを約束するか。
- 古い応答と同じイベントが届き直した時、宛先の版と副作用はどうなるか。

「保存 → 応答を失う → 再送」と一列書けたら、その途中で守りたい条件を式にする。モデルに入れる順序と、実装テストで観測する値が、そこから決まる。

## 読み終えたら確認する

<details>
<summary>1. 同じ DO への二件の POST は、どこで二重獲得になるか？</summary>

未予約を読んだ後、外部 I/O を待つ間にもう一件も未予約を読む。`ClaimStore` の修正版は、待機前に transaction で予約を確定する。ただし、予約後の停止からの回復までは扱わない。

</details>

<details>
<summary>2. purge が成功したのに、なぜ画面が古くなり得るか？</summary>

purge 前に取得して配送中だった GET は、保存応答より後に届き得る。同期の E2E はこの順序を作り、`acceptSnapshot` が古い版を採用しないことを確認する。

</details>

<details>
<summary>3. outbox があれば、監査の二重計上も防げるか？</summary>

防げない。ログへの発行は済んだが応答を失った場合、outbox からの再送で同じイベントが重複する。監査側でイベント ID の記録と計上を原子的に確定する。

</details>

<details>
<summary>4. 修正版のモデル検査と完了経路の検査が通れば、実 K2 でも必ず完了するか？</summary>

そこまでは言えない。モデルの緑は記述した範囲の安全性、完了経路は到達可能性であり、すべての実行の完了保証ではない。このリポジトリの E2E は DO のローカル代替を使っている。

</details>

## 付録: 手元で確かめる

Node.js 24 以上、pnpm、just、TLC を動かす Java が必要。依存の準備は [リポジトリの README](../README.md) の手順を使う。

```sh
just model-check durableObject                    # 二重獲得の反例と修正版
just test durable-object.spec.ts sync.spec.ts     # 実 API の成功件数と画面の巻き戻り
just guide-check                                  # 全モデル・引用・図の検査
```

`just guide-check` は `mizchi/explainer` の `verify-doc.mjs` を使う。スキルの置き場所が既定と違う場合は `EXPLAINER_SKILL` で指定する。

全モデルの検査結果は `docs/checks.json` の期待行と照合する。本文に全件のログは貼らず、以下から必要なモデルとテストを辿れる。

| 対象 | モデル | 実行検証の範囲 |
| --- | --- | --- |
| DO の二重獲得 | [durable-object.qnt](../models/durable-object.qnt) | [Worker API の E2E](../tests/durable-object.spec.ts) |
| Cache と画面 | [sync.qnt](../models/sync.qnt) | [配送順を制御した E2E](../tests/sync.spec.ts)。Cache の実動作は未検証 |
| waitUntil の中断 | [wait-until.qnt](../models/wait-until.qnt) | モデルのみ |
| Queues の重複・batch の失敗 | [queues.qnt](../models/queues.qnt)、[queue-consumer.qnt](../models/queue-consumer.qnt) | モデルのみ |
| K2 の lease・batch ack | [k2.qnt](../models/k2.qnt) | モデルのみ。実 K2 は未検証 |
| 保存から検索・監査 | [document-events.qnt](../models/document-events.qnt) | [ローカルの E2E](../tests/pipeline.spec.ts)、[HTTP 契約](../tests/k2-contract.spec.ts) |
| 保存の再送・隔離・期限切れ復旧 | [追加パターンの三モデル](recovery-patterns.md) | [API と画面の E2E](../tests/pipeline-recovery.spec.ts)、[復旧の操作列を照合するテスト](../tests/search-recovery.spec.ts) |
| D1 の replica 読取 | [d1.qnt](../models/d1.qnt) | モデルのみ |
| R2 の条件付き上書き | [r2.qnt](../models/r2.qnt) | モデルのみ |

D1 と R2 は、古い状態を前提にした操作の追加例だ。D1 は書き込み後も replica が古い版を返す反例を作り、[bookmark 付き session](https://developers.cloudflare.com/d1/best-practices/read-replication/#start-a-session-from-previous-context-bookmark)で、直前の書き込み以上の版を読む条件を検査する。

R2 は A/B が同じ ETag を読んだ後、A の更新を B が無条件に上書きする反例を作る。[`onlyIf.etagMatches`](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#conditional-operations)で、観測した ETag と現在の ETag が一致する時だけ更新する。両者とも、このリポジトリには実リソースや binding がない。
