# claude 実行ファイル検出（SDK 0.2/0.3 両対応）運用ドキュメント

サイクル SDK-1（`doc/sdk-0.3-migration-findings.md` の後継実装）で導入した、
`@anthropic-ai/claude-agent-sdk` 同梱の Claude Code 実行ファイル検出器の仕様と運用手順。
**本ドキュメントが対象とするのはコミット①②③（検出器の両対応化）のみ。
依存バージョン自体を 0.3.x へ上げるコミット④は本ドキュメント公開時点でまだ実施していない。**

## 1. 検出仕様

### 1.1 背景

- SDK 0.2 系は `<SDK dir>/cli.js`（単一ファイル、~12MB）を同梱していた。
- SDK 0.3 系ではこれが消滅し、プラットフォーム別の `optionalDependencies` パッケージ
  （`@anthropic-ai/claude-agent-sdk-<platform>-<arch>[-musl]`）が同梱するネイティブバイナリ
  （`claude`、Windows のみ `claude.exe`、1本あたり ~230MB）に置き換わった。
- 旧 `getClaudeExecutableFallback()` は「`cli.js` があるか」だけを見ていたため、0.3 系では
  常に「欠落」と誤判定し、全機体が無条件でシステム `claude` へフォールバックしてしまう
  （#287 の安全網自体は正しいが、0.3 系では毎回発火する誤検知になる）。

### 1.2 候補集合とバージョン非依存の設計

検出器（`agents/{linux,macos}/src/services/sdk-executable-locator.ts`）は
**候補集合を「0.2 系 cli.js」∪「0.3 系ネイティブバイナリ」にし、バージョン判定を一切しない**。

判定順序:

1. `resolveSdkEntry()`（`createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk')` 相当）が失敗
   → `form:'unresolved'`（SDK エントリ自体が無い。#287 以前と同じ「SDK 既定に委ねる」）
2. `<sdkDir>/cli.js` が存在 → `form:'clijs'`
   **0.2 系のみの環境ではここで確定し、以降のネイティブ探索コードには一度も到達しない。**
   これにより「0.2.80 上での判定結果が変更前と完全に同一」が構造的に保証される。
3. ネイティブ候補を順に試す → 見つかれば `form:'native'`、全滅なら `form:'none'`
4. `form:'none'`（同梱が両方とも見つからない）ときだけ `resolveSystemClaude()`（#287 の安全網）

3 の全体は try/catch で包まれており、想定外の例外（`exists`/`readPackageJson` の異常等）は
`onWarn()` で警告した上で `form:'none'` / `probeStatus:'legacy'` に倒す（＝ 2 の cli.js
判定結果を最終結果として扱う）。検出器自体のバグで全 AI コマンドが止まることを防ぐための保険。

### 1.3 `sdk.mjs` 起点の `createRequire` が絶対条件（findings 訂正3）

0.3 系ネイティブバイナリの解決は、**Agent 側モジュール起点ではなく、解決済み `sdk.mjs`
パスを起点にした `createRequire`** で行う。

```ts
const sdkEntry = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk'); // sdk.mjs の絶対パス
const requireFromSdk = createRequire(sdkEntry);
requireFromSdk.resolve('@anthropic-ai/claude-agent-sdk-linux-x64/claude'); // OK
```

pnpm はプラットフォームパッケージ（`optionalDependencies`）を **SDK パッケージ自身の
private `node_modules`** にしかリンクせず、Agent の `node_modules` 直下には配置しない。
そのため Agent 側モジュール（例: `ai-runner.ts`）起点の `createRequire` では、
健全なインストールでも必ず `MODULE_NOT_FOUND` になる（SDK-0 サイクルで npm 環境と比較して実証済み）。
この回帰は `sdk-executable-locator.test.mjs` の T5（実ディレクトリ木フィクスチャ、実 `fs`/`createRequire`
を使用）でカバーしている。

### 1.4 ネイティブバイナリ specifier の組み立て規則（抽出元・抽出方法）

`findings` にはプラットフォームパッケージ名の一覧はあったが、specifier 組み立ての
**規則そのもの**は記載が無かったため、本サイクルの Plan フェーズで以下の方法で確定した。

