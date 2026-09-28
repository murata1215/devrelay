# 2026-09-28 ｜ Devin モデルカタログ更新（Claude Opus 5.5 対応 + 実測リフレッシュ）

## 背景

ユーザーから WebUI 設定ページのモデル選択ドロップダウン画像を添えて「devinのモデル一覧だけど
更新できる？opus5.5とか使いたいな」という依頼。添付画像は Codex CLI の見出し直上に開いていたが、
一覧の中身（Adaptive / Claude Opus / Claude Sonnet / Claude Haiku / Claude Fable 5.1 / GPT /
GPT-5.6 Terra / GPT-5.6 Luna / Codex / Gemini / Gemini 3.1 Pro / SWE / GLM 5.3 / カスタム…）を
`packages/shared/src/constants.ts` の `AI_MODEL_CATALOG` と突き合わせると **Devin CLI の一覧**
（旧13件）と完全一致していたため、まず対象の取り違えを訂正した。

Codex の一覧は別物（`GPT-5.6 Sol / Terra / Luna / GPT-5.5 / GPT-5.4 / GPT-5.4 Mini`）で無関係。

## 実測

`rules/project.md`（#360 節）に「`AI_MODEL_CATALOG.devin` の対応モデル一覧は CLI の実測でしか
確定できない」という明文ルールがある。この機体に Devin CLI は無いため、唯一 Devin が入っている
`tisa-lenovo/lfuser`（Windows、プロジェクト `TEST`）へ `devrelay-ask-member` skill（`--ai claude`
指定・読み取り専用の質問モード）で調査を依頼した。

### 発見1: `devin models list` サブコマンドの存在

devin `3000.6.14`（`devin --version` 実測）に、前回実測サイクル（#360、2026-09-05）では
知られていなかった `devin models list`（`--format json` 対応）サブコマンドが存在すると判明した。
実行時にサーバから最新一覧を取得しており、**52 ファミリー全量**が得られた。

### 発見2: ローカルキャッシュは古い

`%LOCALAPPDATA%\devin\cli\model_configs_v5.*.bin`（JSON ラッパ + base64 protobuf、134,060 bytes
× 2ファイル）をデコードして検証した結果、`fetched_at` が 2026-09-07 13:08:15Z 固定で、
**`claude-opus-5-5` の文字列が0件**だった（先頭エントリは旧世代の `claude-opus-5-medium`）。
→ ローカルキャッシュは実測の根拠にしてはいけない。正は常に `devin models list --format json`。

### 発見3: Claude Opus 5.5 の実在

- family slug: `claude-opus-5.5`（ドット表記）
- model UID: `claude-opus-5-5-{low,medium,high,xhigh,max}` + `-fast` 付き計10個
- 価格: 通常 $4/$0.2/$20 per MTok、`-fast` は $8/$0.4/$40、1M ctx
- `opus-5.5` という短縮形は一覧に**存在しない**

### 発見4: エイリアス解決先の無警告シフト

`--format json` の `aliases` フィールド実測で、エイリアスの解決先が前回実測（#360、2026-09-05）から
動いていることが判明した。同梱ドキュメント（`…\_versions\3000.6.14\share\devin\docs\models.mdx`）にも
「Short names like `opus`, `sonnet`, `swe`, `codex`, and `gemini` always resolve to the latest
version in that model family.」と明記されている。

| エイリアス | 実測時点の解決先 | 前回（#360 時点の想定） |
|---|---|---|
| `opus` | `claude-opus-5.5` | Opus 5 世代 |
| `sonnet` / `claude` | `claude-sonnet-5` | （変化なし） |
| `haiku` | `claude-haiku-4.5` | （変化なし） |
| `gpt` | `gpt-6-sol` | GPT-5.6 Sol |
| `gemini` | `gemini-3.8-flash` | Gemini 3.1 Pro 系 |
| `swe` | `swe-2`（262K ctx・**Free**） | 旧 SWE 世代 |
| `codex` | `gpt-5.3-codex` | （変化なし） |

## 設計方針の修正（ユーザー指摘を反映）

