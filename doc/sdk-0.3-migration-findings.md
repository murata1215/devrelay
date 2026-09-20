# claude-agent-sdk 0.3 系移行調査 findings（サイクル SDK-0）

読み取り専用調査サイクルの成果物。**コード・package.json・pnpm-lock.yaml・node_modules の変更はゼロ。**
Plan フェーズ（read-only）と exec フェーズ（一時ディレクトリでの動的実測）の結果をまとめる。

## 0. 背景

raw-completion Phase 1.3（`doc/devlog/2026-09-20_093326.md`）で SDK を 0.2.77→0.3.278 に上げようとして
停止条件4（同梱 `cli.js` の消滅）により中止した（Commit B）。本サイクルは次の移行（SDK-1）に向けた
調査のみを行い、コード変更は一切行わない。

現状据え置きの代償は同梱 Claude Code が 2.1.80 のままで、`claude-fable-5-1`（要 2.1.251 以上）が
使えないこと。0.3.278 の同梱 CC は 2.1.278 で要件を満たす。

## 1. 前提の訂正 3 件（Plan フェーズで実測・確定）

| # | 前サイクルの前提 | 実測結果 |
|---|---|---|
| 訂正1 | 「agents/linux の SDK リンクは実体の無い 0.2.80 を指す dangling」 | dangling ではない。`agents/linux/node_modules/@anthropic-ai/claude-agent-sdk` は `readlink -f` で `node_modules/.pnpm/@anthropic-ai+claude-agent-sdk@0.2.80_zod@4.4.3/.../claude-agent-sdk` に解決でき、`cli.js`（12,373,859 bytes）も存在する。実稼働している Agent の SDK は 0.2.77 ではなく **0.2.80**（0.2.77 はルートの devDependencies のみ）。 |
| 訂正2 | 「0.3 系は実行時にバイナリを展開する（extractFromBunfs）」 | 我々の構成では展開は起きない。`grep -c extractFromBunfs sdk.mjs` = **0**。`./extract` エクスポートは SDK を自前の Bun バイナリに同梱する利用者向け。node_modules 由来の実パスは `$bunfs` を含まないので `extractFromBunfs()` は入力をそのまま返す。 |
| 訂正3 | （新規発見）バイナリは自前で `require.resolve` できるはず | できない（pnpm 環境限定）。pnpm はプラットフォームパッケージを SDK 自身の private node_modules にしかリンクしない。`createRequire(import.meta.url)` を Agent 側モジュール起点で使うと健全なインストールでも必ず MODULE_NOT_FOUND。**Step 0 で npm フラット node_modules との対比を実測し、この訂正3が pnpm 固有の現象であることを確認済み**（§4参照）。 |

## 2. SDK の import 箇所と使用 API 面（Plan フェーズ実測）

import は 4 ファイルのみ（`apps/server` は `@anthropic-ai/sdk` を使うだけで agent SDK 非依存、
`agents/windows` は SDK 完全非依存）:

- `agents/{linux,macos}/src/services/ai-runner.ts` — `query`, type `CanUseTool`, `PermissionResult`
- `agents/{linux,macos}/src/services/claude-login.ts` — `query`, type `Query`, `SDKUserMessage`

`query()` 呼び出しは 2 箇所×2 OS。渡している options（実測・互換性検証の全対象面）:

`cwd` / `maxTurns` / `settingSources`(`['user','project']` または `[]`) / `env` / `model` /
`abortController` / `pathToClaudeCodeExecutable`(条件付) / `permissionMode`(`'plan'`|`'default'`) /
`allowedTools` / `disallowedTools` / `canUseTool` /
raw-completion 専用: `tools: []` / `mcpServers: {}` / `strictMcpConfig: true` / `settings`(オブジェクト) / `systemPrompt`

未使用: `resume` / `hooks` / `forkSession` / `plugins` / `agents` / `includePartialMessages` / `stderr` / `executable` 他。

受信メッセージ型: `system`(`compact_boundary`) / `assistant` / `rate_limit_event` / `result`
（`usage` / `modelUsage` / `duration_ms` / `subtype` / `is_error` / `num_turns`）。
**`deniedTools` は SDK から取っていない** — `canUseTool` の deny 側で自前配列 `rawDeniedTools` に積み、
`AiRunResult.rawDeniedTools` で返す（Phase 1.1 で確定した契約）。→ SDK 側の型変更の影響を受けない。

