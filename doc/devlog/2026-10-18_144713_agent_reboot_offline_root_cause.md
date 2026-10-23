# x220-158-18-103 Agent 12 体オフライン事故（Phase 0 復旧＋真因 2 件の根治）

- 発生: 2026-10-18 02:46 のマシン再起動後
- 対応: 同日実施（Phase 0 復旧 → 真因調査 → 本体コード修正）

## 概要

`x220-158-18-103` の DevRelay Agent 13 体のうち 12 体が、マシン再起動後にオフラインの
まま復帰しなかった。引き金はサーバー側の起動ハング（別件、`doc/server_listen_hang_20261018.md`
の対策A で解消済み）だったが、調査の過程で **DevRelay 本体の独立したバグ 2 件**を発見した。

## 発見した真因（DevRelay 本体のバグ）

### 真因1: `u` 自己更新の crontab 書き換え sed が冪等でなかった

`agents/linux/src/services/connection.ts`（旧 :3301）の `fix crontab` ステップ:

```
sed 's/export PATH=\([^ ]*\) cd/export PATH=\1; cd/'
```

`[^ ]*`（空白以外の連続）がセミコロンも貪欲に飲み込むため、既に `; cd` を含む行に
再度適用すると `;; cd` になる。**`u` を実行するたびにセミコロンが1個増え続け**、
数回の `u` で crontab の行がシェル構文エラー（`;;` は bash の syntax error）になり、
`@reboot` が発火しても何も実行されなくなっていた。

実機で発見した時点でのセミコロン数（＝そのユーザーの `u` 実行回数）: `pixblog` 97、
`ribbon` 82、`pixwriter` 80、`clipped` 77 など。前回の再起動が 69 日前だったため
今回まで顕在化しなかった。

**修正**: `agents/linux/src/services/crontab-fix-rules.ts` を新設し、キャプチャを
`[^ ;]*`（セミコロンも除外）に変更。「何度適用しても結果が変わらない」ことを
node:test で保証（実際に発生した 97 セミコロンの破損行でも再現・修正を確認済み）。

### 真因2: systemd unit を書く2つの経路でテンプレートが乖離していた

- `scripts/install-agent.sh:768-782` は `Environment=PATH=` を明示
- `agents/linux/src/cli/commands/setup.ts` の `installUserService()` は
  `Environment=NODE_ENV=production` のみで PATH 未指定

systemd user service は `.bashrc` を読まないため、PATH 行が無いと `which` ベースの
AI ツール検出（`detectAndUpdateAiTools()`）が失敗しうる（実機で `pixblog` の unit が
`setup.ts` 経由で作られ、この状態になっていた）。

**修正**: `agents/linux/src/services/service-path-rules.ts` を新設し、
`install-agent.sh` と同じ PATH 組み立てロジックを `setup.ts` からも使うようにした。

## Phase 0: 復旧スクリプト（`.devrelay-output/revive-agents.sh`）

診断 → systemd + linger への統一 → journal ベース検証、の3段構成。実行過程で
2 件の実装ミスを発見・修正（詳細は後述）。最終的に 12 体すべてを online に復帰させ、
マシン再起動（2026-10-18 14:30）での最終検証でも **手動復旧ゼロで 13/13 online** を確認。
listen 開始まで 19 秒（前回障害時は 6 時間 26 分）。

### スクリプト自身の実装ミス2件（修正済み）

1. **未知の引数をサイレントに無視**: `-apply`（ハイフン1個の打ち間違い）が警告なしに
   診断モードへ落ちる作りだった。「実行したつもりで実行されていない」という最も危険な
   失敗モードを招いた（実機で発生）。修正: 不明な引数はエラーにして `exit 1`、
   ハイフン1個のよくある打ち間違いには具体的なヒントを出す。
2. **`WorkingDirectory` に `/dist` が混入**: `agent_dir=$(dirname "$entry")` の
   計算ミスで `.../agents/linux/dist` になっていた（正しくは `.../agents/linux`）。
   実害評価: `process.cwd()` 依存箇所が Agent 側に 0 件、AI 実行は
   `cwd: projectPath` を明示しており実害なし。installer のテンプレートと
   一致させるため修正し、健全性チェックにも検出項目を追加（次回 `--apply` で
   既存ユニットも自動修正される）。

## テスト

- `agents/linux/tests/crontab-fix-rules.test.mjs`（新規7件）: 旧形式→新形式変換、
  **冪等性（10回適用して1回目と同一）**、実機の97セミコロン破損行での回帰確認、
  無関係な行への非干渉
- `agents/linux/tests/service-path-rules.test.mjs`（新規3件）: PATH組み立て順序、
  `~/.local/bin` 有無の分岐、install-agent.sh のテンプレートとの一致
- `agents/linux` フルスイート 1083件中 1082 pass・1件は既知flake（`handle-conversation-clear.test.mjs`
  または `file-handler.test.mjs`。いずれも `mkdtemp`/`tmpdir` を使うテストで、
  単独実行でも非決定的に pass/fail が入れ替わることを確認済み。今回の変更箇所とは
  無関係 — importグラフが重ならない）

## 影響範囲

- `agents/linux` のみ変更（`agents/macos` / `agents/windows` は対象外。
  真因1の sed は linux にしか存在せず、真因2の `setup.ts` も linux 専用）
- `apps/server` / `apps/web` / `packages/shared` / Prisma は **0 行変更**
  （grep で確認済み）
- DB マイグレーション不要
- `pnpm build`（`@devrelay/agent`）実施済み。`pm2 restart` 不要
  （サーバー側は無変更）
- **各機 `u` が必要**（Linux Agent 全機。現在 Linux は x220 のみ稼働中）。
  ただし commit/push 未実施のため `u` は今はまだ届かない

## 次サイクル（未実施）

- 対策D（再接続の回数打ち切り廃止、`lastConnectedAt` バグ修正、2段バックオフ）
- AI ツール検出への絶対パスフォールバック追加（`detectAndUpdateAiTools()`。
  特に gemini/codex には locator が無い）
- インストーラ是正（`install-agent.sh:790` の linger 失敗可視化、
  `management-info.ts` の systemd コマンドへの `XDG_RUNTIME_DIR` 前置）
- `devrelay` 自身（13体目）の systemd 化（crontab は無傷なので緊急性低）
- 対策B/C（`pm2-devrelay.service` の起動順序、`/health` 死活監視）

commit/push 未実施。
