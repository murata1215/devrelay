# 2026-10-08 ｜ Devin モデル名「表示名 vs ID」不一致の根治 + 古い Devin CLI の検知

## 背景

ユーザーから Discord スクショ2枚が届いた。1枚目は

```
ℹ️ モデルが Claude Opus 5.5 から claude-opus-5.5 に変更されました。Devin はセッション再開
（resume）時に --model を反映しないため、前回のセッションを継続せず新規セッションで開始します。
🧠 Devin のモデル: Claude Opus 5.5（Claude Opus 5.5）
⚠️ モデル claude-opus-5.5 を指定しましたが、実際には Claude Opus 5.5 で実行されました。
セッション再開（resume）か Devin 側のモデル制限が原因の可能性があります。
```

という3つの警告が同時に出ているもので、2枚目は WebUI の Codex CLI モデル選択ドロップダウン
（本件とは無関係、名称指定の仕方について確認する過程で添付されたもの）。

ユーザーからの質問は「名称の指定の仕方がわるいっぽいね。マスタ直せばなおるかな？」。
調査の結果、**マスタ（`AI_MODEL_CATALOG`）は正しく、直す必要が無い**ことが判明した
（詳細は後述）。その後プラン提示中にユーザーから追加報告:「devin updateしたら普通にうごいた。
なんでだろうね？？」。DB 実測でこの疑問にも回答し、プランへ反映した。

## 調査で判明した事実

### 真因: ATIF の「人間可読表示名」と「要求モデル ID」の文字列比較

Devin は `agent.model_name`（人間可読、例: `Claude Opus 5.5`）と `steps[].extra.generation_model`
（機械可読 slug、例: `claude-opus-5-5-medium`）という2種類の値を ATIF（`devin --export`）に
書き出す。`extractAtifModel()`（`devin-atif.ts`）は後者を優先するが、ステップが
`generation_model` を一つも持たない場合は null になり、`ai-runner.ts` 側で前者（表示名）に
フォールバックしていた。

- `saveDevinModel()` にこの表示名がそのまま渡り、次ターンの「前回の実モデル」として保存される
- 次ターンで `detectDevinModelMismatch('claude-opus-5.5', 'Claude Opus 5.5')` を評価 →
  `normalizeDevinModelId()`（`model-pricing.ts`）が小文字化もスペース→ハイフン変換もしていなかった
  ため文字列不一致 → 偽の「モデルが変更されました」「実際には…で実行されました」警告

### DB 実測で判明した「なぜ `devin update` で直ったか」

```sql
SELECT "usageData"->>'model' AS model, COUNT(*) n, MAX("createdAt")::date last
FROM "Message" WHERE "usageData"->>'tool'='devin' GROUP BY 1 ORDER BY 3 DESC, 2 DESC;
```

| model | n | 保存形式 |
|---|---|---|
| `Claude Opus 5.5` | 67 | 表示名（バグ） |
| `swe-2-high` | 58 | slug（正常） |
| `claude-opus-5-5-medium` | 36 | slug（正常） |
| `SWE-1.6 Fast` | 1 | 表示名（バグ） |
| `gpt-6-sol-medium` | 3 | slug（正常） |

`usageData.usage`（トークン使用量）の有無と保存形式が完全相関（例外ゼロ、表示名68件は全て
usage 無し、slug 97件は全て usage 有り）。machine 別に集計すると、`DESKTOP-TR0SE8J/lfuser`
（ユーザーのスクショにあった `D:\My Programs\signage-client-android` の機体）だけが表示名
バグに該当し、他の4機体（`DESKTOP-3OGCIRU`/`DESKTOP-FF8BRSB`/`DESKTOP-MM07N0E`）は一貫して
正常だった。さらに `DESKTOP-TR0SE8J` 内の切り替わりを時系列で見ると:

- 最後の表示名ターン: 2026-10-07 06:41:07（JST）
- 最初の slug ターン: 2026-10-07 07:55:20（JST）

という分単位でクリーンな境界があり、`devin update` のタイミングと一致した。

**結論**: その1台の Devin CLI が古く、`devin --export`（ATIF）が `steps`/`final_metrics` を
含まない簡易形式しか出力していなかった。`devin update` で ATIF がフル出力に戻り、
`generation_model`（slug）と `final_metrics`（トークン使用量）が両方取れるようになったため、
全症状が消えた。

### この7日間（68ターン）で静かに失われていたもの

- **Devin セッションの継続（resume）**: 毎ターン `modelChangedNewSession` が誤発火し、
  新規セッションで開始し続けていた（会話文脈が毎ターンリセット、課金増）
- **トークン使用量・コスト表示**: `usage` が null のため Conversations のコスト列が `-`
- **警告の信頼性**: 毎ターン偽の mismatch 警告が出ており、本物の振り替え事故（2026-10-02 修正）
  との区別が付かなくなっていた
- **真因の手がかり**: 「古い Devin CLI」という真因を DevRelay は一度も通知しておらず、
  利用者は「Devin 側のモデル制限が原因かも」という誤誘導メッセージだけを見ていた

### なぜマスタ（`AI_MODEL_CATALOG`）は直さないのか

