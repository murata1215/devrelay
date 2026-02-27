import { readdir, readFile, stat, mkdir, rm, copyFile } from 'fs/promises';
import { join, basename, extname } from 'path';
import type { FileAttachment } from '@devrelay/shared';

// 出力ファイルの履歴保存先ディレクトリ名
const OUTPUT_HISTORY_DIR_NAME = '.devrelay-output-history';

// Directory name for files to be sent to user
export const OUTPUT_DIR_NAME = '.devrelay-output';

// Max file size to transfer (5MB)
const MAX_FILE_SIZE = 5 * 1024 * 1024;

// MIME types for common file extensions
const MIME_TYPES: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.js': 'text/javascript',
  '.ts': 'text/typescript',
  '.py': 'text/x-python',
  '.html': 'text/html',
  '.css': 'text/css',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.xml': 'application/xml',
  '.csv': 'text/csv',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
};

export async function ensureOutputDir(projectPath: string): Promise<string> {
  const outputDir = join(projectPath, OUTPUT_DIR_NAME);
  await mkdir(outputDir, { recursive: true });
  return outputDir;
}

/**
 * 出力ディレクトリをクリアする前に、既存ファイルを履歴ディレクトリにコピーする
 * コピー先: .devrelay-output-history/YYYYMMDD_HHmmss_filename
 * @param projectPath - プロジェクトのルートパス
 */
export async function clearOutputDir(projectPath: string): Promise<void> {
  const outputDir = join(projectPath, OUTPUT_DIR_NAME);
  try {
    // クリア前に既存ファイルを履歴ディレクトリにコピー
    await archiveOutputFiles(projectPath);
    await rm(outputDir, { recursive: true, force: true });
    await mkdir(outputDir, { recursive: true });
  } catch (err) {
    // Directory might not exist, that's ok
  }
}

/**
 * .devrelay-output/ 内のファイルを .devrelay-output-history/ に日時プレフィックス付きでコピーする
 * @param projectPath - プロジェクトのルートパス
 */
async function archiveOutputFiles(projectPath: string): Promise<void> {
  const outputDir = join(projectPath, OUTPUT_DIR_NAME);
  try {
    const files = await readdir(outputDir);
    // ファイルが無ければ何もしない
    if (files.length === 0) return;

    // 履歴ディレクトリを作成
    const historyDir = join(projectPath, OUTPUT_HISTORY_DIR_NAME);
    await mkdir(historyDir, { recursive: true });

    // 日時プレフィックスを生成（YYYYMMDD_HHmmss 形式）
    const now = new Date();
    const prefix = now.getFullYear().toString() +
      String(now.getMonth() + 1).padStart(2, '0') +
      String(now.getDate()).padStart(2, '0') + '_' +
      String(now.getHours()).padStart(2, '0') +
      String(now.getMinutes()).padStart(2, '0') +
      String(now.getSeconds()).padStart(2, '0');

    for (const filename of files) {
      const srcPath = join(outputDir, filename);
      try {
        const stats = await stat(srcPath);
        // ファイルのみコピー（サブディレクトリはスキップ）
        if (!stats.isFile()) continue;

        const destFilename = `${prefix}_${filename}`;
        const destPath = join(historyDir, destFilename);
        await copyFile(srcPath, destPath);
        console.log(`📁 Archived output file: ${destFilename}`);
      } catch (err: any) {
        console.error(`Failed to archive file ${filename}:`, err.message);
      }
    }
  } catch (err: any) {
    // 出力ディレクトリが存在しない場合はスキップ
    if (err.code !== 'ENOENT') {
      console.error('Failed to archive output files:', err.message);
    }
  }
}

export async function collectOutputFiles(projectPath: string): Promise<FileAttachment[]> {
  const outputDir = join(projectPath, OUTPUT_DIR_NAME);
  const attachments: FileAttachment[] = [];

  try {
    const files = await readdir(outputDir);

    for (const filename of files) {
      const filePath = join(outputDir, filename);

      try {
        const stats = await stat(filePath);

        // Skip directories and large files
        if (!stats.isFile()) continue;
        if (stats.size > MAX_FILE_SIZE) {
          console.log(`File too large to transfer: ${filename} (${stats.size} bytes)`);
          continue;
        }

        const content = await readFile(filePath);
        const ext = extname(filename).toLowerCase();
        const mimeType = MIME_TYPES[ext] || 'application/octet-stream';

        attachments.push({
          filename,
          content: content.toString('base64'),
          mimeType,
          size: stats.size,
        });

        console.log(`Collected output file: ${filename} (${stats.size} bytes)`);
      } catch (err: any) {
        console.error(`Failed to read file ${filename}:`, err.message);
      }
    }
  } catch (err: any) {
    // Directory doesn't exist or is empty, that's ok
    if (err.code !== 'ENOENT') {
      console.error(`Failed to read output directory:`, err.message);
    }
  }

  return attachments;
}

