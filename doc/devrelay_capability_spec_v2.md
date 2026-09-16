# DevRelay Capability 配布基盤 指示書 v2.4（サイクル P1〜P3-C）

- 作成日: 2026-09-13（v2）／改訂: 2026-09-13（v2.1、サイクル P1.3）／改訂: 2026-09-15（v2.2、サイクル P3-A）／改訂: 2026-09-15（v2.3、サイクル P3-B）／改訂: 2026-09-17（v2.4、サイクル P3-C）
- 対象: devrelay 本体（`/opt/devrelay`, projectId `cmm5tpzil0042f3p2ieotnow4`）
- ステータス: v2 は実装済み（サイクル P1〜P1.2）。v2.1 は hp630g9/fwjg2 実機検証（claude 2.1.266）で判明した「配布が実質機能していない」不具合（cwd 未指定 / install scope 不一致）の根治とあわせ、§7.4・§8.2・§12 E2E-4 を実装済み挙動に合わせて改訂したもの。v2.2 はサイクル P3-A で 2 つ目の provider×kind 実装（`devin:skill`）を追加し、provider×kind 抽象を実証したもの。v2.3 はサイクル P3-B で `devin:skill` を「配布フォーマット単位」の `agent-skills:standard` に昇格し、ツール別 opt-in（`providers.devin` チェックボックス）を廃止したもの。v2.4 はサイクル P3-C で P3-B 実機 E2E 後の運用上の粗（空 staging 残置・skill 無しプラグインの誤表示・診断文字列の重複）を掃除し、調査中に見つかった「skill の update が構造的に必ず失敗するバグ」を根治したもの
- 置き換え: 本書は同日の「Plugin 配布機能 指示書 v1」を Capability 抽象化で改訂したもの。2026-09-03 の「Toolkit 配布機能（レシピ実行基盤）」案は破棄

## v2.4 改訂差分（サイクル P3-C、2026-09-17）

P3-B の実機 E2E（DESKTOP-1E6SDOQ）合格後、運用上の粗が 4 点残った（空 `.devrelay-staging` の残置／skill を持たないプラグインが web で通常 present と区別不能／診断文字列の接頭辞重複／役目を終えた `providers.devin` 型）。調査中に **skill の update 経路が構造的に必ず失敗する未発見バグ**（T1b）も見つかったため同一コード領域として同時に修正した。詳細な調査・設計判断はプラン `/home/devrelay/.claude/plans/calm-wishing-pinwheel.md` を参照。仕様書としての差分は以下:

1. **§7.x（T1）同期後の空 `.devrelay-staging`/`.devrelay-trash` を削除**: `capabilities/skill-tree-io.ts` に `removeDirIfEmpty(dir)`（`readdir` が 0 件のときだけ非再帰 `rmdir`、それ以外は fail-soft で無視）と `removeResidueDirsIfEmpty(skillsDir)`（`['.devrelay-staging','.devrelay-trash']` に適用）を追加。`agent-skills-adapter.ts` の `AgentSkillsDeps` に `cleanupEmptyResidue` を追加し、`reconcileMachineWithDeps()` の cleanup-only 経路・通常経路の両 return 直前で呼ぶ。既存の冒頭強制掃除 `cleanupResidue()`（中身が残っていても丸ごと削除）とは別関数で、末尾処理は「空なら消す・空でなければ触らない」に限定する。
2. **§7.x（T1b、バグ修正）`.devrelay-trash` 親ディレクトリ未作成による update の必発失敗を修正**: `atomicSwapDir()`（`skill-tree-io.ts`）は dest 既存時（＝ update）に `rename(destDir, trashDir)` を行うが、`.devrelay-trash` 親を作るコードがリポジトリ内に存在せず、**update 経路は必ず ENOENT で失敗していた**（新規 install は trash を使わないため成功し、実機 E2E をすり抜けていた）。`destExisted===true` の分岐で rename 直前に `mkdir(dirname(trashDir), {recursive:true})` を追加。dest 不在時（新規 install）は trash を触らないため mkdir もしない（空ディレクトリを作らない）。回帰テストは (a) `atomicSwapDir()` 単体で trash 親が存在しない状態からの成功（修正前コードでは失敗することを確認済み）、(b) `agent-skills-adapter.test.mjs` に実 `fs/promises`（`skill-tree-io.ts` の実装をそのまま deps 注入）で「install → marketplace 側の内容変更 → 2 回目 reconcile で `updated: 1`、同期後に `.devrelay-staging`/`.devrelay-trash` が残らない」を end-to-end 検証する専用テストを追加。`.devrelay-trash` へ rename する経路は `atomicSwapDir()` の 1 箇所のみ（grep で全数確認、他の `rename()` 呼び出しは無関係な用途）。
3. **§9（T2）web で `<id>:no-skills` を「skill なし」として区別表示**: Agent 側 payload は無変更。`apps/web/src/lib/capability-config-rules.ts`（純関数）に `NO_SKILLS_SUFFIX = ':no-skills'` と `partitionPresentIds(present)`（`present` を実 present と `:no-skills` サフィックス付き plugin id に分離）を追加。`decideSyncStatusDisplay()` / `buildPerProviderBreakdown()` の `presentCount` を「no-skills を除いた実 present 件数」に変更し、`noSkillsCount` / `noSkillsIds?` を新設。**不変条件: `presentCount + noSkillsCount` は変更前の `present` 総数と一致する**（旧来 `present 1` だった context7 のみの状態は変更後 `present 0 / skillなし 1` になるが合計は不変）。`MachinesPage.tsx` のサマリ行・provider 別内訳に `noSkillsCount>0` のときだけ追記表示。
4. **§8.x（T3）診断文字列の接頭辞重複を解消**: `devin --version` の生出力（例 `devin 3000.6.7 (260a97c8)`）をそのまま `${label} ${version}` に連結していたため `Devin devin 3000.6.7 ... 検出` と二重表示になっていた。`agent-skills-rules.ts` に純関数 `formatRuntimeVersion(label, version)` を追加: 空/空白のみ→`null`、最初の非空行を採用、先頭が label と大小文字無視で一致し直後が空白または文字列末尾なら label トークンを除去（`devin` のみ＝版が取れない場合も含む）、80 文字超は先頭 80 文字+`…`。`buildRuntimeDiagnostics()` をこの関数経由に差し替え、`Devin 3000.6.7 (260a97c8) 検出` / `Devin 検出`（版不明）/ `Devin 未検出` の 3 通りに整理。Codex 側の「設定あり/設定なし」語彙（P3-B）は不変。
5. **§4.1 / 型（T4）`providers.devin` 型の削除**: `packages/shared/src/types.ts` の `CapabilityDevinProviderConfig` と `CapabilityConfig.providers.devin` を削除（P3-B で `@deprecated` 型のみ残していたものを完全撤去）。`apps/web/src/lib/capability-config-rules.ts` の web 独自 `CapabilityConfigLike.devin?` も同時に削除（SQL で legacy 表現 0 件を確認済み）。legacy items シム（`agents/linux/src/services/capability-rules.ts` の `LEGACY_ITEM_REMAP`/`normalizeCapabilityItems()`）は型ではなく値でキーしているため無変更で維持され、旧 DB 値の items 経由の読み替えは引き続き機能する。