`claude-login.ts` は型定義に無い `Query.request()` を `as unknown as QueryWithRequest` で使用（要互換確認）。

## 3. `getClaudeExecutableFallback()` の判定と呼び出し元（Plan フェーズ実測）

判定（`agents/linux/src/services/ai-runner.ts:124-148`、macOS は `:127` に同等コピー）:
`require.resolve('@anthropic-ai/claude-agent-sdk')` → `dirname` の隣の `cli.js` を `existsSync` →
**あれば `null`（SDK 既定に委ねる）／無ければ `resolveSystemClaude()`**。

呼び出し元は4箇所のみ（いずれも `if (fallback) sdkOptions.pathToClaudeCodeExecutable = fallback`）:
`agents/linux/src/services/ai-runner.ts:994` / `agents/linux/src/services/claude-login.ts:134` /
`agents/macos/src/services/ai-runner.ts:921` / `agents/macos/src/services/claude-login.ts:134`

同一判定を持つ `logClaudeExecutableStatus()`（linux `:154` / macos `:157`）の呼び出し元は
`agents/linux/src/index.ts:123` / `agents/macos/src/index.ts:78`。

`resolveSystemClaude()` との関係: 重複ではなく役割分担。前者は「SDK 同梱版が健全か」、
後者は「システム claude はどこか」。linux は `claude-path.ts:28-46` ＋純関数 `claude-locator.ts` に分離済み
（P1.3 の循環 import 回避）。**macOS には `claude-path.ts` も `claude-locator.ts` も無く、
`ai-runner.ts:94-115` にハードコード候補のインライン実装が残っている**（byte-identical 崩れ）。

**この関数は 0.3.x に上げると常時 `null` を返さず必ずフォールバックを返すよう壊れる**
（`cli.js` が二度と存在しないため）。SDK-1 での書き換え対象。

## 4. 0.3.278 の実測

### 4.1 パッケージ構成（Plan フェーズ・pnpm 残骸を read-only 実測）

- `cli.js` 消滅。新規 `bridge.mjs`(1,501,253 B) 追加。`sdk.d.ts` は 141,640 → **479,793 B**
- `package.json`: `"claudeCodeVersion": "2.1.278"`（0.2.80 は `"2.1.80"`）← `claude-fable-5-1` の要件 2.1.251 を満たす
- `optionalDependencies`: 8 プラットフォームを完全固定（`0.3.278`）
  `linux-x64` / `linux-arm64` / `linux-x64-musl` / `linux-arm64-musl` / `darwin-x64` / `darwin-arm64` / `win32-x64` / `win32-arm64`
- `@anthropic-ai/claude-agent-sdk-linux-x64`: `{os:["linux"],cpu:["x64"],libc:["glibc"],files:["claude",...]}`、
  `exports` なし・`scripts` なし、中身は `claude` 1本 = **234,119,480 bytes**
- `peerDependencies` 新設: `@anthropic-ai/sdk >=0.93.0` / `@modelcontextprotocol/sdk ^1.29.0` / `zod ^4.0.0`
  → 両 peer は `sdk.d.ts` の `import type` のみ（`grep -c "anthropic-ai/sdk" sdk.mjs` = 0、
  `sdk.mjs` の静的 import は `node:module` だけ）。ルート `tsconfig.json:9` が `skipLibCheck: true` のため型解決も無害。
- バイナリ解決ロジック（逆コンパイル実測）:
  ```js
  let xx = u.pathToClaudeCodeExecutable;
  if (!xx) { ... zo = tW((Mc) => requireFromSdk.resolve(Mc));
    if (!zo) throw Error(`Native CLI binary for ${platform}-${arch} not found. Reinstall ... without --omit=optional, or set options.pathToClaudeCodeExecutable.`);
    xx = zo }
  ```
  `tW()` の候補順: linux は `preferMusl`（`process.report.getReport().header.glibcVersionRuntime === undefined`）で
  musl/glibc の順序が入れ替わる。win32 のみ `.exe` サフィックス。
- エラー分類文字列: `executable_not_found` / `executable_launch_failed`（musl/glibc 不一致のヒント文付き）