- **抽出元**: `@anthropic-ai/claude-agent-sdk@0.3.278` の `sdk.mjs`（前サイクルで pnpm ストアに
  展開されたまま残っていた実体。`/opt/devrelay` のローカル pnpm store 内、追加インストール不要）
- **抽出方法**: `grep -o` で `sdk.mjs` 中の該当関数（難読化後の名前 `tW()` = 実行ファイル解決本体、
  `Bze()` = musl 優先判定）を直接抜き出し、ロジックを読み下した。新規インストールや一時
  ディレクトリでの `npm install` は不要だった。

抜き出した規則（`sdkNativeBinarySpecifiers()` / `preferMuslFromGlibc()` として再実装済み）:

```js
xu = "@anthropic-ai/claude-agent-sdk"
function tW(resolve, t={}) {
  let n = t.platform ?? process.platform, r = t.arch ?? process.arch,
      o = t.exists ?? Hze, s = t.preferMusl ?? Bze(),
      a = n === "win32" ? ".exe" : "",
      l = (n === "android" ? [`${xu}-linux-${r}-android`]
         : n === "linux"  ? (s ? [`${xu}-linux-${r}-musl`, `${xu}-linux-${r}`]
                               : [`${xu}-linux-${r}`, `${xu}-linux-${r}-musl`])
         : [`${xu}-${n}-${r}`]).map((u) => `${u}/claude${a}`);
  for (let u of l) try { let p = resolve(u); if (o(p)) return p } catch {}
  return null;
}
function Bze() { if (process.platform !== "linux") return !1;
  let e = typeof process.report?.getReport === "function" ? process.report.getReport() : null;
  return e != null && e.header?.glibcVersionRuntime === void 0 }
```

候補順の一覧（`sdkNativeBinarySpecifiers(platform, arch, preferMusl)`、`sdk-executable-locator.test.mjs`
T8 で全パターン検証済み）:

| platform | preferMusl | 候補順（`/claude` または `/claude.exe` 付き） |
|---|---|---|
| `linux` | false | `<pkg>-linux-<arch>`, `<pkg>-linux-<arch>-musl` |
| `linux` | true | `<pkg>-linux-<arch>-musl`, `<pkg>-linux-<arch>` |
| `win32` | — | `<pkg>-win32-<arch>`（`.exe` 付き） |
| `darwin` | — | `<pkg>-darwin-<arch>` |
| `android` | — | `<pkg>-linux-<arch>-android` |

`preferMusl` は `platform === 'linux' && process.report.getReport().header.glibcVersionRuntime === undefined`
（Alpine 等の musl ベース linux でのみ true。DevRelay の運用環境である glibc 系 Ubuntu では常に false）。

### 1.5 `resolveSystemClaude()` 安全網（#287）

同梱実行ファイルが両方とも見つからない場合のみ、`claude-path.ts` の `resolveSystemClaude()`
（`agents/linux` と `agents/macos` で byte-identical、`buildClaudeLookupCommand()` /
`claudeFallbackCandidates()` を使用）でシステムにインストールされた `claude` を探す。
これは SDK-1 では変更していない（コミット①でロジックを macOS へ移植しただけ）。

## 2. `agent.log` の 1 行の読み方

Agent 起動時に **1 回だけ**（コマンドごとには出さない）、以下の固定書式で出力する
（grep キー: `[SDK] claude-exec`）。

```
🩺 [SDK] claude-exec sdk=<version|unknown> cc=<claudeCodeVersion|unknown> form=<clijs|native|none|unresolved> decision=<sdk-default|system-claude|none> platform=<platform>-<arch> preferMusl=<true|false> probe=<ok|legacy> path=<実際に使われる実行ファイル|->
```

- `key=value` をスペース区切り。空白を含みうる `path=` は必ず最後のフィールド。
- `form=none` のときだけ追加で診断行を 1 行併記する: `🩺 [SDK] claude-exec tried=<specifier,specifier,...>`
- ログレベル: `decision=sdk-default` → `console.log`、`decision=system-claude` → `console.warn`、
  `decision=none` → `console.error`

