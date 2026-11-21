# クロスユーザー Team Phase C: 購読/借用プロジェクトを Agents ツリーに出して会話する

## きっかけ

ユーザーからの指摘: 「今回ついかしてもらった購読って、askができるようになるよね。
agentツリーに購読したプロジェクトだして、現状のプロジェクトのように会話できるように
ならない？」。

公開型クロスユーザー Team（Phase A/B、2026-11-08〜09）で「購読する」ところまで到達したが、
宛先に到達する手段はチャットに `ask pixterm-server: 質問` と手打ちすることだけで、質問と
回答は宛先ユーザー側の一時セッション（`crossquery_<uuid>`、`userId = 宛先マシン所有者`）に
保存されるため、依頼者側にはリロードすると何も残らなかった。

## 調査で見つけた既存の権限昇格の穴

ツリーに他人の projectId を並べる前提として調査したところ、チャット（WS）経路にのみ
存在する既存の穴を 3 件発見した（REST/MCP 経路は全て `machine: { userId }` で絞っている）。

- `handleProjectConnect()`: `project.findUnique({ where: { id } })` のみで所有者未検証
- `handleMachineConnect()`: `machine.findFirst({ where: { id, deletedAt: null } })` のみ
- `handleProjectList()`: `where: { machineId: context.currentMachineId }` のみ

`m → 他人の machineId → p → 他人のプロジェクト一覧 → select → connect` という一本道が成立し、
クロスユーザー Team のメンバー行（`GET /api/teams`）には既に他人の projectId が入っているため
「ask だけ許したつもりの相手が exec まで到達できる」状態だった。`thread-api-guard.ts` の既存
純関数 `evaluateProjectOwnership()` を再利用して 3 箇所とも修正（キルスイッチの外、常時有効）。

## 設計: 送信フレームを別種にする

購読/借用プロジェクトは「質問専用タブ」として開き、`//connect` も `executeCommand()` も
一切通さない。新設 WS フレーム `web:cross:ask`（`platforms/web.ts`）のハンドラは
`handleProjectConnect`/`parseCommandWithNLP`/`executeCommand` を呼ばないため、入力欄に
`e`/`k`/`testflight`/`//connect` と打っても宛先への質問文字列として渡るだけで構造的に
exec へ到達できない（UI 側のガードが漏れても安全）。

## 実装内容（サーバー）

- `services/cross-ask-rules.ts`（新規、外部 import ゼロ）: `buildCrossAskTargetGroups()`
  （owner → machine → project のグループ化・ソート）、`decideCrossAskInput()`、
  `buildCrossAskContextPrefix()`（案 B、下記）
- `services/cross-session-stats.ts`（新規）: `document-api.ts` の private 関数だった
  `countRecentCrossSessions()` を抽出し `cross-ask-runner.ts` と共用。`document-api.ts` は
  この import に差し替え（挙動不変）
- `services/cross-ask-runner.ts`（新規）: `command-handler.ts` の `handleAskMember()` から
  宛先解決後の処理を `runCrossProjectAsk()` として抽出。既存チャット ask も同じ関数を通るため
  挙動不変。長さ検証（#335 ゲート⑤）・humanTextMeta・Session 作成・監査記録・
  `executorUserId`/`requesterUserId` の分離（`rules/project.md` 最重要設計判断）を集約。
  宛先プロジェクトに実行中の `crossquery_` があれば `targetBusy` で即断る同時実行ガードを
  新規追加（既存チャット ask にも波及する唯一の挙動変更）。タイムアウトを既定 12 時間から
  `ASK_ANSWER_TIMEOUT_MS`（15 分）に明示
- `services/cross-team-authz.ts`: `findCrossTeamAskProjectById()` を追加（既存
  `listCrossTeamAskCandidateProjects()` の結果から該当 1 件を探すだけ。新しい認可クエリは
  書かない）
- `services/cross-team-guard.ts`: `isCrossTeamChatEnabled()`/`isCrossTeamChatContextEnabled()`
  を追加（既定 ON、`DEVRELAY_CROSS_TEAM` との AND は呼び出し側が判定）
- `services/thread-scope.ts`: `buildCrossAskSessionIdFilter()` を追加（`crossquery_` 条件の
  単一情報源。将来 `crossask_` を足す場合は OR に 1 行足すだけで済む形にしてある）
- `routes/api.ts`: `GET /api/cross-team/ask-targets`（中身は
  `listCrossTeamAskCandidateProjects()` を呼ぶだけ）、
  `GET /api/cross-team/projects/:projectId/messages`（認可は `requestedByUserId === userId`
  の 1 条件のみ、projectId の存在確認はしない＝存在オラクルゼロ・購読解除後も自分の過去ログは
  読める）。併せて `GET /api/machines` の `projects` マップに `displayName` を追加（返していな
  かった既存バグ修正）
