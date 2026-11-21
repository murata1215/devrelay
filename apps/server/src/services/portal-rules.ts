/**
 * ポータル（`/portal`）サイクル P1: サーバー側の純関数（外部 import なし。dist を node:test から直接 import する）。
 *
 * - 資料: `DEVRELAY_PORTAL_DIR`（例 `D:\portal`）配下の PDF を分類（直下フォルダ名）ごとに並べる。
 *   PDF 以外は一覧にも出さず配信もしない（ユーザー決定 2026-11-21）。
 * - ニュース: `<DIR>/news/items.json` を読む。DevRelay のアップデートは `portal:news` CLI が
 *   コミット歴を `<DIR>/news/commits/YYYY-MM-DD.jsonl` に書き出し、AI（無ければ件名整形）で 1 件にまとめて追記する。
 * - 全体課題: `<DIR>/issues.json`（人が編集するファイル）。
 * - 自分の TODO: DB（`PortalTodo`、TISA0003）。
 */

/** キルスイッチ（既定 ON、`'0'` のときだけ無効）。`DEVRELAY_PORTAL`。 */
export function isPortalEnabled(raw: string | undefined): boolean {
  return raw !== '0';
}

/** `DEVRELAY_PORTAL_DIR` を正規化する。未設定・空なら null（API は「未設定」を返す）。 */
export function resolvePortalDir(raw: string | undefined): string | null {
  const s = (raw ?? '').trim().replace(/^"(.*)"$/, '$1');
  return s.length > 0 ? s : null;
}

/** 直下に置いた PDF の分類名（ユーザー指示「方針は別途リンクに」）。 */
export const PORTAL_ROOT_CATEGORY = '方針';

/** 資料一覧から除外するフォルダ（ニュースの生データ等）。先頭 `.` / `_` のフォルダも除外する。 */
export const PORTAL_EXCLUDED_DIRS = new Set(['news']);

/** 再帰の深さ上限（直下フォルダ = 1）。 */
export const PORTAL_MAX_DEPTH = 4;

/** 1 回の一覧で返す PDF の上限。 */
export const PORTAL_MAX_DOCS = 500;

export function isPortalExcludedDir(name: string, depth: number): boolean {
  if (name.startsWith('.') || name.startsWith('_')) return true;
  return depth === 1 && PORTAL_EXCLUDED_DIRS.has(name.toLowerCase());
}

export function isPdfFileName(name: string): boolean {
  return /\.pdf$/i.test(name) && !name.startsWith('.') && !name.startsWith('~$');
}

/**
 * クライアントから受け取った相対パス（`/` 区切り）が安全かを判定する。
 * 絶対パス・ドライブ指定・`..`・`\`・制御文字・ADS（`:`）・PDF 以外は拒否。
 * 実ファイルが DIR の内側かは呼び出し側で realpath によっても確認する（二重の防御）。
 */
export function isSafePortalRelPath(rel: unknown): rel is string {
  if (typeof rel !== 'string') return false;
  if (rel.length === 0 || rel.length > 512) return false;
  if (/[\u0000-\u001f\u007f\\:*?"<>|]/.test(rel)) return false;
  if (rel.startsWith('/')) return false;
  const segs = rel.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..' || s.trim() !== s || s.endsWith('.'))) return false;
  return isPdfFileName(segs[segs.length - 1]);
}

export interface PortalDocFile {
  /** DIR からの相対パス（`/` 区切り） */
  rel: string;
  size: number;
  /** ISO 8601 */
  updatedAt: string;
}

export interface PortalDoc {
  title: string;
  path: string;
  size: number;
  updatedAt: string;
}

export interface PortalDocCategory {
  name: string;
  /** true なら DIR 直下の PDF（方針） */
  root: boolean;
  docs: PortalDoc[];
}

/** PDF のファイル名から表示名を作る（拡張子を外す）。 */
export function portalDocTitle(fileName: string): string {
  return fileName.replace(/\.pdf$/i, '');
}

const collator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });

/**
 * PDF の一覧を分類ごとにまとめる。直下フォルダ名 = 分類、直下ファイル = `方針`。
 * サブフォルダの PDF は直下フォルダの分類に入れ、表示名に途中のフォルダ名を前置する。
 * PDF が 0 件の分類は出さない（呼び出し側に渡ってこないので自然に消える）。並びは 方針 → 分類名順。
 */
