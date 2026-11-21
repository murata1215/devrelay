# サイクルS2: クロスユーザー ask の隔離強化（読める範囲の制限と、リセットで本当に消えること）

> 本ファイルは Plan フェーズで提示したプラン全文（人間の承認メモによる追補・方針変更を含む）を
> そのままコピーしたものである。承認メモの指示により、本サイクルで実装したのは **S2a + S2b のみ**
> （S2c「記録の後片付け」・S2d「capability + キルスイッチ + 文面/表示」・S2e「文書」は未実装）。
> 実装結果・実測値・残課題は `doc/devlog/` の個別ファイルと `doc/changelog.md` を参照。

---

## 1. 背景（確認済みの事実）

2026-11-11 22:37 JST、別ユーザーが askreset の直後に ask したところ、貸す側の AI は
`~/.claude/projects/-home-devrelay-testflight-pixterm-server/`（Claude 自身の会話記録、jsonl）を
読み、リセット前の内容をすべて答えた。同じターンで `ls -lt ~/.claude/projects/` も通り、貸す側の
全 12 プロジェクトの記録フォルダ名が見えた。

サイクルS1（`d41690b`/`3f4c14c`/`6163427`/`c589023`）で、プランモードの Bash は PreToolUse フック
（`decidePlanPermission`）を必ず通るようになった。ただしゲートの方針は cat/grep/find/ls/head/tail
などをパスの制限なしで許可しており、Read/Glob/Grep にもパスの制限が無い（`additionalDirectories`
未設定、cwd は境界になっていない）。curl は既定の許可側、WebFetch/WebSearch も読み取り専用ツール側
にある。

askreset / 世代切替の後片付け（clearConversation）は、消す前に `<scopeDir>/conversation-archive/`
に全履歴の写しを作る。スコープのフォルダはプロジェクト配下
（`<projectPath>/.devrelay/sessions/crossask-…`）に残る。

ask 経路の SDK オプションは `settingSources: ['user','project']`、`mcpServers`/`strictMcpConfig`
未指定のため、貸す側アカウントの claude.ai コネクタ（devrelay、Google Drive、Gmail など）と
context7 プラグインのツール定義がセッションに載る。

windows 版はゲート未対応で、クロスユーザー ask は capability により既に断られる。

## 2. 目的

質問する側（別ユーザー）が、貸す側の AI を通じて到達できる範囲を「貸されたプロジェクトの中身
（秘密を除く）」に限定する。あわせて askreset と世代切替で、その質問者とのやり取りが AI から
読める場所に残らないようにする。

## 3. Plan フェーズでの実測（Step 0、人間承認前）

* `client_composed:true` を付けた streamed message で `@/etc/hostname` のような `@パス` 記法が
  **展開されない**こと（control: client_composed 無しでは marker が漏れる、test: 漏れない）を
  実 SDK（0.3.282）で確認。
* `settingSources:[]` + `mcpServers:{}` + `strictMcpConfig:true` + `tools:['Read','Grep','Glob']`
  の組み合わせで、`system/init` メッセージの `tools` が `['Glob','Grep','Read']` に、`mcp_servers`
  が空配列になることを確認（baseline では Bash/Edit/Write/Skill/WebFetch/WebSearch/ToolSearch/Task
  と claude.ai コネクタ4種+context7 プラグインが載っていた）。
* `settings.disableBundledSkills:true` を追加しても、CLI 組み込みのバンドルスキルが**完全には
  0 件にならない**（18件→2件。残る2件は Skill ツール自体が `disallowedTools` で使用不可のため
  実行はできない）。
* `persistSession:false` で `~/.claude/projects/<slug>/` が作られないこと、既定（未指定）では
  作られることを確認。
* `~/.claude/settings.local.json`（ホームディレクトリ直下）の `permissions.allow`
  （`Bash(npx tsc:*)` 等）が、cwd をプロジェクトパスに設定した現行 ask 経路の
  `settingSources:['user','project']` では**フックをバイパスしない**ことを実測
  （`hasMcpServer`/bare 系の既知バイパスとは別経路。CLI の `localSettings` 解決は cwd 相対の
  `<cwd>/.claude/settings.local.json` であり、ホーム直下の同名ファイルは別物で読まれない）。
