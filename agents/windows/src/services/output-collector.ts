import { readdir, readFile, stat, mkdir, rm } from 'fs/promises';
import { join, basename, extname } from 'path';
import type { FileAttachment } from '@devrelay/shared';

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

export async function clearOutputDir(projectPath: string): Promise<void> {
  const outputDir = join(projectPath, OUTPUT_DIR_NAME);
  try {
    await rm(outputDir, { recursive: true, force: true });
    await mkdir(outputDir, { recursive: true });
  } catch (err) {
    // Directory might not exist, that's ok
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

[Plan Mode]
Currently in plan mode. Do not modify or create code files. Only do the following:
- Investigation and analysis
- Create implementation plans
- Ask questions or confirmations

When your plan is complete, end with:
"If this plan looks good, send \`e\` or \`exec\` to start implementation."

Do not make code changes until the user sends \`exec\`.`;

// Instruction for exec mode (after user sends 'exec')
export const EXEC_MODE_INSTRUCTION = `

[Execution Mode]
User has approved starting implementation. Execute code changes according to the plan.`;

// DevRelay Agreement template (to be embedded in CLAUDE.md)
// v3: プランの説明を強制する指示を追加
export const DEVRELAY_AGREEMENT_VERSION = 'v3';
export const DEVRELAY_AGREEMENT_MARKER = `<!-- DevRelay Agreement ${DEVRELAY_AGREEMENT_VERSION} -->`;
export const DEVRELAY_AGREEMENT_END_MARKER = '<!-- /DevRelay Agreement -->';

// 旧バージョンのマーカー（アップグレード検出用）
export const DEVRELAY_AGREEMENT_OLD_MARKERS = [
  '<!-- DevRelay Agreement v1 -->',
  '<!-- DevRelay Agreement v2 -->',
];

export const DEVRELAY_AGREEMENT_TEMPLATE = `${DEVRELAY_AGREEMENT_MARKER}
【重要】ユーザーに渡すファイルを作成する場合は、必ず \`.devrelay-output/\` ディレクトリに保存してください。このディレクトリに置かれたファイルは自動的にユーザーに送信されます。

【プランモード】
現在はプランモードです。コードの書き換えや新規ファイルの作成は行わず、以下のみを行ってください：
- 調査・分析
- 実装プランの立案
- 質問や確認

プランが完成したら、最後に必ず以下のように伝えてください：
「このプランでよければ \`e\` または \`exec\` を送信してください。実装を開始します。」

ユーザーが \`exec\` を送信するまで、コードの変更は行わないでください。

【プランの説明】
プランを立案したら、必ずテキストで概要を説明してください。
ファイルに書き込むだけでなく、ユーザーが Discord/Telegram で内容を確認できるようにしてください。

【ユーザーへの質問】
AskUserQuestion ツールは使用しないでください（DevRelay 経由では応答を返せないため）。
ユーザーに質問や確認が必要な場合は、テキストで質問を書いてください。
ユーザーは Discord/Telegram 経由でテキストで回答します。

【コーディングスタイル】
ソースコードを書く際は、詳細な日本語コメントを必ず残してください。
以下のルールに従ってください：

1. **関数・メソッド**: 必ず JSDoc 形式で目的・引数・戻り値を説明
2. **クラス**: クラスの責務と使用方法を説明
3. **複雑なロジック**: 処理の流れを段階的に説明
4. **条件分岐**: なぜその条件が必要かを説明
5. **重要な変数**: 変数の用途を説明
6. **TODO・FIXME**: 将来の改善点を明記

コメントがないコードは不完全です。他の開発者が読んで理解できるレベルのコメントを心がけてください。
${DEVRELAY_AGREEMENT_END_MARKER}

---
`;

// Prompt for applying DevRelay Agreement to CLAUDE.md
// This prompt must be very explicit to prevent Claude Code from asking clarifying questions
export const AGREEMENT_APPLY_PROMPT = `【タスク】CLAUDE.md に DevRelay Agreement を追加・更新する

これは DevRelay システムからの自動タスクです。質問せずに以下を実行してください：

1. CLAUDE.md ファイルを読む（存在しない場合は新規作成）
2. 以下のいずれかのマーカーが含まれているか確認：
   - 最新版: <!-- DevRelay Agreement ${DEVRELAY_AGREEMENT_VERSION} -->
   - 旧版: <!-- DevRelay Agreement v1 -->
3. 処理：
   - 最新版が含まれている場合 → 何もしない
   - 旧版が含まれている場合 → 旧 Agreement ブロック（<!-- DevRelay Agreement v... --> から <!-- /DevRelay Agreement --> まで）を削除し、新しい Agreement を先頭に追加
   - 含まれていない場合 → ファイルの先頭に以下のブロックを追加

${DEVRELAY_AGREEMENT_TEMPLATE}

4. 結果を報告：
   - 最新版が既にある場合：「✅ CLAUDE.md は DevRelay Agreement ${DEVRELAY_AGREEMENT_VERSION} 対応済みです」
   - 旧版から更新した場合：「📝 CLAUDE.md の DevRelay Agreement を ${DEVRELAY_AGREEMENT_VERSION} に更新しました」
   - 新規追加した場合：「📝 CLAUDE.md に DevRelay Agreement ${DEVRELAY_AGREEMENT_VERSION} を追加しました」

質問は不要です。上記のタスクをそのまま実行してください。`;