**測定方法**: pnpm 仮想ストアに残っていた raw-completion Phase 1.3 の試行インストール残骸
（`node_modules/.pnpm/@anthropic-ai+claude-agent-sdk@0.3.278_.../`）を read-only で `Read`/`Grep` した。
インストール操作自体は Phase 1.3（前サイクル）で行われたもので、本サイクルでは新規インストールしていない。

### 4.2 npm フラット node_modules との差（exec フェーズ・本サイクルで新規実測）

Step 0 として `/tmp/sdk03-1k0OuY`（リポジトリ外）に `npm install @anthropic-ai/claude-agent-sdk@0.3.278` を実施し、
pnpm 環境との解決差を実証した。

- インストール後のバイナリサイズ: **234,119,480 bytes**（pnpm 環境での実測値と完全一致、独立したインストール経路での再現に成功）
- `node_modules/@anthropic-ai/` 直下に `claude-agent-sdk` / `claude-agent-sdk-linux-x64` / `sdk` が**すべてトップレベルに並ぶ**（npm のフラット化。pnpm の入れ子分離と対照的）
- 実測スクリプト `resolve-test.mjs` の実行結果:
  ```
  --- npm フラット node_modules での解決 ---
  script起点で claude-agent-sdk-linux-x64/claude を直接解決: /tmp/sdk03-1k0OuY/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude exists= true
  sdkEntry (sdk.mjs): /tmp/sdk03-1k0OuY/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs
  sdkEntry起点で claude-agent-sdk-linux-x64/claude を解決: /tmp/sdk03-1k0OuY/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude exists= true
  package.json の subpath resolve は失敗（想定通り）: ERR_PACKAGE_PATH_NOT_EXPORTED
  sdk version: 0.3.278 claudeCodeVersion: 2.1.278
  cli.js exists: false
  ```
- **結論（訂正3の再確認）**: npm のフラット node_modules では、`createRequire(import.meta.url)` を
  「呼び出し元スクリプト起点」「解決済み sdk.mjs 起点」のどちらで作っても
  `claude-agent-sdk-linux-x64` の解決に成功する（＝npm では訂正3の問題は再現しない）。
  一方 DevRelay の実運用（pnpm workspaces）では前者が必ず失敗する。
  **SDK-1 の設計は pnpm を前提に「解決済み sdk.mjs 起点」で `createRequire` を作ることを絶対条件とする**
  （npm的な直感で書くと DevRelay の pnpm 環境だけで壊れる、という罠が実証された）。
- `package.json` の subpath export は 0.3.278 でも `ERR_PACKAGE_PATH_NOT_EXPORTED`
  （`exports` に `./package.json` が無いため）。バージョン取得は `fs.readFileSync(path.join(dirname(sdkEntry), 'package.json'))` で行う設計が正しいことを再確認。
- `cli.js` は npm 環境でも存在しない（プラットフォーム分離は pnpm 固有の話ではなく 0.3.278 自体の仕様変更であることの確認）。

## 5. Step 1（型定義の差分）

Plan フェーズで `sdk.d.ts` の主要な差分は 4.1 に記載の通り実測済み（141,640→479,793 bytes、`Options` 型のキー拡張、
peer import type の追加）。exec フェーズでの追加差分抽出は行っていない
（承認note指示「Step 0〜1 は再実測しなくてよい」に従い、Plan フェーズの実測を転記するに留めた）。
`Options` 型の詳細な narrowing 差分は SDK-1 のコミット4のゲート1（`pnpm build` 6 workspace green）で
実地検証する計画（本ドキュメント末尾のSDK-1方針参照）。

## 6. Step 2（query() スモークテスト、本サイクルで新規実測）

一時ディレクトリ `/tmp/sdk03-1k0OuY`（cwd指定・リポジトリ外・SDK 0.3.278）で `query()` を実行。
`maxTurns: 1` / `settingSources: []` / `tools: []`、プロンプトは `"Say exactly: SDK03TEST OK"`。

### 6.1 既定モデル