* この会話自身のプランモードで `git -C /opt/devrelay status`/`git -C /opt/devrelay log -1 ...`
  が**実際に通った**ことを実地確認（既存バイパス、新発見②の実証）。

## 4. 方針（A〜E）

### A. 読める範囲

クロスユーザー ask のセッションでは、読めるのは貸されたプロジェクトのディレクトリ配下だけとする。
パスは実体（realpath）で判定し、プロジェクトの外を指すシンボリックリンク、`..`、`~`、環境変数、
絶対パスのグロブを通さない。プロジェクトの中でも次は読ませない: `.devrelay/` 配下、`.env` 系、
秘密鍵や証明書などの秘密ファイル、`.git/` 全体（config だけでなく logs/HEAD・packed-refs・hooks・
objects も情報源）。

### B. Bash

**「原則全 deny」を採用**（「git 読み取りだけ残す」案は不採用）。`git log -p -- .env` /
`git show <blob>` / `git grep` / `git cat-file` は A の deny 一覧のファイル内容をそのまま印字でき、
サブコマンド allowlist の網羅性も保証できないため。失うのは「他人のコミット履歴を機械的に掘る」
ことだけで、ask の主目的（設計・仕様の質問）は損なわれない。

OS レベルの隔離（sandbox / bubblewrap）は**今サイクルでは不採用**。SDK の `sandbox` オプションは
「FS/ネットワークの制限は permission rules 側」で、読み取り遮断の主防御にならない。Bash を全 deny
する本案では sandbox が守る対象（サブプロセス）自体が存在せず効果が重複する。`failIfUnavailable`
既定 true のため、bubblewrap の無い機体でクロス ask が丸ごと起動失敗に化けるリスクもある。

### C. 外部通信と MCP

`tools:['Read','Grep','Glob']`（基底集合、未知ツールに fail-closed）+ `disallowedTools`（既知名の
実行段 deny、harness 内部の直接呼び出しもブロック）+ PreToolUse フック（唯一の権威）の3層。
`mcpServers:{}` + `strictMcpConfig:true` + `skills:[]` + `settings.disableBundledSkills:true` +
`settings.enabledPlugins:{}` + `settings.disableClaudeAiConnectors:true`。

**`settingSources` は `[]`**（`['project']` から変更。Plan フェーズの敵対的レビューで指摘）。
`['project']` だと貸したプロジェクトの CLAUDE.md は読めるが、同時にプロジェクト
`.claude/settings.json`/`.claude/settings.local.json` の `permissions.allow`・プロジェクト
hooks・`.claude/agents`/`.claude/commands`/`.claude/skills` の `allowed-tools` frontmatter・
`.mcp.json` という5系統の注入経路が同時に開く。CLAUDE.md は Agent 側で自前で読んでプロンプトに
注入する（パスゲート通過・`@` 行の除去・サイズ上限）。

質問文中の `@パス` 記法・スラッシュコマンドのディスパッチは `client_composed:true` を streamed
message に付けて防止する（SDK 型定義が明記する専用の防御手段。副作用としてターン開始の
attachment pass 全体がスキップされ、nested CLAUDE.md の `@相対パス` import も同時に塞がる）。

### D. 記録の後片付け（本サイクルでは未実装、S2c に委ねる）

写しを作らない・scope dir をプロジェクト外へ移す・jsonl を削除する、という3点は**本サイクルの
スコープ外**（承認メモにより S2a + S2b のみ実装）。A の読める範囲の制限により、ask 経路の
`cwd` がプロジェクトパスである限り `~/.claude/projects/**` はそもそも読めなくなるため、
**今回の実被害事例（AI が自分の jsonl を読んで答える）の再現は S2a だけで防げる**。jsonl
ファイル自体の作成・写しの作成は引き続き発生する（残存リスク、完了報告に明記）。

### E. 既存の残骸

プロジェクト配下の `crossask-*` フォルダ・写し・過去の jsonl は AI が削除しない。人間が実行する
削除コマンドを完了報告に示す。

## 5. 抜け道の列挙と対処（Plan フェーズの敵対的レビューで発見した新規項目を含む）