**変更ファイル**: `agents/linux/src/services/capabilities/{skill-tree-io,agent-skills-adapter,agent-skills-rules}.ts`（変更）、`apps/web/src/lib/capability-config-rules.ts` + `apps/web/src/pages/MachinesPage.tsx`（変更）、`packages/shared/src/types.ts`（型削除）。**無変更**: `apps/server/**`、`prisma/**`、`agents/macos/**`、`agents/windows/**`。

---

## v2.3 改訂差分（サイクル P3-B、2026-09-15）

P3-A の `devin:skill` は「Devin という**ツール名**」に紐づいた adapter だったが、実際に配布しているのは Claude plugin の `skills/<name>/` を **Agent Skills 標準**（`~/.agents/skills/<name>/SKILL.md`）に置くことで、この置き場は Devin CLI と Codex が**両方**読む。adapter の単位は「ツール」ではなく「**配布フォーマット**」であるべき、という設計修正。詳細な設計判断・却下案はプラン `/home/devrelay/.claude/plans/rippling-humming-tide.md` を参照。仕様書としての差分は以下:

1. **§2 の用語修正（capability はツール非依存）**: `provider='devin' / kind='skill'` を廃止し、`provider='agent-skills' / kind='standard'`（registry key `agent-skills:standard`）に昇格した。ファイルは `capabilities/agent-skills-{rules,adapter}.ts`（`devin-skill-{rules,adapter}.ts` からリネーム改造）。この adapter は「Agent Skills 標準という配布フォーマット」の実装であり、特定ツール名を冠さない。
2. **§7.x 配布先解決**: `resolveAgentSkillsDirPath({env,platform,home})` を新設。優先順は① `DEVRELAY_AGENT_SKILLS_DIR`（絶対パスのみ採用）→② `<home>/.agents/skills`（win32 は `%USERPROFILE%`、posix は `$HOME` 起点）。P3-A の `resolveDevinSkillsDirPath()` は `resolveLegacyDevinSkillsDirPath()` に改名し**移行スキャン専用**（`DEVRELAY_DEVIN_SKILLS_DIR` も legacy 側として維持）。
3. **§8.x `agent-skills:standard` の手順・marker・移行**:
   - marker は `.devrelay-capability.json` に `{version, adapter:'agent-skills-standard', provider:'agent-skills', kind:'standard', pluginId, skillName, marketplaceName, sourceSha, treeHash, installedAt}`。所有判定 `isOwnedAgentSkillsMarker(m)` は `adapter==='agent-skills-standard'` **または** (`provider==='agent-skills' && kind==='standard'`)。legacy 認識は別関数 `isOwnedLegacyDevinMarker(m)`（`provider==='devin' && kind==='skill'`、P3-A marker 形そのまま）を分離し、新配布先で legacy marker を所有扱いしない。
   - **移行手順（`reconcileMachineWithDeps()` 末尾、`canPerformRemoval(indexOutcome)` ブランチ内）**: ① `~/.agents/skills` へ install/update（staging→rename）② 書き込んだ marker を読み直して `isOwnedAgentSkillsMarker()` を確認 ③ legacy dir を `isOwnedLegacyDevinMarker()` が真のディレクトリだけ `removeManagedDir()` ④ marker なし/他者 marker/読めない は一切触らない。**ゲート（skill 単位）**: install failed または marker 再読込 NG の skill は legacy を削除しない（last-known-good 保全）。index fetch 失敗（`canPerformRemoval` false）時は削除系すべて停止。
   - **`normalizeCapabilityItems()`**（`capability-rules.ts` 純追加）が `{provider:'devin',kind:'skill'}` items を `{provider:'agent-skills',kind:'standard'}` に読み替える。適用箇所は `capability-sync.ts` の `resolveReconcileTargets()` 呼び出し直前の 2 箇所（`runMachineReconcile()`/`reconcileForRunner()`）のみ。`resolveReconcileTargets()`/`listConfiguredProviders()`/`resolveCleanupKeys()` は無変更（items 先行駆動が既に成立しているため、legacy items を canonical key に寄せるだけで足りる）。これが無いと旧 DB 値の `providers.devin` + `devin:skill` items が「uncovered かつ managed」として `runCleanupPass()` に消される事故になる。
   - **ランタイム診断**（配布判断には非関与、`CapabilityResult.runtimeVersion` に格納）: Devin は実際の `devin --version` ランタイム検出（既存 `resolveSystemDevin()`/`resolveDevinRuntimeVersion()` を再利用）で「検出/未検出」。Codex は DevRelay の `aiTools` config 有無だけで判定するため文言を変え「設定あり/設定なし」とする（ランタイム検出ではないことを明示。Codex locator は未実装のため）。`items` が空（cleanup-only 経路）では診断を計算しない。
   - `devin-not-found` / `missing-provider-config` の early return は削除（§5-6の設計により Devin 未検出でも Codex 向けに配布は続行する desired-state 原則）。新規 reason: `unmanaged-conflict`（同名 unmanaged ディレクトリ、上書き・削除しない）、`missing-marketplace-config`（`providers.claude` 未設定）。
