/**
 * ポータル サイクル P1: ファイルシステム側（`DEVRELAY_PORTAL_DIR` の読み取り）。
 * 判定ロジックは `portal-rules.ts`（純関数）に置き、ここは fs の入出力だけを持つ。
 */

import fs from 'fs';
import path from 'path';
import {
  groupPortalDocs,
  isPdfFileName,
  isPortalExcludedDir,
  isSafePortalRelPath,
  normalizeIssues,
  normalizeNewsItems,
  PORTAL_MAX_DEPTH,
  PORTAL_MAX_DOCS,
  type PortalDocCategory,
  type PortalDocFile,
  type PortalIssue,
  type PortalNewsItem,
} from './portal-rules.js';

export const PORTAL_NEWS_DIR = 'news';
export const PORTAL_NEWS_FILE = 'items.json';
export const PORTAL_NEWS_STATE_FILE = 'state.json';
export const PORTAL_NEWS_COMMITS_DIR = 'commits';
export const PORTAL_ISSUES_FILE = 'issues.json';

/** DIR 配下の PDF を列挙する（PDF 以外・除外フォルダ・シンボリックリンクは見ない）。 */
export async function listPortalDocFiles(root: string): Promise<PortalDocFile[]> {
  const out: PortalDocFile[] = [];
  async function walk(dirAbs: string, relParts: string[]): Promise<void> {
    if (out.length >= PORTAL_MAX_DOCS) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= PORTAL_MAX_DOCS) return;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        const depth = relParts.length + 1;
        if (depth > PORTAL_MAX_DEPTH || isPortalExcludedDir(e.name, depth)) continue;
        await walk(path.join(dirAbs, e.name), [...relParts, e.name]);
      } else if (e.isFile() && isPdfFileName(e.name)) {
        const rel = [...relParts, e.name].join('/');
        if (!isSafePortalRelPath(rel)) continue;
        try {
          const st = await fs.promises.stat(path.join(dirAbs, e.name));
          out.push({ rel, size: st.size, updatedAt: st.mtime.toISOString() });
        } catch {
          /* 消えた等は無視 */
        }
      }
    }
  }
  await walk(root, []);
  return out;
}

export async function loadPortalDocs(root: string): Promise<PortalDocCategory[]> {
  return groupPortalDocs(await listPortalDocFiles(root));
}

/**
 * 相対パスを DIR 内の実ファイルに解決する。DIR の外・PDF 以外・存在しないなら null。
 * 文字列判定（isSafePortalRelPath）に加えて realpath でも DIR の内側にあることを確認する。
 */
export async function resolvePortalDocFile(root: string, rel: unknown): Promise<string | null> {
  if (!isSafePortalRelPath(rel)) return null;
  const segs = rel.split('/');
  for (let i = 0; i < segs.length - 1; i++) {
    if (isPortalExcludedDir(segs[i], i + 1)) return null;
  }
  try {
    const realRoot = await fs.promises.realpath(root);
    const real = await fs.promises.realpath(path.join(realRoot, ...segs));
    const rootWithSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
    if (!real.toLowerCase().startsWith(rootWithSep.toLowerCase())) return null;
    const st = await fs.promises.stat(real);
    if (!st.isFile() || !isPdfFileName(path.basename(real))) return null;
    return real;
  } catch {
    return null;
  }
}

async function readJson(file: string): Promise<unknown> {
  try {
    const text = await fs.promises.readFile(file, 'utf8');
    return JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

export async function loadPortalNews(root: string): Promise<PortalNewsItem[]> {
  return normalizeNewsItems(await readJson(path.join(root, PORTAL_NEWS_DIR, PORTAL_NEWS_FILE)));
}

export async function loadPortalIssues(root: string): Promise<PortalIssue[]> {
  return normalizeIssues(await readJson(path.join(root, PORTAL_ISSUES_FILE)));
}

/** JSON を一時ファイル経由で書く（書きかけを API が読まないように）。 */
export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  await fs.promises.rename(tmp, file);
}

export async function readPortalJson(file: string): Promise<unknown> {
  return readJson(file);
}
