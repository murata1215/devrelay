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
          console.log(`⚠️ File too large to transfer: ${filename} (${stats.size} bytes)`);
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

        console.log(`📤 Collected output file: ${filename} (${stats.size} bytes)`);
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

【重要】ユーザーに渡すファイルを作成する場合は、必ず \`${OUTPUT_DIR_NAME}/\` ディレクトリに保存してください。このディレクトリに置かれたファイルは自動的にユーザーに送信されます。`;

// Instruction for plan mode (when user hasn't sent 'exec' yet)
export const PLAN_MODE_INSTRUCTION = `

【プランモード】
現在はプランモードです。コードの書き換えや新規ファイルの作成は行わず、以下のみを行ってください：
- 調査・分析
- 実装プランの立案
- 質問や確認

プランが完成したら、最後に必ず以下のように伝えてください：
「このプランでよければ \`e\` または \`exec\` を送信してください。実装を開始します。」

ユーザーが \`exec\` を送信するまで、コードの変更は行わないでください。`;

// Instruction for exec mode (after user sends 'exec')
export const EXEC_MODE_INSTRUCTION = `

【実行モード】
ユーザーが実装開始を承認しました。プランに従ってコードの変更を実行してください。`;
