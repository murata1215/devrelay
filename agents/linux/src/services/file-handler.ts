import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import type { FileAttachment } from '@devrelay/shared';

// Directory to save received files (relative to project path)
const RECEIVED_FILES_DIR = '.devrelay-files';

/**
 * Generate datetime prefix for filename
 * Format: YYYYMMDD_HHmmss_
 */
function getDateTimePrefix(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}_${hh}${min}${ss}_`;
}

export async function saveReceivedFiles(
  projectPath: string,
  files: FileAttachment[]
): Promise<string[]> {
  const savedPaths: string[] = [];
  const filesDir = join(projectPath, RECEIVED_FILES_DIR);

  // Create directory if not exists
  try {
    await mkdir(filesDir, { recursive: true });
  } catch (err: any) {
    if (err.code !== 'EEXIST') {
      console.error(`Failed to create files directory: ${err.message}`);
      return savedPaths;
    }
  }

  // Generate datetime prefix for this batch of files
  const dateTimePrefix = getDateTimePrefix();

  for (const file of files) {
    try {
      // Add datetime prefix to filename
      const prefixedFilename = `${dateTimePrefix}${file.filename}`;
      const filePath = join(filesDir, prefixedFilename);
      const buffer = Buffer.from(file.content, 'base64');
      await writeFile(filePath, buffer);
      console.log(`📥 Saved file: ${filePath} (${file.size} bytes)`);
      savedPaths.push(filePath);
    } catch (err: any) {
      console.error(`Failed to save file ${file.filename}: ${err.message}`);
    }
  }

  return savedPaths;
}

export function buildPromptWithFiles(prompt: string, filePaths: string[]): string {
  if (filePaths.length === 0) {
    return prompt;
  }

  const fileList = filePaths.map(p => `- ${p}`).join('\n');
  return `以下のファイルが添付されています:\n${fileList}\n\n${prompt}`;
}
