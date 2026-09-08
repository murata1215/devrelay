import { readFile, writeFile, mkdir, unlink, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

/**
 * #375: プロジェクト内にプランターンの回答本文を保存するディレクトリ。
 * DevRelay では ExitPlanMode を禁止しているため「プラン本文 = プランターンの AI 回答そのもの」であり、
 * Claude だけでなく Devin/Codex/Gemini/Aider 等すべてのツールで同じ形式のプレーンテキストが手に入る。
 * ここに保存することで、Claude Code ハーネス自身が書く ~/.claude/plans/（機体グローバル、
 * 別プロジェクトのプランを誤って読む「ゴーストプラン」バグ #246 の温床）に頼らず、
 * プロジェクトスコープが構造的に保証されたプラン取得経路を全ツール共通で持てる。
 */
const PLAN_DIR = '.devrelay/plans';

/** 保持する最大ファイル数。超過分は古いものから削除する（無限に溜まるのを防ぐ） */
const MAX_PLAN_FILES = 20;

/** 保存に値すると判定する最小文字数（極端に短い断片・空文字を保存しない） */
const MIN_SAVABLE_LENGTH = 10;

/**
 * 保存先ディレクトリの絶対パスを取得
 */
function getPlanDirPath(projectPath: string): string {
  return join(projectPath, PLAN_DIR);
}

/**
 * 日時から固定幅のファイル名を作る（YYYYMMDD-HHmmss.md、ローカル時刻）。
 * 固定幅ゼロ埋めにすることで、ファイル名の辞書順 = 生成時刻の時系列順になり、
 * 最新ファイルの選択に stat（mtime）が不要になる。
 */
export function buildPlanFileName(date: Date): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  const y = date.getFullYear();
  const mo = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const h = pad(date.getHours());
  const mi = pad(date.getMinutes());
  const s = pad(date.getSeconds());
  return `${y}${mo}${d}-${h}${mi}${s}.md`;
}

/**
 * ファイル名一覧から最新（= 辞書順で最大）の .md ファイル名を選ぶ。
 * .md 以外の混入ファイルは無視する。該当なしは null。
 */
export function selectLatestPlanFileName(names: string[]): string | null {
  const mdFiles = names.filter((n) => n.endsWith('.md')).sort();
  return mdFiles.length > 0 ? mdFiles[mdFiles.length - 1] : null;
}

/**
 * プラン本文として保存に値するかどうかを判定する。
 * 空文字・空白のみ・極端に短い断片は保存しない（無意味なファイルの増殖防止）。
 */
export function isSavablePlanText(text: string): boolean {
  return text.trim().length >= MIN_SAVABLE_LENGTH;
}

/**
 * プラン本文をプロジェクト内 .devrelay/plans/ に保存する。
 * 保存に失敗しても throw しない（プラン保存の失敗で AI 応答自体を壊さないため）。
 * MAX_PLAN_FILES を超えた分は古いものから削除する。
 * @returns 保存したファイル名。保存しなかった/失敗した場合は null
 */
export async function savePlanFile(projectPath: string, content: string): Promise<string | null> {
  if (!isSavablePlanText(content)) return null;
  const dirPath = getPlanDirPath(projectPath);
  try {
    if (!existsSync(dirPath)) {
      await mkdir(dirPath, { recursive: true });
    }
    const filename = buildPlanFileName(new Date());
    await writeFile(join(dirPath, filename), content, 'utf-8');

    // 保持上限を超えた古いファイルを削除
    const entries = await readdir(dirPath);
    const mdFiles = entries.filter((n) => n.endsWith('.md')).sort();
    if (mdFiles.length > MAX_PLAN_FILES) {
      const toRemove = mdFiles.slice(0, mdFiles.length - MAX_PLAN_FILES);
      for (const name of toRemove) {
        try {
          await unlink(join(dirPath, name));
        } catch {
          // 個別削除失敗は無視（次回以降のクリーンアップに任せる）
        }
      }
    }

    return filename;
  } catch (err) {
    console.error(`❌ Could not save plan file:`, (err as Error).message);
    return null;
  }
}

/**
 * プロジェクト内 .devrelay/plans/ から最新のプランファイルを読み込む。
 * 存在しない/読み取り失敗の場合は null。
 */
export async function loadLatestPlanFile(
  projectPath: string,
): Promise<{ filename: string; content: string } | null> {
  const dirPath = getPlanDirPath(projectPath);
  try {
    if (!existsSync(dirPath)) return null;
    const entries = await readdir(dirPath);
    const latest = selectLatestPlanFileName(entries);
    if (!latest) return null;
    const content = await readFile(join(dirPath, latest), 'utf-8');
    return { filename: latest, content };
  } catch {
    return null;
  }
}
