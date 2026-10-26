# `chatgpt-user` 障害の根治: AI CLI 検出が絶対パスを捨てて spawn ENOENT になる問題 (2026-10-27)

## 経緯

ユーザーが OS ユーザー `chatgpt-user` を新規作成し codex を導入、DevRelay Agent をインストールした。
チャットで「こんにちは」と送ると `Error: spawn codex ENOENT`。`u` → `u force` も
「✅ Agent は最新です」で何も起きなかった。

前日（2026-10-26）に直した同名の `spawn codex ENOENT`（真因＝`u` 自己更新が裸 node で
再起動し nvm 環境を失う）とは**別の真因**であることを実機で確認した。

## 調査（実機診断）

```
$ command -v codex
/home/chatgpt-user/.local/bin/codex
$ ls -l ~/.local/bin/codex
... -> ../lib/node_modules/@openai/codex/bin/codex.js
$ grep -A1 codex ~/.devrelay/config.yaml
  codex:
    command: codex          ← 素のコマンド名
```

| 項目 | 実測 |
|---|---|
| codex の実体 | `~/.local/bin/codex`（npm グローバルの標準的な場所。nvm ではない） |
| Agent 起動 | `systemd --user` の子プロセス。linger 有効で正常稼働 |
| タイムスタンプ | linger 作成 23:59 → codex シンボリックリンク 00:00 → Agent 起動 00:03 |

当初 nvm 由来（前日と同型）を疑ったが実機で否定され、より単純で確実なバグが見つかった。

## 真因（連鎖）

1. **23:59** インストーラ実行時点で `~/.local/bin` が未作成 →
   `scripts/install-agent.sh:924` の `if [ -d "$HOME/.local/bin" ]` が偽 →
   systemd unit の `Environment=PATH=` に `~/.local/bin` が入らない（`setup.ts` も同条件）
2. **00:00** ユーザーが codex を `~/.local/bin` に導入
3. **00:03** Agent 起動 → `detectAndUpdateAiTools()` がフォールバック候補
   （`aiToolFallbackCandidates()`）で `~/.local/bin/codex` の実在を検出したが、
   `ai-tool-probe.ts` の `probe()` が **boolean しか返さず、見つけた絶対パスを捨てて**
   `command: codex`（素の名前）を保存していた
4. 実行時 `spawn('codex')` → サービスの PATH に `~/.local/bin` が無い → **ENOENT**

副次的な増幅要因:
- `config.ts` の `if (config.aiTools[name]) continue;` — 一度書かれた素の名前は、
  何度 Agent を再起動しても絶対パスに昇格しない
- `filterPresentAiTools()` の fail-open — 1つも実在しないと config をそのまま返すため、
  UI は「Codex CLI ✓」と表示し続け、ユーザーには「入っている」ようにしか見えない
- `decideUpdateFlow()` — commit が最新なら `force` でも `upToDate` を返し Agent を
  再起動すらしない。「新 CLI を入れたら `u`」という定石が最新コミット時には機能しない
- `proc.on('error')` → `formatAiErrorMessage()` は Claude の OAuth 期限切れしか特別扱い
  しないため、生の `Error: spawn codex ENOENT` が素通りする（親切な `ai.cliNotFound` は
  close ハンドラ経由でしか出ない）

## 対応

Codex の `sandbox_mode` 分岐と同じ「唯一 plan/exec で挙動を変える」先例には倣わず、
今回は AI CLI 検出・PATH 解決そのものの構造的バグを直した。

- **`ai-tool-probe.ts`**: `probeDetailed()` で見つかった絶対パスも一緒にキャッシュし、
  新規 export `resolveAiToolFallbackPath()` で取得可能にする。既存の `isAiToolPresent()` は
  戻り値・キャッシュを完全に維持（後方互換）
- **`ai-tool-presence.ts`**: 純関数 `decideAiToolPathSelfHeal(existingCommand, fallbackPath)`
  を追加。「パスでない」×「PATH で解決不能」×「フォールバック候補に実在する」の3条件を
  すべて満たす時だけ昇格を許可し、ユーザー明示の絶対パスや PATH 解決可能なエントリは
  一切触らない
- **`config.ts`**: `detectAndUpdateAiTools()` が、新規検出時はフォールバックで見つかった
  場合のみ絶対パスを保存（PATH で引ける場合は従来どおり素の名前のまま。ツール更新で
  パスが変わっても壊れないように）。既存エントリも上記3条件を満たす時だけ自己修復する
  （`{ ...existing, command: healed }` で devin の `maxRuntimeMinutes` 等の他フィールドは保持）
- **`service-path-rules.ts`**: `buildServicePath()` の `hasLocalBin` 分岐を廃止し、
  `~/.local/bin` を無条件で PATH に含める（存在しないディレクトリが PATH にあっても無害）。
  「インストール順序に依存して PATH が変わる」という罠そのものを解消。`setup.ts` の
  `fs.access` 存在確認コードも不要になったため削除
