/**
 * 端末インタフェースモード（Terminal Mode）用パーサ
 *
 * PTY 経由で起動された `claude --continue` の出力ストリームを解析し、
 * 以下を判定する:
 *  - 初期プロンプト復帰（起動完了）
 *  - tool 承認プロンプト出現
 *  - AskUserQuestion プロンプト出現
 *  - 最終出力テキストの抽出
 *
 * Claude CLI の UI は ANSI 制御コードを多用するため、検出は ANSI 除去後の
 * テキストに対して行う。誤検出を最小化するためバッファ末尾のみを参照する。
 */
import stripAnsi from 'strip-ansi';
import type { Terminal } from '@xterm/headless';

/** 直近何文字を見るか（バッファ末尾の判定用） */
const TAIL_WINDOW = 4000;

/** バッファ末尾を ANSI 除去後の文字列で返す */
function tailPlain(buffer: string): string {
  const tail = buffer.length > TAIL_WINDOW ? buffer.slice(-TAIL_WINDOW) : buffer;
  return stripAnsi(tail);
}

/**
 * Claude CLI の入力プロンプトに復帰したかを判定する
 *
 * Claude CLI のプロンプト形態:
 *  - 標準: `> ` で終わる
 *  - 枠付き: `│ > ` で終わる
 *  - 空入力カーソル: `╭─ ... ─╮\n│ > │\n╰─ ... ─╯` の末尾
 *
 * 末尾の空白・改行は無視する
 */
export function detectPromptReady(buffer: string): boolean {
  const tail = tailPlain(buffer).trimEnd();
  if (tail.length === 0) return false;

  // 末尾 4 行を見る
  const lines = tail.split('\n').slice(-4).map(l => l.trimEnd());

  for (const line of lines) {
    // "> " または "│ > " で終わる行
    if (/^>\s*$/.test(line)) return true;
    if (/^>\s*\|?\s*$/.test(line)) return true;
    if (/[│|]\s*>\s*[│|]?\s*$/.test(line)) return true;
  }
  return false;
}

/**
 * tool 承認プロンプトが出ているかを判定する
 *
 * Claude CLI の承認プロンプト典型例:
 *   [Bash] git status を実行してよろしいですか?
 *   1. はい
 *   2. いいえ (理由を入力)
 *   ❯
 *
 * 多言語対応のため、番号付き選択肢（"1. ... 2. ..."）と
 * 末尾のカーソルマーク `❯` の同時出現で判定する
 */
export function detectToolApprovalPrompt(buffer: string): boolean {
  const tail = tailPlain(buffer);
  // "1. " "2. " のような選択肢が含まれ、末尾近くに ❯（U+276F）がある
  const hasChoices = /(?:^|\n)\s*1\.\s.+\n\s*2\.\s/.test(tail);
  const hasCursor = /❯\s*$/.test(tail.trimEnd());
  return hasChoices && hasCursor;
}

/**
 * AskUserQuestion プロンプトが出ているかを判定する
 *
 * Claude CLI が AskUserQuestion を実行すると、tool 承認プロンプトに似た
 * 質問形式が出る。選択肢にツール名 `AskUserQuestion` を含む場合や
 * 「Q:」「質問:」キーワードを含む場合に検出する
 */
export function detectAskQuestionPrompt(buffer: string): boolean {
  const tail = tailPlain(buffer);
  if (!/❯\s*$/.test(tail.trimEnd())) return false;
  return /AskUserQuestion|質問:|Q:\s/i.test(tail);
}

/**
 * 「このフォルダを信頼しますか」プロンプト（trust folder prompt）を判定する
 *
 * Claude CLI は初回ワークスペース利用時に以下のプロンプトを表示する:
 *   Quick safety check: Is this a project you created or one you trust?
 *   Claude Code'll be able to read, edit, and execute files here.
 *   > 1. Yes, I trust this folder
 *     2. No, exit
 *   Enter to confirm · Esc to cancel
 *
 * `--dangerously-skip-permissions` を付けても表示されるため、端末モードでは
 * 自動承認して通常プロンプトまで進める必要がある。
 *
 * 「trust this folder」「No, exit」両方の文言が末尾近くに出ていれば trust prompt と判定
 */
export function detectTrustPrompt(buffer: string): boolean {
  const tail = tailPlain(buffer);
  const hasTrust = /trust\s+this\s+folder|フォルダ.{0,4}信頼/i.test(tail);
  const hasExit = /No,?\s*exit|いいえ.{0,4}終了/i.test(tail);
  return hasTrust && hasExit;
}

/**
 * @xterm/headless の仮想ターミナルから最終的な表示テキストを抽出する
 *
 * PTY 出力には ANSI 制御コードが大量に含まれており、
 * カーソル移動・再描画でテキストが上書きされている可能性がある。
 * Terminal バッファの各行を読み出すことで「最終的な見た目」を得られる。
 *
 * 末尾の空行はトリムする
 */
export function extractFinalOutput(term: Terminal): string {
  const buffer = term.buffer.active;
  const lines: string[] = [];
  for (let y = 0; y < buffer.length; y++) {
    const line = buffer.getLine(y);
    if (!line) continue;
    lines.push(line.translateToString(true));
  }
  // 末尾の空行を削除
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }
  return lines.join('\n');
}