```
=== query() 実行: model=(default model) ===
  init: model= claude-opus-5[1m]  cwd= /tmp/sdk03-1k0OuY
  所要時間(ms): 5399
  text 非空: true  text: "SDK03TEST OK"
  sawResult: true  resultInfo: {"subtype":"success","is_error":false,"num_turns":1,"duration_ms":1590,"usage":{...}}
```

### 6.2 `claude-fable-5-1`

```
=== query() 実行: model=claude-fable-5-1 ===
  init: model= claude-fable-5-1  cwd= /tmp/sdk03-1k0OuY
  所要時間(ms): 5442
  text 非空: true  text: "SDK03TEST OK"
  sawResult: true  resultInfo: {"subtype":"success","is_error":false,"num_turns":1,"duration_ms":1672,"usage":{...}}
```

**結論**: 両モデルとも `query()` が正常応答し、`text` は非空、`result.is_error: false`。
`system/init` メッセージの `model` フィールドが要求どおり反映されることを確認
（`claude-fable-5-1` は init で正しくエコーされ、拒否/フォールバックは発生しなかった）。
所要時間はほぼ同等（5.4秒前後、うち SDK 内部の `duration_ms` は1.6秒台）。
**`claude-fable-5-1` が 0.3.278 上で動作することを実機ではなく一時ディレクトリのスモークで確認**
（本番相当の認証情報 `~/.claude/.credentials.json` を共有する環境での実測）。

## 7. auto-memory キルスイッチの動的確認（本サイクルで新規実施、承認note必須項目）

raw-completion Phase 1.3 の3層防御（`agents/linux/src/services/raw-completion-mode.ts`）:

1. env `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`（`RAW_ENV_OVERRIDES`）
2. `settings.autoMemoryEnabled: false`
3. `settings.autoMemoryDirectory: '~/.devrelay/raw-memory'`（1・2が両方破れた場合の最後の砦）

Phase 1.3 は 0.2.x の可読な `cli.js` を読んで確認していたが、0.3.x では `cli.js` が消滅しているため
**挙動で再確認する必要があった**（プラン停止条件6・データ漏洩面につき重要）。

### 7.1 手順

一時ディレクトリ `/tmp/sdk03-1k0OuY`（cwd）に対する sentinel を仕込むため、
`query()` の `system/init` メッセージの `memory_paths.auto` フィールドを実測して
実際の auto-memory 参照先ディレクトリを特定した:

```
memory_paths: {"auto":"/home/devrelay/.claude/projects/-tmp/memory/"}
```

**重要な副次発見**: cwd `/tmp/sdk03-1k0OuY` に対して素朴に想定される完全エンコード
（`-tmp-sdk03-1k0OuY`、実際にセッションログ `*.jsonl` が保存されるディレクトリ名と同じ）とは異なり、
auto-memory の参照先は **`-tmp`** に短縮されている。原因は未特定（SDK 内部のパスサニタイズ処理が
セッションログ用と auto-memory 用で別ロジックになっている可能性が高い。ハイフンを含む cwd で
情報が失われる潜在バグの可能性があるが、本サイクルのスコープ外のため深追いしていない）。
**この副次発見自体が「SDK-1 で auto-memory 系のパスに依存するコードを書く場合は必ず
`memory_paths` を実測で確認すること」という設計上の注意点になる。**

この実測により判明した正しいディレクトリ（`~/.claude/projects/-tmp/memory/MEMORY.md`）に
sentinel（`SENTINEL-TOKEN-7f3a9c2e-SDK03-AUTOMEMORY-PROBE`）を仕込み、
プロンプトで「コンテキストに `SENTINEL-TOKEN-` で始まる行があれば逐語的に出力せよ、無ければ
`NO_SENTINEL_FOUND` と出力せよ」と指示して4パターンを実測した。

### 7.2 実測結果

| # | 条件 | sentinel 漏洩 | 応答 |
|---|---|---|---|
| A | 対照区: `settingSources` 未指定（SDK既定=フル設定読み込み）、kill switch 無し | **漏洩する** | `SENTINEL-TOKEN-7f3a9c2e-SDK03-AUTOMEMORY-PROBE` |
| B | `settingSources: []` のみ（raw-completion が常に設定する値、kill switch 無し） | **漏洩する** | `SENTINEL-TOKEN-7f3a9c2e-SDK03-AUTOMEMORY-PROBE` |
| C | raw-completion 3層フル（env + `settings.autoMemoryEnabled:false` + `autoMemoryDirectory`） | **漏洩しない** | `NO_SENTINEL_FOUND` |
| D | env のみ（`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`、settings層無し） | **漏洩しない** | `NO_SENTINEL_FOUND` |

