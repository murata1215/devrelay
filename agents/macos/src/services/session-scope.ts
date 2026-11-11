/**
 * セッションの「一時性」を判定する純関数（#348 層 B: Agent 側の直交化）。
 *
 * クロスプロジェクト連携（ask-member / teamexec-member）や WebUI のプロジェクト説明生成は、
 * 呼び出し元セッションと同じ projectPath 上で **一時的に** 動くだけのセッションであり、
 * 対話セッション（人間が使い続けるセッション）と同じ `.devrelay/claude-session-id` /
 * `.devrelay/conversation.json` を読み書きしてはならない。読み書きすれば同一 projectPath を
 * 複数セッションが同時に read-modify-write することになり、resume 先の取り違えや
 * 会話履歴の lost update（2026-09-01 の輻輳事故で実測: 83→82→81 件と減っていく）を引き起こす。
 *
 * 外部 import ゼロの純関数のみで構成する（#332 `permission-policy.ts` / #337 `progress-timeout.ts` /
 * #339 `claude-login-code.ts` / #348 `cross-query-guard.ts` と同じ流儀）。
 * `agents/linux` と `agents/macos` と `agents/windows` で byte-for-byte 同一内容を維持すること。
 */

export type SessionScope = 'interactive' | 'crossQuery' | 'teamExec' | 'askDesc' | 'raw';

/**
 * sessionId のプレフィックスからセッションの種別を判定する。
 *
 * - `crossquery_` : ask-member（クロスプロジェクト問い合わせ）
 * - `teamexec_`    : teamexec-member（クロスプロジェクト実行依頼）
 * - `askdesc_`     : WebUI のプロジェクト説明生成（AI に1回だけ聞くだけの使い捨てセッション）
 * - `raw_`         : raw-completion（ゲーム席用の素の completion API。専用 WS チャネル
 *                    `server:raw:prompt`/`agent:raw:result` を通るため本経路には来ないが、
 *                    将来の変更で `handleAiPrompt` に迷い込んだ場合に `saveConversation`/
 *                    `clearOutputDir`/`archiveWorkState` を止める最後の砦として追加）
 * - それ以外        : 対話セッション（人間が継続して使うセッション）
 *
 * @param sessionId 判定対象のセッション ID
 */
export function classifySessionScope(sessionId: string): SessionScope {
  if (sessionId.startsWith('crossquery_')) return 'crossQuery';
  if (sessionId.startsWith('teamexec_')) return 'teamExec';
  if (sessionId.startsWith('askdesc_')) return 'askDesc';
  if (sessionId.startsWith('raw_')) return 'raw';
  return 'interactive';
}

/**
 * 一時セッション（projectPath 上の永続状態を読み書きしてはいけないセッション）かどうかを判定する。
 *
 * @param sessionId 判定対象のセッション ID
 */
export function isEphemeralSession(sessionId: string): boolean {
  return classifySessionScope(sessionId) !== 'interactive';
}

/**
 * ログ表示用のラベルを返す（既存の `CROSS-QUERY` / `TEAM-EXEC` 表記と互換の大文字ハイフン区切り）。
 *
 * @param scope 表示対象のスコープ
 */
export function sessionScopeLabel(scope: SessionScope): string {
  switch (scope) {
    case 'crossQuery':
      return 'CROSS-QUERY';
    case 'teamExec':
      return 'TEAM-EXEC';
    case 'askDesc':
      return 'ASK-DESC';
    case 'raw':
      return 'RAW';
    case 'interactive':
      return 'INTERACTIVE';
  }
}

