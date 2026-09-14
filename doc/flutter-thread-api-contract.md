# Flutter 向けスレッド API 契約（F0-b）

DevRelay サーバーは Session 行 = スレッド、1 project に複数 active スレッドが存在しうる前提
（スレッド管理サイクル1〜6 / 「(無題)」根治サイクル A〜C 適用後）。本書は Flutter クライアントが
`apps/server` のソースを読まずに実装できる粒度で、現行サーバーの契約を確定したものである。
**read-only 調査結果であり、本書自体はコード変更を伴わない。**

対象コミット時点: 2026-09-12（スレッド管理サイクル6 `69bcd3e` ＋ サイクル A/B/C 適用後）

---

## 1. 認証

- `Authorization: Bearer <token>` ヘッダー、または `?token=` クエリパラメータ
- トークンは `AuthSession.token`。残 TTL が 15 日未満になると自動的に +30 日へスライド延長される
- 他人のリソースへのアクセスは **403 ではなく 404**（リソースの存在自体を漏らさない設計）
- 全 `/api/*` レスポンスに `Cache-Control: no-store`

---

## 2. REST エンドポイント一覧

| # | Method | Path | 用途 |
|---|---|---|---|
| 1 | GET | `/api/threads?projectId=&limit=` | スレッド一覧（横断／プロジェクト絞り込み兼用） |
| 2 | POST | `/api/threads` | 新規スレッド作成 |
| 3 | PATCH | `/api/sessions/:id` | スレッド名変更 |
| 4 | POST | `/api/sessions/:id/switch` | 指定タブの current スレッドを切替 |
| 5 | GET | `/api/sessions/:id/messages?limit=&before=` | スレッドの会話履歴 |
| 6 | GET | `/api/projects/:projectId/messages?limit=&before=` | 旧・プロジェクト単位履歴（互換用。新規実装では使わない） |
| 7 | GET | `/api/projects/:projectId/approvals?limit=&before=` | 承認履歴（project 単位のみ、session 単位は無い） |
| 8 | GET | `/api/sessions/active?limit=` | 旧・プロジェクトごとの代表 active（互換用） |

> **`GET /api/projects/:id/threads` という個別エンドポイントは存在しない。**
> プロジェクト絞り込みは `GET /api/threads?projectId=<id>` の `projectId` クエリで行う。

---

### 2.1 `GET /api/threads` — スレッド一覧

```
GET /api/threads?projectId=<optional>&limit=<1..50, 既定50>
```

**レスポンス 200**

```json
{
  "threads": [
    {
      "sessionId": "clx1a2b3c",
      "title": null,
      "projectId": "clproj001",
      "projectName": "pixblog",
      "machineName": "hp630g9",
      "machineOnline": true,
      "aiTool": "claude",
      "status": "active",
      "lastActiveAt": "2026-09-12T10:15:30.000Z",
      "firstUserMessage": "READMEを更新して",
      "labelFromUser": "READMEを更新して",
      "labelFromAi": "承知しました。READMEを確認します",
      "messageCount": 12,
      "isScoped": false
    }
  ]
}
```

**フィールド仕様**

| フィールド | 型 | 説明 |
|---|---|---|
| `sessionId` | string | スレッド ID（= `Session.id`） |
| `title` | string \| null | ユーザーが明示設定した名前のみ。未設定は `null`（自動生成タイトルではない） |
| `projectId` / `projectName` | string | |
| `machineName` | string | `machine.displayName ?? machine.name` |
| `machineOnline` | boolean | 取得時点のリアルタイム接続状態 |
| `aiTool` | string | `"claude"` \| `"devin"` \| `"codex"` \| `"gemini"` 等 |
| `status` | `"active"` \| `"ended"` | この 2 値のみ（詳細は §6） |
| `lastActiveAt` | string (ISO8601) | `lastActiveAt ?? startedAt` |
| `firstUserMessage` | string \| null | 先頭 user メッセージの先頭 60 字（タグ除去なし、後方互換用） |
| `labelFromUser` | string \| null | `firstUserMessage` から `[exec]`/`[w]`/`[teamexec]` タグを除去したもの、先頭 60 字 |
| `labelFromAi` | string \| null | 先頭 AI 応答から進捗マーカー（`🔧`行）・コンテキスト情報（`📊`/`📝`prefix）を除去したもの、先頭 60 字 |
| `messageCount` | number | |
| `isScoped` | boolean | `agentScopeId !== null` |

