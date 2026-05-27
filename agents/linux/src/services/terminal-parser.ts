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
    // ただし "❯ 1. ..." のような番号付き選択肢行は除外（trust prompt / tool 承認カードの誤検知防止）
    if (/^\s*[>❯]\s+(?!\d+\.)\S/.test(line)) return true;
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
 * Claude CLI が表示する選択肢プロンプトを汎用検出する（起動時 + 会話中の AskUserQuestion 等）。
 *
 * 対応する 2 系統:
 *  - **confirm 型** (即決): trust folder / resume from summary / 将来追加されるシステムプロンプト
 *    → 「Enter to confirm · Esc to cancel」
 *  - **select 型** (↑/↓ navigation): 会話中の AskUserQuestion など
 *    → 「Enter to select · ↑/↓ to navigate · Esc to cancel」
 *
 * tool 承認プロンプト (`detectToolApprovalPrompt`) との構造差:
 *  - select/confirm 型: カーソル `❯` が option 1 行頭に乗る (`❯ 1. ...`)、専用入力行なし
 *  - tool 承認型: 番号付き選択肢の下に独立した `❯` 入力行
 *
 * いずれも `extractChoicePrompt` で {question, options} を抽出 → 既存 WS 承認カード経路で
 * WebUI/Discord/Telegram に転送 → ユーザー応答を `<choice>\r` で PTY に書き戻す
 */
export function detectStartupChoicePrompt(text: string): boolean {
  const hasInstruction = /Enter\s+to\s+(?:confirm|select).*Esc\s+to\s+cancel/i.test(text);
  const hasNumberedOptions = /^\s*[❯>]?\s*1\.\s+\S/m.test(text);
  return hasInstruction && hasNumberedOptions;
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
 * Claude CLI のレンダリング済み画面から「最新の応答ブロック」を抽出する。
 *
 * 旧実装は「baseline に含まれない最初のバレット行から最初の separator まで」だったが、
 * 以下の問題で巨大ダンプ（7000+ chars）になる事故が発生したため再設計（#228 続編 3）:
 *  - baseline=0（履歴未ロード/spawn 直後）だと全 bullet が「新規」扱いになる
 *  - prompt に `Previous conversation:` 形式の会話履歴を含めると、Claude がそれを画面に
 *    echo・処理し、過去ターン bullet が大量に scrollback に積まれる
 *  - xterm セル上書きで破損した bullet テキストも混入する
 *
 * 新ロジック: **入力枠を下から anchor して、最新の応答ブロックのみ取り出す**
 *  (1) 画面下部の入力枠境界（╭─ / ╰─ / 連続 ─ / ⏵⏵）を見つける
 *  (2) その上で最も近い `●` バレット = Claude の最新応答の末尾
 *  (3) そこから上方走査して応答ブロックの開始を探す。以下で停止:
 *      - 2 行以上の連続空行（ターン境界）
 *      - 強い separator（連続 ─, ╭─, ╰─）
 *      - `Previous conversation:` / `User:` / `Assistant:` / `【プランモード】` 等の
 *        prompt 内マーカー（過去会話との境界）
 *  (4) その範囲を join して返す
 *
 * @param rendered 仮想ターミナルでレンダリング済みのテキスト
 * @param _baselineBulletMap （互換のため残す、現実装では未使用）
 * @returns 最新応答ブロックの本文（trim 済み）。見つからなければ空文字列
 */
export function extractClaudeResponse(rendered: string, _baselineBulletMap: Map<string, number>): string {
  const lines = rendered.split('\n');

  // (1) 画面下部の入力枠境界（バッファ末尾から走査）
  let inputBoxIdx = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (/^[╭╰][─━]/.test(t) || /^⏵⏵/.test(t) || /^[─━]{20,}$/.test(t)) {
      inputBoxIdx = i;
      break;
    }
  }

  // (2) 入力枠の上で最後の `●` バレットを探す
  let lastBulletIdx = -1;
  for (let i = inputBoxIdx - 1; i >= 0; i--) {
    if (/^\s*[●●]\s/.test(lines[i])) {
      lastBulletIdx = i;
      break;
    }
  }
  if (lastBulletIdx === -1) return '';

  // (3) 上方走査して応答ブロックの開始を見つける
  let startIdx = lastBulletIdx;
  let emptyLineRun = 0;
  for (let i = lastBulletIdx - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t === '') {
      emptyLineRun++;
      if (emptyLineRun >= 2) break;  // 2 行以上の空行 = ターン境界
      continue;
    }
    emptyLineRun = 0;
    // 強い separator
    if (/^[─━]{20,}/.test(t)) break;
    if (/^[╭╰][─━]/.test(t)) break;
    // prompt 内マーカー（過去会話との境界）
    if (/^(?:Previous conversation:|User:|Assistant:|【プランモード】|【実行モード】|【重要】)/.test(t)) break;
    // Claude CLI banner（再 spawn / resume 時に画面に出る）
    if (/^[▐▝]|^▘▘\s+▝▝/.test(lines[i])) break;
    // それ以外は応答ブロックの一部
    startIdx = i;
  }

  // (4) 下方走査して endIdx を見つける（lastBulletIdx 以降に banner / 完了マーカー /
  // User: 等が来たらそこで止める。入力枠より前に止まることが多い）
  let endIdx = inputBoxIdx;
  for (let i = lastBulletIdx + 1; i < inputBoxIdx; i++) {
    const t = lines[i].trim();
    if (/^[▐▝]|^▘▘\s+▝▝/.test(lines[i])) { endIdx = i; break; }
    if (/^(?:✅ 完了|⚠️ |User:|Assistant:|Previous conversation:|【プランモード】|【実行モード】|【重要】)/.test(t)) { endIdx = i; break; }
    if (/^[─━]{20,}/.test(t)) { endIdx = i; break; }
  }

  // (5) 抽出 + ツール呼び出し / partial / tool 出力サマリ をフィルタしてノイズ削減
  const responseLines = lines.slice(startIdx, endIdx);
  const filtered = responseLines.filter(line => {
    if (/^\s*[●●]\s/.test(line)) {
      const trimmed = line.trim();
      // ツール呼び出しバレット (Bash/PowerShell/Read/Write/...) → 除外
      if (isToolCallBullet(trimmed)) return false;
      // 途中切れの partial バレット → 除外
      if (isLikelyPartialBullet(trimmed)) return false;
    }
    // tool 出力サマリの ⎿ 行 → 除外
    if (/^\s*⎿/.test(line)) return false;
    return true;
  });
  return filtered.join('\n').trim();
}

