/**
 * 端末インタフェースモード（Terminal Mode）用パーサ
 *
 * PTY 経由で起動された `claude --continue` の画面状態を解析し、
 * 以下を判定する:
 *  - 初期プロンプト復帰（起動完了）
 *  - tool 承認プロンプト出現
 *  - AskUserQuestion プロンプト出現
 *  - フォルダ信頼確認プロンプト出現
 *  - 最終出力テキストの抽出
 *
 * 各 detect 関数は **`@xterm/headless` 仮想画面でレンダリング済みのテキスト**
 * を受け取る。raw PTY バッファに `strip-ansi` するだけだとカーソル位置指定で
 * 配置された単語が密着してしまう（"Yes, I trust this folder" → "Yes,Itrustthisfolder"）。
 * 仮想画面でレンダリングしたテキストはカーソル位置を解釈してセルに配置されるため、
 * 視認できるとおりの空白で単語が並ぶ。
 */
import type { Terminal } from '@xterm/headless';

/**
 * Claude CLI の入力プロンプトに復帰したかを判定する
 *
 * Claude CLI のプロンプト形態:
 *  - 標準: `> ` または `❯ ` で終わる（カーソルマーカー U+276F）
 *  - 枠付き: `│ > │` / `│ ❯ │` で終わる
 *  - プレースホルダ付き: `│ ❯ Try "..."` の形式（実機で確認された形式）
 *
 * 末尾 5 行の中に該当パターンがあれば true
 */
export function detectPromptReady(text: string): boolean {
  const trimmed = text.trimEnd();
  if (trimmed.length === 0) return false;

  const lines = trimmed.split('\n').slice(-5).map(l => l.trimEnd());

  for (const line of lines) {
    // "> " または "❯ " のみの行（標準プロンプト・空入力、先頭空白も許容）
    if (/^\s*[>❯]\s*$/.test(line)) return true;
    // "│ > │" / "│ ❯ │" 形式（枠付きプロンプト、空入力）
    if (/^[│|]\s*[>❯]\s*[│|]?\s*$/.test(line)) return true;
    // "│ > プレースホルダ │" / "│ ❯ プレースホルダ" 形式（Try ... 等のヒント付き）
    if (/^[│|]\s*[>❯]\s/.test(line)) return true;
    // "❯ Try ..." 形式（枠なしの新プロンプト、実機で確認、先頭空白許容）
    if (/^\s*[>❯]\s+\S/.test(line)) return true;
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
 * 末尾のカーソルマーク `❯` の同時出現で判定する。空白の有無は問わない
 * （仮想画面レンダリング後でも稀に密着する可能性に備えて緩く）
 */
export function detectToolApprovalPrompt(text: string): boolean {
  // "1." と "2." が近接して出現し、末尾近くに ❯（U+276F）がある
  const hasChoices = /1\.\s*\S.{0,200}2\.\s*\S/s.test(text);
  const hasCursor = /❯\s*$/.test(text.trimEnd());
  return hasChoices && hasCursor;
}

/**
 * AskUserQuestion プロンプトが出ているかを判定する
 *
 * Claude CLI が AskUserQuestion を実行すると、tool 承認プロンプトに似た
 * 質問形式が出る。選択肢にツール名 `AskUserQuestion` を含む場合や
 * 「Q:」「質問:」キーワードを含む場合に検出する
 */
export function detectAskQuestionPrompt(text: string): boolean {
  if (!/❯\s*$/.test(text.trimEnd())) return false;
  return /AskUserQuestion|質問:|Q:\s/i.test(text);
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
 * "trust this folder" と "No, exit" が共に画面内にあれば trust prompt と判定。
 * 仮想画面でレンダリング済みでも稀に密着する可能性があるため、空白は \s* で許容する
 */
export function detectTrustPrompt(text: string): boolean {
  // "trust" と "folder" の間に this（あるいは何もなし）を許容
  const hasTrust = /trust\s*this\s*folder|trustfolder|フォルダ.{0,4}信頼/i.test(text);
  // "No, exit" は カンマ・空白を任意に
  const hasExit = /No\s*,?\s*exit|いいえ.{0,4}終了/i.test(text);
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

/**
 * Claude CLI のレンダリング済み画面から「baseline 後に追加された Claude のメッセージ」を抽出する
 *
 * Claude CLI は各メッセージを `●` で始まる行で表示する:
 *   ● こんにちは！PixBlog の作業、何かありますか？
 *
 * baseline 時点の `●` 行数（baselineBulletCount）を保存しておき、
 * それ以降に出現したバレットブロックだけを返す。入力ボックスの枠線
 * （────, ╭, ╰, ⏵⏵）に到達したら抽出終了
 *
 * @param rendered 仮想ターミナルでレンダリング済みのテキスト
 * @param baselineBulletCount baseline 時点の `●` 行数
 * @returns 新規メッセージの本文（trim 済み）。新規がなければ空文字列
 */
export function extractClaudeResponse(rendered: string, baselineBulletCount: number): string {
  const lines = rendered.split('\n');
  // バレット行（`●` で始まる行）のインデックスを全て収集
  const bulletIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*[●●]\s/.test(lines[i])) {
      bulletIndices.push(i);
    }
  }
  // baseline 数を超えなければ新規メッセージなし
  if (bulletIndices.length <= baselineBulletCount) return '';

  const startLine = bulletIndices[baselineBulletCount];
  const result: string[] = [];
  for (let i = startLine; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    // 入力ボックス・セパレータに到達したら抽出終了
    if (i > startLine && (
      /^[─━]{3,}$/.test(trimmed) ||
      /^[╭╰][─━]/.test(trimmed) ||
      /^⏵⏵/.test(trimmed)
    )) {
      break;
    }
    result.push(lines[i]);
  }
  return result.join('\n').trim();
}

/**
 * テキスト中の Claude メッセージ（`●` 行）の数を返す
 * baseline 確定時に呼び出して保存する
 */
export function countClaudeBullets(rendered: string): number {
  const lines = rendered.split('\n');
  let count = 0;
  for (const line of lines) {
    if (/^\s*[●●]\s/.test(line)) count++;
  }
  return count;
}