// Instruction to append to prompts
export const OUTPUT_DIR_INSTRUCTION = `

[Important] If you create files to give to the user, save them in the \`${OUTPUT_DIR_NAME}/\` directory. Files placed in this directory will be automatically sent to the user.`;

// Instruction for plan mode (when user hasn't sent 'exec' yet)
export const PLAN_MODE_INSTRUCTION = `

【プランモード】
現在はプランモードです。コードの書き換えや新規ファイルの作成は行わず、以下のみを行ってください：
- 調査・分析
- 実装プランの立案
- 質問や確認

プランが完成したら、最後に必ず以下のように伝えてください：
「このプランでよければ \`e\` または \`exec\` を送信してください。実装を開始します。」

ユーザーが \`exec\` を送信するまで、コードの変更は行わないでください。

【重要】\`ExitPlanMode\` ツールは使用しないでください。DevRelay のプランモード解除はユーザーが \`e\` / \`exec\` を送信することで行います。`;

// Instruction for exec mode (after user sends 'exec')
export const EXEC_MODE_INSTRUCTION = `

【実行モード】
ユーザーが実装開始を承認しました。プランに従ってコードの変更を実行してください。`;

// DevRelay Agreement v4: ルールを rules/devrelay.md に分離
// CLAUDE.md には軽量マーカーのみ配置し、Agreement 本体は rules/devrelay.md に置く
export const DEVRELAY_AGREEMENT_VERSION = 'v4';
export const DEVRELAY_AGREEMENT_MARKER = `<!-- DevRelay Agreement ${DEVRELAY_AGREEMENT_VERSION} -->`;
export const DEVRELAY_AGREEMENT_END_MARKER = '<!-- /DevRelay Agreement -->';

// 旧バージョンのマーカー（アップグレード検出用）
export const DEVRELAY_AGREEMENT_OLD_MARKERS = [
  '<!-- DevRelay Agreement v1 -->',
  '<!-- DevRelay Agreement v2 -->',
  '<!-- DevRelay Agreement v3 -->',
];

