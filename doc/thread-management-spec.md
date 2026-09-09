# スレッド管理 spec v1（案 A: Session = スレッド）

作成: 2026-09-09 ／ 根拠: read-only 調査 `~/.claude/plans/enumerated-purring-pretzel.md`（submission `cmttyv0mm00fno1diuchhgt25`）

> **サイクル1 実装時の訂正（2026-09-09）**: §2 の ALTER を `agentScopeId` を含む3本に訂正（当初案は
> `title`/`lastActiveAt` の2本のみだったが、これだけでは対話経路のスコープを DB に永続できず
> スレッド分離が2発目のプロンプトで破綻するため）。詳細は `~/.claude/plans/curious-watching-whistle.md`
> の D1〜D3 と `doc/devlog/2026-09-09_202517.md` を参照。

## 0. 目的と範囲

1 プロジェクト内で複数の会話スレッドを持ち、WebUI の現タブ内パネルから
新規 / 切替 / 一覧 / 改名 できるようにする。ChatGPT / claude.ai 型スレッド管理の土台。

- スレッドは AI ツール非依存。各スレッドが「その AI で文脈を再開するハンドル」を持つ
  （claude: session UUID を `--resume`、codex / devin: agent 側 scope dir の付随状態、再開不可のツールは文脈なしで続行）
- v1 対象: server ＋ agent 最小変更（A1）＋ WebUI パネル
- v1 対象外（§10）: アーカイブ / 削除、Flutter、Lite シェル、Discord / Telegram からのスレッド指定、MCP からのスレッド指定

### 最終着地（Lite シェル、v2）

claude.ai 型の 3 ペイン。v1 はこの形に**そのまま持ち上げられる**ことを設計条件にする。

- 左: スレッド一覧。**プロジェクト横断**（ユーザーの全スレッドを `lastActiveAt desc`、各行にプロジェクト名バッジ）。上部に「＋ 新規」
- 中央（空状態）: 「どのプロジェクトで始めますか」= **プロジェクト選択**（machine / project、オンライン状態）。選択で新規スレッド開始
- 中央（スレッド選択後）: メッセージ一覧
- 下: 入力欄

プロジェクトタブは Lite シェルには無く、スレッドがプロジェクトを決める。
このため v1 のスレッド一覧 API・一覧コンポーネントは最初から**プロジェクト横断**で作り、現タブ内パネルでは `projectId` で絞って表示する。

## 1. モデル

| 概念 | 実体 | 備考 |
|---|---|---|
| スレッド | `Session` 行 | `title` を追加。1 project に active な Session が複数あってよい |
| スレッドの agent 側状態 | `.devrelay/sessions/<agentScopeId>/` | #336 の scope dir をそのまま使う。対話経路でも `agentScopeId = session.id` を採番 |
| タブの現在スレッド | `ChannelSession.currentSessionId` | 既存。`chatId = web:{userId}:{tabId}` 単位 |
| レガシースレッド | `agentScopeId = NULL` の既存 Session | agent 側状態は `.devrelay/` 直下（従来）。一覧では「既定」と表示。**NULL のまま触らない**（一斉に resume を失うため） |
| AI 再開ハンドル | agent の scope dir 内（対話経路） ／ `Session.planAiSessionId` `execAiSessionId`（MCP 経路） | サーバーは対話経路の UUID を関知しない（現状踏襲） |

前提確認（サイクル 1 の read-only で裏取り、結果は上記訂正と同じ devlog を参照）:
サーバー再起動 / agent 再接続 / `q` → `c` のとき Session 行が**同一 id のまま復元される**こと。
どこかで新規 Session が採番されて同じ会話が分断されるなら、案 A はスレッドが割れる → その経路を同一 id に直すか、案 B（Thread テーブル）へ切替を判断する。

**実測結果**: サーバー再起動／Agent 再接続／タブ再読込→`//connect` は同一 id を維持。`q`→`c` のみ新規採番
（`q` は明示終了操作のためスレッド分断ではなく正しい挙動と判断し、同一 id化の改修は行わない。案 B への切替は不要）。

## 2. スキーマ変更

```sql
ALTER TABLE "Session" ADD COLUMN "title" TEXT;               -- スレッド名（NULL = 未命名）
ALTER TABLE "Session" ADD COLUMN "lastActiveAt" TIMESTAMP(3); -- 最終利用日時（一覧ソート用）
ALTER TABLE "Session" ADD COLUMN "agentScopeId" TEXT;         -- Agent 側 scope dir の ID（= 自身の id）。NULL = 従来の .devrelay/ 直下（既存行は必ず NULL のまま）
```

