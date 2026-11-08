# Devin CLI plugin 配布基盤（`devin:plugin` adapter 新設、サイクル P4-A） (2026-10-31)

## 経緯

Agent Settings の Capabilities セクション（`murata1215/devrelay-plugins` マーケットプレイスからの配布）
の説明文は「Devin / Codex 等は Agent Skills 標準（`~/.agents/skills`）」だった。これはサイクル P3-B
（2026-09-15）時点で Devin CLI に plugin という概念が存在せず、Claude plugin の `skills/<name>/` だけを
抜き出して `~/.agents/skills/` にコピーする回避策（`agent-skills:standard` adapter）しか無かったため。

ユーザーから画像（WebUI の Agent Settings モーダル）を添えて「プラグインって devin で使えそう」と相談を
受け、2026-10 時点の Devin CLI 公式ドキュメント（docs.devin.ai）を調査したところ、前提が崩れていた。

## 調査

### 公式ドキュメント（docs.devin.ai）

| 事実 | 出典 |
|---|---|
| `devin plugins install/list/info/update/remove/prune` が存在する | `cli/extensibility/plugins/overview` |
| manifest 優先順は `.devin-plugin/plugin.json` > **`.claude-plugin/plugin.json`** > `plugin.json` | 同上 |
| install ソースは `owner/repo` / `owner/repo#subdir` / Git URL / `--local ./dir` | 同上 |
| plugin は skills に加え rules(`AGENTS.md`)/hooks(`hooks.json`)/MCP(`.mcp.json`)/subagents(`agents/`) を運べる | 同上 |

`murata1215/devrelay-plugins` の全エントリは `"source": "./plugins/<name>"`（リポ内 vendoring）であり、
`owner/repo#plugins/<id>` への機械的翻訳で**変換なしに入る**見込みが立った。

### 実機確認（devin 3000.6.14、2026-10-31、DESKTOP-5U400FO/lfuser の devin プロジェクト `TEST` 経由）

Windows 機で人間が PowerShell を手打ちする前サイクルの案（`.devrelay-output/devin-plugin-probe.ps1`）は
ユーザーから「スクリプトは実施したくない。自動化できない？」と差し戻された。DevRelay 自身がリモート実行
基盤であること（Devin は常に `--permission-mode dangerous` で起動されるため ask ターンでもシェルを実行
できる、`ask_project` は Team 登録不要）に気づき、MCP `ask_project` で読み取り専用の質問を 2 回投げて
実機確認した（install 自体の実行検証は `approve_implementation` が Devin の plan→exec resume 未対応で
弾かれたため未実施。`devin plugins install --help` の読み取りのみで代替）。

```
$ devin plugins --help
Commands:
install  Install a plugin from a source (auto-installs its required plugins)
list     List installed plugins with their version and blocked status
info     Show a plugin's skills, hooks, rules, and its required/optional/forbidden lists
update   Re-fetch and re-install a plugin (or all plugins) at the latest HEAD
remove   Remove an installed plugin (auto-installed requireds are left in place)
prune    Prune plugin requirements from repos that no longer exist on disk, then garbage-collect

$ devin plugins install --help
Usage: devin.exe plugins install [OPTIONS] <SOURCE>
Options:
-y, --yes    Skip the interactive trust prompt
--local      Install on this machine only, without adding the plugin to your personal plugins

$ devin plugins list
...（chisel のログ行がタイムスタンプ付きで標準出力に混ざる。実機確認済み）...
No plugins installed.
```

`-y, --yes` / `--local` フラグ、`owner/repo#path/to/plugin` の install ソース構文を公式ドキュメントどおり
確認し、**`devin plugins list` の標準出力にはログ行が混ざる**ことも確認した（パーサ非依存設計の根拠）。

## 設計（パーサ非依存・自己 probe 式）

`devin plugins list` を一切パースしない設計にした。冪等性は DevRelay 独自のサイドカー state
（`<configDir>/capabilities/devin-plugins.json`。Devin の install 先には置かない＝所有権侵害を避け
`devin plugins prune` にも消されない）と `devin plugins info <id>` の **exit code のみ**で判定する。

| 公式未記載の不明点 | 対応 |
|---|---|
| `plugins list` の機械可読性 | 一切パースしない |
| install 済みかの判定 | state + `plugins info <id>` の exit code |
| `plugins` サブコマンドの有無 | `devin plugins --help` の exit code で実行時判定（no-op に倒す） |
| install 先の実パス | 見ない（相手の所有領域） |

### action 判定（`decideDevinPluginAction`）

- state 無し & info ok（Devin に実在）→ 人間が手で入れたとみなし触らない（`conflict-unmanaged`）
- state 無し & info NG → `install`
- state あり & info NG（Devin から消えている）→ self-heal として `install`
- state あり & info ok & commit 一致 → `present`
- それ以外 → `update`（`devin plugins update <id> --yes`）

### 索引解決

`agent-skills:standard` が既に維持している marketplace clone（`<configDir>/capabilities/marketplaces/<name>`）
を**索引としてだけ**読み、`plugins[].source`（`./plugins/<id>`）を `owner/repo#plugins/<id>` に翻訳して
`devin plugins install` に渡す。配布物のコピーはしない（Devin が自前で fetch する）。clone/fetch/manifest
解析が失敗した場合は既存 CRITICAL RULE（P3-A 承認ノート#8）を複製し、撤去を一切行わず state を
last-known-good のまま保持する。

