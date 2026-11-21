/**
 * ポータル（`/portal`）用の純関数群。
 *
 * ポータルに載せる内容（お知らせ・PDF マニュアル・リンク）は会社固有のため
 * リポジトリには入れず、配信先（IIS 等）の `<base>portal-files/portal.json` に置く。
 * ここではその JSON を「信用しない入力」として正規化し、ログイン後の戻り先
 * （`?next=`）を内部パスに限定する判定を行う。DOM / window に依存しないため node:test で検証する。
 */

/** PDF・portal.json を置くフォルダ（`<base>` 相対）。ルート `/portal` と衝突しない名前にする */
export const PORTAL_FILES_DIR = 'portal-files/';

export interface PortalNotice {
  date: string;
  text: string;
}

export interface PortalManual {
  title: string;
  description: string;
  /** 開く URL（`<base>portal-files/xxx.pdf` 相対ファイル名を解決済み、または http(s) URL） */
  href: string;
}

export interface PortalLink {
  title: string;
  description: string;
  href: string;
  /** true なら WebUI 内のルート（`/knowledge` 等）。false なら外部 URL / ファイル */
  internal: boolean;
}

export interface PortalConfig {
  title: string;
  subtitle: string;
  notices: PortalNotice[];
  manuals: PortalManual[];
  installSteps: string[];
  links: PortalLink[];
}

export const DEFAULT_PORTAL_CONFIG: PortalConfig = {
  title: 'DevRelay',
  subtitle: 'チャットから Claude Code / Gemini CLI / Devin CLI を操作する AI 開発ハブ',
  notices: [],
  manuals: [],
  installSteps: [
    'DevRelay にログインし、「エージェント」画面で「エージェントを追加」を押す',
    '表示された OS 別のインストールコマンドをコピーする',
    '開発用 PC のターミナル（Windows は PowerShell）に貼り付けて実行する',
  ],
  links: [],
};

/**
 * ログイン後の戻り先として許可する内部パスを返す。許可できなければ null。
 * オープンリダイレクト防止のため、`/` 始まりの単一スラッシュパスのみ許可する
 * （`//evil.com`・`/\evil.com`・`https://...`・制御文字を含むものは拒否）。
 * `manager` は従来の manager.devrelay.io 遷移用キーワードなのでここでは扱わない。
 */
export function sanitizeNextPath(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s.startsWith('/')) return null;
  if (s.startsWith('//') || s.startsWith('/\\')) return null;
  if (/[\u0000-\u001f\u007f\\]/.test(s)) return null;
  if (s.length > 512) return null;
  // ログイン画面系に戻すとループするので除外
  if (/^\/(login|register|auth\/callback|portal)(\/|\?|#|$)/.test(s)) return null;
  return s;
}

/** ログイン画面へ送る URL（戻り先付き）。`/` の場合は next を付けない */
export function buildLoginPath(next: string | null | undefined): string {
  const safe = sanitizeNextPath(next);
  if (!safe || safe === '/') return '/login';
  return `/login?next=${encodeURIComponent(safe)}`;
}

function str(v: unknown, max = 500): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function isHttpUrl(s: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(s);
}

/**
 * マニュアル等のファイル指定を URL に解決する。
 * - http(s) URL はそのまま
 * - それ以外は `<base>portal-files/` 相対のファイル名として扱う（`..`・先頭 `/`・`\` は拒否）
 */
export function resolvePortalFileHref(file: string, base: string): string | null {
  const f = file.trim();
  if (!f) return null;
  if (isHttpUrl(f)) return f;
  if (f.startsWith('/') || f.includes('\\') || f.split('/').some((seg) => seg === '..' || seg === '.')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(f)) return null; // javascript: 等のスキーム
  const b = base.endsWith('/') ? base : `${base}/`;
  return b + PORTAL_FILES_DIR + f.split('/').map(encodeURIComponent).join('/');
}

/**
 * portal.json を正規化する。壊れていても例外を投げず、使える項目だけ拾って既定値で埋める。
 * `base` は `import.meta.env.BASE_URL`（末尾 `/` 付き）。
 */
export function normalizePortalConfig(raw: unknown, base: string): PortalConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return DEFAULT_PORTAL_CONFIG;
  const o = raw as Record<string, unknown>;
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v.slice(0, 50) : []);

  const notices: PortalNotice[] = arr(o.notices)
    .map((n) => {
      const r = (n && typeof n === 'object' ? n : {}) as Record<string, unknown>;
      return { date: str(r.date, 40), text: str(r.text, 1000) };
    })
    .filter((n) => n.text);

  const manuals: PortalManual[] = [];
  for (const m of arr(o.manuals)) {
    const r = (m && typeof m === 'object' ? m : {}) as Record<string, unknown>;
    const title = str(r.title, 200);
    const href = resolvePortalFileHref(str(r.file, 500) || str(r.url, 1000), base);
    if (title && href) manuals.push({ title, description: str(r.description), href });
  }

  const links: PortalLink[] = [];
  for (const l of arr(o.links)) {
    const r = (l && typeof l === 'object' ? l : {}) as Record<string, unknown>;
    const title = str(r.title, 200);
    const href = str(r.href, 1000);
    if (!title || !href) continue;
    const internal = sanitizeNextPath(href);
    if (internal) {
      links.push({ title, description: str(r.description), href: internal, internal: true });
    } else if (isHttpUrl(href)) {
      links.push({ title, description: str(r.description), href, internal: false });
    }
  }

  const installSteps = arr(o.installSteps).map((s) => str(s, 500)).filter(Boolean);

  return {
    title: str(o.title, 100) || DEFAULT_PORTAL_CONFIG.title,
    subtitle: str(o.subtitle, 300) || DEFAULT_PORTAL_CONFIG.subtitle,
    notices,
    manuals,
    installSteps: installSteps.length ? installSteps : DEFAULT_PORTAL_CONFIG.installSteps,
    links,
  };
}

