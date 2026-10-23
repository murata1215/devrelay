# Codex モデル許可リストに GPT-6 世代3件を追加（2026-10-23）

## 発端

raw-completion（`POST /api/agent/raw-completion`、`ai:"codex"`）で GPT-6 世代を使いたいという依頼。
少数決の席から `gpt-6-astra` を送ると `400 aiUnavailable: Unknown Codex model: "gpt-6-astra"` で
弾かれていた。

## 原因

`apps/server/src/services/raw-completion-ai.ts` の `validateRawCodexModel()` が
`AI_MODEL_CATALOG.codex`（`packages/shared/src/constants.ts`）の id 一覧に対して厳密一致で検証する
設計（自動フォールバック無し）。カタログは 2026-08-18 時点の codex-cli 0.147.0 実測スナップショット
（GPT-5.6 / 5.5 / 5.4 世代の6件）のままで、その後 CLI 側に入った GPT-6 世代が未反映だった。

## 変更内容

- `AI_MODEL_CATALOG.codex` の先頭に `gpt-6-astra` / `gpt-6-sol` / `gpt-6-luna` の3件を追加
  （既存6件は無変更・削除なし）。
- 追加前に本機（codex-cli 0.164.0）の `~/.codex/models_cache.json` で `visibility:"list"` の
  3件の存在を確認（依頼元の uso8m 0.163.0 実測と一致）。
- 同キャッシュには priority 最上位の `gpt-6.1-sol` も載っているが、今回は依頼どおり**意図的に
  未追加**（スコープ外であることをテストで固定）。
- CLI 既定モデルの扱いは変更しない（`gpt-5.6-sol` の「（CLI 既定）」表記は据え置き）。
- Agent 側（`agents/*`）は `-m <slug>` を素通しするだけで許可リストを持たないため無変更
  （= 各機の `u` は不要）。

## テスト

- `packages/shared/tests/model-catalog.test.mjs`: GPT-6 3件の存在・既存6件の残存・並び順
  （GPT-6 が先頭）・`gpt-6.1-sol` が未追加であることを固定。
- `apps/server/tests/raw-completion-ai.test.mjs`: `validateRawCodexModel()` が実カタログで
  GPT-6 3件を ok にすること、`gpt-6.1-sol` を NG にすることを追加。
- `README.md` の raw-completion 節「full 6-entry list」を 9-entry に訂正。

## 検証

`pnpm build` 後、shared / server 両ワークスペースのテストが新規分を含めて green
（件数は commit メッセージ参照）。`git diff --stat` で今回対象外のファイル（前サイクル群の
未コミット `.ts` 変更）が混入していないことを確認済み。

## 残作業

- `pm2 restart devrelay-server`（今回は未実施）。
- DB マイグレーション不要。Agent 機の `u` 不要。
- 作業ツリーに前サイクル群の未コミット `.ts` 変更が残っているため、restart 時はそれらも
  同時に反映される点に注意（今回の commit には含めていない）。
