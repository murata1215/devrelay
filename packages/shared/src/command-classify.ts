/**
 * 入力テキストがコマンド（`e` `x` `h` `n make` `u` 数字選択 など）か、AI へのプロンプトかの判定。
 *
 * もとはサーバーの `services/natural-language-parser.ts` にあった `isTraditionalCommand()`。
 * Usage 案件必須サイクル（2026-11-19）で、WebUI 側の「案件が空のスレッドでは AI プロンプトを送らせない」
 * 判定にも同じ基準を使うため shared へ移した（判定内容は無変更）。
 */

import { SHORTCUTS } from './constants.js';

export function isTraditionalCommand(input: string): boolean {
  const trimmed = input.trim().toLowerCase();

  // SHORTCUTS 定数に定義されたコマンド（完全一致）
  if (trimmed in SHORTCUTS) return true;

  // SHORTCUTS キーに空白続きでマッチ（引数付きコマンド: testflight xxx, log 20, etc.）
  // 2文字以上のキーのみ（1文字キーは誤検知リスクがあるため個別対応）
  for (const key of Object.keys(SHORTCUTS)) {
    if (key.length >= 2 && trimmed.startsWith(key + ' ')) return true;
  }

  // 数字のみ（リスト選択）
  if (/^\d+$/.test(trimmed)) return true;

  // 「e, 〜」「exec, 〜」パターン（カンマ付きプロンプト）
  if (/^(?:e|exec)\s*,\s*.+/i.test(trimmed)) return true;

  // ai:claude, ai:gemini 等（AI 切り替え）
  if (/^ai:(claude|gemini|codex|aider)$/i.test(trimmed)) return true;

  // 'a 1', 'a claude' 等（AI 選択）- 1文字キーの特殊パターン
  if (/^a\s+(\d+|claude|gemini|codex|aider)$/i.test(trimmed)) return true;

  // 'u force' / 'u!'（サイクル3.1: busy 保留を無視して強制更新）- 1文字キーの特殊パターン
  // （`u` は :252 の「2文字以上のキーのみ」ガードに引っかからず AI プロンプト扱いになっていたため、
  // `a`/`l`/`login` と同じ個別パターンで明示的に拾う）
  if (/^u(?:pdate)?(?:\s+force|!)$/i.test(trimmed)) return true;

  // 'n 1' 等（スレッド引継ぎの候補選択）- 1文字キーの特殊パターン
  if (/^n\s+\d+$/i.test(trimmed)) return true;
  // 'n make'（スレッド引継ぎの引継ぎ書作成）
  if (/^n\s+make$/i.test(trimmed)) return true;

  // 'l' (モデル一覧), 'l sonnet', 'l plan:haiku', 'l exec:opus' 等（モデル選択）
  if (trimmed === 'l' || /^l\s+.+$/i.test(trimmed)) return true;

  // 'login', 'login cancel', 'login <code#state>'（#326 Phase2: Claude リモート再ログイン）
  // ここでの判定は「トークン一致するか」のみ（大文字小文字を区別しない trimmed を使用）。
  // 実際のコード抽出（大文字小文字区別あり）は command-parser.ts 側で元の input から行う。
  if (/^login(\s+.+)?$/i.test(trimmed)) return true;

  // log20, sum7d 等（スペースなし引数付きコマンド）
  if (/^log\d+$/i.test(trimmed)) return true;
  if (/^sum\d+d?$/i.test(trimmed)) return true;

  return false;
}
