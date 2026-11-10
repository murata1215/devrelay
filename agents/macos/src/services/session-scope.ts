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
 * 案C′（クロス ask のセッション継続）サイクルC1: 一時セッションが projectPath 上のどの状態を
 * 読み書きしてよいかを表す許可リスト。既定は全項目 deny（下記 `resolveSessionStatePolicy` 参照）。
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
 *   促す文言）をプロンプトに付与するか。resumable では付与しない
 *   （所有者プロジェクトへの書き込みを AI に勧める必要が無く、strictReadonly の無駄な deny ログを避ける）
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
}

/** 対話セッション（既存の `!isEphemeral` 分岐と完全一致。全許可・forcePlanTurn のみ false） */
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
};

/**
 * 従来の一時セッション（crossQuery/teamExec/askDesc/raw、resumable 未指定）。
 * 既存コードの `isEphemeral` 分岐をそのまま許可リストへ落とし込んだもの（挙動不変）。
 * `outputFileCollect`/`storageContext`/`receivedFiles`/`projectRescan`/`outputDirInstruction` は
 * 既存コードが `isEphemeral` を見ずに無条件実行している箇所にそのまま対応する
 * （既知の挙動。本サイクルでは変更しない。resume とは独立の別課題）。
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
};

/**
 * 案C′ の第3区分（resumable）。crossQuery セッションに限り、scope dir 内の会話状態だけを
 * 読み書きしてよい。他の全項目は deny（許可リスト方式）。
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
  /** `'resumable-scoped'` 以外の値・未指定はすべて「resume 不可」として扱う */
  statePolicy?: string;
  /** scope dir の識別子。resumable と判定するには `AGENT_SCOPE_ID_PATTERN` を満たす必要がある */
  agentScopeId?: string;
}

/**
 * sessionId と呼び出し時オプションから `SessionStatePolicy`（許可リスト）を決定する。
 *
 * 判定順序（許可は明示的に 1 段ずつ、既定は deny）:
 * 1. `classifySessionScope(sessionId) === 'interactive'` → 全許可（既存挙動と完全一致）
 * 2. `scope === 'crossQuery'` かつ `statePolicy === 'resumable-scoped'` かつ `agentScopeId` が
 *    `AGENT_SCOPE_ID_PATTERN` を満たす → resumable（scope dir の会話状態のみ許可）
 * 3. それ以外（現行の全一時セッション。teamExec/askDesc/raw、または resumable 条件を
 *    満たさない crossQuery） → 従来どおりの一時セッション扱い（挙動不変）
 *
 * `agentScopeId` が不正・未指定の場合は②に落ちず③になるため、`<projectPath>/.devrelay/` 直下を
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

  return { ...LEGACY_EPHEMERAL_STATE_POLICY };
}