### 7.3 結論

- **auto-memory キルスイッチは SDK 0.3.278 でも機能する**（条件C・Dで確認）。Phase 1.3 の防御は
  0.3.278 へ上げても引き続き有効と判断できる。
- **重要な新知見**: `settingSources: []` 単体では auto-memory 注入を止められない（条件B）。
  raw-completion の防御が env による明示的キルスイッチ（条件D）に実質的に依存していることが
  0.3.278 でも変わらず正しい設計だったと実証された。
  「`settingSources:[]` を設定しているから安全」という誤解をしないよう、SDK-1 のドキュメントにも
  明記すべき。
- env 単体（条件D）で漏洩が止まったことから、`CLAUDE_CODE_DISABLE_AUTO_MEMORY` が最優先ゲートで
  あるという Phase 1.3 のコメント（`raw-completion-mode.ts:100`）は 0.3.278 でも成立する。
- 対照実験（条件A・B）で実際に sentinel が漏洩することを確認できたため、
  「防御が効かないケースを再現できず未確認」という事態にはならなかった。

### 7.4 後片付け

以下をすべて削除済み（削除後に再度 `find`/`ls` で残存が無いことを確認済み）:

- `/home/devrelay/.claude/projects/-tmp/`（sentinel 本体・実際の auto-memory 参照先）
- `/home/devrelay/.claude/projects/-tmp-sdk03-1k0OuY/`（セッションログ jsonl 一式 + 未使用の memory サブディレクトリ）
- `/tmp/sdk03-1k0OuY/`（一時作業ディレクトリ全体、npm install した node_modules 含む）

`~/.claude/projects/` 配下の他エントリ（`-tmp-claude-1001-...-scratchpad*` 等）は本サイクル開始前から
存在していたものであり、本サイクルの作業とは無関係・無変更であることを確認した。

## 8. `u` / Auto Update の更新フロー（Plan フェーズ実測）

`u`（2回押し）もサーバー auto-update も同一経路（`server:agent:update`）:

```
git fetch origin
git reset --hard <origin/HEAD または origin/main>     ← 破壊的・巻き戻し経路なし
pnpm install --frozen-lockfile --ignore-scripts
  └ 失敗時 → pnpm install --ignore-scripts （frozen を外して再試行）
pnpm rebuild @homebridge/node-pty-prebuilt-multiarch || true
pnpm --filter @devrelay/shared build
pnpm --filter @devrelay/agent build
[ -f dist/index.js ] なら 旧プロセス kill → nohup 再起動／無ければ旧版のまま稼働
```

- `optionalDependencies` は入る（`--ignore-scripts` はライフサイクルスクリプトのみをスキップ。
  プラットフォームパッケージに `scripts` は無いので無関係）
- install 失敗時は旧 dist のまま動き続けるが、**git は既に新コミットへ reset 済み**（fail-open の穴）
- 検出は `decideRunningCodeStale()`（`running-code-stale.ts`、dist 4ファイルの mtime vs commit 日時）

マシン単位で Auto Update を止められる（`apps/server/src/services/auto-updater.ts`）:

| レバー | 場所 | 再起動要否 |
|---|---|---|
| `Machine.autoUpdate`（マシン単位） | DB / `apps/server/src/routes/api.ts:381-420` / WebUI Machines | 不要 ← カナリアの本命 |
| `UserSettings.auto_update_enabled`（全体） | DB / `user-settings.ts:77` | 不要 |
| `DEVRELAY_AUTO_UPDATE_ONLY=<machineId>` | `apps/server/.env` | pm2 restart 必要 |
| bake time 120分 | `DEVRELAY_AUTO_UPDATE_BAKE_MIN`（既定 `DEFAULT_BAKE_MIN=120`） | — |

その他ゲート: cooldown 30分 / sweep 30分 / 同時3台 / 同一コミット2回失敗で `autoUpdate=false` 自動停止 / `isDevRepo` はスキップ。