### `agent-skills:standard` との関係

**廃止せず併存**させる。`~/.agents/skills` は Codex も読む共有ディレクトリで Devin 都合で消せない。
二重露出の有害性は未検証（実機 install 検証が未実施のため）。有害と判明した場合のみ
`DEVRELAY_DEVIN_PLUGIN_EXCLUSIVE`（本サイクル未実装）で切り替える想定とし、Phase 3 として先送りした。

## 実装

`claude-plugin-adapter.ts` / `agent-skills-adapter.ts` と同じ deps 注入形。

### 新規ファイル

| ファイル | 責務 |
|---|---|
| `agents/linux/src/services/capabilities/devin-plugin-rules.ts` | 外部 import ゼロの純関数。state 解決・install ソース組み立て・action/撤去判定・診断文字列（240 文字上限、`agent-skills-rules.ts` の 80 文字上限とは独立）・予算管理 |
| `agents/linux/src/services/capabilities/devin-cli.ts` | `devin` を spawn する唯一のヘルパー（`claude-cli.ts`/`git-cli.ts` の鏡写し。cwd 必須・90 秒 timeout・`NO_COLOR=1`/`TERM=dumb`） |
| `agents/linux/src/services/capabilities/devin-plugin-adapter.ts` | I/O とオーケストレーション。2 パス構成（Pass 1: manifest 照合・install ソース確定、Pass 2: 1 item ずつ処理・予算切れで自発的に打ち切る） |
| `agents/linux/src/services/capabilities/marketplace-clone.ts` | `agent-skills-adapter.ts` の private `ensureMarketplaceClone()` を移設し両 adapter で共有（git 引数列は1文字も変えていない） |

### 変更ファイル

- `agents/linux/src/services/connection.ts`: `registerCapabilityAdapter(devinPluginAdapter)` を1行追加（無条件登録。キルスイッチは adapter 内部判定）
- `agents/linux/src/services/capabilities/agent-skills-adapter.ts`: clone を `marketplace-clone.ts` に委譲するだけ（ロジック無変更）

### 無変更

`apps/server/**`（`validateCapabilityConfigInput()` は items の provider/kind を意味づけない）、`prisma/**`、
`packages/shared/**`（`providers.devin` は P3-C で削除済み、復活させていない）、`apps/web/**`（items 生成は
次の Phase 2 で別途）、`agents/macos/**`、`agents/windows/**`。

### キルスイッチ

`DEVRELAY_DEVIN_PLUGIN`（既定 `1`）。`0` で adapter 内部が no-op（`hasManagedState()` も false）。
`devin:plugin` items は Phase 2（web 変更）まで存在しないため、既定 `1` のままロールアウトしても
adapter は何もしない。

## 検証

- `pnpm build`（モノレポ全体）green
- `pnpm -r test`: shared 143/143・server 1387/1387・web 924/924・linux 1255/1255・macos 736/737(skip1)・
  windows 155/155 すべて green（linux・macos は 1 回目実行で別ファイルの既知 Node test runner IPC flake
  （`Unable to deserialize cloned data`）により落ちたが、再実行で都度 green。本変更と無関係）
- 新規: `agents/linux/tests/devin-plugin-rules.test.mjs`（46 ケース）・`devin-plugin-adapter.test.mjs`
  （27 ケース）。argv/cwd の直接アサート、`plugins --help` 非 0 時の CLI 呼び出しゼロ、install 失敗時に
  state を書かない、clone/manifest 失敗時に撤去しない等を検証
- 回帰: `agents/linux/tests/agent-skills-adapter.test.mjs`（128 ケース）・
  `apps/server/tests/capability-config-rules.test.mjs` が無改造で全 pass（clone 移設と server 無変更の証明）

## 未実施・残課題

- **install 自体の実機検証が未実施**: MCP `approve_implementation` が Devin の plan→exec resume に
  未対応（`gemini` のみ対応済み）のためエラーになり、`submit_instruction` 経由の承認フローでの検証が
  できなかった。install/list/info/remove の実地検証は、Phase 2（web の plugin id 登録 UI 配線）を
  commit して Windows の Devin 機で「Sync now」を押す形で行う想定
- `agent-skills:standard` との二重露出が有害かどうかは未検証（Phase 3 の判断材料）
- Phase 2（`apps/web/src/lib/capability-config-rules.ts` の items 生成 + `MachinesPage.tsx` の文言更新）
  と `doc/devrelay_capability_spec_v2.md` の v2.5 改訂は本サイクル未実施（ロールアウト順序: Agent 側を
  先に commit → 全機体 `u` → Devin 機で Sync now 確認 → web を commit、という P3-A の教訓に従うため）

## 反映

`.ts` 変更 + `pnpm build` 実行済み。**ビルド完了。以下のコマンドで再起動してください: `pm2 restart devrelay-server`**
（`apps/server` 自体は無変更だが、モノレポ標準の反映手順として案内。実質的な動作変更は Agent 側のみ）。
`agents/linux` を変更したため、Devin を使う全機体で `u` が必要（ただし Phase 2 未実施のため `devin:plugin`
items はまだ生成されず、`u` 後も挙動は変わらない。Phase 2 commit 後に効果が出る）。
DB マイグレーション不要。commit + push 未実施（ユーザー指示待ち）。