export function groupPortalDocs(files: readonly PortalDocFile[]): PortalDocCategory[] {
  const map = new Map<string, PortalDocCategory>();
  for (const f of files) {
    if (!isSafePortalRelPath(f.rel)) continue;
    const segs = f.rel.split('/');
    const root = segs.length === 1;
    const name = root ? PORTAL_ROOT_CATEGORY : segs[0];
    const titleSegs = root ? segs : segs.slice(1);
    const title = [...titleSegs.slice(0, -1), portalDocTitle(titleSegs[titleSegs.length - 1])].join(' / ');
    const key = `${root ? '0' : '1'}:${name}`;
    let cat = map.get(key);
    if (!cat) {
      cat = { name, root, docs: [] };
      map.set(key, cat);
    }
    cat.docs.push({ title, path: f.rel, size: f.size, updatedAt: f.updatedAt });
  }
  const cats = [...map.values()];
  for (const c of cats) c.docs.sort((a, b) => collator.compare(a.title, b.title));
  cats.sort((a, b) => (a.root === b.root ? collator.compare(a.name, b.name) : a.root ? -1 : 1));
  return cats;
}

// ============================================================
// ニュース
// ============================================================

export type PortalNewsCategory = 'update' | 'notice' | 'mail' | 'other';

export interface PortalNewsItem {
  id: string;
  /** YYYY-MM-DD（JST） */
  date: string;
  category: PortalNewsCategory;
  title: string;
  body: string;
  link?: string;
  /** 生成元（'ai' | 'rule' | 'manual' 等。表示には使わない） */
  source?: string;
}

