/**
 * #332: plan モードの canUseTool 判定を切り出した純関数群。
 * 外部 import ゼロ（node:test から直接 dist/ を import してテストするため）。
 * ai-runner.ts はこのモジュールをインポートして使用し、ロジックの重複を作らない。
 *
 * #333: strictReadonly の Bash 判定を「コマンド文字列全体の前方一致」から
 * 「セグメント分割（; && || | 改行）＋セグメントごとの先頭実行ファイル名判定」に変更。
 * グロブ（* ? []）は判定に一切影響させない（#333 の根本原因はグロブそのものではなく、
 * 落ちてきた Bash コマンドを旧実装がコマンド文字列全体の前方一致で判定していたため、
 * 引数にグロブや複数パスが入るだけで allowedTools のどのルールにも前方一致しなくなっていたこと）。
 * matchesToolRule/isAllowedByRules は exec モードの isToolSessionApproved（セッション内
 * 「常に許可」判定、ai-runner.ts にインライン複製）からも使われている概念のため、シグネチャ・
 * 挙動とも linux 版と完全に同一に保つ（macOS の自己完結方針により import ではなくファイルを複製する）。
 */

/**
 * 単一のルール文字列がツール呼び出しにマッチするかを判定する。
 * ルール形式:
 * - "ToolName": ツール名完全一致（Edit, Read, Write, Glob, Grep 等）
 * - "Bash(cmd)": Bash コマンドの完全一致
 * - "Bash(cmd *)": Bash コマンドの前方一致（cmd 自体、または "cmd " で始まるコマンド）
 * @returns マッチした場合 true
 */
export function matchesToolRule(rule: string, toolName: string, input: Record<string, unknown>): boolean {
  // "ToolName" 形式: ツール名完全一致
  if (!rule.includes('(')) {
    return toolName === rule;
  }

  // "Bash(cmd *)" / "Bash(cmd)" 形式: Bash コマンドのパターンマッチ
  const match = rule.match(/^(\w+)\((.+)\)$/);
  if (!match) return false;
  const [, ruleToolName, rulePattern] = match;
  if (toolName !== ruleToolName) return false;

  if (toolName === 'Bash' && typeof input.command === 'string') {
    const command = input.command.trim();
    if (rulePattern.endsWith(' *')) {
      const prefix = rulePattern.slice(0, -2);
      return command === prefix || command.startsWith(prefix + ' ');
    }
    return command === rulePattern;
  }
  return false;
}

/**
 * ルール配列（plan モードの allowedTools 等）に対してツール呼び出しがマッチするかを判定する。
 * @returns マッチした場合 true
 */
export function isAllowedByRules(rules: string[] | undefined, toolName: string, input: Record<string, unknown>): boolean {
  if (!rules || rules.length === 0) return false;
  for (const rule of rules) {
    if (matchesToolRule(rule, toolName, input)) return true;
  }
  return false;
}

/**
 * 文字列の各文字位置が「クォート内（シングル or ダブル）」かどうかを判定する。
 * クォート文字自身も「内側」として扱う（トークナイズ時に開始・終了クォートを
 * 一貫した規則で除去できるようにするため）。エスケープされたダブルクォート（\"）は
 * トグル対象から除外する簡易対応（バックスラッシュエスケープの完全なシェル互換は目的としない）。
 */
function scanQuoteState(command: string): boolean[] {
  const state: boolean[] = new Array(command.length).fill(false);
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === "'" && !inDouble) {
      state[i] = true;
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle && command[i - 1] !== '\\') {
      state[i] = true;
      inDouble = !inDouble;
      continue;
    }
    state[i] = inSingle || inDouble;
  }
  return state;
}

/**
 * コマンド置換（$(...) / `...` / <(...)）が含まれるかを判定する。
 * これらはサブシェルの中身を静的に検査できないため、含まれていれば
 * 常に compoundCommand として deny する（クォートの内外を問わない。
 * ダブルクォート内でも $(...) は展開されるため）。
 */
