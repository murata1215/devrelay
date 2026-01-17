import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import type { FileAttachment } from '@devrelay/shared';

// Directory to save received files (relative to project path)
const RECEIVED_FILES_DIR = '.devrelay-files';

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

  for (const file of files) {
    try {
      const filePath = join(filesDir, file.filename);
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