**表示名（ラベル）導出の優先順位（★重要・クライアント側の責務）**

サーバーは単一の `label` フィールドを返さない。以下の優先順位で **クライアント側が** 表示名を組み立てること
（`apps/web` の実装と同一の規約に揃える）:

```
title → labelFromUser → labelFromAi → firstUserMessage → "(無題)" / "(untitled)"
```

いずれの段も「空文字列」は「無し」として次の段にフォールバックする。DB へは永続化されず、
一覧取得のたびにサーバー側で再計算される値である。

**サーバー側フィルタ（クエリの WHERE 句で除外。取得後の欠落ではない）**

- 一時セッション ID（プレフィックス `teamexec_` / `crossquery_` / `askdesc_`）
- ソフトデリート済み project / machine 配下のスレッド
- `status='ended'` かつ `messageCount=0` の抜け殻スレッド（「＋新規」直後の active・0件スレッドは対象外）
  - キルスイッチ `DEVRELAY_THREADS_HIDE_EMPTY_ENDED=0` で従来通り全件表示に戻せる（サーバー管理者向け）

**並び順**: `lastActiveAt` 降順（`NULLS LAST`）。`projectId` 省略時は**そのユーザーの全マシン・全プロジェクト横断**。

**エラー**: `projectId` 指定時のみ所有権チェック → 404 `{ "error": "Project not found" }`

---

### 2.2 `POST /api/threads` — 新規スレッド作成

```json
// Request body
{ "projectId": "clproj001", "tabId": "uuid-optional", "title": "optional, max 60 codepoints" }
```

```json
// Response 201
{ "sessionId": "clx9z8y7", "projectId": "clproj001", "projectName": "pixblog", "title": null }
```

- `title` は **60 コードポイント**上限（絵文字等のサロゲートペアも安全に判定）
- `tabId` を渡すと、そのタブの current スレッドが新スレッドに切り替わり、
  **WS 経由で `web:session_info` が該当タブへ push される**。
  Flutter は必ず自分の `tabId` を渡すこと（渡さないと WS 側の current が更新されない）
- 副作用: サーバー内部で `createSession()` → Agent へ scope 開始通知が送られる

**エラー**

| status | body | 意味 |
|---|---|---|
| 400 | `{ "error": "projectId is required" }` | `projectId` 欠落 |
| 400 | `{ "error": "title must not be empty" }` / `{ "error": "title too long" }` | title 検証エラー |
| 404 | `{ "error": "Project not found" }` | 存在しない／他人のプロジェクト |
| **409** | `{ "error": "Machine is offline" }` | **503 ではなく 409**。幽霊スレッドを作らせない設計。Flutter はオフライン時「＋新規」を無効化するか、409 を明示的にハンドリングすること |

---

### 2.3 `PATCH /api/sessions/:id` — スレッド名変更

```json
// Request body（必須）
{ "title": "新しい名前" }
```

```json
// Response 200
{ "sessionId": "clx1a2b3c", "title": "新しい名前" }
```

- **patch できるのは `title` のみ**（`status` 等は変更不可）
- **このエンドポイントは `web:session_info` を push しない。** 他タブは自力で一覧を再取得する必要がある
- エラー: 400（`title is required` / `title must not be empty` / `title too long`）、404（`Session not found`）

---

### 2.4 `POST /api/sessions/:id/switch` — タブの current スレッド切替

```json
// Request body（tabId 必須）
{ "tabId": "uuid" }
```

```json
// Response 200
{
  "sessionId": "clx1a2b3c",
  "projectId": "clproj001",
  "projectName": "pixblog",
  "machineId": "clmach001",
  "machineDisplayName": "hp630g9",
  "title": null
}
```

- 内部で `chatId = "web:{userId}:{tabId}"` を組み立て、その `ChannelSession.currentSessionId` を更新する
- 成功時、**該当タブに `web:session_info` が WS 経由で push される**
- エラー判定の順序が重要: **`tabId` 欠落は所有権チェックより先に 400 で弾かれる**
  （「tabId の有無で応答が変わる」ことでセッションの存在有無を推測されないため）
  - 400 `{ "error": "tabId is required" }`
  - 404 `{ "error": "Session not found" }`

