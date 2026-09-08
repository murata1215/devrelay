# #379 マイグレーション: Windows Agent ストア層置換（DB 変更なし）

`agents/windows/src/services/session-store.ts` / `conversation-store.ts` を
`agents/linux` 版で byte-for-byte 置換した（サブサイクル B）。`schema.prisma` の変更は無い。

## レイアウトへの実際の影響（V3 訂正 — 重要）

依頼当初は「置換後は保存レイアウトが変わる」ことを前提にしていたが、実測の結果 **本サイクルでは
レイアウトは一切変わらない**（layout-neutral）。

- 新しい `resolveScopeDir(projectPath, agentScopeId?)` は `agentScopeId` が `undefined` のとき
  従来どおり `<projectPath>/.devrelay/` を返す
- Windows の `connection.ts` / `ai-runner.ts` は本サイクルで無変更（`git diff` 空）であり、
  `agentScopeId` を渡す呼び出し元がゼロ（`grep -rn "agentScopeId" agents/windows/src/services/connection.ts
  agents/windows/src/services/ai-runner.ts` が 0 件）
- したがって Windows マシンの `.devrelay/claude-session-id` 等は **サブサイクル B の適用前後で
  ファイル配置・resume 動作とも無変更**

レイアウト分岐（`.devrelay/sessions/<agentScopeId>/` への書き込み）が実際に発効するのは、
`agentScopeId` の受信配線を行う **サブサイクル C** から。C 適用後に初めて、MCP submission 経由の
セッションが従来の対話セッションと別ディレクトリに分離される。C 適用時点で新規に発生する一度きりの
注意点（対話セッションの `.devrelay/conversation.json` はそのまま・MCP 経由セッションのみ新レイアウトに
切り替わる）は C のマイグレーション文書側で扱う。

## 本サイクルで live になった内部実装の変化（レイアウトとは無関係）

- `markExecPoint()` が内部で `mutateConversation()`（`path-mutex` によるロック + ディスク再読込 +
  `atomic-write` による書き込み）を経由するようになった。保存先パスは変わらない
  （`.devrelay/conversation.json`）が、書き込み方式が「メモリ上の履歴をそのまま書く」から
  「ロック取得→ディスクから読み直す→変更を適用→アトミック書き込み」に変わった
- `getConversationContext()` の注入時に進捗マーカー除去（`stripProgressMarkers`）とプラン区間の
  絞り込み（`selectPlanMessages`）が適用されるようになった（詳細は devlog 参照）

## 適用手順

DB 変更が無いため `ALTER` は不要。

1. `git pull`（このサイクルの commit を取得）
2. `pnpm build`
3. Windows 機で `u`（`git fetch && git reset --hard origin/main` 相当の自己更新）
4. 実機 smoke（R-A3）: `e` を 1 回送って `.devrelay\conversation.json` に exec マーカーが付くこと、
   `agent.log` に `⚠️ atomic-write: rename ... failed` が出ないことを確認
   （`fs.rename` の Windows 上書き挙動は実機未検証のため、初回はログを目視すること）

## 互換性

- 対話セッション（人間が使い続けるセッション）は本サイクルの前後で保存レイアウト・resume 挙動とも無変更
- `agentScopeId` を送る経路（サブサイクル C 以降）が無いため、旧サーバー・新サーバーいずれと組み合わせても
  本サイクル単体では動作に差が出ない

## サイクル C への申し送り事項（本サイクルでは対応しない）

- **D1**: `saveConversation` の書き込み失敗は `console.error` に握り潰される（自己修復が効かなくなる、
  詳細は devlog）
- **#372 の save 側未移植**: `connection.ts:852` は保存時に `stripProgressMarkers()` を掛けていない
  （注入時のみ除去。`conversation.json` の肥大は本サイクルでは解消しない）