4. **§5-8 Claude adapter の install 検証**: machine scope の `claude plugin install <fullId> --scope user` が exit 0 でも、`~/.claude/plugins/installed_plugins.json` を再読込し `scope:'user'` のエントリが実在することを確認できたときだけ `installed` に積む（`hasUserScopedInstall()`）。検証落ちは `failed: install-verify-failed`。present 判定（`~/.claude/settings.json` の `enabledPlugins`）とは役割が異なるため混ぜない。
5. **§5-9 item id 二重サフィックス防止（3段防御）**: (a) web 入力時 `normalizePluginIdInput(raw, marketplaceName, existingIds)` で trim→末尾 `@marketplaceName` を1回だけ剥がす→空/重複は reject、(b) 表示 `formatPluginTag()` は既に `@marketplaceName` で終わっていれば付与しない、(c) Agent 側最終防波堤 `buildQualifiedPluginId(id, marketplaceName)`（既に付与済みなら素通し）を machine scope install の id 組み立てに使う。`stripMarketplaceSuffix()` は `agent-skills-rules.ts` 側で同様の bare id 化に使う。
6. **§9 Web**: 「Devin にも配布する」チェックボックスを廃止。`CapabilityConfigFormState.distributeToDevin` を削除し、plugin id を 1 つ登録すれば `claude:plugin` と `agent-skills:standard` の items を**常に両方**生成する（`providers` は `claude` のみ生成。索引宣言を単一情報源として流用し server 側検証器は無変更）。セクション見出しは `Capabilities`、直下に「配布先: Claude Code は plugin、Devin/Codex 等は Agent Skills 標準（`~/.agents/skills`）」を明記。内側見出しは「配布するプラグイン」。breakdown（`perProvider`）は `results.length > 1` の条件を撤去し 1 件でも表示、`presentCount`/`runtimeDiagnostics`（診断情報である旨の注記付き）を追加。`summary` にも `presentCount`/`removedCount` を追加。
7. **`providers.devin` 廃止の後方互換**: shared 型 `CapabilityDevinProviderConfig`/`CapabilityConfig.providers.devin` は `@deprecated` コメント付きで型のみ残す（削除しない）。旧 DB → 新 Agent/新 web は `normalizeCapabilityItems()` とフォーム変換の後方互換読み取りで正しく動く。新 DB → 旧 Agent は `agent-skills:standard` が `unsupported-provider` になるだけで `claude:plugin` は無傷（ロールバック安全）。

**変更ファイル**: `agents/linux/src/services/capabilities/{agent-skills-rules,agent-skills-adapter}.ts`（新規、`devin-skill-*` からリネーム改造）、`agents/linux/src/services/{capability-rules,capability-sync,connection}.ts`（変更）、`agents/linux/src/services/capabilities/claude-plugin-{rules,adapter}.ts`（変更）、`packages/shared/src/types.ts`（`@deprecated` コメントのみ）、`apps/web/src/lib/capability-config-rules.ts` + `apps/web/src/pages/MachinesPage.tsx`（変更）。**無変更**: `apps/server/**`、`prisma/**`、`agents/macos/**`、`agents/windows/**`。

---

## v2.1 改訂差分（サイクル P1.3、2026-09-13）

hp630g9/fwjg2 の実機検証で、リポの `.claude/settings.json` に `enabledPlugins` を宣言してタスク投入しても Claude Code 側で `✘ failed to load` になり配布が機能していないことが判明した。真因は2点:

1. **cwd 未指定**: prelaunch の CLI 呼び出しに `cwd` が無く、Agent プロセス自身の作業ディレクトリ（`u` で `git reset --hard` されうる場所）に install していた。
2. **install scope の不一致**: 常に `--scope local` を渡していたため、`.claude/settings.json`（project scope 宣言）で有効化したプラグインが `--scope project` で install されず読み込まれなかった。

これを受け、以下を実装済み挙動として仕様を改訂する（§7.4 / §8.2 / §12 E2E-4）。あわせて索引未知 ID への `marketplace update` 1 回リトライと、marketplace 未登録時の初回フォールバック（machine reconcile への委譲）を実装した。

## v2.2 改訂差分（サイクル P3-A、2026-09-15）

`claude:plugin` 1 つだけだった adapter レジストリに 2 つ目の実装 `devin:skill` を追加し、provider×kind 抽象が実際に機能することを実証した。同じ索引・同じ item（Claude plugin の `skills/<name>/`）を Claude Code と Devin CLI の両方へ配布できる。詳細な設計判断・却下案・実装手順はプラン `/home/devrelay/.claude/plans/floofy-giggling-pine.md` と承認ノート `doc/p3a_devin_skill_adapter_approval_note.md` を参照。仕様書としての差分は以下:

1. **§7.1 adapter 契約に optional `hasManagedState?(): Promise<boolean>` を追加**（撤去経路用）。「true = この adapter が過去に配置した管理下の状態がこのマシンに残っている。未実装の adapter（Claude 等）は撤去（cleanup）経路に構造的に入らない。throw / timeout は false 扱い（fail-closed）」を不変条件とする。
2. **§6 `CapabilityResult` に `removed?: string[]` を追加**（P1.3 までの「型は凍結、導出は純関数で」原則に対する初の例外）。純加算・非空のときだけキーを生やす。撤去の実行条件は「`resolveReconcileTargets()` の対象から外れた（uncovered）＋ `hasManagedState()` が true（managed）」の両方を満たす adapter のみ。`capabilityConfig` が全体 null の場合は `configDelivered` フラグ（`capabilityConfig` キー自体が payload に一度でも存在したか。値が null でも true）が true のときだけ撤去を許可する（P1 未満のサーバーへロールバックした際の誤撤去を防ぐ）。
3. **§8.3（新設）Devin adapter v1 の手順**: 索引取得は `~/.claude/plugins/marketplaces` に依存せず `<configDir>/capabilities/marketplaces/<name>/` への shallow git clone + fetch/reset で独立取得する（非対話強制: `GIT_TERMINAL_PROMPT=0` 等）。展開単位は plugin 単位（`items[].id` は Claude 側と同じ ID 空間）で、1 plugin の `skills/` 直下の各ディレクトリを devin skills dir（既定 `%APPDATA%\devin\skills` / `~/.config/devin/skills`。`DEVRELAY_DEVIN_SKILLS_DIR` で上書き可）へ 1:1 コピーする。状態管理は宛先ディレクトリごとの marker ファイル（`.devrelay-capability.json`、所有権判定は `schema/managedBy/provider/kind` 一致）。更新はコピー先を staging → 既存を trash へ退避 → rename の 2 段アトミック手順。**CRITICAL RULE**: 索引取得（clone/fetch/manifest パース）が失敗した reconcile では撤去判定を一切行わず、既存の managed skill を last-known-good として保持し `failed` を報告する。非管理（marker 無し）の同名ディレクトリは触らず `failed: dest-occupied-unmanaged` を報告する。
4. **§7.3 予算配分の内訳を明記**: `ADAPTER_TIMEOUT_MS`（3 分）のうち、Devin adapter は git 呼び出し全体で 90 秒（`allocateGitTimeout()` で各呼び出しに配分）、残り約 90 秒をコピー/削除に充てる設計とする。
5. **provider 固有の設定フィールドはサーバー検証器を通せない**: `apps/server/src/services/capability-config-rules.ts` の `validateCapabilityConfigInput()` は `providers[key] = { marketplaceName, marketplaceSource }` の既知 2 フィールドだけを再構築し、未知キーは黙って捨てる。そのため `providers.devin.skillsDir` のような provider 固有フィールドはサーバーを経由できない。1 機体だけの上書きが必要な場合は Agent ローカルの環境変数（`DEVRELAY_DEVIN_SKILLS_DIR` 等）で代替する。
6. **§10（やらないこと）に追記**: project scope（`.devin/skills/`）/ prelaunch 経由の Devin 配布 / Codex adapter / `.agents/skills/` / MCP・hooks・commands の変換 / 宛先ドリフト検知（手動でファイルを書き換えられても検知しない）は v1 スコープ外。
7. **Web UI**: Agent Settings の Capabilities セクションに「Devin にも配布する」チェックボックスを追加。チェックすると `providers.devin` と `devin:skill` items（claude と同じ plugin id 群）が `providers.claude` / `claude:plugin` items の後ろに追加される。チェックを外す（＝ `providers.devin` を消す）と撤去経路（上記2.）が走り、次回 reconcile で managed skill が撤去される。

**変更ファイル**: `agents/linux/src/services/capabilities/{devin-skill-rules,devin-skill-adapter,git-cli,skill-tree-io}.ts`（新規）、`agents/linux/src/services/{devin-locator,devin-path}.ts`（新規）、`agents/linux/src/services/{capability-rules,capability-sync,connection}.ts`（変更）、`packages/shared/src/types.ts`（型のみ追加）、`apps/web/src/lib/capability-config-rules.ts` + `apps/web/src/pages/MachinesPage.tsx`（変更）。**無変更**: `apps/server/**`、`prisma/**`、`agents/macos/**`、`agents/windows/**`（provider 非依存の検証器のため server は完全に無変更で済んだ）。

---

## 0. 進め方（Plan フェーズの制約）

- Plan を提出した時点で終了。**実装は承認後**
- **AskUserQuestion は使用しないでください**。不明点は Plan に「前提」として明記
- シェルコマンドは 1 つずつ（`&&` / `;` 禁止）
- `prisma migrate dev` 禁止。スキーマ変更は人間側 `psql ALTER` → `cd apps/server` → `npx prisma generate`
- `pm2 restart`・全機 `u` は人間側。Plan / 完了報告に「人間側でやること」として書く

## 1. 目的と最重要方針

DevRelay に **Capability 配布基盤**を作る。Capability とは「特定の AI ランナーに対し DevRelay が導入・同期できる追加能力」で、`provider`（claude / codex / devin …）と `kind`（plugin / skill / mcp …）で識別する。

```
DevRelay
  └─ Capability Distribution（共通層: DB / Server / WS / Agent 同期基盤）
       ├─ Claude adapter  ← v1 で実装（kind=plugin のみ）
       ├─ Codex adapter   ← 将来
       └─ Devin adapter   ← 将来
```

- v1 で実装・E2E するのは **`provider=claude / kind=plugin`（Claude Code プラグイン）だけ**
- しかし DB・Server・WS・Agent 共通層・設定名を Claude 固有にしない。将来 Codex / Devin を **adapter と UI セクションの追加だけ**で足せる構造にする
- **抽象化は今やる。将来機能の実装は今やらない。** Codex / Devin のダミー adapter・仮 CLI・空実装は作らない。存在するか不明な CLI 仕様を interface に焼き込まない
- DevRelay を「Claude Plugin 配布システム」にしない。Plugin は Capability の最初の実装であり同義ではない