> ★ **なぜ送信前に switch が必須か（§4 で詳述）**: `web:command` に `projectId` ヒントを付けて送るだけでは
> 「そのタブが直前に見ていたスレッド」または「最新の active スレッド」に暗黙で流れ込む可能性があり、
> ユーザーが明示的に選んだスレッドへの送信を保証できない。必ず本 API でタブの current を先に固定すること。

---

### 2.5 `GET /api/sessions/:id/messages` — スレッド履歴

```
GET /api/sessions/:id/messages?limit=<1..100, 既定30>&before=<messageId>
```

```json
// Response 200
{
  "messages": [
    {
      "id": "clmsg001",
      "role": "user",
      "content": "READMEを更新して",
      "createdAt": "2026-09-12T10:10:00.000Z",
      "files": [
        { "id": "clfile01", "filename": "screenshot.png", "mimeType": "image/png", "size": 20481, "direction": "input" }
      ]
    },
    {
      "id": "clmsg002",
      "role": "ai",
      "content": "承知しました。READMEを確認します。",
      "createdAt": "2026-09-12T10:10:05.000Z",
      "files": []
    }
  ],
  "hasMore": true
}
```

- `role` は `"user"` \| `"ai"` \| `"system"` の 3 値
- 返却順は **古い→新しい**（サーバー内部では `createdAt DESC` で取得後に反転している）

**ページネーション（`before` カーソル）の正確な仕様**

- `before` は **メッセージ ID**（タイムスタンプではない）
- サーバーは `before` で指定された ID の `createdAt` を DB から引き直し、`createdAt < その時刻` で絞り込む
- **`before` に存在しない ID（誤字・削除済み等）を渡すと、カーソル条件が丸ごと無視され最新ページがそのまま返る**
  （fail-open。エラーにはならない）
- 遡って読み込む場合は、**直前に受け取った配列の先頭（最古のメッセージ）の `id`** を次回の `before` に渡す

★ **打ち止め判定の推奨**: `hasMore: false` を最優先の終了条件とする。加えて防御的に、
「返ってきた配列の先頭 `id` が前回リクエストの `before` と同一、または前回取得結果の先頭 `id` と同一」の場合は
無限ループ防止のため取得を打ち切ること（`before` 不一致時の fail-open で同じページが返り続ける事態への対策）。

**エラー**: 404 `{ "error": "Session not found" }`（存在しない／他人のセッション）

---

### 2.6 `GET /api/projects/:projectId/messages` との差分（互換用・新規実装では非推奨）

| 項目 | `/api/sessions/:id/messages`（推奨） | `/api/projects/:projectId/messages`（旧・互換用） |
|---|---|---|
| スコープ | **1 スレッドのみ** | プロジェクト配下の**全セッションの発言が混在** |
| `limit` / `before` | 同じ仕様 | 同じ仕様 |
| 返却順 | 古い→新しい | 同じ |
| `role` | 同じ3値 | 同じ |
| `files` | あり（同一5フィールド） | あり（同一） |
| 追加フィールド | なし | `sourceProjectName?: string`（クロスプロジェクト問い合わせ由来の行のみ付与） |

**Flutter はスレッド画面で必ず §2.5 を使うこと。** §2.6 を使うと、同一プロジェクト内の
複数スレッドの発言が 1 画面に混在して表示される（これは現行 Flutter アプリで報告されている
「別スレッドの発言が混ざる」症状の直接原因）。

---

### 2.7 `GET /api/projects/:projectId/approvals` — 承認履歴

```json
{
  "approvals": [
    {
      "id": "clappr01",
      "requestId": "req-abc123",
      "toolName": "Bash",
      "toolInput": { "command": "npm install" },
      "status": "allow",
      "createdAt": "2026-09-12T10:00:00.000Z",
      "resolvedAt": "2026-09-12T10:00:05.000Z"
    }
  ],
  "hasMore": false
}
```

- `status`: `"pending"` \| `"allow"` \| `"deny"` \| `"auto"` \| `"timeout"`
- `requestId: null` は自動承認/自動拒否（ユーザー応答なし）を意味する
- **project 単位のみ。session 単位のフィルタ・pending 件数専用 API は存在しない**（§7 参照）