Prisma（`schema.prisma`）:
```prisma
title        String?   // スレッド名（NULL = 未命名。一覧では先頭メッセージで代替表示）
lastActiveAt DateTime? // 最終利用日時（プロンプト送信ごとに更新。一覧ソート用）
agentScopeId String?   // Agent 側 scope dir の ID。NULL = 従来の .devrelay/ 直下（既存行はバックフィル禁止）
```

- `prisma migrate dev` 禁止。反映手順は §7
- `archivedAt` は v2 で追加（v1 では列を作らない）
- **`agentScopeId` の既存行は永久に NULL のまま**（backfill は推測であっても禁止）。NULL=従来挙動、非NULLのみ scope-aware 挙動。この不変条件は migration の SELECT 検証と単体テストの両方で担保する

## 3. サーバー

### 3.1 「1 project 1 active」前提の解消（S1〜S8）

plan ファイルの S1〜S8 を全て **sessionId キー**に直す。

- `getSessionIdByChatId()`（`session-manager.ts:40-45`）の線形探索を廃止し、`ChannelSession.currentSessionId` を正とする
- `web:response` / `web:progress` の配送は sessionId 基準。**participant ベースの配送自体は維持**し、payload に `sessionId` を付与する形で識別可能にする（背景プロジェクトタブへの配送を退行させないため）
- 受け入れ条件: 同一 project に active Session が 2 本ある状態で、片方への AI 出力がもう片方のタブに出ない

### 3.2 API（新規 / 変更）

| Method | Path | 内容 |
|---|---|---|
| GET | `/api/threads?projectId=` | 呼び出しユーザーの Session 一覧（**プロジェクト横断**、`projectId` は任意の絞り込み。active+ended を返す）。`{id, title, projectId, projectName, machineName, machineOnline, aiTool, status, lastActiveAt, firstUserMessage(先頭 60 字), messageCount}`、`lastActiveAt desc` |
| POST | `/api/threads` | body `{projectId, tabId, title?}`。Session 作成（status active、`agentScopeId = id`）→ agent に `server:session:start`（agentScopeId 付き）→ 呼び出しタブの `currentSessionId` を差し替え → `web:session_info` 送信。machine がオフラインなら 409 |
| PATCH | `/api/sessions/:id` | body `{title}`。改名。所有者チェック |
| POST | `/api/sessions/:id/switch` | body `{tabId}`。呼び出しタブの `currentSessionId` を差し替え。対象スレッドが `ended` の場合は `active` に戻す。agent 側にその Session が生きていなければ `server:session:start`（agentScopeId 付き）で復帰 → `web:session_info` |
| GET | `/api/sessions/:id/messages` | 既存・未使用。WebUI の履歴取得先として復活。所有者チェックを確認 |

`//connect`（プロジェクト選択）の互換: 接続先 project の**最新 active スレッド**に入る。無ければ新規作成。

### 3.3 WebSocket

- `web:session_info` に `title` と `agentScopeId` を追加
- 一覧の更新通知は v1 では持たない（クライアントが `session_info` 受信時に一覧を再取得）

### 3.4 `x` の扱い

- `x` は**現在スレッドの scope dir だけ**をクリアする（agent A1 が必要）。`Message` / `Session` は従来どおり無変更
- `agentScopeId = NULL`（既定スレッド）では従来どおり `.devrelay/` 直下をクリア
- **サイクル1時点では `agentScopeId` 付きスレッドへの `x` は fail-closed（未対応と案内し送信しない）**。
  agent 側（サイクル2）で scope-aware なクリアが実装されるまでの暫定措置。TODO コメント/テストで追跡し、
  サイクル2実装時に解除する
- パネルには `x` を出さない。「区切りたければ新規スレッド」を基本操作にする

### 3.5 MCP 経路

- `submit_instruction` が作る Session もスレッドとして一覧に出る（`title` は instruction の先頭行）
- `approve_implementation` / `get_build_status` / rollback は変更しない
- MCP からのスレッド指定は v2

## 4. agent（A1）

- `server:conversation:clear` に `agentScopeId?: string` を追加
- `handleConversationClear`（`connection.ts:731`）で scope dir を解決し、そのスレッドの `conversation.json` / devrelay-history / AI ハンドル（claude UUID、codex / devin 付随状態）をクリア。アーカイブ先も scope dir 配下
- `agentScopeId` 未指定は従来動作（互換）
- 対象: `agents/linux`（hp630g9 等 Windows 機も `agents/linux/dist` を node.exe で実行）／ macOS ストア。`agents/windows`（Electron）は未デプロイのため同期のみ
- 未 `u` の機体: `agentScopeId` を無視して従来動作。既定スレッドは壊れない。新規スレッドの `x` だけ効かない

