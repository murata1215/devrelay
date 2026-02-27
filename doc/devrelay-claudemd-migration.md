# CLAUDE.md 圧縮・分離 移行ガイド（一回用）

> このガイドは既存プロジェクトの肥大した CLAUDE.md を分離・圧縮する一回限りの作業手順です。
> 移行後の維持ルールは `rules/devrelay.md` の「CLAUDE.md 更新ルール」セクションに記載されています。

## 背景

CLAUDE.md は **毎回のプロンプトでコンテキストに全文載る**。
肥大した CLAUDE.md はトークンコスト増・コンテキスト圧迫・ノイズ増加を招く。

| 指標 | Before | After |
|------|--------|-------|
| CLAUDE.md サイズ | 5,000〜15,000 トークン | **1,000〜2,000 トークン** |
| 毎回のコンテキスト浪費 | 3,000〜13,000 トークン | **ほぼゼロ** |

## 移行後のディレクトリ構造

```
project/
├── CLAUDE.md                  ← 軽量ハブ（参照 + 概要のみ）
├── rules/
│   ├── devrelay.md            ← DevRelay Agreement + CLAUDE.md 更新ルール（全プロジェクト共通）
│   └── project.md             ← プロジェクト固有ルール（設計判断・注意事項）
├── doc/
│   ├── changelog.md           ← 開発記録・Phase 履歴
│   ├── architecture.md        ← 詳細アーキテクチャ
│   └── ...
```

## 分類判断フローチャート

CLAUDE.md の各セクションを以下のフローで分類する：

```
そのセクションは...
├─ DevRelay の共通ルール（Agreement）？
│   → rules/devrelay.md
├─ 今も開発時に毎回参照が必要？（技術スタック、ビルド手順、環境変数、DB概要）
│   ├─ YES → CLAUDE.md に残す（ただし簡潔に）
│   └─ NO → 次へ
├─ 設計判断・注意事項（現在有効）？
│   → rules/project.md
├─ 完了済み・履歴・経緯・チェックリスト？
│   → doc/changelog.md
├─ API仕様・DB定義（詳細）？
│   → doc/api-spec.md or doc/architecture.md
└─ コードから読めるもの？
    → 削除（重複排除）
```

## 移行手順

### Step 1: ディレクトリ作成

```bash
mkdir -p rules doc
```

### Step 2: rules/devrelay.md を作成

DevRelay Agreement 全文 + CLAUDE.md 更新ルールをここに配置。
（別途提供の `devrelay-agreement-template.md` を使用）

既存 CLAUDE.md から `<!-- DevRelay Agreement -->` ～ `<!-- /DevRelay Agreement -->` を切り出して移動。

### Step 3: rules/project.md を作成

CLAUDE.md から **現在も有効な** 設計判断・ルール・注意事項を抽出。

含めるもの：
- 認証方式の優先順位、フロー説明
- basePath 切り替えの仕組み
- 月間投稿カウントのルール
- アフィリエイトクリック追跡の設計
- やってはいけないこと（例：本番で NEXT_PUBLIC_BASE_PATH を設定しない）
- よくあるトラブルと対処法

含めないもの：
- ✅ チェックリスト → changelog
- 日付付き実装詳細 → changelog
- Before/After の経緯 → changelog

### Step 4: doc/changelog.md を作成

CLAUDE.md から全ての履歴情報を移動。

対象：
- Phase 完了チェックリスト
- 日付付き実装記録（「2026-02-22 実装」系すべて）
- 仕様変更の経緯・Before/After
- 新規ファイル一覧
- 環境変数の追加履歴

フォーマット：
```markdown
# Changelog

## 2026-02-27
### ads.txt + プラットフォーム共通固定ページ
- ...

## 2026-02-24
### カテゴリマスタ管理 + タグ機能
- ...

## Phase 3 完了（pixblog.net ドメイン移行）
- ...

## Phase 2 完了
- ...
```

### Step 5: CLAUDE.md を軽量版に書き換え

以下のテンプレートに従って書き換える：

```markdown
# {プロジェクト名}

{1〜2行のプロジェクト概要}

## ルール
- DevRelay 共通ルール: `rules/devrelay.md`
- プロジェクト固有ルール: `rules/project.md`

## 技術スタック

| レイヤー | 技術 |
|---------|------|
| ... | ... |

## ビルド & デプロイ

{最小限のコマンド 5〜10行}

## 環境変数

| 変数名 | 説明 |
|--------|------|
| ... | ... |

## DB テーブル（概要）

| テーブル | 用途 |
|---------|------|
| ... | {1行説明} |

## 詳細ドキュメント
- 設計・アーキテクチャ: `doc/architecture.md`
- 変更履歴: `doc/changelog.md`
- API 仕様: `doc/api-spec.md`（またはコード参照）
```

### Step 6: 動作確認

1. プロジェクト接続時に Agreement チェックが通ること
2. Claude Code が `rules/devrelay.md` を読めること
3. `w` コマンドで changelog に書かれること（CLAUDE.md が肥大化しないこと）

## DevRelay Agent 側の変更（任意）

### agreement コマンドの変更

現在の `a` / `agreement` コマンドは CLAUDE.md に Agreement 全文を埋め込んでいる。
これを以下のように変更する：

1. `rules/devrelay.md` を作成（Agreement 全文 + 更新ルール）
2. CLAUDE.md には参照行のみ追加
3. チェック対象を `rules/devrelay.md` の存在 + バージョンマーカーに変更

### compress コマンドの新設（任意）

`compress` コマンドで既存の肥大した CLAUDE.md を AI に自動分離させる：

```
ユーザー: compress
→ Claude Code が CLAUDE.md を分析
→ rules/, doc/ に分離
→ CLAUDE.md を軽量版に書き換え
```
