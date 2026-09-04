import { writeFile, mkdir } from 'fs/promises';
import { join, resolve, sep } from 'path';
import type { FileAttachment } from '@devrelay/shared';

// Directory to save received files (relative to project path)
const RECEIVED_FILES_DIR = '.devrelay-files';

/** サニタイズ後のファイル名の長さ上限（切り詰めのみ、拒否はしない） */
const SAVED_FILENAME_MAX_LENGTH = 120;

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

/**
 * 受信ファイル名を保存用にサニタイズする（Agent 側の多重防御、パストラバーサル対策の第一段）。
 *
 * サーバー側（MCP 経路の attachment-validation.ts）は同種のサニタイズ・拒否を既に行うが、
 * WebUI 経由の web:command フレームにはこの防御が掛かっていない。実際、本関数導入前は
 * ファイル名に `../../../etc/passwd` を渡すと `join(filesDir, prefixedFilename)` が正規化され
 * `.devrelay-files` はおろか projectPath の外にまで書き込めてしまう状態だった
 * （サーバーを信頼できる場合の MCP 経路に限らず、既存の WebUI 経路でも成立していた穴）。
 * Agent は最後の防衛線であり、サーバー側の検証有無に関わらずここでも同じ攻撃を防ぐ。
 *
 * サーバー側とは異なり、ここでは**拒否せずに正規化**する。多くの場合すでにサーバー側で
 * 検証済みのファイルが渡ってくるため、ここで落とすとユーザー体験が悪化するだけである。
 * 正規化が発生した場合は呼び出し側で console.warn に記録する。
 */
export function sanitizeSavedFilename(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    return 'attachment';
  }

  // basename 化: '/' '\' の最後の出現以降だけを採用（win32 の path.join は '\' も区切り扱いのため両方剥がす）
  const lastSep = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'));
  let name = lastSep >= 0 ? raw.slice(lastSep + 1) : raw;

  // 制御文字除去（改行・タブ・DEL・NUL 等、プロンプトへの行注入対策）
  name = name.replace(/[\u0000-\u001F\u007F]/g, '');

  if (name.length === 0 || name === '.' || name === '..') {
    return 'attachment';
  }

  if (name.length > SAVED_FILENAME_MAX_LENGTH) {
    name = name.slice(0, SAVED_FILENAME_MAX_LENGTH);
  }

  return name;
}

export async function saveReceivedFiles(
  projectPath: string,
  files: FileAttachment[]
): Promise<string[]> {
  const savedPaths: string[] = [];
  const filesDir = join(projectPath, RECEIVED_FILES_DIR);
  const resolvedFilesDir = resolve(filesDir);

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

  // 同一バッチ内のファイル名重複カウンター
  const usedNames = new Map<string, number>();

  for (const file of files) {
    try {
      // ディスク書き込み先とプロンプト平文の両方に使われる前に正規化する
      const sanitizedFilename = sanitizeSavedFilename(file.filename);
      if (sanitizedFilename !== file.filename) {
        console.warn(`Sanitized attachment filename: "${file.filename}" -> "${sanitizedFilename}"`);
      }

      // 同名ファイルがあれば連番を付与（例: image_2.png, image_3.png）
      const baseKey = sanitizedFilename;
      const count = usedNames.get(baseKey) || 0;
      usedNames.set(baseKey, count + 1);

      let uniqueFilename = sanitizedFilename;
      if (count > 0) {
        const dotIdx = sanitizedFilename.lastIndexOf('.');
        if (dotIdx > 0) {
          uniqueFilename = `${sanitizedFilename.substring(0, dotIdx)}_${count + 1}${sanitizedFilename.substring(dotIdx)}`;
        } else {
          uniqueFilename = `${sanitizedFilename}_${count + 1}`;
        }
      }

      const prefixedFilename = `${dateTimePrefix}${uniqueFilename}`;
      const filePath = join(filesDir, prefixedFilename);

      // 構造的な保証: サニタイズにすり抜けがあっても filesDir の外には絶対に書き込めないことを最終確認する
      const resolvedFilePath = resolve(filePath);
      if (resolvedFilePath !== resolvedFilesDir && !resolvedFilePath.startsWith(resolvedFilesDir + sep)) {
        console.error(`Refusing to save file outside filesDir: ${resolvedFilePath}`);
        continue;
      }

      const buffer = Buffer.from(file.content, 'base64');
      await writeFile(filePath, buffer);
      console.log(`Saved file: ${filePath} (${file.size} bytes)`);
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
  return `The following files are attached:\n${fileList}\n\n${prompt}`;
}
