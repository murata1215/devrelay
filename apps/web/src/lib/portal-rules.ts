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