---

## 3. WebSocket 契約（`/ws/web`）

### 3.1 接続

```
wss://<host>/ws/web?token=<AuthSession.token>&tabId=<uuid>
```

- `token` 必須。欠落／無効時は `web:error` 送信後 `close(4001)`
- `tabId` は**省略可だが、省略すると接続のたびに新規 UUID が振られ状態が引き継がれない**
- サーバー内部の `chatId = "web:{userId}:{tabId}"` がタブの識別子
- **同一 `tabId` で新しい接続が来ると、既存ソケットは `terminate()` される**
  （＝ 1 tabId につき同時に張れる WS は 1 本のみ。chat 画面用と global/background 用で
  **別々の tabId** を使わないと互いに切断し合う）
- サーバーから 15 秒間隔で WS ping が送られる（Caddy 経由の接続維持用）

### 3.2 接続直後にサーバーが自動送信するもの

1. 切断中にキューされていた `web:response`
2. 進行中の進捗があれば `web:progress`
3. その `tabId` の current セッションに保留中の承認カードがあれば `web:tool:approval`

> **`web:session_info` は接続直後に自動送信されない。** 接続後の sessionId は
> `GET /api/threads` での確認、または `//connect` 送信で確定させること。

### 3.3 Server → Client フレーム一覧（sessionId の有無を含む）

| type | sessionId | projectId | payload |
|---|---|---|---|
| `web:response` | **あり**（※例外あり） | あり | `{ message, files?, projectId?, messageId?, sessionId? }` |
| `web:progress` | **あり** | あり | `{ output, elapsed, projectId?, sessionId? }` |
| `web:user_message` | **あり** | あり | `{ content, files?, projectId, sessionId }` |
| `web:session_info` | **常にあり（必須）** | 必須 | `{ projectId, sessionId, title?, agentScopeId? }` |
| `web:tool:approval` | **常にあり** | あり | `{ requestId, toolName, toolInput, sessionId, title?, description?, projectId?, isQuestion?, originProjectId? }` |
| `web:tool:approval:resolved` | **なし** | あり | `{ requestId, behavior: "allow" \| "deny", projectId? }` |
| `web:tool:approval:auto` | **なし** | あり | `{ toolName, toolInput, projectId?, status?, reason? }` |
| `web:assist:response` | なし | — | VoiceAssistResponse |
| `web:pong` | — | — | （なし） |
| `web:error` | なし | — | `{ error: string }` |

**sessionId が載らない既知の例外（fail-open 設計。バグではなく意図的な仕様）**

- セッション未参加時の応答は `{ message }` のみ（`projectId` すら無い場合がある）
- `//connect` コマンド自体への直接応答は `{ message, projectId }` のみ（sessionId は直後の `web:session_info` で補われる）

**受信ルーティングの推奨規則（fail-open。`apps/web` の `shouldRouteToTab()` と同じ考え方）**

> 「payload と表示中タブの両方に `sessionId` があり、かつ値が不一致のときのみ表示を捨てる。
> どちらか一方でも `sessionId` が無ければ（従来互換のため）表示する」

これを「`sessionId` 必須」という fail-closed にすると、上記の例外系フレームが全て表示されなくなる。

**例外: 承認カード（`web:tool:approval`）は fail-closed でよい**。`sessionId` を必ず持つため、
`sessionId` 完全一致でのみ表示する実装にすること（誤承認自体は `requestId` 一致で別途防止されている）。
なお `web:tool:approval` はセッション参加者が 0 件の場合、**接続中の全 Web クライアントへフォールバック配信**
される仕様があるため、`sessionId` 一致フィルタは表示側で必ず自前実装する必要がある。

### 3.3.1 永続化と配信スコープ（read-only 調査、2026-09-13）

Flutter で「一時ステータス通知が AI 吹き出しとして 2 回出る」「`web:progress` だけ 2 回に 1 回届かない」が
観測されたため調査した。**本節はコード変更を伴わない read-only 確認結果**。

**(a) 永続化の唯一の判別子は `payload.messageId` の有無**

`web:response` には 2 種類ある。専用の `type` やプレフィックス規約は存在しない。