- `platforms/web.ts`: `case 'web:cross:ask'` を追加。`addParticipant()` は絶対に呼ばない
  （呼ぶと他人のマシンのツール承認カードが依頼者に飛び、押せてしまう）。応答は
  `sendWebMessage()`（`sendJson` ではない。15 分かかる間に WS が切れても再接続時にキューから
  フラッシュされる）、`sessionId` は乗せない（`crossquery_` は使い捨てのため、タブに
  sessionId を持たせると次の回答が `session-mismatch` で捨てられる）
- `packages/shared/src/types.ts`: `WebClientMessage` に `web:cross:ask`
  （`{ projectId, text }`、`files` を持たない＝ファイル添付非対応）を追加

## 会話の継続性: 案 C を自己レビューで撤回し、案 B に差し替え

ユーザー要望「これは継続したいな」を受け、当初は新プレフィックス `crossask_` を足すだけで
「サーバー側は一時扱い・Agent 側（`session-scope.ts`）は未知プレフィックスを `interactive`
と判定するので resume が効く」という案を採用しかけた。

**自己レビューで撤回**: Agent の「interactive 扱い」は会話の読み書きだけでなく
`clearOutputDir()`（質問のたびに所有者の `.devrelay-output/` を rm -rf）・
`savePlanFile()`（質問のたびに所有者の `.devrelay/plans/` が増殖）も同時に有効化してしまい、
**#348 で修正したはずの「cross-query のたびに対話セッションの書きかけ成果物が消える事故」を
そのまま再発させる**。さらに未更新の Agent（`u` を打っていない機）では新プレフィックスを
認識できないため同じ事故が起きる。

代わりに `cross-ask-runner.ts` 内で、同一 (依頼者, プロジェクト) の過去ログ（履歴 API と
同じクエリ）から直近 3 往復（`CROSS_ASK_CONTEXT_PREFIX_TURNS = 3`、最大
`CROSS_ASK_CONTEXT_PREFIX_MAX_CHARS = 6000` 文字で truncate）を取り出し、
`neutralizeHumanInputTag()` で無害化してから `fenceIfHuman()` の**外側**に
「これまでのやりとり（参考）」として前置する案 B を採用した。

- Agent 改修ゼロ・配布不要（旧 Agent が混ざっていても安全）
- セッションは従来どおり `crossquery_<uuid>` の使い捨て ＝ #348 のガードも監査の 1:1 対応も
  レート制限の数え方も一切壊さない
- キルスイッチ `DEVRELAY_CROSS_TEAM_CHAT_CONTEXT`（既定 1）で完全な 1 問 1 答に戻せる

本物の resume（案 C′）は、Agent 側に「会話は resume する・`clearOutputDir`/`savePlanFile`/
workState 注入はしない」という第三の種別（`classifySessionScope()` に `'crossAsk'` を追加）と
`AgentCapability`（宛先 Agent が申告している場合のみ使う）を実装する形で次サイクル以降に
先送りした。

## G-2: 併せて修正した既存バグ（クロス ask が所有者の work state を食う）

`connection.ts` の `loadWorkState(projectPath)` が `isEphemeral` を見ずに無条件で呼ばれており、
**現行のクロスユーザー ask（本サイクルの新機能ではなく、既存の `ask` コマンド）でも既に**

- 所有者の作業途中メモ（work state）が借り手向けのプロンプトに混入していた
  （クロスユーザーのデータ露出）
- `archiveWorkState()` でファイルが移動され、所有者の auto-continue が消費されていた

`agents/{linux,macos,windows}` の `connection.ts` 3 箇所を同一内容で修正
（`pendingWorkState = isEphemeral ? null : await loadWorkState(projectPath)`）。
反映には貸す側マシンの `u`（Agent 更新）が必要、未更新機は現状維持で degrade しない。

## 実装内容（WebUI）

- `lib/cross-ask-rules.ts`（新規、外部 import ゼロ）: `isCrossTab`/`shouldSendConnect`/
  `decideComposerCapabilities`/`buildCrossTabBanner`/`buildCrossTabBadge`/
  `resolveCrossHistorySource`/`flattenCrossAskGroups`