| # | 抜け道 | 対処 |
|---|---|---|
| 1 | シンボリックリンク | realpath で実体解決し境界判定。プロジェクト内を指すリンクも構成要素チェックで deny（defense-in-depth） |
| 2 | ハードリンク | 検出不能だが Bash 全 deny で作成手段が無い（低リスク） |
| 3 | Glob/Grep の path/pattern | path は Read と同検査、pattern/glob は相対のみ（Grep の検索正規表現 pattern は対象外） |
| 4 | NotebookRead | 引数キー whitelist 方式により `tools` から外れていれば deny、キー検査でも notebook_path は未知キーとして deny |
| 5 | /proc・/dev | 境界判定で deny |
| 6 | サブエージェント | `tools`/`disallowedTools` に加え `agent_id` フィールドで無条件 deny |
| 7 | ToolSearch | `tools`/`disallowedTools` で deny |
| 8 | 質問文中の @パス 自動展開（ツール呼び出しゼロで漏れる最重要項目） | `client_composed:true` |
| 9 | CLAUDE.md の取り込み | `settingSources:[]`。プロジェクト CLAUDE.md は Agent が自前で読み、`@` 行除去 + サイズ上限で注入 |
| 10 | 自動メモリ | env 3種 + `settings.autoMemoryEnabled:false` + 退避先ディレクトリの3層 |
| 11 | Read 単体での秘密ファイル読み取り | realpath 境界判定 + deny パターン一覧（二重） |
| 12 | settings インライン注入の fail-open | `system/init` メッセージの実行時アサート（新発見⑤） |
| 13 | .devrelay-output/ 経由の持ち出し | deny パターン一覧に含める |
| 14 | 既存バイパス: `git -C <他プロジェクト>` でルール一致を迂回（新発見②、実機確認済み） | `hasGitScopeEscapeFlag()` でルール一致判定の前段に deny を追加 |
| 15 | 既存バイパス: `~/.claude/settings.local.json` の扱い（新発見③） | 実測で ask 経路では読まれないことを確認。一般的な可視化のため `warnIfSettingsFileHasPermissions` の対象にプロジェクト相対の `settings.local.json` を追加 |
| 16 | fail-open: `crossAskScope` が立つのに `strictReadonly`/`usePlanMode` が別系統で食い違う経路（新発見④） | `statePolicy.crossAskScope` 単独で発火する fail-closed チェックを追加 |
| 17 | `ISOLATED_STATE_POLICY.forcePlanTurn` が resumable と違い false だった | true に変更（resumable と同じ構造的保証に揃える） |

## 6. 実装場所

新設（linux/macos、byte-identical。windows は変更しない）:
`cross-ask-scope-rules.ts`（外部 import ゼロの純関数、deny-only 判定・SDK overrides の組み立て）、
`cross-ask-path-guard.ts`（fs 依存のパス実体判定）、`cross-ask-claude-md.ts`（CLAUDE.md 安全注入）。

変更: `plan-permission.ts`（`hasGitScopeEscapeFlag`追加、通常の plan モードにも適用）、
`session-scope.ts`（`crossAskScope` フィールド追加、`ISOLATED_STATE_POLICY.forcePlanTurn` 修正。
windows は未変更のため 3 OS byte-identical の原則から本サイクル限定で外れる）、
`ai-runner.ts`（PreToolUse フック・canUseTool・system/init アサートの3箇所に新ゲートを配線）、
`connection.ts`（fail-closed チェック、`sendOptions.crossAskScope`、CLAUDE.md 注入）。

## 7. 分割案（実施した段階のみ記載）

| 段階 | 内容 | 実施 |
|---|---|---|
| S2a | 読める範囲とツールの制限 | 実施 |
| S2b | 既存バイパスの根治（git -C、settings.local.json 可視化拡張、statePolicy/strictReadonly 食い違いの fail-closed 化、forcePlanTurn 修正） | 実施 |
| S2c | 記録の後片付け（scope dir 移設・jsonl 削除・persistSession） | **未実施** |
| S2d | capability + キルスイッチ + 文面/表示の修正 | **未実施** |
| S2e | 文書の仕上げ | 本ファイルと devlog のみ（CLAUDE.md・rules/project.md の更新は未実施） |

DB 変更なし。`pm2 restart`・各機の `u` は実行しない。