/**
 * 案C′（クロス ask のセッション継続）サイクルC1 + サイクルG（既存バグ修正）: 一時セッションが
 * projectPath 上のどの状態を読み書きしてよいかを表す許可リスト。既定は全項目 deny
 * （下記 `resolveSessionStatePolicy` 参照）。
 *
 * 各フィールドが呼び出し元のどのガードに対応するかは `connection.ts` 側のコメントで明示する。
 * - scopedConversation: conversation.json / claude-session-id / codex-session-id / context-usage
 *   （scope dir = `.devrelay/sessions/<agentScopeId>/` 内のみ。projectPath 直下には一切出ない）
 * - outputDirClear: `clearOutputDir()`（`.devrelay-output/` の rm -rf + mkdir）
 * - outputFileCollect: `collectOutputFiles()`（`.devrelay-output/` の内容を呼び出し元へ転送）
 * - planFile: `savePlanFile()`（`.devrelay/plans/` への書込・古いファイルの unlink）
 * - workState: `loadWorkState()`/`archiveWorkState()`（work state の読み出し・消費）
 * - storageContext: `loadStorageContext()` の内容をプロンプトに注入するか
 * - receivedFiles: `saveReceivedFiles()`（添付ファイルの `.devrelay-files/` への保存）
 * - projectRescan: `rescanProjectsAndSync()`（`CLAUDE.md` / `~/.devrelay/projects.yaml` の書込）
 * - forcePlanTurn: true の場合、履歴に `exec` マーカーが混入していても plan ターンに固定する
 *   （`strictReadonly` が必ず効くことの構造的保証。resumable 以外では false = 従来どおり
 *   履歴末尾の `exec` マーカーで判定する）
 * - outputDirInstruction: `OUTPUT_DIR_INSTRUCTION`（成果物を `.devrelay-output/` に置くよう AI へ
 *   促す文言）をプロンプトに付与するか。resumable/isolated では付与しない
 *   （所有者プロジェクトへの書き込みを AI に勧める必要が無く、strictReadonly の無駄な deny ログを避ける）
 * - projectStateRead（サイクルG, G-5b）: Codex/Devin のセッション ID・モデル・ATIF オフセット・
 *   パーミッションモードの **読み出し**（`loadCodexSessionId`/`loadDevinSessionId` 等）を許可するか。
 *   書き込み・削除は別途 `SendPromptOptions.persistProjectState`（= `scopedConversation`）が
 *   ガードする（既存の仕組みを再利用。読み出しだけ本フィールドで分離する）。
 *   同一ユーザーの一時セッション（legacy）では既存の継承挙動を変えないため true のまま、
 *   isolated（クロスユーザー ask）でのみ false にする（所有者の Codex/Devin 会話を覗けなくする）。
 * - approveAllState（サイクルG, G-8）: 機体プロセス全体の「以降すべて許可」モード
 *   （`ai-runner.ts` の `approveAllMode`/`sessionApprovedTools`）を読む・書く・リセットするか。
 *   一時セッション全般（legacy/isolated とも false）が対象 — 他人（または別プロジェクト）の
 *   一時的な質問 1 通が対話セッションの「以降すべて許可」を消したり、逆に一時セッションが
 *   対話セッションの「以降すべて許可」を継承して自動承認されたりする既存バグの根治。
 * - refuseUnsafeAiTool（サイクルG, G-7 を一般化): true の場合、読み取り専用を権限で強制できない
 *   実効 AI（devin / gemini、または claude+Project.terminalMode）へのターンを、AI を一切起動
 *   せずに Agent 側で拒否する。isolated（クロスユーザー ask）専用 — Devin の git 自動復元
 *   ガードが所有者の未コミット作業を巻き戻す事故（G-7）や、gemini/terminalMode では
 *   `strictReadonly` が構造的に効かないことへの対応。同一ユーザーの ask は
 *   2026-09-26 承認サイクルの人間判断（AI を差し替えず実行し、プロンプト禁止文のみ付与する）
 *   を変えないため false のまま。
 * - reportAiToolSubstitution（サイクルG）: `resolveEffectiveAiTool()` が要求 AI を実際に使える
 *   ツールへ差し替えたとき、`agent:session:aiTool` でサーバーへ報告するか。報告すると
 *   サーバー側は `Project.defaultAi` を実態へ書き換える（#309 の既存挙動）。isolated では
 *   他人の質問 1 通で所有者のプロジェクト既定 AI が書き換わってしまうため false にする。
 */
export interface SessionStatePolicy {
  scopedConversation: boolean;
  outputDirClear: boolean;
  outputFileCollect: boolean;
  planFile: boolean;
  workState: boolean;
  storageContext: boolean;
  receivedFiles: boolean;
  projectRescan: boolean;
  forcePlanTurn: boolean;
  outputDirInstruction: boolean;
  projectStateRead: boolean;
  approveAllState: boolean;
  refuseUnsafeAiTool: boolean;
  reportAiToolSubstitution: boolean;
}

/** 対話セッション（既存の `!isEphemeral` 分岐と完全一致。全許可・forcePlanTurn/refuseUnsafeAiTool のみ false） */
const INTERACTIVE_STATE_POLICY: SessionStatePolicy = {
  scopedConversation: true,
  outputDirClear: true,
  outputFileCollect: true,
  planFile: true,
  workState: true,
  storageContext: true,
  receivedFiles: true,
  projectRescan: true,
  forcePlanTurn: false,
  outputDirInstruction: true,
  projectStateRead: true,
  approveAllState: true,
  refuseUnsafeAiTool: false,
  reportAiToolSubstitution: true,
};