### OS 別 grep コマンド

```bash
# Linux / macOS
grep -F "[SDK] claude-exec" ~/.devrelay/logs/agent.log | tail -n 3
```

```powershell
# Windows（-Encoding UTF8 必須。省略すると文字化けする、#354 D2 と同じ理由）
Select-String -Path $env:USERPROFILE\.devrelay\logs\agent.log -SimpleMatch "[SDK] claude-exec" -Encoding UTF8 | Select-Object -Last 3
```

### `form` × `decision` の組み合わせと意味

| form | decision | 意味 | 対応 |
|---|---|---|---|
| `clijs` | `sdk-default` | 0.2 系、cli.js 健全 | 正常（現行の全機体の期待値） |
| `native` | `sdk-default` | 0.3 系、ネイティブバイナリ健全 | 正常（④ 適用後の期待値） |
| `unresolved` | `sdk-default` | SDK パッケージ自体が解決不能 | SDK 既定に委ねる。通常は SDK 側で別のエラーになるはず。`node_modules` 破損の疑い |
| `none` | `system-claude` | 同梱実行ファイルが両方とも欠落、システム claude で代替 | 不完全インストールの疑い。`tried=` 行の specifier を確認し、`rm -rf node_modules/@anthropic-ai/claude-agent-sdk && pnpm install` |
| `none` | `none` | 同梱もシステム claude も無し | AI コマンドが確実に失敗する。最優先で対応 |
| いずれか | — | `probe=legacy` が付く | 検出器自体が想定外の例外を投げた（バグ）。cli.js 判定結果へ退避しているので致命的ではないが、④ より先に直す |

## 3. カナリア手順（②③ push 後、④ 着手前の確認フェーズ）

②③は「挙動同一のリファクタ＋ログ追加」であり④のような依存バンプではないため、
push 自体にカナリア段階を設ける必要はない。ただし④ の着手条件（3 系統すべてが
`form=clijs decision=sdk-default probe=ok` を報告すること）を確認するための手順は必要。

1. commit + push 後、**bake time（既定 120 分）以内に**、対象機（uso8m）で人間が手動 `u` を実行し
   Auto Update のゲート（bake time・sweep 間隔）を待たずに反映させる。
2. `u` 実行後、`agent.log` を `[SDK] claude-exec` で grep し、1 行を確認する。
3. 期待どおり（`form=clijs decision=sdk-default probe=ok`、`path` 末尾が
   `@anthropic-ai/claude-agent-sdk/cli.js`）であれば次の機体へ。
   **問題があれば直ちに手順 0（後述ロールバック §4 の R2）で当該機の `autoUpdate` を false にし、
   他機への sweep 適用を止める。**
4. 全機（ubuntu-prod / hp630g9 / MacBook-Air）で確認できたら ④ の着手条件を満たす。

### ④に進む条件のチェックリスト

| # | 機体 | コードベース | 期待する 1 行の要点 |
|---|---|---|---|
| ④-1 | ubuntu-prod | `agents/linux` | `sdk=0.2.80 cc=2.1.80 form=clijs decision=sdk-default platform=linux-x64 preferMusl=false probe=ok` + `path` 末尾 `/claude-agent-sdk/cli.js` |
| ④-2 | hp630g9（Windows / node.exe） | `agents/linux` | 同上 `platform=win32-x64` + `path` 末尾 `\claude-agent-sdk\cli.js` |
| ④-3 | MacBook-Air | `agents/macos` | 同上 `platform=darwin-arm64` + `path` 末尾 `/claude-agent-sdk/cli.js` |
| ④-4 | 全機共通 | — | `probe=legacy` が 1 件も出ていない／`decision=system-claude` に退化した機体が無い |
| ④-5 | 全機共通 | — | ②③前後で通常チャット・plan ターン・exec 承認カードが従来どおり動く（退行が無い） |

