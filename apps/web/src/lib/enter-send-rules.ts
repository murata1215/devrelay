/**
 * Enter 送信ロック（2026-11-21）の純関数群。
 *
 * ロックしていないとき（従来どおり）: Enter で送信、Shift+Enter で改行。
 * ロック中: Enter は改行（ブラウザ既定動作）、送信は送信ボタンか Ctrl+Enter / ⌘+Enter。
 * ロックの有無に関わらず、IME 変換中（日本語入力の確定 Enter）は送信しない。
 * DOM / localStorage に依存しないため node:test で検証する（tests/enter-send-rules.test.mjs）。
 */

export const ENTER_LOCK_STORAGE_KEY = 'devrelay-enter-lock';

export interface EnterKeyInput {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  /** KeyboardEvent.isComposing（React では e.nativeEvent.isComposing） */
  isComposing: boolean;
  /** IME 処理中の keydown は keyCode 229（Safari 等で isComposing が立たない場合の保険） */
  keyCode?: number;
}

/** 'send' = 送信する（preventDefault も必要） / 'default' = 何もしない（改行などブラウザ既定に任せる） */
export type EnterAction = 'send' | 'default';

export function decideEnterAction(e: EnterKeyInput, locked: boolean): EnterAction {
  if (e.key !== 'Enter') return 'default';
  if (e.isComposing || e.keyCode === 229) return 'default';
  if (e.shiftKey) return 'default';
  if (e.ctrlKey || e.metaKey) return 'send';
  return locked ? 'default' : 'send';
}

/** 保存値 → ロック中か。'1' のときだけロック（未設定・その他はロックしない＝従来どおり） */
export function parseEnterLock(stored: string | null | undefined): boolean {
  return stored === '1';
}

export function serializeEnterLock(locked: boolean): string {
  return locked ? '1' : '0';
}
