# スレッド引継ぎ `n`（next thread）を追加 (2026-10-31)

## 経緯

「セッションの引継ぎ機能を作りたい」という相談から、プランモードで設計を詰めた。ユーザーと決めたこと:

- 種類は「新しいスレッドへの引継ぎ」（AI ツール間・端末間・人への引継ぎではない）
- 引継ぎ書は元スレッドの AI が書く（全文脈を知っているため。追加の API キーも不要）
- 元スレッドは残す。確認・編集画面は後回し
- コマンドは `n`（next thread）。新スレッドで `n` → 候補一覧、`n 1` → 引継ぎ完了。
  使用中の引継ぎがあるときは「別の引継ぎを使うと元の引継ぎは消えます」と出す
- 引継ぎ書は `doc/handover/` に置いて git で管理する（`w` でコミットされる）
- ファイル名は `YYYYMMDD_HHmmss_<元スレッドID>.md`、使ったら `..._<新スレッドID>.md` にリネーム。
  ID は全桁、要約はファイル名に入れない（中身を見る運用）
- 差し替えで外したファイルは未使用名に戻す

## 実現性の確認

- サーバーは「今のチャットのスレッドではないスレッド」でも 1 ターン走らせ、最終出力をサーバー側で受け取れる
  （MCP `ask_project`・`executeCrossProjectQuery` が使う `pendingCrossQueries` 方式）
- Agent の `sessionInfoMap` は sessionId キーで、各スレッドが自分の scope dir（resume ID・conversation.json）を持つ。
  元スレッドの `agentScopeId` で `server:session:start` してから送れば、元スレッドの文脈で答える
- 注意点: Agent は毎ターン `.devrelay-output/` を消す（project 単位）ので、裏ターンでは消さないフラグ（`handoverTurn`）を足した。
  完了時のプッシュ通知も `finalizeProgress` が必ず出すため、セッション単位の抑止（`setSessionNotifySuppressed`）を足した

## 実装

- shared: `UserCommand` に `handover:list` / `handover:pick`、`lastListType` に `'handover'`、
  WS 型 `server:handover:apply` / `agent:handover:applied`、`AiPromptPayload.handoverTurn`、
  capability `thread-handover`、`SHORTCUTS` に `n`、i18n（チャット文言 + `getHandoverPrompt()`）
- server:
  - `thread-handover-rules.ts`（純関数: キルスイッチ、スタンプ、候補選別、使い回し判定、引継ぎ書の整形）
  - `command-parser.ts` / `natural-language-parser.ts`（`n`・`n <番号>`、キルスイッチ OFF なら AI プロンプト）
  - `command-handler.ts`（`handleHandoverList` / `handleHandoverPick` / `performHandover`、`handleSelect` の `'handover'`）
  - `agent-manager.ts`（`runHandoverTurn` / `applyHandoverOnAgent`、`agent:handover:applied` の受信）
  - `session-manager.ts`（`setSessionNotifySuppressed`）
  - Prisma: Session に 6 列（プランの 4 列 + ファイル名特定用のスタンプ 2 列）
- agent（linux / macos）: `handover-store.ts`（byte-for-byte 同一）、`connection.ts`
  （`server:handover:apply` の処理、`handleAiPrompt` での注入と `clearOutputDir` 抑止）。
  Windows Electron 版は未実装のため capability を申告しない（サーバーは「未対応」で断る）

### 細部の判断

- `handoverDocAt` は AI 応答の `Message` 行が保存されるのを待ってから記録する
  （`handleAiOutput` は pending を resolve した後に非同期で行を作るため、先に記録すると使い回し判定が常に外れる）
- 使用中の引継ぎ元は `n` の一覧から外す（ユーザー提示の運用例どおり）
- 引継ぎ書の前置き（「以下が引継ぎ書です」等）は最初の `# ` 見出しより前を落とし、見出し直後にメタ行
  （元スレッド ID・作成日時・AI ツール）を入れる
- スタンプはサーバーのローカル時刻で採番する（Agent に渡す）

## 検証

- `pnpm build` green（6 workspace）、server・linux・macos・windows の `tsc --noEmit` green
- 新規テスト: server `thread-handover-rules.test.mjs` 10 件、linux `handover-store.test.mjs` 9 件、すべて pass
- フルスイート: server 1390 件中 1383 pass、linux 1178 件中 1158 pass。失敗はいずれも今回触っていないモジュールの
  Windows 環境起因のもの（POSIX パス・0600 権限前提）と、`tracked-imports` ガード（新規ファイルが未追跡のため。
  `git add` すれば解消する）
- DB: `prisma db execute` で列を追加し、`information_schema.columns` で 6 列の存在を確認。`prisma generate` は
  稼働中サーバーがクエリエンジン DLL をロックしているため DLL の置き換えだけ失敗したが、生成クライアント（JS/型）は更新済み
- 実機（チャットでの `n` / `n 1`）は未確認。サーバー再起動と各機 `u` の後に確認が必要

## 反映手順

- DB マイグレーション適用済み
- サーバー再起動（このマシンは `C:\tools\devrelay-restart.cmd`）
- 各機 Agent の `u`（linux / macos）