| 区分 | 条件 | 例 |
|---|---|---|
| 永続化済み AI 応答 | `messageId` **あり**（DB `Message.id` と同一値） | AI の最終応答（`agent:ai:output` の完了時のみ `prisma.message.create` を経由） |
| 非永続の一時通知 | `messageId` **常に `undefined`** | `🤖 AI Status: {status}` + `✅/⚠️ DevRelay Agreement …`（1 フレーム内で `\n` 連結された 1 本の `message`）、`💾` ストレージ保存、`⛔`/`⚠️` キャンセル結果、`🛑` loop-guard、`🔄` session rotate、進捗タイムアウト通知、**および全コマンド応答**（`a`/`p`/`s`/`ag`/`//connect` 等、`executeCommand` の戻り値全般） |

非永続系はいずれも `GET /api/sessions/:id/messages` に出現しない（`Message` テーブルへの `create` を経由しないため）。
Flutter クライアントは **`messageId` の有無で「履歴に残る発言」と「一時通知」を区別すること**。
プレフィックス（絵文字）でのマッチングは i18n 文言変更に弱く非推奨（補助手段にとどめる）。

**(b) 一時通知が同一ターンで 2 回届くことがある（Agent 側の非冪等性）**

`🤖 AI Status: …` は Agent が `server:session:start` を受けるたびに無条件で送り返す（冪等でない）。
一方サーバー側は Agent 再接続のたびに内部フラグを立てるが、スレッド新規作成 API 経由の初回セッション開始では
このフラグをクリアしないため、「スレッド作成 → 直後の最初の送信」の 1 ターンに限り
`server:session:start` が実質 2 回発行され、結果として **同一の一時通知が数秒差で 2 通**届くことがある
（2 ターン目以降はフラグがクリアされるため発生しない）。

**C2 適用済み（サイクルS1、commit `1f29e2c`）**: `POST /api/threads` と MCP `submit_instruction`
のスレッド作成直後に `clearAgentRestarted()` を呼ぶよう修正済み。`//connect`（`handleProjectConnect`）は
元々この対策を持っていたため、現在は 3 経路すべてで揃っており、上記の 2 重送信は発生しない。

**Flutter 側の対策（引き続き推奨）**: 上記修正後もサーバー障害・タイミング差などで理論上ゼロ通を
保証するものではないため、`messageId` が無いフレームには classic（`apps/web`）と同じ
**「role + content が完全一致 かつ 直近 5 件以内 かつ 30 秒以内なら 2 通目を破棄」** という dedupe を
保険として実装しておくことを推奨する（必須ではなくなったが、他経路の保険として有効）。

**(c) 配信スコープと参加者評価タイミングは frame ごとに異なる**

| type | 配信先 | 参加者リストの評価タイミング |
|---|---|---|
| `web:response` | セッション参加者全員 | **フレーム送信のたびに live 評価** |
| `web:user_message` | セッション参加者全員（送信元 chatId を除く） | **フレーム送信のたびに live 評価** |
| `web:progress` | セッション参加者全員 | **C4 適用済み（サイクルS1、commit `1f29e2c`）: フレーム送信のたびに live 評価** |

**C4 適用済み（サイクルS1、commit `1f29e2c`）**: `web:progress` の配信先は、従来の「ターン開始時点の
スナップショットに含まれ、かつその瞬間 WS が OPEN だった chatId のみ・以降 8 秒ごとの更新もこの
スナップショットにしか送らない」という実装から、`web:response` / `web:user_message` と同じ
**フレーム送信のたびに live 評価**する実装（`resolveProgressRecipients()`、
`apps/server/src/services/progress-recipients.ts`）に置き換えた。
これにより、ターン開始後に参加した（または開始直前に再接続が完了していなかった）クライアントも、
**次の 8 秒フレームから** `web:progress` を受信できるようになった（1 ターン丸ごと 0 通、という状態は
解消済み）。旧実装の帰結だった「`web:progress` だけ届かない／2 回に 1 回」という観測はこれで解消される
（モバイル OS のバックグラウンド遷移で WS が瞬断・再接続するタイミングと重なると発生しやすかった）。