/** items.json に残す最大件数。 */
export const PORTAL_NEWS_MAX_ITEMS = 200;

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function isDateKey(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function isHttpUrl(s: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(s);
}

/** items.json（`{ items: [...] }` または配列）を正規化する。壊れた行は捨てる。新しい順。 */
export function normalizeNewsItems(raw: unknown): PortalNewsItem[] {
  const arr = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { items?: unknown }).items)
      ? (raw as { items: unknown[] }).items
      : [];
  const out: PortalNewsItem[] = [];
  const seen = new Set<string>();
  for (const r0 of arr.slice(0, 2000)) {
    if (!r0 || typeof r0 !== 'object') continue;
    const r = r0 as Record<string, unknown>;
    const title = str(r.title, 300);
    const date = str(r.date, 10);
    if (!title || !isDateKey(date)) continue;
    const id = str(r.id, 200) || `${date}-${title}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const c = str(r.category, 20);
    const category: PortalNewsCategory = c === 'update' || c === 'notice' || c === 'mail' ? c : 'other';
    const link = str(r.link, 1000);
    const item: PortalNewsItem = { id, date, category, title, body: str(r.body, 4000) };
    if (link && isHttpUrl(link)) item.link = link;
    const source = str(r.source, 20);
    if (source) item.source = source;
    out.push(item);
  }
  return sortNewsItems(out);
}

export function sortNewsItems(items: PortalNewsItem[]): PortalNewsItem[] {
  return items.sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1));
}

/** 既存に新規を足す（同じ id は既存を残す＝人が手で直した文面を上書きしない）。新しい順・上限件数。 */
export function mergeNewsItems(
  existing: readonly PortalNewsItem[],
  incoming: readonly PortalNewsItem[],
  max = PORTAL_NEWS_MAX_ITEMS,
): PortalNewsItem[] {
  const ids = new Set(existing.map((i) => i.id));
  const merged = [...existing, ...incoming.filter((i) => !ids.has(i.id))];
  return sortNewsItems(merged).slice(0, max);
}

// ============================================================
// コミット歴 → アップデートのニュース
// ============================================================

/** `git log` に渡す書式（フィールド区切り \x1f、レコード区切り \x1e）。 */
export const GIT_LOG_FORMAT = '%H%x1f%h%x1f%cI%x1f%an%x1f%s%x1f%b%x1e';

export interface PortalCommit {
  hash: string;
  short: string;
  /** コミット日時（ISO 8601） */
  date: string;
  author: string;
  subject: string;
  body: string;
}

export function parseGitLog(text: string): PortalCommit[] {
  const out: PortalCommit[] = [];
  for (const rec of text.split('\x1e')) {
    const t = rec.replace(/^\s+/, '');
    if (!t) continue;
    const [hash, short, date, author, subject, body = ''] = t.split('\x1f');
    if (!hash || !/^[0-9a-f]{7,40}$/.test(hash) || !subject) continue;
    out.push({ hash, short, date, author, subject: subject.trim(), body: body.trim().slice(0, 2000) });
  }
  return out;
}

/** Date → JST の YYYY-MM-DD。 */
export function jstDateKey(d: Date): string {
  const j = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return j.toISOString().slice(0, 10);
}

/** 社員向けのニュースに載せないコミット（文書・テスト・雑務・WIP）。 */
export function isNewsworthyCommit(subject: string): boolean {
  const s = subject.trim();
  if (!s) return false;
  if (/^(docs|doc|test|tests|chore|style|ci|build|wip)(\([^)]*\))?!?:/i.test(s)) return false;
  if (/^(wip|fixup!|squash!)/i.test(s)) return false;
  return true;
}

/** `feat(web): xxx` → `xxx`。`Merge origin/main (...) into main: xxx` → `本家の更新を取り込み: xxx`。 */
export function cleanCommitSubject(subject: string): string {
  let s = subject.trim();
  const merge = /^Merge\b.*?:\s*(.+)$/.exec(s);
  if (merge) return `本家の更新を取り込み: ${merge[1].trim()}`;
  s = s.replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, '');
  return s;
}

/** ルールベースの本文に載せる最大行数。 */
export const RULE_NEWS_MAX_LINES = 6;

/** AI を使わないときのアップデート 1 件（件名を整えて箇条書き）。 */
export function buildRuleBasedUpdateItem(date: string, headShort: string, commits: readonly PortalCommit[]): PortalNewsItem | null {
  const lines = commits.filter((c) => isNewsworthyCommit(c.subject)).map((c) => cleanCommitSubject(c.subject));
  if (lines.length === 0) return null;
  const shown = lines.slice(0, RULE_NEWS_MAX_LINES).map((l) => `・${l}`);
  if (lines.length > RULE_NEWS_MAX_LINES) shown.push(`ほか ${lines.length - RULE_NEWS_MAX_LINES} 件`);
  return {
    id: `update-${date}-${headShort}`,
    date,
    category: 'update',
    title: `DevRelay を更新しました（${lines.length} 件の変更）`,
    body: shown.join('\n'),
    source: 'rule',
  };
}

/** AI に渡すコミットの最大件数・最大文字数（費用と応答の安定のため）。 */
export const AI_NEWS_MAX_COMMITS = 60;
export const AI_NEWS_MAX_CHARS = 12000;

export const AI_NEWS_SYSTEM_PROMPT = [
  'あなたは社内ポータルの編集者です。社内の AI 開発ハブ「DevRelay」のコミット歴を、利用者（開発者以外も含む社員）向けのお知らせ 1 件にまとめます。',
  '- 利用者にとって何が変わったか・何ができるようになったかを書く。内部の実装・ファイル名・関数名・コミットハッシュは書かない',
  '- 文書・テストだけの変更は無視する',
  '- 平易な日本語。title は 40 文字以内、body は「・」で始まる箇条書き 1〜5 行（各 60 文字以内）',
  '- 出力は JSON のみ: {"title": string, "body": string}',
].join('\n');

export function buildAiNewsUserPrompt(date: string, commits: readonly PortalCommit[]): string {
  const lines: string[] = [`日付: ${date}`, `コミット ${commits.length} 件:`];
  let total = 0;
  for (const c of commits.slice(0, AI_NEWS_MAX_COMMITS)) {
    const body = c.body ? `\n  ${c.body.replace(/\s+/g, ' ').slice(0, 300)}` : '';
    const line = `- ${c.subject}${body}`;
    if (total + line.length > AI_NEWS_MAX_CHARS) break;
    total += line.length;
    lines.push(line);
  }
  return lines.join('\n');
}

/** AI の JSON 応答を解釈する。使えなければ null（呼び出し側はルールベースに切り替える）。 */
export function parseAiNewsJson(text: string): { title: string; body: string } | null {
  const m = /\{[\s\S]*\}/.exec(text ?? '');
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as Record<string, unknown>;
    const title = str(o.title, 80);
    const body = str(o.body, 1500);
    if (!title || !body) return null;
    return { title, body };
  } catch {
    return null;
  }
}

// ============================================================
// 全体課題・TODO
// ============================================================

export interface PortalIssue {
  title: string;
  owner?: string;
  due?: string;
  status?: string;
  link?: string;
}

/** issues.json（`{ items: [...] }` または配列）を正規化する。 */
export function normalizeIssues(raw: unknown): PortalIssue[] {
  const arr = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { items?: unknown }).items)
      ? (raw as { items: unknown[] }).items
      : [];
  const out: PortalIssue[] = [];
  for (const r0 of arr.slice(0, 200)) {
    if (!r0 || typeof r0 !== 'object') continue;
    const r = r0 as Record<string, unknown>;
    const title = str(r.title, 300);
    if (!title) continue;
    const issue: PortalIssue = { title };
    const owner = str(r.owner, 100);
    const due = str(r.due, 20);
    const status = str(r.status, 40);
    const link = str(r.link, 1000);
    if (owner) issue.owner = owner;
    if (due) issue.due = due;
    if (status) issue.status = status;
    if (link && isHttpUrl(link)) issue.link = link;
    out.push(issue);
  }
  return out;
}

/** TODO の本文上限・1 人あたりの件数上限。 */
export const PORTAL_TODO_MAX_TEXT = 200;
export const PORTAL_TODO_MAX_PER_USER = 100;

/** TODO の本文を正規化する（改行は空白に、前後空白除去）。不正なら null。 */
export function normalizeTodoText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (s.length === 0 || s.length > PORTAL_TODO_MAX_TEXT) return null;
  return s;
}