## 2. 前提・用語

- Claude Code プラグイン: skills / agents / hooks / MCP を 1 パッケージにした Claude Code 標準の配布単位。マーケットプレイス（`.claude-plugin/marketplace.json` を持つ git リポ）から `claude plugin install <plugin>@<marketplaceName> --scope <user|project|local>` で非対話 install できる。CLI からの install は**次のセッション起動時**に読み込まれる（DevRelay はタスクごとに新セッションなので足りる）
- マーケットプレイスの登録状態は **OS ユーザー単位**（`~/.claude/plugins/known_marketplaces.json`）。ubuntu-prod の 13 ユーザーは各自登録される（遅延登録）
- v1 の Claude adapter が使うマーケットプレイス: GitHub `murata1215/devrelay-plugins`（`name: devrelay`、public、別紙の雛形）。これは **Claude adapter が使う索引**であって「DevRelay 全 provider 共通仕様」ではない。本サイクルでリポは作らない
- 対象 Agent は `agents/linux`（hp630g9 も linux dist）。`agents/windows`（Electron）は対象外

## 3. v1 の範囲

- 有効な組み合わせは `provider=claude / kind=plugin` のみ
- 共通層は未知・未対応の provider / kind を受けても **Agent を落とさず**、同期結果に `unsupported-provider` / `unsupported-kind` として記録する
- 旧 `pluginConfig` / `pluginSyncStatus` / `plugin-sync.ts` / `server:plugin:sync` / `agent:plugin:sync` は **使わない**。新規実装に残っていないことを Plan で確認

## 4. DB（`apps/server/prisma/schema.prisma`、人間側 ALTER）

`Machine` に `Json?` を 2 カラム（cuid / camelCase / `@@map` なし / enum なし / 日本語コメント必須）。Plan に人間側で流す `ALTER TABLE` 文を 1 文ずつ 2 本書く。

### 4.1 `capabilityConfig`

```json
{
  "providers": {
    "claude": { "marketplaceName": "devrelay", "marketplaceSource": "murata1215/devrelay-plugins" }
  },
  "items": [
    { "provider": "claude", "kind": "plugin", "id": "commit-commands" }
  ]
}
```

- `items` は論理的な配布対象一覧。provider と kind を必ず明示。`id` は bare 名（`unity`）
- Claude マーケットプレイス固有情報は `providers.claude` 配下に閉じ込める。`marketplaceName` をトップレベルに置かない
- 将来 `providers.codex` / `providers.devin` を追加できる構造にするが、v1 で `providers.claude` 以外を保存する UI は作らない
- null = 未設定（機能 OFF）

### 4.2 `capabilitySyncStatus`

`agent:capability:sync` の payload（§6）をそのまま保存 + `receivedAt`。

## 5. Server

- Server は provider 固有のインストール方法を**知らない**。扱うのは `capabilityConfig` / `capabilitySyncStatus` / `server:capability:sync` / `agent:capability:sync` の 4 つだけ。Server に `claude plugin …` / `.codex/` / `.agents/` 等を書かない
- **配信**: `capabilityConfig` を既存の `server:connect:ack` と `server:config:update`（リアルタイム設定配信）に載せる。新しい配信経路は作らない
- **保存 API**: Agent Settings の既存保存エンドポイント（skipPermissions / hostnameAlias / projectsDirs と同じ）に `capabilityConfig` を追加。保存時は **Hostname Alias と同じ規則で同一ホスト名の全 Machine（`deletedAt` null）に一括適用**し、各 Agent に `server:config:update`。これにより将来 1 台に Claude / Codex / Devin の capability をまとめて宣言できる
- **手動同期**: `server:capability:sync`（payload なし）を Web から既存の管理コマンド送信経路（Restart と同じ）で送る
- **結果受信**: `agent:capability:sync` を `Machine.capabilitySyncStatus` に保存し、Agent Settings を開いている Web にリアルタイム反映（`agent:update:status` と同じ扱い）
- **互換**: 未更新 Agent は `capabilityConfig` を無視して既存動作を継続できること。更新済み Server が古い Agent に新 field を送っても壊れないこと。報告が無い Machine は Web で「未同期（Agent 更新が必要）」

## 6. WebSocket（追加は 2 型のみ）

```
server:capability:sync  {}

agent:capability:sync {
  status: 'done' | 'error' | 'skipped',        // skipped = 機能OFF / busy
  results: [{
    provider: 'claude', kind: 'plugin',
    runtimeVersion: string | null,             // claude --version
    installed: string[], updated: string[], present: string[],
    failed: { id: string, reason: string }[],  // reason 例: claude-not-found, marketplace-name-mismatch, unsupported-provider, unsupported-kind, timeout
    notAllowed: string[]                       // リポ宣言だが devrelay 索引外で無視した ID
  }],
  durationMs: number,
  trigger: 'connect' | 'config' | 'idle' | 'manual' | 'prelaunch'
}
```

`results` は provider / kind ごとに 1 要素。v1 は常に 1 要素だが配列で送る。unsupported な item は該当 provider/kind の要素を作って `failed` に積む。

## 7. Agent の構造（`agents/linux`）

### 7.1 2 層に分ける

```
capability-sync.ts（共通層）
  config 解釈 / 直列化 / trigger 管理 / timeout / 結果集約 / Server 報告 / provider・kind による adapter routing
capabilities/claude-plugin-adapter.ts（Claude adapter）
  Claude CLI 呼び出し / marketplace 操作 / <projectPath>/.claude/settings.json の解釈
```