// ============================================================
// ポータル サイクル P1: 3 カラム化（資料・ニュース・課題・TODO）
// サーバーの応答も「信用しない入力」として正規化する（壊れていても画面を落とさない）。
// ============================================================

export interface PortalDocItem {
  title: string;
  /** `DEVRELAY_PORTAL_DIR` からの相対パス（`/` 区切り） */
  path: string;
  size: number;
  updatedAt: string;
}

export interface PortalDocCategory {
  name: string;
  /** true なら DIR 直下の PDF（方針） */
  root: boolean;
  docs: PortalDocItem[];
}

export type PortalNewsCategory = 'update' | 'notice' | 'mail' | 'other';

export interface PortalNewsItem {
  id: string;
  date: string;
  category: PortalNewsCategory;
  title: string;
  body: string;
  link?: string;
}

export interface PortalIssue {
  title: string;
  owner?: string;
  due?: string;
  status?: string;
  link?: string;
}

export type PortalNewsTab = 'latest' | 'update';

function arrOf(raw: unknown, key: string, max: number): unknown[] {
  if (!raw || typeof raw !== 'object') return [];
  const v = (raw as Record<string, unknown>)[key];
  return Array.isArray(v) ? v.slice(0, max) : [];
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** `GET /api/portal/docs` の応答を正規化する。 */
export function normalizePortalDocs(raw: unknown): PortalDocCategory[] {
  const out: PortalDocCategory[] = [];
  for (const c0 of arrOf(raw, 'categories', 100)) {
    const c = rec(c0);
    const name = str(c.name, 200);
    if (!name) continue;
    const docs: PortalDocItem[] = [];
    for (const d0 of Array.isArray(c.docs) ? c.docs.slice(0, 500) : []) {
      const d = rec(d0);
      const title = str(d.title, 300);
      const p = str(d.path, 600);
      if (!title || !p) continue;
      docs.push({ title, path: p, size: typeof d.size === 'number' ? d.size : 0, updatedAt: str(d.updatedAt, 40) });
    }
    if (docs.length > 0) out.push({ name, root: c.root === true, docs });
  }
  return out;
}

/** PDF を開く URL（`<base>api/portal/docs/file?path=…`）。`base` は `import.meta.env.BASE_URL`。 */
export function portalDocFileHref(docPath: string, base: string): string {
  const b = base.endsWith('/') ? base : `${base}/`;
  return `${b}api/portal/docs/file?path=${encodeURIComponent(docPath)}`;
}

/** 資料ページ（`/portal/docs?c=<分類>`）のパス。 */
export function portalDocsPagePath(category?: string | null): string {
  return category ? `/portal/docs?c=${encodeURIComponent(category)}` : '/portal/docs';
}

/** `GET /api/portal/news` の応答を正規化する（新しい順）。 */
export function normalizePortalNews(raw: unknown): PortalNewsItem[] {
  const out: PortalNewsItem[] = [];
  for (const r0 of arrOf(raw, 'items', 300)) {
    const r = rec(r0);
    const title = str(r.title, 300);
    const date = str(r.date, 10);
    if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const c = str(r.category, 20);
    const category: PortalNewsCategory = c === 'update' || c === 'notice' || c === 'mail' ? c : 'other';
    const link = str(r.link, 1000);
    out.push({
      id: str(r.id, 200) || `${date}-${title}`,
      date,
      category,
      title,
      body: str(r.body, 4000),
      ...(link && isHttpUrl(link) ? { link } : {}),
    });
  }
  return out.sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1));
}

/** portal.json のお知らせをニュース（notice）に混ぜる。日付の無いお知らせは最新扱いにしない（末尾）。 */
export function mergeNoticesIntoNews(notices: readonly PortalNotice[], news: readonly PortalNewsItem[]): PortalNewsItem[] {
  const fromNotices: PortalNewsItem[] = notices.map((n, i) => ({
    id: `notice-${i}-${n.date}`,
    date: /^\d{4}-\d{2}-\d{2}$/.test(n.date) ? n.date : '0000-00-00',
    category: 'notice',
    title: n.text,
    body: '',
  }));
  return [...news, ...fromNotices].sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1));
}

/** タブで絞る（最新 = 全部、アップデート = update のみ）。 */
export function filterPortalNews(items: readonly PortalNewsItem[], tab: PortalNewsTab): PortalNewsItem[] {
  return tab === 'update' ? items.filter((i) => i.category === 'update') : [...items];
}

/** `GET /api/portal/issues` の応答を正規化する。 */
export function normalizePortalIssues(raw: unknown): PortalIssue[] {
  const out: PortalIssue[] = [];
  for (const r0 of arrOf(raw, 'items', 200)) {
    const r = rec(r0);
    const title = str(r.title, 300);
    if (!title) continue;
    const link = str(r.link, 1000);
    out.push({
      title,
      ...(str(r.owner, 100) ? { owner: str(r.owner, 100) } : {}),
      ...(str(r.due, 20) ? { due: str(r.due, 20) } : {}),
      ...(str(r.status, 40) ? { status: str(r.status, 40) } : {}),
      ...(link && isHttpUrl(link) ? { link } : {}),
    });
  }
  return out;
}

/** ナレッジ検索のパス（空なら検索画面そのもの）。 */
export function buildKnowledgeSearchPath(q: string): string {
  const s = q.trim().slice(0, 500);
  return s ? `/knowledge?q=${encodeURIComponent(s)}` : '/knowledge';
}

/** ファイルサイズの表示（KB / MB）。 */
export function formatPortalFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