なお discord/telegram は編集対象メッセージが無い chatId への新規投稿を避けるため、`tracker` に
`messageId` の記録がある chatId のみを配信対象とする規則は維持している（web は編集を使わないため
常に対象に含まれる）。セッション参加を外れた chatId（`sessionParticipants` に居ない）は、
`tracker` に記録が残っていても以降のフレームを受け取らなくなる（`finalizeProgress()` と同じ挙動に揃えた
ための意図的な変更）。

再接続時には現在の進捗が 1 回だけ復元送信される救済経路があるが、**この復元フレームには `sessionId` が
含まれない**（`{ output, elapsed, projectId }` のみ）。fail-open ルーティング（3.3 節の推奨規則）であれば
表示されるが、`web:progress` を fail-closed（`sessionId` 必須）で実装している場合は消えるため注意。

**(d) `web:progress` の送信頻度**

ツールイベント駆動ではなく、**ターン開始時 + 以降 8 秒固定周期**（env で調整不可）。
Agent からの部分出力はいったんサーバー側バッファに溜まるだけで、それ自体はフレームを発生させない
（次の 8 秒周期でまとめて反映される）。したがって出力の無い処理（例: 1 分の `sleep`）の間は、
`output` が同一内容のまま `elapsed` だけ増える `web:progress` が **約 8 回**（0/8/16/…/56 秒）届き、
最後に `messageId` 付きの `web:response` が 1 通届いて終わる。Flutter は `elapsed` の増分で
更新を判定し、`output` の内容比較で新着扱いしないこと。

**(e) §2.1 `labelFromAi` のマーカー集合とは無関係**

`labelFromAi` が除去する `🔧`/`📊`/`📝` マーカーは、**DB に保存された AI 応答本文の中のノイズ**を
除去する目的のものであり、本節の一時通知（`🤖`/`⚠️`/`✅`/`💾`/`⛔`/`🛑`/`🔄`）とは対象も目的も別集合である。
一時通知はそもそも `Message` に保存されないため `labelFromAi` の対象にならない。両者を混同しないこと。

### 3.4 Client → Server フレーム一覧（全 4 種）

| type | payload | 備考 |
|---|---|---|
| `web:command` | `{ text: string, files?: FileAttachment[], projectId?: string }` | メイン送信フレーム。`text` 空 かつ `files` 空は無視される |
| `web:tool:approval:response` | `{ requestId, behavior: "allow" \| "deny", approveAll?, alwaysAllow?, answers? }` | 承認カードへの応答 |
| `web:assist` | `VoiceAssistRequestPayload` | 音声入力 |
| `web:ping` | （なし） | `web:pong` が返る |

**WS 経由でスレッドを切り替える専用フレームは存在しない。** 切替は次の 2 経路のみ:

1. REST `POST /api/sessions/:id/switch`（推奨）
2. `web:command` で `text: "//connect <projectId>"` を送る

`web:join` / `web:subscribe` に相当するフレームも無い。**あるスレッドへの「参加登録」は
`web:command` を 1 通送信した時点で暗黙に行われる**。WS 切断時は自動的に参加解除される。

---

## 4. `web:command` の送信先スレッド解決（★送信前 switch 必須の理由）

```
web:command { text, projectId? } 受信
 ├ projectId ヒントがタブの直前の lastProjectId と異なる → プロジェクト自動接続処理を実行
 ├ text が "//connect <projectId>" → 専用の接続処理を実行して終了
 ├ コマンド実行
 │   └ タブに current セッションが無い場合、直前のプロジェクトがあれば自動再接続を試みる
 └ 処理前後で current セッションが変わっていれば web:session_info を再送
```

**プロジェクト自動接続処理（`projectId` ヒント経由・`//connect` 経由 共通）の決定順序**

1. そのタブが直前に開いていたスレッド ID（優先）／明示指定 ID があればそれを優先候補とする
2. 同一ユーザー・同一プロジェクト・同一マシンの **active** スレッドを列挙
   - 優先候補が active 候補に含まれる → **それを再利用**
   - active 候補が 0 件 → 3 へ
   - それ以外 → **最終活動時刻が最新の active スレッドを再利用**
3. active が 0 件の場合、**ended** スレッドを確認:
   - 優先候補が ended スレッドの中にある → **その 1 本だけ復活**させて使う
   - 優先候補との一致がなく、かつ **マシンがオフライン** → 直近の ended スレッドを復活
   - それ以外 → **新規スレッドを作成**