- **`install-agent.sh` / `install-agent.ps1`**: 新規 `config.yaml` 生成時、
  `command -v "$tool"` / `(Get-Command $tool).Source` で解決した絶対パスを書き込む。
  crontab の `PATH=` も `SERVICE_PATH` 経由で同じ恩恵を受ける（`u` 自己更新の実起動経路）
- **`ai-runner.ts`（3 OS）**: `proc.on('error')` で `code === 'ENOENT'` のとき
  `ai.cliNotFound` を出す（従来は生エラーがそのまま出ていた）
- **`connection.ts`（linux/macos）**: `filterPresentAiTools()` の fail-open 発動を
  プロセス寿命中 1 回だけ警告ログに出す（#325 静かなフォールバック禁止）
- **`i18n.ts`**: `ai.cliNotFound` の文面を訂正。旧文言「`u` で再検出されます」は
  本件で誤りだと実証された（commit 最新時は `u`/`u force` が再起動しない、既存エントリは
  再起動しても自動では直らない場合がある）。実際に効く手段（`a` で切替・WebUI の
  再起動ボタン）に変更

## 見送った項目（ユーザー判断）

- **`u force` を「最新でも再起動する」に変更すること**: 却下（2026-10-27
  「さいきどうしないで」）。`decideUpdateFlow()` は現状のまま
- **`upToDate` 応答への案内文追加**: 見送り。追加すると `apps/server` の変更になり
  `pm2 restart devrelay-server` が必要になるため、Phase 1 を Agent 側だけに保つことを
  優先した。代わりに `ai.cliNotFound` の文面訂正で同じ案内を「実際に詰まった瞬間」に出す
- **`aiToolFallbackCandidates()` への nvm 候補追加**: 当初の仮説だったが実機で否定された
  （codex は `~/.local/bin`）ため見送り
- **`buildServicePath()` に nvm の bin を焼き込むこと**: node のバージョン更新で陳腐化し
  unit は自動では書き換わらないため、新たな壊れ方を作る

## 到達範囲の但し書き

`u`（自己更新）は systemd unit を書き換えない。したがって `service-path-rules.ts` の
修正が効くのは**新規インストールと `devrelay setup` 再実行のときだけ**で、既存機体の
unit は古い PATH のまま残る。既存機体は `config.ts` の自己修復（上記）で救われるため
実害は無い。既存 unit の一括修正は今回のスコープ外。

## 変更ファイル

`agents/{linux,macos}/src/services/{ai-tool-probe,ai-tool-presence,config,connection,service-path-rules}.ts`・
`agents/linux/src/cli/commands/setup.ts`・`agents/{linux,macos,windows}/src/services/ai-runner.ts`・
`agents/{linux,macos}/tests/ai-tool-presence.test.mjs`（新規テスト5件、decideAiToolPathSelfHeal）・
`agents/linux/tests/service-path-rules.test.mjs`（新シグネチャに更新）・
`packages/shared/src/i18n.ts`（`ai.cliNotFound` 文面訂正）・
`scripts/install-agent.sh`・`scripts/install-agent.ps1`

Windows Electron agent（`agents/windows/src/services/config.ts`）は `where` ベースの
単純な検出のみでフォールバック候補の仕組み自体を持たないため、probe/config 側の
修正対象外（`ai-runner.ts` の ENOENT ハンドリングのみ 3 OS 共通で対応）。

## 検証

`packages/shared` → `agents/{linux,macos,windows}` の順に個別 `tsc --noEmit` で green
確認後、`pnpm build`（モノレポ全体 6 workspace）green。shared104/104・server1380/1380・
web924/924 green（apps/server・apps/web は 0 行変更）。
linux1164/1164 green（既知flakeゼロで通過）。macos723件中722pass+skip1（`conversation-store-scope.test.mjs`
の既知flake1件、単体実行では7/7 green、本変更と無関係と確認済み）。
windows147件中146pass（同じ既知flake、単体実行では7/7 green）。
`ai-tool-probe.ts`/`ai-tool-presence.ts`/テストファイルは linux/macos 間で byte-identical
維持を diff で確認。`install-agent.sh` のループロジックをダミー codex バイナリで
分離シミュレーションし、PATH 解決時は絶対パス・未検出時は素の名前のまま、という
両分岐を実際に確認した。`grep -c 'require(' apps/web/dist/assets/index-*.js` = 0。

## 反映

`agents/*` + `packages/shared` + `scripts/` のみの変更。`apps/server`・`apps/web` は
0 行変更（`ai.cliNotFound` は Agent のみが参照することを grep で確認済み）のため
**`pm2 restart devrelay-server` は不要**。各機で `u` が必要（今回は新 commit があるため
実際に更新・再起動される。`chatgpt-user` では更新後に `config.yaml` の `codex` エントリが
自動で絶対パスへ自己修復されることを次回 `u` 実行時に確認予定）。DB マイグレーション不要。
commit `8734d5d` push済み（main直接）。実機での最終確認（`chatgpt-user` でのチャット応答）は
人間側実施待ち。
