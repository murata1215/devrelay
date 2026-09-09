# #381 マイグレーション: Windows Agent の scope 受信配線が発効（DB 変更なし）

`agents/windows/src/services/connection.ts` / `ai-runner.ts` に `agentScopeId` / `resumeSessionId` /
`turnId` の受信配線を追加した（サブサイクル C）。`schema.prisma` の変更は無い（core#336 のカラムは
`#376` で追加済み・server 側は無変更）。

## レイアウト分岐が実際に発効するのは本サイクルから

`#379`（サブサイクル B）の時点では `resolveScopeDir()` はストア層に存在していたが、呼び出し側が
`agentScopeId` を一切渡していなかったため実効果はゼロ（layout-neutral）だった。本サイクル（C）で
初めて Windows マシン上でも実際に `.devrelay/sessions/<agentScopeId>/` への分岐が発生する。

## R-B1: `u` 後の初回 MCP submission の一度きりの注意点

- Windows 機で `u`（Agent 自己更新）を実行し本サイクルの commit を反映した直後、**それ以前に開始済みの
  MCP submission セッション**（存在すれば）は旧レイアウト（フラットな `.devrelay/claude-session-id` /
  `.devrelay/conversation.json`）で resume しようとしていた可能性があるが、agent 再起動により
  メモリ上の `sessionInfoMap` は失われるため、`u` 後最初の MCP `submit_instruction` は
  **空の `.devrelay/sessions/<agentScopeId>/` から新規に始まる**（フラットな
  `claude-session-id` を resume することはない）。これは意図どおりの一度きりの挙動であり、
  データ損失やエラーではない
- 対話セッション（WebUI/Discord/Telegram/LINE）は `agentScopeId` を送らないため、`u` の前後で
  `.devrelay/` 直下のファイル配置・resume 挙動とも無変更

## 本サイクルで初めて Windows の挙動が変わる点（実害の解消）

サーバーは `agent:ai:output`（`isComplete=true`）の `turnId` + `aiSessionId` を突き合わせて
`Session.planAiSessionId` を保存する（`apps/server/src/services/agent-manager.ts`）。本サイクル以前は
Windows がこのエコーバックを一切送っていなかったため、`planAiSessionId` が永久に `null` のままとなり
**Windows マシンへの MCP `approve_implementation` は fail-closed のままだった**。本サイクルの
コミット2（C3 エコーバック）でこれを解消した。

## isEphemeral ゲート（#348）も同時に発効

- ask-member / teamexec-member / WebUI のプロジェクト説明生成（`crossquery_` / `teamexec_` /
  `askdesc_` プレフィックスの sessionId）は、Windows でも本サイクルから **projectPath 上の永続状態
  （conversation.json / claude-session-id / context-usage / .devrelay-output）を読み書きしなくなる**
  （読み取りゲートと書き込みゲートは同一コミットで導入済み。片方だけ先行させると新規リグレッションに
  なるため）
- 対話セッションはこのプレフィックスを持たないため、isEphemeral 判定は常に false のままで無影響

## D1（コード変更なし・Linux との挙動一致の確認のみ）

Linux の `saveConversation` も書き込み失敗時は `console.error` のみで自己修復しない
（`conversation-store.ts` 実測）。Windows も同じ挙動のため、本サイクルではコード変更を行わず
「Linux と同じ既知の限界」として記録するのみ。

## 適用手順

DB 変更が無いため `ALTER` は不要。

1. `git pull`（このサイクルの commit を取得）
2. `pnpm build`
3. Windows 機で `u`（`git fetch && git reset --hard origin/main` 相当の自己更新）
4. R-A3 実機 smoke: `markExecPoint` 経路で atomic-write の `fs.rename` が動くこと（`agent.log` に
   `⚠️ atomic-write: rename ... failed` が出ないこと。`-Encoding UTF8` 付きで確認）
5. MCP E2E: `submit_instruction` → `get_plan` → `approve_implementation` → 完了まで実行し、サーバー側で
   `Session.planAiSessionId` が null でないこと・exec が plan と同じセッションを resume していることを確認
6. 同一プロジェクトへ MCP submission 2本を同時に送り、`.devrelay/sessions/<id>/` が2つ生成されることを
   確認する。対話経路は引き続き `.devrelay/` 直下のまま変化しないことも確認する

## 互換性

- 旧 Agent（本サイクル未適用）× 新サーバー: 従来どおり `agentScopeId` 等を無視するため
  `planAiSessionId` は保存されず `approve_implementation` は安全側で拒否され続ける
- 新 Agent × 旧サーバー: server 側は `#376`/`#380` 以前から `agentScopeId` 等を送信しているため
  非該当（本サイクルは server 変更ゼロ）
- 対話経路（WebUI/Discord/Telegram/LINE）は `agentScopeId` を送らないため、resume 挙動・ファイル配置は
  本サイクルの前後で無変更