「無条件に最新の ended を復活」はしない設計になっている（アイドルスイープで整理されるべき古いスレッドまで
復活させないため）。

**結論**: `projectId` だけを付けて `web:command` を送っても、
「そのタブの直前のスレッドに入る」「最新 active に吸い込まれる」「新規作成される」のいずれかであり、
**ユーザーが一覧から選んだ特定のスレッドへ送信される保証がない。**
そのため Flutter は、ユーザーがスレッドを選択またはメッセージ送信する直前に、必ず
**`POST /api/sessions/:id/switch` を呼んでタブの current を明示的に固定してから** `web:command` を送信すること。

---

## 5. `web:session_info` の再送と配信先

- 再送条件: `web:command` の処理前後で「そのタブの current セッション」が変化した場合のみ
- 配信先: **送信元のタブ ＋ 当該セッションに参加している他の Web タブ全員**
  （ユーザーの全ソケットに配信されるわけではない。参加していない別タブには届かない）
- REST 経由（`POST /api/threads` の `tabId` 指定時、`POST /api/sessions/:id/switch`）は
  **その 1 タブのみ**に push される
- payload の `title` / `agentScopeId` は、値が無い（null/未設定）場合は **キー自体が省略される**
  （`"title": null` のように送られるのではない）。Flutter のデコーダは両フィールドの欠落を
  許容する実装にすること

---

## 6. `Session.status` と生存状態

- 値は **`"active"` と `"ended"` の 2 値のみ**（既定値 `"active"`）。「processing」「waiting_approval」等の
  中間状態は存在しない
- `active → ended`: 明示的な終了操作 / Agent 切断時の一括終了 / サーバー起動時のアイドル掃除 / 定期スイープ
- `ended → active`（復活）: `//connect` 経由でタブの優先候補と一致した場合、またはマシンオフライン時の
  直近 ended 復活（§4 参照）のみ

---

## 7. 「処理中 / 承認待ち」バッジに使える材料（現状の制約）

| 欲しい表示 | 現状 REST で取得可能か |
|---|---|
| スレッドが active/ended か | ○（§2.1 の `status`） |
| マシンがオンラインか | ○（§2.1 の `machineOnline`） |
| メッセージ数 | ○（§2.1 の `messageCount`） |
| **処理中（ターン実行中）** | **×**。サーバー内部にインメモリの管理はあるが、一覧 REST には出ていない |
| **承認待ち件数**（スレッド単位） | **×**。プロジェクト単位の履歴 API（§2.7）はあるが、スレッド単位・件数専用の API は無い |

現状 Flutter の一覧画面が出せるバッジは「active/ended」「machineOnline」「messageCount」までであり、
「処理中」「承認待ち」は **そのスレッドの WS に接続している間だけ**（`web:progress` / `web:tool:approval` の
到着で）表示可能。一覧全体で常時表示するには、サーバー側に §9 候補 C 相当の対応が必要（本サイクルでは未実装）。

---

## 8. tabId とプッシュ通知に関する注意

### 8.1 tabId

- **セキュアストレージ等に永続化し、再起動・再接続をまたいで使い回すこと。** 毎回新規 UUID を
  発行すると、そのたびに「タブの current スレッド」がリセットされる
- **chat 画面用と global/background 用は必ず別々の `tabId` を使うこと**（同一だと接続が互いに `terminate()` される）
- 同一 `tabId` で再接続すると、サーバー側に保持されている current スレッドがそのまま復元される
  （サーバー再起動をまたいでも復元される）
- 新しい `tabId` で接続すると current スレッドは無い状態から始まる。古い `tabId` の状態は
  自動的には掃除されずサーバー側に残り続ける（実害はないが、無限に増やさない運用が望ましい）

### 8.2 プッシュ通知（FCM）

- FCM の `data` マップには **`sessionId` が含まれる**（ツール承認通知・応答完了通知の両方）。
  通知タップから該当スレッドへ直接遷移する実装は現行サーバーのままで可能
  （`sessionId` → `POST /api/sessions/:id/switch` → `GET /api/sessions/:id/messages`）
- 一方、**アプリ内の通知一覧 API（`GET /api/notifications`）が返す `Notification` には
  `sessionId` が含まれていない**（`projectId` までしか辿れない）。この一覧からスレッドへ直接
  遷移させたい場合はサーバー側の追加対応が必要（§9 候補 B）