/**
 * 従来の一時セッション（crossQuery/teamExec/askDesc/raw、resumable/isolated 未指定。
 * 同一ユーザーの ask-member / teamexec-member / WebUI 説明生成もこの区分のまま）。
 * 既存コードの `isEphemeral` 分岐をそのまま許可リストへ落とし込んだもの。
 * `outputFileCollect`/`storageContext`/`receivedFiles`/`projectRescan`/`outputDirInstruction`/
 * `projectStateRead` は既存コードが `isEphemeral` を見ずに無条件実行している箇所にそのまま
 * 対応する（同一ユーザー ask の既存の使い方——成果物添付・storageContext・Codex/Devin
 * 会話継続——を壊さないため、本サイクルでも変更しない）。
 * `approveAllState` はサイクルG（G-8）で false に変更（一時セッション全般に適用する既存バグ修正。
 * 詳細は `SessionStatePolicy` の JSDoc 参照）。
 */
const LEGACY_EPHEMERAL_STATE_POLICY: SessionStatePolicy = {
  scopedConversation: false,
  outputDirClear: false,
  outputFileCollect: true,
  planFile: false,
  workState: false,
  storageContext: true,
  receivedFiles: true,
  projectRescan: true,
  forcePlanTurn: false,
  outputDirInstruction: true,
  projectStateRead: true,
  approveAllState: false,
  refuseUnsafeAiTool: false,
  reportAiToolSubstitution: true,
};

/**
 * 案C′ の第3区分（resumable）。crossQuery セッションに限り、scope dir 内の会話状態だけを
 * 読み書きしてよい。他の全項目は deny（許可リスト方式）。
 * `projectStateRead` は `scopedConversation` と連動して true にする
 * （scope dir 内の Codex/Devin セッション状態は resumable 自身が読み書きしてよい対象のため。
 * `ai-runner.ts` の全読み出し箇所が `options.agentScopeId` を伴って `resolveScopeDir()` 経由で
 * 呼ばれるため、resumable の必須条件である有効な `agentScopeId` が無い限り projectPath 直下
 * ＝所有者の対話セッションの状態を読む経路は構造的に存在しない）。
 * `approveAllState`/`reportAiToolSubstitution` は C2 でも暫定値のまま false を維持する
 * （機体グローバル状態・`Project.defaultAi` 書き換えは resume のユースケースに不要なため）。
 * `refuseUnsafeAiTool`（サイクルC2, A-1）: C1 時点では false の暫定値だったが、ここを true に
 * 変更する。サーバー側 `decideCrossAskSessionPlan()` が `readOnlyEnforced`（G の
 * `decideAskReadOnlyEnforcement()` と同じ判定）を満たす宛先にしか resumable を送らないため主防御は
 * サーバー側にあるが、Agent 側の `resolveEffectiveAiTool()` がサーバーの availability 申告と
 * 食い違って devin/gemini 等へ差し替えた場合の最後の砦として isolated と同じ `true` に揃える。
 */
const RESUMABLE_SCOPED_STATE_POLICY: SessionStatePolicy = {
  scopedConversation: true,
  outputDirClear: false,
  outputFileCollect: false,
  planFile: false,
  workState: false,
  storageContext: false,
  receivedFiles: false,
  projectRescan: false,
  forcePlanTurn: true,
  outputDirInstruction: false,
  projectStateRead: true,
  approveAllState: false,
  refuseUnsafeAiTool: true,
  reportAiToolSubstitution: false,
};

/**
 * サイクルG の第4区分（isolated）。クロスユーザー ask（別ユーザーのプロジェクトへの質問）に
 * 限り、サーバーが `statePolicy: 'isolated'` を送る。所有者プロジェクトの状態を一切読み書き・
 * 漏洩させず、読み取り専用を権限で強制できない実効 AI へのターンは開始前に拒否する
 * （`refuseUnsafeAiTool`）。resumable と異なり会話状態も持たない（`scopedConversation: false`）
 * — 本サイクルでは resume を配線しないため。
 */
const ISOLATED_STATE_POLICY: SessionStatePolicy = {
  scopedConversation: false,
  outputDirClear: false,
  outputFileCollect: false,
  planFile: false,
  workState: false,
  storageContext: false,
  receivedFiles: false,
  projectRescan: false,
  forcePlanTurn: false,
  outputDirInstruction: false,
  projectStateRead: false,
  approveAllState: false,
  refuseUnsafeAiTool: true,
  reportAiToolSubstitution: false,
};

/**
 * `agentScopeId` が安全な識別子かどうかを検証する正規表現。
 *
 * `scope-dir.ts` の `isValidAgentScopeId()` と意図的に重複させている（import しない）。
 * 本ファイルは「外部 import ゼロの純関数のみで構成する」規約を持ち、`scope-dir.ts` はまさに
 * この規約を守るために `path` を要する処理を分離した別ファイルであるため（同ファイルの JSDoc
 * 参照）、本ファイルから `scope-dir.ts` を import すると規約が崩れる。1 行の正規表現なので
 * 重複のコストは小さい。両方を変更する場合は必ずセットで直すこと。
 */