/**
 * バレットがツール呼び出し（Bash/PowerShell/Read/Write/Update 等）かどうかを判定する。
 *
 * 形式例:
 *  ● Bash(git status && echo "---FILES---" && ls)
 *  ● PowerShell(Get-ChildItem dist | Select-Object Name)
 *  ● Read(file.css)
 *  ● Reading 1 file… (ctrl+o to expand)
 *  ● Write(rules\devrelay.md)
 *  ● Searching for 1 pattern…
 *  ● I used the wrong shell. Let me use PowerShell.
 *
 * ツール呼び出し系のバレットは WebUI 出力では本質的にノイズなので
 * streaming / 最終応答の両方で除外する。Claude の説明文・分析・結論
 * （`● ビルド設定を確認しました...` 等のテキストバレット）のみ残す
 */
export function isToolCallBullet(text: string): boolean {
  const stripped = text.replace(/^\s*[●●]\s*/, '').trim();
  // 末尾文字は `[\s(.]` で whitespace / `(` / `.` のいずれか
  // （"I used the wrong shell. Let me use PowerShell." のような period 直後パターンに対応）
  return /^(?:Bash|PowerShell|Read|Reading|Write|Update|Edit|MultiEdit|Searching|Glob|Grep|TodoWrite|WebFetch|WebSearch|NotebookEdit|Task|Background|I used the wrong shell)[\s(.]/i.test(stripped);
}

/**
 * バレットが「途中切れの partial 文字列」かどうかを判定する。
 *
 * Claude CLI のストリーミング rendering で行が scroll-up された時、その時点の
 * 「途中まで書かれた状態」が scrollback に確定する。例:
 *   ● ビルドはパ            (本来は「...パッケージング段階まで...」)
 *   ● I used the wron        (本来は「...the wrong shell.」)
 *   ● Rea                    (本来は「Reading 1 file…」)
 *
 * これら partial を WebUI に流すと意味のない文字列で画面が埋まるため filter する。
 * ヒューリスティック: バレット本文が 8 文字未満 + 末尾が完全な区切り文字でない
 */
export function isLikelyPartialBullet(text: string): boolean {
  const body = text.replace(/^\s*[●●]\s*/, '').trim();
  if (body.length >= 8) return false;
  // 完全な区切り文字（句読点・閉じ括弧・三点リーダ等）で終わっていれば partial ではない
  return !/[。.!?:;)\]\}」』］】…]$/.test(body);
}