- `lib/api.ts`: `crossTeamChat.listTargets()`/`crossTeamChat.getMessages()` を追加
- `hooks/useWebSocket.ts`: `sendCrossAsk(projectId, text)` を追加
- `pages/ChatPage.tsx`:
  - `Tab` 型に `kind?: 'own' | 'cross'` と `crossMeta` を追加（省略時 `own` = 既存タブ互換）
  - Agents ツリー末尾に「🔗 購読・共有されたプロジェクト」セクション（独立 30 秒ポーリング、
    `machinesApi.list()` の 10 秒ポーリングには混ぜない。Phase B の教訓: 同じ
    `Promise.all`/`try` に混ぜると片方のキルスイッチ OFF で両方消える）
  - **`sendCommand('//connect …')` を撃つ 5 箇所を全部 `shouldSendConnect()` でガード**
    （再接続・マウント復元・`handleSelectProject`・タブクローズ後・Server 切替。
    実装中に `handleSelectProject`（TabBar クリックでも呼ばれる汎用ハンドラ）の
    ガード漏れを発見し追加修正——既存のクロスタブを TabBar から再選択すると `//connect`
    が送られてしまう穴だった）
  - マウント時のタブ復元に `crossTeamChat.listTargets()` をマージ（`projectInfoMap` に無い
    projectId を捨てる従来実装のままだとクロスタブがリロードで消えるため）
  - クロスタブでは `ThreadPane`/`ThreadList` を非表示、添付ボタン・停止ボタンを無効化
    （`decideComposerCapabilities()`）、ヘッダに常時バナー
  - `handleSend()`: クロスタブは `sendCrossAsk()` を使う

## テスト

- `apps/server/tests/cross-ask-rules.test.mjs`（新規、17 ケース）
- `apps/server/tests/cross-team-chat-wiring.test.mjs`（新規、23 ケース。ソース静的ガード。
  `web:cross:ask` が `executeCommand` 系を通らないこと、所有者チェックの後退防止、
  `executorUserId`/`requesterUserId` の分離、セッション採番が `crossquery_` のまま
  （撤回した案の復活防止）、G-2 の Agent 3機種ガード等）
- `apps/web/tests/cross-ask-rules.test.mjs`（新規、13 ケース）
- `apps/web/tests/cross-ask-source-guards.test.mjs`（新規、7 ケース。`//connect` 送信箇所が
  既知の 5 件から増減していないこと・全て `shouldSendConnect()` 配下にあることを機械的に固定）
- 既存テストの更新: `cross-team-api-wiring.test.mjs`（`countRecentCrossSessions` の抽出に
  追従）、`web-command-persistence-wiring.test.mjs`（`handleAskMember` → `runCrossProjectAsk`
  への委譲に追従）、`knowledge-source-guards.test.mjs`（ChatPage.tsx 行数ピンを実測値に更新。
  renderMarkdown 出現数は無変更のため据え置き）

## 検証

`pnpm build` 全 6 workspace green。`apps/server` の `node --test` 1540/1540、
`apps/web` の `node --test` 971/971、`agents/linux` 1275/1275、`agents/macos` 756/756
（既存 1 件 skip は無関係）、`agents/windows` 155/155（非退行、全て既存含む）。
`apps/web/dist` に CJS `require(` 混入なし。実機での往復確認（リロード後の履歴保持・
`e, ...` が質問として扱われること・既存の権限昇格の穴が塞がれたこと等）は未実施
（実装完了直後のため、再起動後にユーザー側で確認予定）。

## 変更ファイル

新規: `apps/server/src/services/{cross-ask-rules,cross-ask-runner,cross-session-stats}.ts`、
`apps/server/tests/{cross-ask-rules,cross-team-chat-wiring}.test.mjs`、
`apps/web/src/lib/cross-ask-rules.ts`、
`apps/web/tests/{cross-ask-rules,cross-ask-source-guards}.test.mjs`。

既存: `apps/server/src/services/{command-handler,cross-team-authz,cross-team-guard,
thread-scope}.ts`、`apps/server/src/routes/{api,document-api}.ts`、
`apps/server/src/platforms/web.ts`、
`apps/server/tests/{cross-team-api-wiring,web-command-persistence-wiring}.test.mjs`、
`apps/web/src/{hooks/useWebSocket,lib/api,pages/ChatPage}.ts(x)`、
`apps/web/tests/knowledge-source-guards.test.mjs`、`apps/web/tsconfig.test.json`、
`packages/shared/src/types.ts`、`agents/{linux,macos,windows}/src/services/connection.ts`、
`CLAUDE.md`、`rules/project.md`。

DB スキーマ変更なし。新規キルスイッチ `DEVRELAY_CROSS_TEAM_CHAT`・
`DEVRELAY_CROSS_TEAM_CHAT_CONTEXT`（両方既定 ON、`DEVRELAY_CROSS_TEAM` との AND）。
ソースコード変更ありのため `pnpm build` 実行済み、再起動が必要。

## 未解決（別サイクルで対応予定）

- 本物の resume（案 C′、`classifySessionScope()` + `AgentCapability` ゲート）
- クロスユーザー `teamexec`（exec）解禁（Phase 2）
- 進捗表示のリレー（承認カード抑止とセットで要検討）、`k` による停止、ファイル添付
- Agent CLI スキル（`devrelay-ask-member`）から購読宛先を引けない問題
  （`GET /api/agent/members` は `TeamMember` 行しか見ないため `TeamSubscription` の宛先が
  出てこない。認可は通るのに projectId が引けない非対称が残る）
- クロスタブあたりの会話は 1 本固定（複数スレッド・会話リセット手段は未実装）