export function hasCommandSubstitution(command: string): boolean {
  return /\$\(|`|<\(/.test(command);
}

/**
 * コマンド文字列を `;` `&&` `||` `|` および改行（クォート外のみ）で分割する。
 * 空セグメントは除去する。
 */
export function splitShellSegments(command: string): string[] {
  const quoteState = scanQuoteState(command);
  const segments: string[] = [];
  let current = '';
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (!quoteState[i]) {
      if (ch === '\n' || ch === ';') {
        segments.push(current);
        current = '';
        i += 1;
        continue;
      }
      if (ch === '&' && command[i + 1] === '&') {
        segments.push(current);
        current = '';
        i += 2;
        continue;
      }
      if (ch === '|' && command[i + 1] === '|') {
        segments.push(current);
        current = '';
        i += 2;
        continue;
      }
      if (ch === '|') {
        segments.push(current);
        current = '';
        i += 1;
        continue;
      }
    }
    current += ch;
    i += 1;
  }
  segments.push(current);
  return segments.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * セグメント内に書き込みリダイレクト（`>` `>>` `<>`、クォート外）が含まれるかを判定する。
 * `2>&1` / `>&2` のような fd 複製は `>` の直後が `&` であるため書き込みとはみなさない。
 */
export function hasWriteRedirect(segment: string): boolean {
  const quoteState = scanQuoteState(segment);
  for (let i = 0; i < segment.length; i++) {
    if (quoteState[i]) continue;
    const ch = segment[i];
    if (ch === '>') {
      if (segment[i + 1] === '&') {
        i += 1;
        continue;
      }
      return true;
    }
    if (ch === '<' && segment[i + 1] === '>') {
      return true;
    }
  }
  return false;
}

/**
 * セグメントをクォート考慮の上で空白区切りにトークナイズする。
 * クォート文字自体はトークンから除去する（展開・エスケープ処理は行わない簡易実装）。
 */
export function tokenizeSegment(segment: string): string[] {
  const quoteState = scanQuoteState(segment);
  const tokens: string[] = [];
  let current = '';
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (!quoteState[i] && /\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    if ((ch === '"' || ch === "'") && quoteState[i]) {
      continue;
    }
    current += ch;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

/** 先頭の `export` キーワードおよび `VAR=value` 形式の変数代入トークンを読み飛ばす。 */
function stripLeadingAssignmentsAndExport(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === 'export') {
      i += 1;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
      i += 1;
      continue;
    }
    break;
  }
  return tokens.slice(i);
}

/** 値を伴う git のグローバルフラグ（サブコマンドの前に置ける）。 */
const GIT_GLOBAL_FLAGS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);

/**
 * `git -C <dir> log --oneline` のような git のグローバルフラグを読み飛ばし、
 * 先頭を `['git', <subcommand>, ...]` に正規化する。git 以外はそのまま返す。
 */
function normalizeGitTokens(tokens: string[]): string[] {
  if (tokens[0] !== 'git') return tokens;
  const result: string[] = ['git'];
  let i = 1;
  while (i < tokens.length) {
    const t = tokens[i];
    if (GIT_GLOBAL_FLAGS_WITH_VALUE.has(t)) {
      i += 2;
      continue;
    }
    if (t.startsWith('-')) {
      i += 1;
      continue;
    }
    break;
  }
  result.push(...tokens.slice(i));
  return result;
}

/**
 * "Bash(cmd)" / "Bash(cmd *)" ルールをトークン列で判定する（#333）。
 * 文字列全体の前方一致ではなくトークン単位で比較するため、引数にグロブが
 * 含まれていても（グロブ自体は1トークンとして扱われるため）誤って不一致にならない。
 * git はサブコマンド前のグローバルフラグを読み飛ばしてから比較する。
 */
export function matchesBashRuleByTokens(rule: string, tokens: string[]): boolean {
  const match = rule.match(/^Bash\((.+)\)$/);
  if (!match) return false;
  const rulePattern = match[1];
  const normalizedTokens = normalizeGitTokens(tokens);

  if (rulePattern.endsWith(' *')) {
    const prefixTokens = tokenizeSegment(rulePattern.slice(0, -2));
    if (normalizedTokens.length < prefixTokens.length) return false;
    return prefixTokens.every((t, idx) => normalizedTokens[idx] === t);
  }
  const patternTokens = tokenizeSegment(rulePattern);
  if (patternTokens.length !== normalizedTokens.length) return false;
  return patternTokens.every((t, idx) => normalizedTokens[idx] === t);
}

/**
 * トークン列が書き込み系コマンドかどうかを判定する。
 * - `sudo` 経由は常に write 扱い（権限昇格を剥がして判定しない）
 * - `sed -i` は write 扱い
 * - それ以外は git のグローバルフラグを読み飛ばした上で、先頭 1 語 or 2 語が
 *   writeBashCommands（例: 'rm', 'git commit', 'pm2 restart'）に一致するかで判定
 */
function isWriteBashCommand(tokens: string[], writeBashCommands: string[]): boolean {
  if (tokens.length === 0) return false;
  if (tokens[0] === 'sudo') return true;
  if (tokens[0] === 'sed' && tokens.includes('-i')) return true;

  const normalized = normalizeGitTokens(tokens);
  const single = normalized[0];
  const double = normalized.length >= 2 ? `${normalized[0]} ${normalized[1]}` : undefined;
  if (double && writeBashCommands.includes(double)) return true;
  if (writeBashCommands.includes(single)) return true;
  return false;
}

/** decidePlanPermission / decideBashCommand の判定結果 */
export type PlanPermissionDecision =
  | { behavior: 'allow' }
  | { behavior: 'deny'; reason: string; detail?: string };

/**
 * 1 セグメント（`;`/`&&`/`||`/`|` で区切られたコマンドの1個）を判定する（#333）。
 * 判定順: ①書き込みリダイレクト→②書き込み系コマンド→③読み取り専用コマンド表→
 * ④allowedTools ルール（トークン一致）→⑤どれにも当たらなければ notInAllowlist。
 */
function decideSingleBashSegment(
  segment: string,
  allowedTools: string[] | undefined,
  readonlyBashCommands: string[],
  writeBashCommands: string[],
): PlanPermissionDecision {
  if (hasWriteRedirect(segment)) {
    return { behavior: 'deny', reason: 'planPolicy:writeTool', detail: `書き込みリダイレクト: ${segment}` };
  }

  const rawTokens = tokenizeSegment(segment);
  const tokens = stripLeadingAssignmentsAndExport(rawTokens);
  if (tokens.length === 0) {
    return { behavior: 'deny', reason: 'planPolicy:notInAllowlist', detail: '空のセグメントです' };
  }

  if (isWriteBashCommand(tokens, writeBashCommands)) {
    return { behavior: 'deny', reason: 'planPolicy:writeTool', detail: `書き込み系コマンド: ${tokens[0]}` };
  }

  const commandName = normalizeGitTokens(tokens)[0];
  if (readonlyBashCommands.includes(commandName)) {
    return { behavior: 'allow' };
  }

  const matchesRule = (allowedTools ?? []).some((rule) => matchesBashRuleByTokens(rule, tokens));
  if (matchesRule) {
    return { behavior: 'allow' };
  }

  return { behavior: 'deny', reason: 'planPolicy:notInAllowlist', detail: `許可コマンド一覧にない: ${tokens[0]}` };
}

/**
 * strictReadonly の Bash コマンド判定本体（#333）。
 * コマンド置換（$(...) 等）は中身を検査できないため無条件で compoundCommand。
 * 複合コマンドは全セグメントが allow でなければ deny（reason は compoundCommand に丸める。
 * ただし detail には実際に失敗した最初のセグメントの理由を残す）。
 * `ls doc/* | head` のように読み取り専用コマンド同士のパイプは allow になる
 * （パイプ先が read-only なら情報が外に出ないため許可する方針。`| tee out.txt` は
 * tee が write 表に入っているため deny になる）。
 */
export function decideBashCommand(params: {
  command: string;
  allowedTools?: string[];
  readonlyBashCommands: string[];
  writeBashCommands: string[];
}): PlanPermissionDecision {
  const { command, allowedTools, readonlyBashCommands, writeBashCommands } = params;

  if (hasCommandSubstitution(command)) {
    return {
      behavior: 'deny',
      reason: 'planPolicy:compoundCommand',
      detail: 'コマンド置換 $(...) / `...` / <(...) の中身は検査できません',
    };
  }

  const segments = splitShellSegments(command);
  if (segments.length === 0) {
    return { behavior: 'deny', reason: 'planPolicy:notInAllowlist', detail: '空のコマンドです' };
  }

  const segmentDecisions = segments.map((segment) =>
    decideSingleBashSegment(segment, allowedTools, readonlyBashCommands, writeBashCommands),
  );

  if (segments.length === 1) {
    return segmentDecisions[0];
  }

  const failing = segmentDecisions.find((d) => d.behavior === 'deny');
  if (failing && failing.behavior === 'deny') {
    return {
      behavior: 'deny',
      reason: 'planPolicy:compoundCommand',
      detail: `複合コマンドに許可されないセグメントを含む: ${failing.detail ?? ''}`,
    };
  }
  return { behavior: 'allow' };
}

/**
 * plan モードの canUseTool 相当の判定（AskUserQuestion / ExitPlanMode の特別扱いは
 * 呼び出し側で先に処理する前提。この関数はそれ以外の通常ツールのみを対象とする）。
 *
 * - strictReadonly=true:
 *   - writeTools（Write/Edit/MultiEdit/NotebookEdit 等）は常に deny（reason: 'planPolicy:writeTool'）
 *   - Bash は decideBashCommand に委譲（セグメント分割＋トークン判定、#333）
 *   - それ以外は readonlyTools（PLAN_READONLY_TOOLS 相当）または allowedTools にマッチしなければ
 *     deny（reason: 'planPolicy:notInAllowlist'）
 *   - allowedTools は「呼び出し元が渡した allowedTools（ユーザーカスタム含む） ∪ defaultAllowedTools
 *     （対象 OS の DEFAULT_ALLOWED_TOOLS_*）」の和集合で評価する（#333 人間承認時の追記）。
 *     ユーザーが独自保存した allowedTools は default より緩い方向の差分も含めてそのまま尊重し、
 *     default にあってカスタムに無い読み取り系ルールを欠落扱いにしない。この和集合は
 *     strictReadonly 判定専用であり、options.allowedTools 自体（interactive の SDK 事前承認や
 *     exec モードの isToolSessionApproved が参照する値）は書き換えない。
 * - strictReadonly=false: 従来どおり allow（skipPermissions の値に関係なく plan モードのデフォルト動作）
 */
export function decidePlanPermission(params: {
  toolName: string;
  input: Record<string, unknown>;
  strictReadonly: boolean;
  allowedTools?: string[];
  defaultAllowedTools?: string[];
  readonlyTools?: string[];
  readonlyBashCommands?: string[];
  writeBashCommands?: string[];
  writeTools?: string[];
  skipPermissions: boolean;
}): PlanPermissionDecision {
  if (!params.strictReadonly) {
    return { behavior: 'allow' };
  }

  if ((params.writeTools ?? []).includes(params.toolName)) {
    return { behavior: 'deny', reason: 'planPolicy:writeTool', detail: `書き込み系ツール: ${params.toolName}` };
  }

  // #333 人間承認時の追記: ユーザーカスタム allowedTools ∪ 対象 OS の DEFAULT_ALLOWED_TOOLS の和集合。
  const effectiveAllowedTools = Array.from(
    new Set([...(params.allowedTools ?? []), ...(params.defaultAllowedTools ?? [])]),
  );

  if (params.toolName === 'Bash' && typeof params.input.command === 'string') {
    return decideBashCommand({
      command: params.input.command,
      allowedTools: effectiveAllowedTools,
      readonlyBashCommands: params.readonlyBashCommands ?? [],
      writeBashCommands: params.writeBashCommands ?? [],
    });
  }

  const allowed =
    (params.readonlyTools ?? []).includes(params.toolName) ||
    isAllowedByRules(effectiveAllowedTools, params.toolName, params.input);
  return allowed
    ? { behavior: 'allow' }
    : { behavior: 'deny', reason: 'planPolicy:notInAllowlist', detail: `許可ツール一覧にない: ${params.toolName}` };
}
