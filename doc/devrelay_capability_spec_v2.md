# DevRelay Capability 配布基盤 指示書 v2（サイクル P1）

- 作成日: 2026-09-13
- 対象: devrelay 本体（`/opt/devrelay`, projectId `cmm5tpzil0042f3p2ieotnow4`）
- ステータス: **人間レビュー待ち（未 submit）**
- 置き換え: 本書は同日の「Plugin 配布機能 指示書 v1」を Capability 抽象化で改訂したもの。2026-09-03 の「Toolkit 配布機能（レシピ実行基盤）」案は破棄

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

### 7.4 CLI 実行の安全性

- `spawn` / `execFile` でコマンドと引数を分離。**シェル文字列連結で実行しない**。Web から受け取った plugin ID / marketplaceSource をそのままシェル文字列へ結合してはいけない
- `claude` 実行ファイルの解決は ai-runner が Claude Code を起動するのと**同じ方法**を使う
- 機械可読 JSON オプションがあるコマンドでは JSON を使う（Plan で実機確認。無ければ行パースを純関数化してテスト）

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

### 8.2 project/prelaunch（`reconcileProject`、trigger prelaunch）

- 通常は 8.1 の 1〜4（存在確認 / marketplace 登録 / marketplace update）を行わない。**例外（初回フォールバック）**: marketplace が未登録、またはプロセス内に有効な plugin list キャッシュが一度も無い場合（Agent 起動直後に config 受信 → reconcile 未完のままタスク投入、の競合）だけ、3 分上限の中で必要最小限の初期化（存在確認 → marketplace add → list 取得）を行う。実機確認で不要と分かれば簡略化可
- `<projectPath>/.claude/settings.json` の `enabledPlugins` から true のものを抽出（このファイルを読むのは **adapter 内**）
- `@<marketplaceName>` でない ID は `notAllowed`（install しない）
- 対象を直近の `claude plugin list` 結果（プロセス内キャッシュ、reconcile のたびに更新）と比較。**user scope で既に有効なものは local へ重複 install しない**（`present`）。差分がある場合のみ list を取り直して確認し、`claude plugin install <id> --scope local` → `installed`
- **差分が無ければ CLI を呼ばない**

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
4. test010 の `.claude/settings.json` に `{"enabledPlugins": {"commit-commands@devrelay": true}}` を置き `claude plugin uninstall` した状態でタスク投入 → 起動前に `--scope local` で入り `.claude/settings.local.json` が作られる
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