- 共通層から Claude CLI を直接呼ばない。`.claude/settings.json` も共通層は知らない（将来 `.codex/` `.agents/` 等の provider 固有パスを共通層に列挙しない）
- adapter 境界は最低限 `provider` / `kind` / 利用可否チェック / machine(user) scope reconcile / project(prelaunch) reconcile / 結果 を分離する。概念例:

```ts
interface CapabilityAdapter {
  provider: string; kind: string;
  reconcileMachine(...): Promise<CapabilityResult>;
  reconcileProject(...): Promise<CapabilityResult>;
}
```

interface 名・引数は既存 Agent コードに合わせ Plan で決める。巨大 interface を先に作らない。ファイル名も既存構造に合わせて Plan で最終決定してよい

### 7.2 Runner と Capability の分離

「Claude を起動するから plugin-sync する」という密結合にしない。

```
runner 起動要求 → runner の provider を判定 → その provider の prelaunch capability reconcile → runner 起動
```

v1 では Claude runner だけが `provider=claude` で共通層の prelaunch 入口を呼ぶ。将来 Codex runner → `codex`、Devin runner → `devin` を同じ入口に接続する。

### 7.3 接続点（共通層）

| 接続点 | 動作 |
|---|---|
| `server:connect:ack` / `server:config:update` で `capabilityConfig` 受信 | メモリ保持。変化があればアイドルなら即 reconcile、実行中なら次のアイドルで |
| Auto Update と同じアイドル時サイクル | reconcile を相乗り。頻度・抑制は Auto Update と同じ（Plan で既存実装の場所と周期を確認） |
| `server:capability:sync` | busy でも受け付け、直列キューへ |
| runner 起動直前 | §7.2 の prelaunch。ブロック上限 **3 分**、超えたら諦めて起動 |

- reconcile は Agent 内で**直列化**（実行中は再入せず、完了後に 1 回だけ再実行）
- AI セッション実行中は prelaunch 以外の reconcile をしない（Auto Update の「アイドル時」原則）
- 各 CLI 呼び出しはタイムアウト 3 分。timeout 後も runner 起動判断へ戻る

### 7.4 CLI 実行の安全性（v2.1 改訂）

- `spawn` / `execFile` でコマンドと引数を分離。**シェル文字列連結で実行しない**。Web から受け取った plugin ID / marketplaceSource をそのままシェル文字列へ結合してはいけない
- `claude` 実行ファイルの解決は ai-runner が Claude Code を起動するのと**同じ方法**を使う（`claude-path.ts` に切り出し、`ai-runner.ts` から再エクスポートして後方互換を保つ）
- 機械可読 JSON オプションがあるコマンドでは JSON を使う（実機確認済み。`plugin list` / `plugin marketplace list` とも `--json` あり）
- **`cwd` は型レベルで必須**（P1.3）。Claude Code は CLI 実行時の cwd を「プロジェクト」とみなし、install scope の解決や `installed_plugins.json` の `projectPath` 記録に使う。cwd を省略すると Agent プロセス自身の作業ディレクトリに install される事故になる（実機で発生）。
  - `reconcileProject`（prelaunch）: 全 CLI 呼び出しの `cwd` は対象プロジェクトの `projectPath`
  - `reconcileMachine`（machine/user scope）: 全 CLI 呼び出しの `cwd` は `projectPath` と無関係の安定したディレクトリ（既定 `getConfigDir()`＝`~/.devrelay` 等。存在しなければ `os.homedir()`。**`os.tmpdir()` は使わない**＝他ユーザーに共有ディレクトリを汚染されうるため）
  - 共有 spawn ヘルパ（`capabilities/claude-cli.ts`）の型シグネチャで `cwd` を省略不可にし、呼び出し漏れを型で防ぐ

## 8. Claude adapter v1 の手順（冪等）

対象は `provider=claude / kind=plugin` のみ。

### 8.1 machine/user scope（`reconcileMachine`、trigger connect / config / idle / manual）

1. `claude` 存在確認 → 無ければ `failed: claude-not-found`
2. `claude --version` → `runtimeVersion`
3. `claude plugin marketplace list` に `marketplaceName` が無ければ `claude plugin marketplace add <marketplaceSource>`。追加後に list を再取得し、marketplace.json の `name` が一致しなければ `marketplace-name-mismatch` で打ち切り
4. `claude plugin marketplace update <marketplaceName>`。失敗（オフライン等）は `failed` に積んで続行
5. `claude plugin list` で install 済み一覧を **scope 付きで**取得
6. `items` のうち claude/plugin を `<id>@<marketplaceName>` に組み立てて比較。**同一 ID が project / local scope に存在するだけでは `present` とみなさない。user scope に存在することを確認する**（test010 だけに local で入っているものを「ホスト常備済み」と誤認しない）。`plugin list --json` 等で scope 情報を取る方法を Plan に明記
7. user scope に未 install → `claude plugin install <id>@<marketplaceName> --scope user` → `installed`
8. user scope に install 済み → `claude plugin update <id>@<marketplaceName>` → 実際に版が変わったものだけ `updated`、変わらなければ `present`。注意: Claude Code の更新判定は plugin.json の `version` → marketplace entry の `version` → git SHA の優先順で、**索引の sha を変えただけでは更新されないことがある**。E2E-6 が実機で通れば採用、通らなければ `updated` は v1 で空を返し、更新方式は P2 で決める
9. 1 件ずつ実行。失敗しても次へ（CLI 失敗が他 plugin の処理を止めない）
10. `CapabilityResult` を返す

### 8.2 project/prelaunch（`reconcileProject`、trigger prelaunch、v2.1 改訂）