// v4: rules/devrelay.md に書き込む Agreement 全文テンプレート
export const DEVRELAY_RULES_TEMPLATE = `<!-- DevRelay Agreement v4 -->

# DevRelay 共通ルール

## ファイル出力

ユーザーに渡すファイルを作成する場合は、必ず \`.devrelay-output/\` ディレクトリに保存してください。
このディレクトリに置かれたファイルは自動的にユーザーに送信されます。

## プランモード

現在はプランモードです。コードの書き換えや新規ファイルの作成は行わず、以下のみを行ってください：
- 調査・分析
- 実装プランの立案
- 質問や確認

プランが完成したら、最後に必ず以下のように伝えてください：
「このプランでよければ \\\`e\\\` または \\\`exec\\\` を送信してください。実装を開始します。」

ユーザーが \\\`exec\\\` を送信するまで、コードの変更は行わないでください。

\\\`ExitPlanMode\\\` ツールは使用しないでください。DevRelay のプランモード解除はユーザーが \\\`e\\\` / \\\`exec\\\` を送信することで行います。

## プランの説明

プランを立案したら、必ずテキストで概要を説明してください。
ファイルに書き込むだけでなく、ユーザーが Discord/Telegram で内容を確認できるようにしてください。

## ユーザーへの質問

AskUserQuestion ツールは使用しないでください（DevRelay 経由では応答を返せないため）。
ユーザーに質問や確認が必要な場合は、テキストで質問を書いてください。
ユーザーは Discord/Telegram 経由でテキストで回答します。

## コーディングスタイル

ソースコードを書く際は、詳細な日本語コメントを必ず残してください。

1. **関数・メソッド**: 必ず JSDoc 形式で目的・引数・戻り値を説明
2. **クラス**: クラスの責務と使用方法を説明
3. **複雑なロジック**: 処理の流れを段階的に説明
4. **条件分岐**: なぜその条件が必要かを説明
5. **重要な変数**: 変数の用途を説明
6. **TODO・FIXME**: 将来の改善点を明記

コメントがないコードは不完全です。他の開発者が読んで理解できるレベルのコメントを心がけてください。

---

## CLAUDE.md 更新ルール

CLAUDE.md は **毎回のプロンプトでコンテキストに全文載る**。
肥大化を防ぐため、以下のルールを厳守すること。

### CLAUDE.md に書いてよいもの（2,000 トークン以内を維持）

- プロジェクト概要（1〜2行）
- ルールファイルへの参照（\\\`rules/devrelay.md\\\`、\\\`rules/project.md\\\`）
- 技術スタック（テーブル 5〜8行）
- ビルド & デプロイ手順（5〜10行）
- 環境変数一覧（テーブル）
- DB テーブル概要（テーブル名 + 1行説明）
- 詳細ドキュメントへの参照リンク

### CLAUDE.md に絶対書いてはいけないもの

| 書いてはいけないもの | 代わりに書く場所 |
|---------------------|--------------------|
| 完了済みタスクのチェックリスト（✅） | \\\`doc/changelog.md\\\` |
| 日付付きの実装記録（「2026-XX-XX 実装」） | \\\`doc/changelog.md\\\` |
| Phase 完了の詳細 | \\\`doc/changelog.md\\\` |
| 仕様変更の経緯（Before/After） | \\\`doc/changelog.md\\\` |
| 新規ファイル一覧 | \\\`doc/changelog.md\\\` |
| API エンドポイント全一覧 | \\\`doc/\\\` またはコードから読む |
| 設計判断の追加・変更 | \\\`rules/project.md\\\` |

### \\\`w\\\` コマンド（wrap up）実行時の手順

1. **doc/changelog.md** に今回の変更内容を追記（日付 + 概要 + 詳細）
2. **rules/project.md** に設計判断・ルールの追加/変更があれば追記
3. **CLAUDE.md** は技術スタック・DB テーブル・環境変数に変更があった場合**のみ**更新
4. README.md を必要に応じて更新
5. コミット & プッシュ

### 判断に迷ったら

「このセクションは、次回のプロンプトで Claude が作業するために毎回必要か？」

- **YES** → CLAUDE.md に残す（ただし簡潔に）
- **NO** → \\\`doc/changelog.md\\\` または \\\`rules/project.md\\\` に移動

<!-- /DevRelay Agreement v4 -->
`;

// v4: CLAUDE.md 先頭に置く軽量マーカー（Agreement 本体は rules/devrelay.md に分離）
export const DEVRELAY_CLAUDEMD_MARKER = `${DEVRELAY_AGREEMENT_MARKER}
See \`rules/devrelay.md\` for DevRelay rules.
${DEVRELAY_AGREEMENT_END_MARKER}`;

// v4 用 Agreement 適用プロンプト
// rules/devrelay.md を作成し、CLAUDE.md の旧 Agreement ブロックを軽量マーカーに置き換える
export const AGREEMENT_APPLY_PROMPT = `【タスク】DevRelay Agreement v4 を適用する

これは DevRelay システムからの自動タスクです。質問せずに以下を実行してください：

## Step 1: rules/devrelay.md を作成・更新

1. \`rules/\` ディレクトリを作成（存在しない場合）
2. \`rules/devrelay.md\` に以下の内容を書き込む（既存の場合は上書き）：

${DEVRELAY_RULES_TEMPLATE}

## Step 2: CLAUDE.md を更新

1. CLAUDE.md を読む（存在しない場合は新規作成）
2. 旧 Agreement ブロック（\`<!-- DevRelay Agreement v...\` から \`<!-- /DevRelay Agreement -->\` まで、その直後の \`---\` 行も含む）を**全て削除**
3. ファイルの先頭に以下のマーカーを追加：

${DEVRELAY_CLAUDEMD_MARKER}

---

## Step 3: 補助ファイルの作成（未存在時のみ）

1. \`doc/\` ディレクトリを作成（存在しない場合）
2. \`doc/changelog.md\` が存在しなければ、以下の内容で作成：
\`\`\`
# Changelog
\`\`\`
3. \`rules/project.md\` が存在しなければ、以下の内容で作成：
\`\`\`
# プロジェクト固有ルール
\`\`\`

## Step 4: 結果を報告

以下の形式で結果を報告してください：
- \`rules/devrelay.md\` を作成/更新した
- CLAUDE.md を更新した
- 補助ファイルを作成した場合はその旨

質問は不要です。上記のタスクをそのまま実行してください。`;