**重要（④のスコープ、本サイクルには含まない）**: ④（依存バンプ）を実施する際は、
実際にインストールした SDK に対して `probeSdkExecutable()` を実行し、`form=none` になったら
red になるテストを追加すること。これは「検出器が実インストールと整合しているか」を機械的に
保証するための回帰テストで、②③の時点（0.2.80 のみが実在する環境）では書けない
（0.3 系パッケージが実際にインストールされていないと検証できないため）。

## 4. ロールバック手順

### R1: commit の revert（全機共通）

`git revert`（force-push 禁止。②③は SDK パッケージ自体を変更していないため、
revert しても `package.json`/`pnpm-lock.yaml`/`node_modules` には触れない）。

```bash
git revert <③のcommit-sha>
git revert <②のcommit-sha>
git push origin main
```

revert 後、各機で `u` を実行するか Auto Update の反映（bake time + sweep）を待つ。

### R2: マシン単位のロールバック（人間が SSH で 1 コマンドずつ実行）

**手順 0（最優先）**: WebUI で当該マシンの `Machine.autoUpdate` を **false** にする。
これをしないと 30 分ごとの sweep が再度最新コミットを適用してしまう。

#### Linux / macOS

```bash
cd ~/.devrelay/agent
git log --oneline -5
```

```bash
git reset --hard <ロールバック先のSHA>
```

```bash
pnpm build
```

ビルド成果物の mtime が新しいことを確認してから次へ進む（`running-code-stale.ts` の
判定に使われているのと同じ考え方: ビルドせずに kill だけすると次回起動時に stale なコードのまま動く）。

```bash
stat ~/.devrelay/agent/agents/linux/dist/index.js
```

```bash
pgrep -u $(whoami) -af "\.devrelay.*index\.js"
```

node プロセスが**1本だけ**であることを確認してから kill する（2本以上あれば二重起動＝無限再接続の兆候、
`CLAUDE.md` の二重起動注意を参照）。crontab `@reboot` で再起動されるため、kill 後は自動的に新しいコードで立ち上がる。

```bash
kill <PID>
```

再起動後、`agent.log` で `[SDK] claude-exec` の行を確認する。

#### Windows

```powershell
cd $env:USERPROFILE\.devrelay\agent
git log --oneline -5
```

```powershell
git reset --hard <ロールバック先のSHA>
```

```powershell
pnpm build
```

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Select-Object ProcessId, CommandLine
```

node プロセスが 1 本だけであることを確認してから該当プロセスを終了する（PowerShell の
タスクスケジューラ経由で再起動される構成の場合、手動再起動が必要なこともある）。

```powershell
Stop-Process -Id <PID>
```

```powershell
Select-String -Path $env:USERPROFILE\.devrelay\logs\agent.log -SimpleMatch "[SDK] claude-exec" -Encoding UTF8 | Select-Object -Last 3
```

**`-Encoding UTF8` は必須**（#354 D2。省略すると絵文字・日本語部分が文字化けし、
grep パターンとの一致判定を誤らせる可能性がある）。

## 5. 落とし穴メモ

- **`settingSources: []` 単体では auto-memory を止められない**（SDK-0 §7.3 の新知見）。
  auto-memory を遮断する必要がある経路（raw-completion 等）では、env
  `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` が最優先で評価される点に注意（`settings.autoMemoryEnabled`
  は `settingSources` に関わらず `flagSettings` として無条件マージされるため、これ単体でも有効だが
  env の方が優先度が高い）。本サイクルの検出器とは直接関係しないが、SDK オプションを扱う際の
  共通の落とし穴として記録する。
- **`package.json` の subpath resolve は使えない**。SDK パッケージの `exports` フィールドに
  `./package.json` が無いため、`createRequire(sdkEntry).resolve('@anthropic-ai/claude-agent-sdk/package.json')`
  は `ERR_PACKAGE_PATH_NOT_EXPORTED` で失敗する。バージョン取得は `readPackageJson()` で
  ファイルを直接読む必要がある（`sdk-executable-locator.ts` の `readPackageJson` 依存を参照）。
- **cli.js 優先の順序を変えてはいけない**。0.2 系のみの環境で判定結果を完全に同一に保つための
  構造的保証がこの順序に依存している（`sdk-executable-locator.test.mjs` T3 で固定）。