/**
 * 仮想画面の rendered text から `●` で始まる行のテキスト（trim 済み）配列を返す。
 * 同一テキストが複数行に現れる場合は全て返す（baseline / 完了判定で count を取るため）
 */
export function getBulletLines(rendered: string): string[] {
  const lines = rendered.split('\n');
  const result: string[] = [];
  for (const line of lines) {
    if (/^\s*[●●]\s/.test(line)) result.push(line.trim());
  }
  return result;
}

/**
 * バレット行配列を Map<text, count> に変換する。
 * baseline 確定時に呼び出して保存する
 */
export function bulletCountMap(lines: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1);
  return m;
}

/**
 * Claude CLI の exit 時に出力される「Resume this session with: claude --resume <UUID>」から
 * UUID を抽出する。同セッション中に複数表示される（過去 session のメッセージなど）場合は
 * 最後のもの（最新）を採用。
 *
 * これを `.devrelay/claude-session-id` に保存すれば、次回 terminal mode 起動時に
 * `--resume <id>` で会話を完全継続できる
 */
export function extractClaudeSessionIdFromBuffer(rendered: string): string | null {
  const re = /claude\s+--resume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
  let lastMatch: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rendered)) !== null) {
    lastMatch = m[1];
  }
  return lastMatch;
}

/**
 * Claude CLI の「思考中インジケータ」（Cogitating for 28s · 64 tokens 等）を画面から抽出する。
 *
 * Claude CLI は思考中に画面下部に料理関連の動詞 + 経過秒数 + トークン数 を animate して表示する:
 *   * Cogitating (28s · 64 tokens)
 *   ✻ Stewing for 6s · 36 tokens
 *   * Crafting (5s · 100 tokens)
 *   Sauteed for 6s   ← 過去形 = 完了直後
 *
 * heartbeat 表示用に整形した 1 行を返す。検出できなければ null
 */
export function extractThinkingIndicator(rendered: string): string | null {
  const lines = rendered.split('\n');
  // 末尾 10 行のみ走査（インジケータは入力枠の上に常駐）
  const tail = lines.slice(-10);
  for (let i = tail.length - 1; i >= 0; i--) {
    const line = tail[i].trim();
    if (line.length === 0 || line.length > 200) continue;
    // 強い特徴: 「N tokens」または「for Ns」
    if (/\b\d+\s*tokens?\b/i.test(line) || /\bfor\s+\d+[sm](?:\s+\d+[sm])?\b/.test(line)) {
      // アニメ用装飾を削って整形
      return line.replace(/[*·✻✶✽✢⠐⠂✣⠂]/g, '').replace(/\s+/g, ' ').trim().slice(0, 100);
    }
  }
  return null;
}

/**
 * baseline から見た新規バレット出現数を返す。
 *
 * 各テキストの「current count - baseline count」の正値を合計する:
 *  - 同じテキストが baseline より多く出現 → 新規描画とみなす
 *  - current で消えた（buffer trim）テキストは無視（負数を足さない）
 *  - baseline に無いテキストが出現 → 新規（base count=0 として扱う）
 */
export function countNewBullets(baselineMap: Map<string, number>, currentLines: string[]): number {
  const currentMap = bulletCountMap(currentLines);
  let newCount = 0;
  for (const [text, count] of currentMap) {
    const baseCount = baselineMap.get(text) ?? 0;
    newCount += Math.max(0, count - baseCount);
  }
  return newCount;
}