**`u` はこれらのゲートを一切通らない**（手動で直接 `origin/main` HEAD へ）。カナリアの唯一の穴。

## 9. 3系統の分岐点（Plan フェーズ実測）

| 機体 | コードベース | 取得パッケージ | サイズ |
|---|---|---|---|
| ubuntu-prod（この機体） | `agents/linux` | `...-linux-x64` | 234,119,480 B |
| hp630g9（Windows 上の node.exe） | `agents/linux`（`agents/windows` は Electron GUI 版で SDK 非依存） | `...-win32-x64` | 約 237 MB（未実測） |
| MacBook-Air | `agents/macos` | `...-darwin-arm64` | 約 218 MB（未実測） |

## 10. ubuntu-prod のディスク影響（Plan フェーズ実測）

- OS ユーザーごとに Agent: `/home/devrelay/.devrelay/agent` と `/home/ribbon/.devrelay/agent` の2系統
- pnpm store は共有されない: `/home/devrelay/.local/share/pnpm/store`（devrelay 所有）と
  `/home/ribbon/.local/share/pnpm/store`（ribbon 所有）が別実体
- → 234 MB × 2 ユーザー ＋ `/opt/devrelay`（devrelay ユーザーのストアと hardlink 共有のため追加コスト≒0）
  ≒ +470 MB。`df` 実測で `/` は 145G 中 87G 空き（41% 使用）→ 問題なし

## 11. SDK-1 の実装方針案（Plan フェーズで策定・承認済み・次サイクルで実施）

### 不変条件

**検出ロジックの書き換えを先に全機へ行き渡らせ、依存バンプは最後。**

### A. 実行ファイル解決の作り直し

方針: 自前で「検出」だけし、見つかったら `null` を返して SDK に委ねる。見つからない時だけシステム claude。

- 候補集合を `{0.3.x ネイティブバイナリ} ∪ {0.2.x cli.js}` にすることで**バージョン判定なしで両対応**。
- `resolveSystemClaude()` フォールバックは維持。
- `createRequire` は**解決済み sdk.mjs 起点**（訂正3、§4.2で再確認済み）。Agent モジュール起点だと必ず失敗する。

新設予定（linux/macOS byte-identical）:

`agents/{linux,macos}/src/services/sdk-executable-locator.ts`（純関数・外部import ゼロ）
```ts
sdkNativeBinarySpecifiers(platform, arch, preferMusl): string[]
preferMuslFromReport(platform, report): boolean
sdkSiblingPath(sdkEntryPath, filename): string
decideSdkExecutable(probe): { kind:'bundled-native'|'bundled-cli-js'|'system'|'none'; path? }
buildSdkExecutableStatusLine(probe, source): { level, message }
```

`agents/{linux,macos}/src/services/sdk-executable.ts`（I/O 薄皮）
```ts
probeSdkExecutable(): SdkExecutableProbe | null
getClaudeExecutableFallback(): string | null   // 互換（健全なら null）
logClaudeExecutableStatus(): void
```

**macOS の先行整備**: `claude-locator.ts` / `claude-path.ts` を macOS へ移植し byte-identical 化。
`agents/linux/tests/claude-locator.test.mjs:48-56` の darwin アサーションを更新する必要がある。

### B. コミット分割案

| # | 内容 | 検証 |
|---|---|---|
| 1 | macOS へ `claude-locator.ts`/`claude-path.ts` 移植 | diff 無出力、既存 darwin テスト更新、6 workspace build |
| 2 | `sdk-executable{,-locator}.ts` 新設、`ai-runner.ts` 再エクスポート化（挙動は 0.2.80 上で完全同一） | 3形態すべての `agent.log` で `bundled cli.js OK` を目視するまでコミット4を push しない |
| 3 | ドキュメント | — |
| 4 | 依存バンプのみ（package.json 3箇所 + lockfile）。バージョン完全固定（キャレット無し） | 下記ゲート |
| 5 | （条件付）peer 対応 | ゲートが実際に落ちた時だけ |
| 6 | （2週間ソーク後）`cli.js` 分岐の削除 | — |

