/**
 * MCP submit_instruction 添付ファイルの検証・サニタイズを行う純粋関数群。
 *
 * 対象は MCP `submit_instruction` の `attachments` パラメータ（base64 JSON、
 * WebUI の `web:command` フレームと同じ形）。この配線は Agent 側
 * `file-handler.ts` の2つの既存の弱点をそのまま突く新しい攻撃面になる:
 *   1. ファイル名がディスク書き込み先に使われる（パストラバーサル）
 *   2. ファイル名が AI プロンプトへ平文で前置される（行注入）
 * そのため、ここでの検証は「セキュリティ境界」そのものであり、
 * human-text-fence.ts のような provenance 表示ではない。
 *
 * 外部 import ゼロ（DB/ネットワーク非依存）に保ち、コンパイル済み dist を直接
 * `node --test` から import して単体検証できるようにする（#308/#331/#332/#334 と同じ流儀）。
 */

/** 1ファイルあたりのデコード後サイズ上限（5MB）。get_attachment の取得上限（tools.ts）と同値。 */
export const ATTACHMENT_MAX_FILE_SIZE = 5 * 1024 * 1024;

/** 1リクエストあたりのデコード後合計サイズ上限（10MB） */
export const ATTACHMENT_MAX_TOTAL_SIZE = 10 * 1024 * 1024;

/** 1リクエストあたりの添付件数上限 */
export const ATTACHMENT_MAX_COUNT = 10;

/** サニタイズ後のファイル名の長さ上限（string.length 基準、切り詰めない＝超過は拒否） */
export const ATTACHMENT_FILENAME_MAX_LENGTH = 100;

/** 許可する MIME タイプ（宣言値がこれ以外なら即拒否） */
export const ALLOWED_ATTACHMENT_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'text/plain',
  'text/markdown',
] as const;

export type AllowedAttachmentMimeType = (typeof ALLOWED_ATTACHMENT_MIME_TYPES)[number];

/** MCP から受け取る添付ファイルの生入力（size は受け取らない。デコード後の実測値を権威とするため） */
export interface RawAttachmentInput {
  filename: string;
  mimeType: string;
  content: string;
}

/** サーバー内部・Agent 送信用の検証済み添付ファイル（packages/shared の FileAttachment と同形） */
export interface ValidatedAttachment {
  filename: string;
  content: string; // base64（デコード検証済みの原文をそのまま保持し、二重変換しない）
  mimeType: string;
  size: number; // デコード後の実バイト数（クライアント申告値は使わない）
}

/** ファイル名サニタイズの結果 */
export interface SanitizeFilenameResult {
  ok: boolean;
  /** ok=true のときのサニタイズ後ファイル名 */
  filename?: string;
  /** basename 化・制御文字除去等でオリジナルから変更があったか（無言の改変をしないため呼び出し側に伝える） */
  changed: boolean;
  /** ok=false のときの拒否理由 */
  reason?: 'empty' | 'nulByte' | 'dotOnly' | 'tooLong';
}

/**
 * ファイル名をサニタイズする。
 *
 * - NUL バイトを含む場合は拒否する（正当なファイル名には出現しない＝明確な攻撃意図）。
 * - `/` `\` を含む場合は最後の区切り以降だけを採用する（basename 化）。
 *   win32 の path.join は `\` も区切りとして扱うため両方を対象にする。
 * - basename 化の結果が空 / `.` / `..` の場合は拒否する（ディレクトリに解決してしまうため）。
 * - 制御文字（U+0000–U+001F, U+007F）は除去する（プロンプトへの行注入対策）。
 * - サニタイズ後の長さが上限を超える場合は拒否する（無言の切り詰めはしない、#325）。
 */