`AI_MODEL_CATALOG.devin` の非エイリアス全16件で
`name.toLowerCase().replace(/\s+/g,'-') === id` が成立する（実測で検証済み）ため、
**正規化層（`normalizeDevinModelId()`）に1行足すだけで全件直る**。マスタの `id` を表示名に
寄せる方向で直すと、`isUnsafeModelId()` が空白を含む値を拒否して `--model` 自体が付与されなくなり、
`DEVIN_MODEL_PRICING` のキーとも一致しなくなるため、**むしろ壊れる**。

## 実装内容

### 1. `packages/shared/src/model-pricing.ts`

`normalizeDevinModelId()` の冒頭に **無条件で** `toLowerCase().replace(/\s+/g, '-')` を追加。
「空白を含むときだけ」にすると `SWE-2`/`GPT-5.3-Codex`（表示名なのに空白を含まない）だけ
正規化漏れが残るため、条件分岐は避けた。`DEVIN_MODEL_TRACKING_ALIASES` を `export` 化
（テストがマスタ駆動で直接参照するため）。`detectDevinModelMismatch()` の JSDoc に
「表示名のみのターンでは `-fast` の有無が原理的に判別できない」という既知の限界を明記。

### 2. `packages/shared/src/i18n.ts`

- `devin.modelUsedNameOnly`: `modelId` が無い/`modelName` と同一のときの単独表示用
  （`Devin のモデル: X（X）` の重複表示を解消）
- `devin.atifDegraded`: 簡易形式 ATIF（`modelId` も `usage` も null、`modelName` のみ取得）を
  検知したときの `devin update` 案内

### 3. `agents/{linux,macos,windows}/src/services/ai-runner.ts`（3機体 byte-identical）

- `devinAtifDegraded` フラグを新設（close ハンドラで `!digest.modelId && !digest.usage && !!digest.modelName`
  として判定）
- モデル名の1行通知を分岐化: `modelId`/`modelName` が両方取れて異なる場合のみ両方表示、
  それ以外は `devinModelUsedNameOnly`
- `devinAtifDegradedWarnedSessions`（`Set<sessionId>`、既存の `devinModelUnsupportedWarnedSessions`
  と同じ流儀）でセッション単位1回だけ `devin.atifDegraded` を通知

`saveDevinModel()` の呼び出し行自体は変更していない（読み出し側の正規化だけで、ディスクに
残っている古い表示名 baseline も次ターンから自動的に一致判定されるようになるため、
書き込み側の変更や手動クリーンアップは不要）。

### 4. `agents/{linux,macos,windows}/src/services/session-store.ts`

`saveDevinModel()` の JSDoc が「実測できた実際のモデル **ID**」と書いていたが実装と
食い違っていたため、「slug でも表示名でもよい。比較は常に `normalizeDevinModelId()` を通す」
に訂正（docstring のみ、動作変更なし）。

### 5. テスト

- `packages/shared/tests/model-pricing.test.mjs`:
  - 既存ケース `MODEL_PRIVATE_11` の期待値を小文字化後の形に修正（意図的な case fold による
    唯一の既存テスト変更）
  - `AI_MODEL_CATALOG.devin` を直接走査し、非エイリアス全件で表示名→id の slug 化が成立する
    ことを固定するカタログ駆動テストを追加
  - 報告バグの回帰（`claude-opus-5.5` vs `Claude Opus 5.5` → false）、空白を含まない表示名
    （`SWE-2`/`GPT-5.3-Codex`）の回帰、本物の不一致は検知し続けること、`-fast` の既知の限界、
    単価解決と `resolveMessageCost` の遡及回復を確認するテストを追加
- `agents/{linux,macos}/tests/devin-atif.test.mjs`: 簡易形式 ATIF（`agent.model_name` のみ、
  `steps`/`final_metrics` 無し）のフィクスチャで `extractAtifModel`/`extractAtifUsage` の挙動を固定
  （windows は該当テストファイル自体が存在しないため対象外）

### 6. ドキュメント

`rules/project.md` の「Devin セッションIDとモデルは常に対で扱う」節に、今回の DB 実測と
対策方針を追記。

## 変更していないもの

- `AI_MODEL_CATALOG`（マスタ）: `id` は `--model` の実引数かつ `DEVIN_MODEL_PRICING` のキーで、
  正しい
- `saveDevinModel()` の実装・呼び出し行（docstring のみ訂正）
- `result.usageData.model`（DB 書き込み値）: 読み出し側の修正で既存の表示名行も遡及的に
  単価解決できるようになるため、書き込み時正規化は不要かつ有害（`-fast`/推論量情報が失われる）

## 検証

`node --test packages/shared/tests/` と `agents/{linux,macos}/tests/devin-atif.test.mjs` が
green であることを確認。`pnpm build` 実行済み。

## デプロイ

- `pnpm build` 実行済み
- **pm2 restart 要**（Conversations のコスト遡及表示が server 側 `resolveMessageCost` 経由のため）
- **Devin を使う全機体で `u` 必須**: `DESKTOP-3OGCIRU`, `DESKTOP-FF8BRSB`, `DESKTOP-MM07N0E`,
  `DESKTOP-TR0SE8J`
- DB マイグレーション不要、バックフィル不要