## 5. WebUI

- スレッド一覧は独立コンポーネント `ThreadList` として作る（props: `projectId?`, `currentSessionId`, `onSelect`, `onCreate`）。
  v1 は現タブ内パネルに `projectId` 付きで置き、Lite シェルでは `projectId` 無しで左サイドバーに置く。**同じ部品**
- ChatPage の各プロジェクトタブ内、メッセージ一覧の左にスレッドパネル（折りたたみ可。モバイルはドロワー）
  - 行: `title` ／ 未命名なら `firstUserMessage` 先頭 40 字、相対時刻、現在スレッドをハイライト。`projectId` 無しのときはプロジェクト名バッジも表示
  - 「＋ 新規」、行クリックで切替、ペンアイコンで改名（インライン編集）
- 「＋ 新規」の空状態: v1（タブ内）はそのタブの project で即作成。Lite シェルでは中央にプロジェクト選択（machine / project、オンライン状態）を出し、選択で作成 — この選択 UI は v2
- 履歴取得を `/api/projects/:id/messages` → `/api/sessions/:id/messages` に差し替え
  - クロスセッションスクロールバックは v1 で「スレッド内のみ」に縮退。全体表示は会話履歴ページで代替
- `web:session_info` でハイライトと一覧を同期
- Plan / Exec カード、ツール承認カードは sessionId 紐づけのまま動く想定（サイクル 3 の read-only で確認）

## 6. 表示ルール

- 一覧の並び: `lastActiveAt desc`。`NULL` は `startedAt` で代替
- 既定スレッド（`agentScopeId = NULL`）は「既定」ラベル付きで常に表示
- 上限: v1 は active+ended を全件表示（50 件を超えるなら v2 のアーカイブで対処）

## 7. 反映手順（人間側）

1. `psql` で §2 の ALTER（3本）
2. `cd apps/server` → `npx prisma generate`
3. `pnpm build`
4. `pm2 restart devrelay-server`
5. サイクル 2 完了後、全機 `u`（Linux / macOS）

## 8. 受け入れ基準（E2E）

1. 新規スレッド作成 → agent 側に `.devrelay/sessions/<id>/` が作られる
2. スレッド A で「合言葉 X」を教え、B を新規作成して聞く → 知らない。A に戻して聞く → 答える（claude resume がスレッド単位）
3. 2 タブで A / B を同時に開き、A に投げた出力が B に出ない
4. 改名が一覧に反映され、リロード後も保持される
5. A で `x` → A の scope dir だけクリア、B は無傷（サイクル2以降で確認）
6. 未 `u` の機体で既定スレッドが従来どおり動く
7. MCP `submit_instruction` の Session が一覧に出て、approve 経路が壊れない
8. `//connect` で既存プロジェクトに入ると最新スレッドに入る

## 9. 実装分割

| サイクル | 範囲 | 人間側 |
|---|---|---|
| 1 server | §2 §3。テスト: S1〜S8 の誤配送回帰、API 所有者チェック、`//connect` 互換 | ALTER（3本） → generate → build → restart |
| 2 agent A1 | §4。テスト: scope dir 解決、`agentScopeId` 未指定の互換 | 全機 `u` |
| 3 WebUI | §5 §6 | E2E §8 |

各サイクルは read-only 確認 → Plan → 承認 → 実装。devlog は各サイクル冒頭。

## 10. v2 候補

- アーカイブ / 削除（`archivedAt`、`deletedAt` の soft delete）
- Flutter アプリのスレッド一覧
- Lite シェル（§0 最終着地）: 左 = `ThreadList`（プロジェクト横断）、中央空状態 = プロジェクト選択、下 = 入力欄。旧 UI とはトグルで切替、旧 UI は残す
- スレッド名の自動生成（初回応答後に AI が 1 行タイトルを付ける。v1 は先頭メッセージで代替）
- Discord / Telegram からのスレッド操作（`t` 一覧、`t 2` 切替）
- MCP `submit_instruction` の `threadId` 指定
- スレッド間の要約引継ぎ（新規作成時に前スレッドの要約を初期文脈に）
- 案 B への昇格（Session 1:1 で Thread 行を生成。A → B は無停止で可能）