export function sanitizeAttachmentFilename(raw: string): SanitizeFilenameResult {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, changed: false, reason: 'empty' };
  }
  if (raw.includes('\u0000')) {
    return { ok: false, changed: false, reason: 'nulByte' };
  }

  let changed = false;

  // basename 化: '/' '\' の最後の出現以降だけを採用
  const lastSlash = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'));
  let name = lastSlash >= 0 ? raw.slice(lastSlash + 1) : raw;
  if (lastSlash >= 0) {
    changed = true;
  }

  if (name.length === 0 || name === '.' || name === '..') {
    return { ok: false, changed: true, reason: 'dotOnly' };
  }

  // 制御文字除去（改行・タブ・DEL 等）
  const stripped = name.replace(/[\u0000-\u001F\u007F]/g, '');
  if (stripped !== name) {
    changed = true;
    name = stripped;
  }

  if (name.length === 0 || name === '.' || name === '..') {
    return { ok: false, changed: true, reason: 'dotOnly' };
  }

  if (name.length > ATTACHMENT_FILENAME_MAX_LENGTH) {
    return { ok: false, changed, reason: 'tooLong' };
  }

  return { ok: true, filename: name, changed };
}

/**
 * 厳密な base64 デコード。
 *
 * `Buffer.from(x, 'base64')` は不正な文字を黙って読み飛ばすため、
 * 1) 空白類除去 → 2) 文字集合・長さ(%4)の正規表現検査 → 3) デコード後の再エンコードで
 * 往復一致を確認、の3段で判定する。不正なら null を返す（呼び出し側で明示エラーにする）。
 */