---

## 9. server 側の変更候補（本サイクルでは未実装・提案のみ）

以下はいずれも **Agent（`agents/linux` 等）を一切変更しないため `u`（Agent 自己更新）は不要**、
`pnpm build` + `pm2 restart devrelay-server` のみで全マシンに反映される想定。DB マイグレーションが
必要なのは候補 B のみ。

| ID | 内容 | 影響範囲 | DB マイグレーション | 状態 |
|---|---|---|---|---|
| A | `web:command` payload に `sessionId?` を追加受付し、そのターンの配送先スレッドを直接確定できるようにする（現状は switch との2段階のためレースの余地が残る） | `apps/server` のみ | 不要 | 未実装 |
| B | `Notification` テーブルに `sessionId` カラムを追加し、通知一覧からスレッドへ直接遷移できるようにする | `apps/server` のみ | **必要**（1カラム追加、nullable） | 未実装 |
| C | `GET /api/threads` のレスポンスに `isProcessing` / `pendingApprovalCount` を追加する（サーバー内部に既にある管理データを一覧 API に露出するだけ） | `apps/server` のみ | 不要 | 未実装 |
| D | `PATCH /api/sessions/:id`（改名）でも `web:session_info` を他タブへ再送する | `apps/server` のみ | 不要 | 未実装 |
| E | `web:tool:approval:resolved` / `web:tool:approval:auto` に `sessionId` を追加する（現状 `projectId` 止まりで、同一プロジェクトの別スレッドの承認カードに影響しうる表示上の穴がある） | `apps/server` のみ | 不要 | 未実装 |
| C1 | `web:response` の payload に `transient?: true`（または `persisted: boolean`）を純加算し、3.3.1(a) の `messageId` 判別をクライアント側の推測ではなく明示フィールドにする | `apps/server` + `packages/shared` の型 | 不要 | 未実装 |
| C2 | `POST /api/threads` の直後に Agent 再起動フラグをクリアし、3.3.1(b) の一時通知 2 重送信の起点そのものを断つ | `apps/server` のみ（1 行） | 不要 | **適用済み（サイクルS1、commit `1f29e2c`）**。あわせて MCP `submit_instruction` にも同じ対策を追加済み |
| C3 | Agent 側で同一 `sessionId` への `session:start` 再送に対し `agent:ai:status` の再送を抑止（冪等化） | `agents/{linux,macos,windows}` | 不要（ただし commit+push+各機 `u` が必要） | 未実装 |
| C4 | `web:progress` の配信先をターン開始時スナップショットではなく送信時 live 評価に変更し、3.3.1(c) の「開始後に参加したクライアントに届かない」問題を根治する | `apps/server` のみ | 不要 | **適用済み（サイクルS1、commit `1f29e2c`）** |

C2・C4 は本サイクル（S1）で適用済み。C1・C3・A・B・D・E は引き続き**未実装**。
採否・優先順位は次サイクルで判断する（C3 は Agent 側の反映コストが高いため引き続き優先度低）。

---

## 10. Flutter 実装チェックリスト（まとめ）

- [ ] `tabId` を永続化し、chat 用／global 用で別々に持つ
- [ ] スレッド選択・送信の直前に必ず `POST /api/sessions/:id/switch` を呼ぶ
- [ ] 履歴取得は `GET /api/sessions/:id/messages` のみを使用（プロジェクト単位 API は使わない）
- [ ] `before` ページネーションは `hasMore` を主判定にし、先頭 ID の重複検知で打ち止めの保険を入れる
- [ ] 受信ルーティングは fail-open（承認カードのみ fail-closed で `sessionId` 完全一致）
- [ ] `web:session_info` はいつでも非同期に届きうる前提で、届いたら即座に画面の sessionId を更新する
- [ ] `title` / `agentScopeId` はキーごと欠落しうる前提でパースする
- [ ] スレッド表示名は `title → labelFromUser → labelFromAi → firstUserMessage → "(無題)"` の順で自前導出する
- [ ] オフラインマシンへの「＋新規」は 409 で失敗する前提でハンドリングする
- [ ] FCM の `sessionId` はスレッド直行に使えるが、通知一覧 API にはまだ無いことを認識する
