/**
 * Sandbox selftest の確認プローブ（ホスト経由で実行した curl 等）の結果解釈（外部 import ゼロ、純関数）。
 *
 * サイクル SB-1a-1.1（B6 対応）。既存の `cli/commands/sandbox.ts` の `describeProbeOutcome()`
 * （開発者身元で直接 `cmd.exe` を実行していた旧実装）を、ホスト経由実行の結果を解釈する形に
 * 置き換えるために新設。**fail-closed の原則を維持する**: 「判断できない」結果は
 * 常に `'inconclusive'` とし、`'blocked'` と断定しない。既知の回避経路（bitsadmin 等）は
 * どんな結果でも `'blocked'` と表示しない（人間の承認条件6）。
 */

export type SandboxProbeOutcome = 'blocked' | 'reachable' | 'inconclusive';

export interface SandboxHostProbeInput {
  /** ホスト経由で起動したプロセスの終了コード（`awaitSandboxProcessResult()` の結果） */
  exitCode: number | null;
  timedOut: boolean;
  /** ホストへの spawn 要求自体が失敗した（接続不能・ハンドシェイク不成立等） */
  spawnFailed: boolean;
  /** このプローブのために自分でプロキシを起動した場合、プロキシが実際に拒否ログを記録したか */
  proxyDeniedObserved?: boolean;
}

export interface SandboxProbeInterpretation {
  outcome: SandboxProbeOutcome;
  /** 表示に添える根拠（終了コード・観測した記録等） */
  evidence: string;
}

/** curl が「接続できなかった」場合に返す終了コード（`CURLE_COULDNT_CONNECT`） */
const CURL_CONNECT_FAILED_EXIT_CODES: ReadonlySet<number> = new Set([7]);

/** curl が「上位（中継）プロキシから CONNECT に非 200 応答を受けた」場合に返す終了コード（`CURLE_RECV_ERROR`） */
const CURL_PROXY_REJECTED_EXIT_CODES: ReadonlySet<number> = new Set([56]);

/** 確認 1: プロキシを使わない直結が遮断されたか（陽性対照方式。許可リストの実ホストへの直結を試す） */
export function interpretSandboxDirectBlockProbe(input: SandboxHostProbeInput): SandboxProbeInterpretation {
  if (input.spawnFailed) {
    return { outcome: 'inconclusive', evidence: 'ホスト経由でのプロセス起動に失敗したため確認できませんでした。' };
  }
  if (input.timedOut) {
    return { outcome: 'inconclusive', evidence: 'タイムアウトしたため確認できませんでした。' };
  }
  if (input.exitCode === 0) {
    return { outcome: 'reachable', evidence: '直結できました（curl exit=0）。' };
  }
  if (input.exitCode !== null && CURL_CONNECT_FAILED_EXIT_CODES.has(input.exitCode)) {
    return { outcome: 'blocked', evidence: `接続に失敗しました（curl exit=${input.exitCode}）。` };
  }
  return { outcome: 'inconclusive', evidence: `未知の結果です（curl exit=${input.exitCode ?? 'null'}）。` };
}

/** 確認 2: 中継プロキシ経由で、許可リスト外のホストが拒否されたか */
export function interpretSandboxProxyDenyProbe(input: SandboxHostProbeInput): SandboxProbeInterpretation {
  if (input.spawnFailed) {
    return { outcome: 'inconclusive', evidence: 'ホスト経由でのプロセス起動に失敗したため確認できませんでした。' };
  }
  if (input.timedOut) {
    return { outcome: 'inconclusive', evidence: 'タイムアウトしたため確認できませんでした。' };
  }
  if (input.exitCode === 0) {
    return { outcome: 'reachable', evidence: '許可外ホストへ到達できました（curl exit=0）。' };
  }
  if (input.exitCode !== null && CURL_PROXY_REJECTED_EXIT_CODES.has(input.exitCode)) {
    const base = `プロキシが CONNECT を拒否しました（curl exit=${input.exitCode}）。`;
    return {
      outcome: 'blocked',
      evidence: input.proxyDeniedObserved
        ? `${base} 許可リスト判定の拒否記録あり。`
        : `${base}（根拠弱: 既存の待ち受けを使ったため拒否記録は確認していません）`,
    };
  }
  return { outcome: 'inconclusive', evidence: `未知の結果です（curl exit=${input.exitCode ?? 'null'}）。` };
}

/**
 * 既知の回避経路（bitsadmin 等のブローカーサービス経由）の確認。
 * **どんな結果でも `'blocked'` を返さない**（SID ベースのファイアウォールルールでは
 * 別 SID のブローカーサービスが実際の通信を行うため構造的に遮断できない）。
 */
export function interpretSandboxKnownBypassProbe(input: SandboxHostProbeInput): SandboxProbeInterpretation {
  if (input.exitCode === 0) {
    return {
      outcome: 'reachable',
      evidence: '到達した可能性があります（exit=0）。既知の回避経路のため構造的に遮断できません。',
    };
  }
  return {
    outcome: 'inconclusive',
    evidence: '既知の回避経路のため、失敗してもファイアウォールの効果とは断定できません。',
  };
}

export type SandboxReadProbeOutcome = 'readable' | 'not-readable' | 'inconclusive';

export interface SandboxReadProbeInterpretation {
  outcome: SandboxReadProbeOutcome;
  evidence: string;
}

/**
 * `cmd.exe /c type <path> >nul` の終了コードから読み取り可否を判定する（C1 `--acl-audit`）。
 * 対象が存在しない場合も `type` は exit=1 を返すため、「読めなかった」と「存在しない」は
 * この終了コードだけでは区別できない（いずれも期待どおり読めていないことには変わらないため、
 * 両者を区別する追加プローブは本サイクルの範囲外とする）。
 */
export function interpretSandboxReadProbe(exitCode: number | null): SandboxReadProbeInterpretation {
  if (exitCode === 0) {
    return { outcome: 'readable', evidence: '読み取りに成功しました（exit=0）。' };
  }
  if (exitCode === 1) {
    return { outcome: 'not-readable', evidence: '読み取りに失敗しました（exit=1。アクセス拒否または対象が存在しない）。' };
  }
  return { outcome: 'inconclusive', evidence: `未知の結果です（exit=${exitCode ?? 'null'}）。` };
}