- `<projectPath>/.claude/settings.json`（project scope）と `<projectPath>/.claude/settings.local.json`（local scope）の両方の `enabledPlugins` から true のものを抽出（このファイルを読むのは **adapter 内**）
- `@<marketplaceName>` でない ID は `notAllowed`（install しない）
- **差分が無ければ CLI を呼ばない**（candidate 0 件なら `claude` の存在確認すら行わない）
- **候補が 1 件以上ある場合のみ** `claude plugin marketplace list --json` を実行し、宣言された `marketplaceName` の登録状態を確認する:
  - 登録済み（`registered`）→ 通常どおり続行
  - パース不能・CLI 失敗（`unknown`）→ **fail-open**（登録済みとみなして続行。ネットワーク瞬断等で毎回ブロックしないため）
  - **未登録（`not-registered`）→ 初回フォールバック**: prelaunch は `marketplace add` を**行わない**（cwd がプロジェクトディレクトリのため、ここで addすると意図しない場所に marketplace 状態が残るリスクがあるのと、3分予算内で完結させるため）。代わりに `requestMachineReconcile()`（共通層 `capability-sync.ts` から prelaunch にのみ注入されるコールバック。machine 経路には注入されず自己再帰しない）を**1回だけ** fire-and-forget で呼び machine reconcile（§8.1 の 1〜4 を含む）に処理を委譲し、`failed: [{ id: 'marketplace:<name>', reason: 'marketplace-not-registered' }]` を積んで**即 return**（起動を一切ブロックしない）
- **install scope は宣言元ファイルに合わせる**（実機で `enabledPlugins` の宣言 scope と install scope が不一致だと Claude Code がプラグインを読み込まないことを確認済み）:
  - project の `.claude/settings.json` にのみ宣言 → `--scope project`
  - local の `.claude/settings.local.json` にのみ宣言 → `--scope local`
  - 両方に宣言 → **project を優先し 1 回だけ** install（local への重複 install はしない）
- **present 判定は宣言 scope と cross-check する**: `claude plugin list --json` の結果に対象 ID が存在するだけでは不十分。**scope が宣言 scope と一致し、かつ enabled、かつ（project/local の場合）`projectPath` が対象プロジェクトと一致**して初めて `present`。scope 情報が list に出ない（未知）場合は `unknownScopePolicy: 'accept'` で fail-open 扱いにし、その旨を Agent ログに 1 行 `console.warn` する（reject 既定にすると scope が出ない実装/バージョンで毎 prelaunch 全件再 install する install storm になるため）
- **install 後は同じ list を取り直して再検証**し、対象 ID が宣言 scope で satisfied になって初めて `installed` に数える。再検証で satisfied でなければ `installed` ではなく `failed`（reason `install-verify-failed`）
- **索引未知 ID への 1 回のみのリトライ**: install が失敗し、そのエラーが「索引に存在しない」パターン（`PLUGIN_NOT_IN_INDEX_PATTERNS`、実機文言 `Plugin "<name>" not found in marketplace "<marketplace>"` を含む）に一致し、かつこの `reconcileProject` 呼び出し内でまだ 1 度もリフレッシュしていなければ、`claude plugin marketplace update <marketplaceName>` を 1 回実行し install を 1 回だけ再試行する。フラグは呼び出しごとのローカル変数（モジュールグローバルにしない）。timeout kill・spawn 失敗（ENOENT 等）・出力空はこのパターンに一致させず即 `failed`（無限リトライ・誤判定防止）
- v1 では **uninstall は行わない**（既に present なもの・不要になったものを削除する処理は無い）
- 1 件ずつ実行。失敗しても次へ（CLI 失敗が他 plugin の処理を止めない）
- **prelaunch の status**（P1.3 で新規導出。`packages/shared` の `CapabilityResult` 型は凍結のため `failed[].reason` から `capability-rules.ts` の純関数 `decidePrelaunchStatus()` で導出しWS送信 payload の `status` に反映）:
  - installed/updated/notAllowed が 1 件でもあれば `done`
  - 上記が無く failed が `marketplace-not-registered` のみで構成されていれば `skipped`（初回フォールバック中の一時的な状態。委譲先の machine reconcile が直後に完了すれば自己修復する）
  - それ以外で failed が 1 件以上あれば `error`（**旧仕様からの意図的な変更**。従来は install 失敗時も常に `done` と報告していた）

## 9. Web（Agent Settings モーダル）

Auto Update の下にセクションを追加。DevRelay 全体の概念名は **Capabilities**。v1 の表示:

```
Capabilities
  Claude Code Plugins
    Marketplace [ devrelay ]   Source [ murata1215/devrelay-plugins ]
    Plugins     [ commit-commands ] [ unity ]      （Project Search Paths と同じタグ入力、表示は unity@devrelay と補完）
    [ Sync now ]
    最終同期: 日時 / installed N / updated N / failed N / trigger   （Auto Update の「最終自動更新」行と同じ形式。failed / notAllowed は展開で理由）
```

- 内部 payload は `capabilityConfig`（§4.1）に変換する
- 「Provider: Claude / Devin / Codex」のような未実装の選択 UI は置かない。将来 provider が増えたときにセクションを追加できる構造だけ確保
- 保存は Hostname Alias と同じ「同一ホスト名の全 Agent に適用」の注記
- `capabilitySyncStatus` が null なら「未同期（Agent 更新が必要）」
- **`presentCount` と `noSkillsCount`（v2.4、サイクル P3-C）**: Agent から届く `present` 配列には、skill を 1 つも持たないプラグイン用の `<pluginId>:no-skills` という値が混在しうる（payload は無変更）。web は `partitionPresentIds()` でこれを分離し、`presentCount` は「実際に present な skill/plugin の件数」、`noSkillsCount` は「skill が無いため present にならなかったプラグインの件数」を表す。**不変条件: `presentCount + noSkillsCount` は Agent が報告した `present` 配列の総要素数（＝ v2.3 以前の `presentCount` の値）と常に一致する**。将来 Flutter/モバイル等の別クライアントがこの数値を読む場合もこの式で従来の合計値を復元できる。