/**
 * 番号付き選択肢プロンプトから質問本文と選択肢リストを抽出する
 *
 * Claude CLI の承認プロンプト典型例（会話中の tool 承認）:
 *   [Bash] git status を実行してよろしいですか?
 *   1. はい
 *   2. いいえ (理由を入力)
 *   ❯
 *
 * 起動時の選択肢プロンプト典型例（trust folder / resume summary）:
 *   Quick safety check: Is this a project you created or one you trust?
 *   ❯ 1. Yes, I trust this folder
 *     2. No, exit
 *
 * AskUserQuestion 典型例（インデント説明文 + 末尾 separator + Chat about this）:
 *   依頼の意図を確認させてください
 *   ❯ 1. 再ビルドしてexe生成
 *        既存のelectron-builder設定で...    ← インデント説明文
 *     2. ビルドの仕組みを整備
 *        ビルド手順書・npmスクリプト...
 *     ...
 *     5. Type something.
 *   ─────────────────
 *     6. Chat about this
 *
 * 起動時はカーソル `❯` が option 1 行頭に乗るパターンがあるため、
 * 番号の前に `❯` / `>` を許容する正規表現を使う。
 * 旧実装は「連続する番号行」前提だったため AskUserQuestion 形式（説明文や separator が間に挟まる）
 * で破綻していた → 「1, 2, 3, ... の最長連続シーケンス」検出方式に変更（#228 続編 3）。
 * 偶然 1 や 2 が会話履歴中に出現しても、シーケンシャルな番号付けが続かない限り採用されない
 *
 * @returns { question, options } または null（選択肢が抽出できない場合）
 */
export function extractChoicePrompt(text: string): { question: string; options: string[] } | null {
  const lines = text.split('\n');

  // (1) 全ての「番号付き選択肢行」候補を収集（先頭 `❯`/`>` カーソルマーカー許容）
  type OptCandidate = { index: number; num: number; text: string };
  const candidates: OptCandidate[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*[❯>]?\s*(\d+)\.\s+(.+?)\s*$/);
    if (m) {
      candidates.push({ index: i, num: Number(m[1]), text: m[2] });
    }
  }

  // (2) 1, 2, 3, ... の最長連続シーケンスを探す（インデント説明文や `─────` separator が
  // 間に挟まっても、連続番号が見つかればそれをプロンプト本体とみなす）
  let bestSeq: OptCandidate[] = [];
  let curSeq: OptCandidate[] = [];
  let nextExpected = 1;
  for (const c of candidates) {
    if (c.num === nextExpected) {
      curSeq.push(c);
      nextExpected++;
    } else if (c.num === 1) {
      if (curSeq.length > bestSeq.length) bestSeq = curSeq;
      curSeq = [c];
      nextExpected = 2;
    } else {
      if (curSeq.length > bestSeq.length) bestSeq = curSeq;
      curSeq = [];
      nextExpected = 1;
    }
  }
  if (curSeq.length > bestSeq.length) bestSeq = curSeq;

  const optionLines = bestSeq;
  if (optionLines.length < 2) return null;

  // 質問本文: 最初の選択肢の直前の連続テキスト行（空行・セパレータで境界）。
  // 質問とその上のメッセージは通常空行で区切られているため、最初の空行で停止する
  const firstOptIdx = optionLines[0].index;
  const questionLines: string[] = [];
  for (let i = firstOptIdx - 1; i >= 0; i--) {
    const line = lines[i];
    const trimmed = line.trim();
    // 空行に到達したら抽出終了（前のメッセージとの境界）
    if (trimmed === '') {
      if (questionLines.length > 0) break;
      continue;  // 選択肢直上の空行はスキップ
    }
    // セパレータに到達したら抽出終了
    if (/^[─━]{3,}/.test(trimmed) || /^[╭╰][─━]/.test(trimmed) || /^⏵⏵/.test(trimmed)) break;
    // 履歴メッセージ（`●`）に到達したら抽出終了
    if (/^[●●]\s/.test(trimmed)) break;
    questionLines.unshift(trimmed);
    if (questionLines.length > 15) break;  // safety cap
  }

  return {
    question: questionLines.join('\n').trim() || '(質問テキストを抽出できませんでした)',
    options: optionLines.map(o => o.text),
  };
}
