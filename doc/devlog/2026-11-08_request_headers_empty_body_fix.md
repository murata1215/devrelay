# body 無し POST が常に 400 になる既存バグの根治（WebUI 共通ヘッダー）

## きっかけ

公開型 Team Phase B の実機テストで、yahoo が「購読する」を押したら **Bad Request**
になった。「組織で公開中のチーム」には `pixterm` が 2 件（又貸し防止は正しく効いていた）
で出ていたため、Phase B 自体の実装は機能しているように見えたが、購読操作だけが失敗した。

## 調査

サーバーログに原因が明確に残っていた:

```
{"level":30,...,"res":{"statusCode":400},
 "err":{"type":"FastifyError",
        "message":"Body cannot be empty when content-type is set to 'application/json'",
        "code":"FST_ERR_CTP_EMPTY_JSON_BODY",...},
 "msg":"Body cannot be empty when content-type is set to 'application/json'"}
```

`apps/web/src/lib/api.ts` の共通 HTTP ヘルパー `request()`（L27-45）が、body の有無に
関わらず常に `Content-Type: application/json` を付けていた:

```ts
const headers: Record<string, string> = { 'Content-Type': 'application/json' };
...
body: body ? JSON.stringify(body) : undefined,   // body は undefined なのにヘッダだけ残る
```

`POST /api/teams/:teamId/subscribe` は body を取らない設計（`teams.subscribe(teamId)`
に引数は `teamId` のみ）。body 無しなのに「JSON を送る」と宣言する不正なリクエストに
なり、Fastify の既定 JSON パーサが**認証フックより前のボディパース段階で** 400 を返す
（ハンドラは一度も実行されない。`decideCrossTeamAccess()` 等の認可ロジックまで到達
すらしていなかった）。

### 本番サーバーへの無害な実証

```
POST /api/teams/xxx/subscribe + Content-Type: application/json・body なし → 400（認証前）
POST /api/teams/xxx/subscribe（Content-Type なし）                        → 401（認証まで到達）
```

### 影響範囲調査: 同じ条件の呼び出しが 5 箇所

`apps/web/src/lib/api.ts` 内で `body` 引数を省略している POST 呼び出しを grep した結果:

| 行 | エンドポイント | 影響する UI |
|---|---|---|
| L425 | `POST /push/fcm/test` | 設定画面の「テスト通知を送る」 |
| L940 | `POST /teams/invites/:id/decline` | 招待の「辞退」 |
| L973 | `POST /teams/:teamId/subscribe` | 「購読する」（今回発覚） |
| L1110 | `POST /org/leave` | 「組織を抜ける」 |
| L1372 | `POST /sites/:host/health-check` | Sites のヘルスチェック |

**いずれも今回の購読機能とは無関係に、以前から 400 で動いていなかった**（未検証のまま
放置されていた経路だったと考えられる）。

## 実装内容

リポジトリの既存流儀（外部 import ゼロの純関数 + `node --test`）に合わせ、
`apps/web/src/lib/request-headers-rules.ts` に `buildRequestHeaders({ token, hasBody })`
を新設。`hasBody` が true のときだけ `Content-Type` を付け、`token` が非 null のときだけ
`Authorization` を付ける（両条件は互いに独立）。

`api.ts` の `request()` 側は `buildRequestHeaders({ token: getToken(), hasBody: body
!== undefined })` に差し替えるだけ。body ありの呼び出し（大多数）は従来どおり
`Content-Type` が付くため挙動は完全に不変。body 無しの POST/PUT/PATCH だけヘッダが
外れて 400 が解消する。

### 採らなかった選択肢

サーバー側で空 JSON を許容する `addContentTypeParser` を足す案は検討したが採らなかった:
- ボディパースの挙動をサーバー全体で変えるため影響範囲が広い
- 本当に壊れたリクエストまで黙って通してしまう
- 原因はクライアントが「JSON を送る」と嘘の宣言をしていることなので、そこを直すのが筋

## 検証

`pnpm build` 全 6 workspace green。web バンドルに CJS `require(` 混入なしを確認。
`apps/web` の `node --test` 951/951（新規 7 ケース含む非退行）。`apps/server` の
`node --test` 1495/1495（サーバー側変更なし・非退行）。

テストには旧ロジック（常に Content-Type を付ける）を手元で再現して新旧を直接比較する
アサーションと、`api.ts` にヘッダ直書きが復活していないかのソース静的ガードを入れた
（将来うっかり元に戻されたら即座に落ちる）。

## 変更ファイル

新規 `apps/web/src/lib/request-headers-rules.ts`、
`apps/web/tests/request-headers-rules.test.mjs`。既存 `apps/web/tsconfig.test.json`
（include 追加）、`apps/web/src/lib/api.ts`（`request()` のヘッダ組み立てを差し替え）。
**サーバー側の変更なし。** DB スキーマ変更なし・新規キルスイッチなし。ソースコード
変更ありのため `pnpm build` 実行済み、再起動が必要。

## 留意事項

モバイルアプリ等 DevRelay 本体リポジトリ外のクライアントが同じ書き方（body 無しでも
常に `Content-Type: application/json` を付ける実装）をしていれば、同じ理由で 400 に
なる可能性がある。本サイクルでは `apps/web` のみ調査・修正しており、他クライアントの
有無・実装は未確認。

## 教訓

「body を取らない POST」は一見シンプルだが、HTTP ヘッダの宣言と実際の本文が
食い違うと、フレームワークのボディパース段階でハンドラに到達する前に落ちる。
新機能の実装時に「似た形の既存ボタンがちゃんと動いているか」を事前に確認していれば
早期に気づけた可能性がある（今回は 4 つの既存ボタンが未検出のまま壊れていた）。