## 10. やらないこと（v1 外）

Devin / Codex adapter・その CLI 調査と操作、provider 共通の独自 plugin / package フォーマット、独自レシピエンジン、DevRelay 独自 Skill 規格、Claude Plugin の Devin / Codex への変換、provider 間の自動変換、「1 つの Capability ID で全 AI へ自動配布」、private リポ認証（v1 は public 前提。Plan に「git 認証が無いと失敗」を明記）、uninstall / disable / rollback（v1 は追加と更新のみ）、`strictKnownMarketplaces` 配布、承認コマンド、マーケットプレイスリポの生成・vendoring、Windows Electron Agent、Quick Install スクリプト変更（初回 `server:connect:ack` の config で自動登録されるので不要）。

## 11. テスト

- 共通層: `claude/plugin` が Claude adapter に routing される / unsupported provider・kind で Agent が落ちず `failed` に記録される / reconcile が直列化される / timeout 後も runner 起動判断へ戻る / 複数 adapter を想定した `results[]` 形式で Server へ送れる
- Claude adapter: marketplace 差分 / install 差分 / update 差分 / `enabledPlugins` 解析 / `--scope user` と `--scope local` の使い分け / **local にしか無い ID を user scope の present と誤認しない** / user scope 有効なら local へ重複 install しない / prelaunch 初回フォールバック（未登録・キャッシュ無し）と通常時の分岐 / 差分無しなら CLI を呼ばない / CLI 失敗が他 plugin を止めない / list 出力パーサー
- Server: `capabilityConfig` 保存でホスト名一括適用 / `agent:capability:sync` の保存と Web 転送 / 未更新 Agent で既存動作不変
- Web: セクション表示・タグ入力・null 時「未同期」
- 既存テスト全 pass（server / web / agent の件数を Plan に書く）

## 12. 反映と E2E（人間側）

1. `psql` で ALTER 2 本 → `cd apps/server` → `npx prisma generate` → `pnpm build` → `pm2 restart`
2. Linux / macOS の全 Agent に `u`（hp630g9 含む）
3. tisa-lenovo の Agent Settings で Marketplace 既定値 + Plugins に `commit-commands`（索引に置いておく）→ Save → Sync now → 「最終同期」に installed 1 → 当該マシンの `claude plugin list` に出る → 同一ホスト名の別 Agent にも入る
4. **（v2.1 改訂）** 対象リポの `.claude/settings.json`（project scope）に `{"enabledPlugins": {"commit-commands@devrelay": true}}` を置いた状態でタスク投入 → 起動前にそのプロジェクト cwd で `--scope project` で入り、`~/.claude/plugins/installed_plugins.json` の該当 entry が `scope: project` かつ `projectPath` が対象リポのパスと一致する → プロジェクト cwd での `claude plugin list` が `Scope: project` / `✔ enabled` になる。`.claude/settings.local.json` は生成されない（project scope 専用ではなく local scope 専用のファイルのため）。`.claude/settings.local.json` にのみ宣言した場合は同様に `--scope local` で入ることを別途確認する
5. 索引外 ID（`foo@claude-plugins-official`）を宣言したリポで `notAllowed` に載る
6. 索引の `sha`（必要なら entry の `version` も）を進めて Sync now → `updated` に載る（8.1-8 の実機確認。通らなければ P2 送り）

## 13. 完了条件（exec 後）

- §4〜§9 が commit・push 済み（1 コミットでよい）
- devlog: `doc/devlog/YYYY-MM-DD_HHMMSS.md` を**新規 1 ファイル**（`TZ=Asia/Tokyo date '+%Y-%m-%d_%H%M%S'`、冒頭 `# YYYY-MM-DD HH:MM JST ｜ サイクルP1: Capability 配布基盤（Claude adapter）`、要求 / 実行 / 検証 / 発見 を平文 3〜10 行、テスト件数は具体値）。`doc/devlog/INDEX.md` 末尾に 1 行追記。既存 devlog への追記・全読み禁止
- 完了報告に「人間側でやること」（ALTER 文、prisma generate、pm2 restart、全機 u、E2E 手順）を再掲
- 完了報告に **構造確認を 1 段落**: Capability 共通層 / Claude 固有層 / 将来 Codex を足す場所 / 将来 Devin を足す場所。「Codex / Devin 追加時に Server・DB・WS 同期基盤を変えず、Agent adapter と UI / provider 設定の追加を中心に拡張できる」ことをコード構造上確認する

## 14. Plan に必ず書くこと

1. Auto Update（アイドル時更新）の既存実装の場所・周期・抑制条件と相乗り方法
2. Hostname Alias の一括適用の既存実装と `capabilityConfig` で同じ経路を使う方法
3. 現在どのファイルが Claude 固有の runner 処理を担当しているか。ai-runner の `claude` 実行ファイル解決と prelaunch 入口の挿入位置
4. `capability-sync.ts` 共通層と Claude adapter の責務分割（ファイル名・interface 名・引数）
5. Claude 固有コードが Server / Web / 共通層へ漏れていないこと
6. 将来 Codex adapter / Devin adapter を追加する場合の接続点（それぞれ）
7. 今回あえて抽象化しなかった部分と理由
8. 変更後の DB カラム名・WS 型名・ファイル名。旧 `pluginConfig` / `pluginSyncStatus` 等が新規実装に残っていないこと
9. `claude plugin list` / `marketplace list` / `plugin update` の実機出力（ubuntu-prod/devrelay で read-only 実行して貼る）、JSON オプションの有無、**list から scope（user / project / local）を判別する方法**
10. 変更ファイル一覧と行数見積、追加テスト件数
11. 未更新 Agent との互換性（新 field 無視・null 扱い）の確認
12. **実装開始前に Plan を提示して停止すること**