**コミット4の停止条件**:
1. `pnpm build` 6 workspace green（`sdk.d.ts` が 479KB へ肥大、`Options` の narrowing が未検証）
2. lockfile に8プラットフォームすべてが `os:`/`cpu:`/`libc:` 付きで載る
3. 全 workspace テスト green
4. probe が `bundled-native` / `0.3.278 (Claude Code 2.1.278)` を報告
5. 実 `query()` スモーク（**本サイクルの§6・§7で先行実施し、両方とも達成可能であることを確認済み**）
6. **auto-memory 契約の再確認**（**本サイクルの§7で先行実施し、条件C・Dで防御が機能することを実証済み**）

### C. peer 依存の扱い

何もしない（推奨）。根拠は実測済み: `sdk.mjs` に両 peer の module specifier が0個、
`sdk.d.ts` の `import type` のみ、ルート `tsconfig.json:9` が `skipLibCheck: true`。

### D. 障害モードと `agent.log` からの見分け方

| # | 障害 | 見分け方 |
|---|---|---|
| F1 | 234MBの取得タイムアウト／部分取得（最有力） | 起動時 `🩺 [SDK] … no bundled executable (tried: …)` が決定打 |
| F2 | `--ignore-scripts` × optionalDeps | プラットフォームパッケージに `scripts` 無し → 安全 |
| F3 | linux 生成 lockfile を Windows/macOS で `--frozen-lockfile` | pnpm は `os:/cpu:/libc:` 付きで記録し install 時にフィルタ → 安全（lockfile 再生成は ubuntu-prod でのみ行う規律が必要） |
| F4 | musl/glibc 不一致（linux のみ） | `executable_launch_failed` ＋ SDK 自身の musl ヒント文 |
| F5 | fail-open ビルドゲート | `decideRunningCodeStale()` → `runningCodeStale: true` |
| F6 | Windows: Defender が237MB未署名exeを検疫 | `pnpm install` exit=0 なのに `no bundled executable` |
| F7 | macOS: Gatekeeper（未検証） | `executable_launch_failed` |

### E. カナリア方針案

uso8m 先行 → hp630g9 → MacBook-Air → ubuntu-prod/devrelay 最後。
push 前に uso8m 以外の全マシンの `Machine.autoUpdate` を false、`u` フリーズを宣言、
good SHA を記録。bake time 120分 = push 後2時間の暗黙の中断窓。

### F. ロールバック手順案

**R1 リポジトリ単位（推奨）**: コミット4を `git revert`（force-push禁止）。

**R2 マシン単位（緊急）**: WebUI で `autoUpdate` を false にした上で、SSH で1コマンドずつ
`git fetch` → `git reset --hard <good-sha>` → `pnpm install --ignore-scripts` → ビルド → プロセス再起動。
詳細手順（Linux/macOS/Windows別）は Plan フェーズのプラン文書
（`soft-stargazing-ladybug.md`、承認済みプラン）に記載済み。次サイクル（SDK-1）実施時に本ドキュメントへ転記する。

## 12. まとめ

- 0.3.278 への移行で壊れる箇所は `getClaudeExecutableFallback()` の判定ロジックのみと特定できた。
- pnpm 特有の `createRequire` 解決の罠（訂正3）は npm との対比実験で存在が実証され、
  SDK-1 の設計（解決済み sdk.mjs 起点で `createRequire` する）が正しい対策であることが裏付けられた。
- `query()` は 0.3.278 で `claude-fable-5-1` を含め問題なく動作することを実機一歩手前のスモークで確認した。
- auto-memory の3層防御は 0.3.278 でも機能することを実証し、`settingSources:[]` 単体では
  不十分であるという追加の知見も得られた（SDK-1 のドキュメントに明記すべき事項）。
- 以上により、SDK-1（実装サイクル）に進むための技術的な障害は見当たらない。

## 検証（本サイクル）

- `git diff --stat -- apps/ agents/ packages/ prisma/ package.json pnpm-lock.yaml` は空
- `git status --short` に `doc/` 配下以外の新規／変更は無し
  （※既存の未コミット差分 `doc/devlog/2026-09-20_083514.md`（変更）と `doc/devlog/2026-09-17_221048.md`（未追跡）は
  本サイクル開始前から存在しており、本サイクルでは一切触れていない）
- 一時ディレクトリ・sentinel 状態はすべて削除済み（§7.4）
- ビルド・テストは実行していない（コード無変更のため）