初版プランでは `claude-opus-5.5` を明示追加する一方、`gpt-6-sol` は「`gpt` エイリアスで届くから」
として省いていた。ユーザーから「gpt-6-sol は？」と指摘を受け、この扱いが不統一だと気づいた。

エイリアスは family の世代が上がると無警告で解決先が変わる（上表のとおり）ため、
**「最新に自動追従したい」エイリアスと「世代を固定したい」family slug を対で載せる**方針に修正した。
片方だけだと、自動追従派は気づかないうちに単価が変わり、固定派は新モデルに永久に届かない。

対にした7組: `opus`↔`claude-opus-5.5`、`sonnet`↔`claude-sonnet-5`、`haiku`↔`claude-haiku-4.5`、
`gpt`↔`gpt-6-sol`、`codex`↔`gpt-5.3-codex`、`gemini`↔`gemini-3.8-flash`、`swe`↔`swe-2`。

## 実装

Devin は catalog の値を `--model` にそのまま渡すだけ（`agents/{linux,macos,windows}/src/services/
ai-runner.ts` の `args.push('--model', devinModel)`）なので、Claude 追加時（Opus 5.5 対応サイクル、
2026-09-25）のような Agent 側 SDK バージョン依存は無い。変更は `packages/shared` のみで完結する。

- `packages/shared/src/constants.ts`: `AI_MODEL_CATALOG.devin` を **13件 → 24件**へ更新
  （**削除は0件**、旧13件は全て今も Active）。カテゴリ見出しコメント（Claude/GPT/Gemini/その他）で
  可読性を確保。ヘッダー JSDoc に「devin のみ 2026-09-28 に再実測」を追記
  - 新規12件: `claude-opus-5.5` / `claude-opus-5` / `claude-sonnet-5` / `claude-haiku-4.5` /
    `gpt-6-sol` / `gpt-6-astra` / `gpt-6-luna` / `gpt-5.3-codex` / `gemini-3.8-flash` / `swe-2` /
    `deepseek-v4.1-flash`（11件のモデル追加 + 既存エイリアス4件のラベルに「（最新追従）」を追記）
  - 載せなかったもの: `-priority` 付き UID、`fusion-*`（335バリアント）、grok-4.7 / kimi-k3 /
    inkling / nemotron-3-ultra / glm-5.2 / glm-5.3-flash 等のマイナーファミリー
    （WebUI の「カスタム…」／チャット `l devin:<任意文字列>` で自由入力可能なため）
- `packages/shared/tests/model-catalog.test.mjs`:
  - 件数アサートを 13 → 24 に更新
  - 順序固定 `deepEqual` の `expected` 配列を新24件へ更新
  - 新規テスト: `claude-opus-5.5` / `gpt-6-sol` の存在確認
  - 新規テスト: エイリアス⇔解決先 family slug の7組が両方カタログに存在することを検査
    （今回の設計方針をテストで固定し、将来の再実測サイクルで崩れないようにする）
- `rules/project.md`（#360 節に追記）: `devin models list --format json` が正であること・
  ローカルキャッシュ（`model_configs_v5.*.bin` 等）は古くなるため根拠にしないこと・
  エイリアス対の設計方針（自動追従 vs 世代固定）を明記

## 検証

- `pnpm build`: 6 workspace すべて green
- `node --test`: shared 53/53・server 762/762・web 518/518 すべて green
- `git diff --stat -- apps/ agents/ prisma/`: 空（想定どおり `packages/shared` + `rules/` のみが
  変更対象。Devin の `--model` 素通し設計により Agent 側・DB は無変更で正しい）

## 反映

`packages/shared/src/constants.ts` は server（`command-handler.ts`）・web
（`SettingsPage.tsx`）の両方が単一情報源として参照するため、**`pm2 restart devrelay-server` 必須**。
各マシンの `u`（Agent 更新）は**不要**（Devin の `--model` はカタログの値をそのまま渡すだけで、
Agent 側コードは無変更のため）。DB マイグレーション不要。

commit/push は本サイクルでは未実施。