export function decodeStrictBase64(raw: string): Buffer | null {
  if (typeof raw !== 'string') return null;
  const compact = raw.replace(/\s+/g, '');
  if (compact.length === 0) return null;
  if (compact.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return null;

  const buf = Buffer.from(compact, 'base64');
  // 往復一致チェック（Buffer.from が不正文字を黙って読み飛ばした場合や、
  // パディングビットに非ゼロの余剰ビットが入っている非正規な base64 を検出する）。
  // 正規なエンコーダの出力は常にゼロパディングのため、正しい入力なら完全一致する。
  if (buf.toString('base64') !== compact) {
    return null;
  }
  return buf;
}

/**
 * マジックバイトから実際の画像 MIME を判定する（宣言値を信用しない）。
 * 一致しなければ null を返す（テキスト等、画像シグネチャを持たない場合も null）。
 */
export function detectMimeFromMagicBytes(buf: Buffer): string | null {
  if (buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) {
    return 'image/png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buf.length >= 4 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
    return 'image/gif';
  }
  if (buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
    return 'image/webp';
  }
  return null;
}

/** 添付ファイル1件あたりの検証失敗理由 */
export type AttachmentFailureReason =
  | 'filenameInvalid'
  | 'mimeNotAllowed'
  | 'base64Invalid'
  | 'mimeMismatch'
  | 'textInvalidUtf8'
  | 'fileTooLarge';

/** 添付ファイル1件の検証失敗 */
export interface AttachmentFailure {
  index: number;
  filename: string;
  reason: AttachmentFailureReason;
  detail?: string;
}

/** validateAttachments() の結果 */
export type ValidateAttachmentsResult =
  | {
      ok: true;
      files: ValidatedAttachment[];
      /** basename 化・制御文字除去等でファイル名が変更された件数 */
      sanitizedFilenameCount: number;
      totalBytes: number;
    }
  | {
      ok: false;
      reason: 'tooManyFiles' | 'totalTooLarge' | 'itemInvalid';
      failures: AttachmentFailure[];
      /** tooManyFiles / totalTooLarge のときの実測値 */
      detail?: { count?: number; totalBytes?: number };
    };

/**
 * 文字列が妥当な UTF-8 として往復デコードできるかを検査する（text/* 用）。
 * NUL を含む場合も無効とみなす。
 */
function isValidUtf8Text(buf: Buffer): boolean {
  if (buf.includes(0x00)) return false;
  const decoded = buf.toString('utf-8');
  // 不正なバイト列は U+FFFD（置換文字）に化けるため、再エンコードしてバイト長が一致するかで判定する。
  // 正当な UTF-8 に元々 U+FFFD が含まれるケースは稀だが許容する（再エンコード一致で吸収される）。
  return Buffer.from(decoded, 'utf-8').equals(buf);
}

/**
 * MCP `submit_instruction` の attachments を検証する。
 *
 * 呼び出し側は ok:false の場合、いかなる状態変更（セッション作成・Message 保存・
 * Agent への送信等）も行う前に処理を中断すること（#334 と同じ規約）。
 *
 * @param input 生の添付ファイル配列（未検証）
 */
export function validateAttachments(input: RawAttachmentInput[]): ValidateAttachmentsResult {
  if (input.length > ATTACHMENT_MAX_COUNT) {
    return { ok: false, reason: 'tooManyFiles', failures: [], detail: { count: input.length } };
  }

  const failures: AttachmentFailure[] = [];
  const files: ValidatedAttachment[] = [];
  let sanitizedFilenameCount = 0;
  let totalBytes = 0;

  input.forEach((item, index) => {
    const rawFilenameForReport = typeof item?.filename === 'string' ? item.filename : '(unknown)';

    // 1. ファイル名サニタイズ
    const sanitized = sanitizeAttachmentFilename(item?.filename ?? '');
    if (!sanitized.ok) {
      failures.push({ index, filename: rawFilenameForReport, reason: 'filenameInvalid', detail: sanitized.reason });
      return;
    }

    // 2. 宣言 MIME の allowlist チェック
    const declaredMime = item?.mimeType;
    if (typeof declaredMime !== 'string' || !ALLOWED_ATTACHMENT_MIME_TYPES.includes(declaredMime as AllowedAttachmentMimeType)) {
      failures.push({ index, filename: sanitized.filename!, reason: 'mimeNotAllowed', detail: String(declaredMime) });
      return;
    }

    // 3. 厳密 base64 デコード
    const buf = decodeStrictBase64(item?.content ?? '');
    if (!buf) {
      failures.push({ index, filename: sanitized.filename!, reason: 'base64Invalid' });
      return;
    }

    // 4. サイズ上限（単体、デコード後の実測値が権威）
    if (buf.length > ATTACHMENT_MAX_FILE_SIZE) {
      failures.push({
        index, filename: sanitized.filename!, reason: 'fileTooLarge',
        detail: `${buf.length} bytes (max ${ATTACHMENT_MAX_FILE_SIZE})`,
      });
      return;
    }

    // 5. MIME 実体検証（宣言値を信用しない）
    if (declaredMime.startsWith('image/')) {
      const detected = detectMimeFromMagicBytes(buf);
      if (detected === null || detected !== declaredMime) {
        failures.push({
          index, filename: sanitized.filename!, reason: 'mimeMismatch',
          detail: `declared=${declaredMime} detected=${detected ?? 'unknown'}`,
        });
        return;
      }
    } else {
      // text/* — マジックバイトを持たないため 画像シグネチャ非一致 + UTF-8 妥当性 で判定する。
      // 画像シグネチャ一致チェックを先に行う: 実体が既知の画像だった場合、テキストとしての
      // UTF-8 妥当性の成否に関わらず「宣言と実体が矛盾している」という、より具体的な
      // mimeMismatch を優先させる（PNG バイト列は UTF-8 として不正になることが多く、
      // その場合に textInvalidUtf8 に埋もれて実体が画像であることが見えなくなるのを防ぐ）。
      const looksLikeImage = detectMimeFromMagicBytes(buf);
      if (looksLikeImage !== null) {
        failures.push({
          index, filename: sanitized.filename!, reason: 'mimeMismatch',
          detail: `declared=${declaredMime} detected=${looksLikeImage}`,
        });
        return;
      }
      if (!isValidUtf8Text(buf)) {
        failures.push({ index, filename: sanitized.filename!, reason: 'textInvalidUtf8' });
        return;
      }
    }

    if (sanitized.changed) {
      sanitizedFilenameCount += 1;
    }
    totalBytes += buf.length;
    files.push({
      filename: sanitized.filename!,
      content: buf.toString('base64'),
      mimeType: declaredMime,
      size: buf.length,
    });
  });

  if (failures.length > 0) {
    return { ok: false, reason: 'itemInvalid', failures };
  }

  if (totalBytes > ATTACHMENT_MAX_TOTAL_SIZE) {
    return { ok: false, reason: 'totalTooLarge', failures: [], detail: { totalBytes } };
  }

  return { ok: true, files, sanitizedFilenameCount, totalBytes };
}