const AGENT_SCOPE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * `resolveSessionStatePolicy` が受け取るオプション。
 * `statePolicy` は wire 上の `EphemeralStatePolicy`（`@devrelay/shared`）と同じ意味だが、
 * 本ファイルは外部 import ゼロのため共有パッケージの型は import せず、プレーンな
 * `string | undefined` として受け取り、リテラル比較でのみ判定する
 * （`permission-policy.ts` の `PermissionPolicySource` と同じ流儀）。
 */
export interface ResolveSessionStatePolicyOptions {
  /** `'resumable-scoped'` / `'isolated'` 以外の値・未指定はすべて「従来の一時セッション扱い」になる */
  statePolicy?: string;
  /** scope dir の識別子。resumable と判定するには `AGENT_SCOPE_ID_PATTERN` を満たす必要がある
   *  （isolated では使わない。agentScopeId の有無に関わらず isolated 判定は変わらない） */
  agentScopeId?: string;
}

/**
 * sessionId と呼び出し時オプションから `SessionStatePolicy`（許可リスト）を決定する。
 *
 * 判定順序（許可は明示的に 1 段ずつ、既定は deny）:
 * 1. `classifySessionScope(sessionId) === 'interactive'` → 全許可（既存挙動と完全一致）
 * 2. `scope === 'crossQuery'` かつ `statePolicy === 'resumable-scoped'` かつ `agentScopeId` が
 *    `AGENT_SCOPE_ID_PATTERN` を満たす → resumable（scope dir の会話状態のみ許可）
 * 3. `scope === 'crossQuery'` かつ `statePolicy === 'isolated'` → isolated
 *    （クロスユーザー ask。`agentScopeId` は不要——isolated は scope dir を使わない）
 * 4. それ以外（現行の全一時セッション。teamExec/askDesc/raw、同一ユーザーの crossQuery、または
 *    resumable/isolated の条件を満たさない crossQuery） → 従来どおりの一時セッション扱い（挙動不変）
 *
 * `agentScopeId` が不正・未指定の場合は②に落ちず④になるため、`<projectPath>/.devrelay/` 直下を
 * resumable 扱いで触ることは構造的に起き得ない。
 *
 * @param sessionId 判定対象のセッション ID
 * @param opts `server:session:start`/`server:ai:prompt` から渡される statePolicy/agentScopeId
 */
export function resolveSessionStatePolicy(
  sessionId: string,
  opts: ResolveSessionStatePolicyOptions = {},
): SessionStatePolicy {
  const scope = classifySessionScope(sessionId);

  if (scope === 'interactive') {
    return { ...INTERACTIVE_STATE_POLICY };
  }

  if (
    scope === 'crossQuery' &&
    opts.statePolicy === 'resumable-scoped' &&
    opts.agentScopeId !== undefined &&
    AGENT_SCOPE_ID_PATTERN.test(opts.agentScopeId)
  ) {
    return { ...RESUMABLE_SCOPED_STATE_POLICY };
  }

  if (scope === 'crossQuery' && opts.statePolicy === 'isolated') {
    return { ...ISOLATED_STATE_POLICY };
  }

  return { ...LEGACY_EPHEMERAL_STATE_POLICY };
}

/**
 * サイクルG（G-7 の一般化）: 読み取り専用を権限で強制できる実効 AI かどうかを判定する。
 *
 * サーバー側 `apps/server/src/services/ask-guard.ts` の `decideAskReadOnlyEnforcement()` /
 * `ENFORCED_READONLY_AI_TOOLS` と**意図的に同じ判定を複製**している
 * （本ファイルの「外部 import ゼロ」規約のため apps/server 側を import できない。
 * サーバー側を変更する場合は必ずこちらも同時に直すこと。双方に同じ回帰ガードコメントがある）。
 *
 * - claude（Agent SDK: canUseTool + PLAN_WRITE_TOOLS）/ codex（CLI `sandbox_mode="read-only"`）は
 *   権限レベルで構造的に強制される。ここに devin/gemini を追加してはならない。
 * - claude であっても `terminalMode` が true の場合は PTY 経由の素の `claude --continue` が
 *   起動し `--permission-mode plan` が適用されないため、強制対象から外れる。
 * - macOS/Windows Agent には `terminalMode` の概念が無いため、呼び出し側は常に `false` を渡す
 *   （本関数のシグネチャ自体は 3 機種 byte-for-byte 同一を維持する）。
 *
 * @param aiTool 判定対象の実効 AI ツール名
 * @param terminalMode 端末インタフェースモード（PTY 経由 claude）かどうか
 */
export function isAiToolReadOnlyEnforceable(aiTool: string, terminalMode: boolean): boolean {
  const toolEnforced = aiTool === 'claude' || aiTool === 'codex';
  return toolEnforced && !terminalMode;
}
