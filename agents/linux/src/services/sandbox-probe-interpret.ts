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
  /**
   * サイクル SB-1a-2（a 対応）: 同じ中継プロキシ経由で許可リスト内のホストへ陽性対照を試した結果。
   * `false` の場合、中継プロキシ自体に到達できていないため、拒否プローブの結果（exit=7 等）は
   * 「遮断できた」ではなく「未確認」と解釈する（SB-1a-1.1 時点のバグ: プロキシのリースが
   * プローブごとに再生成され、2 本目の確認が始まる前に閉じてしまっていたため、拒否と
   * 未到達が exit=7 で混同されていた）。未確認（陽性対照を試していない）なら `undefined`。
   */
  proxyControlReachable?: boolean;
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
  // a 対応: 陽性対照（許可リスト内のホストへ、同じ中継プロキシ経由）を先に確認する。
  // 到達できていなければ、拒否プローブの結果が「拒否されたから失敗した」のか
  // 「プロキシ自体に繋がらなかったから失敗した」のか区別できないため、未確認とする。
  if (input.proxyControlReachable === false) {
    return {
      outcome: 'inconclusive',
      evidence: '中継プロキシへの陽性対照（許可リスト内のホストへの到達）が失敗したため確認できませんでした。',
    };
  }
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
 * `%APPDATA%\devrelay` の列挙確認（exit コードのみで判定、existence/control の区別は不要。
 * Agent が実行中である以上このディレクトリは必ず存在するため「存在しない」との混同が起きない）。
 */
export function interpretSandboxDirListProbe(exitCode: number | null): SandboxReadProbeInterpretation {
  if (exitCode === 0) {
    return { outcome: 'readable', evidence: '列挙に成功しました（exit=0）。' };
  }
  if (exitCode === 1) {
    return { outcome: 'not-readable', evidence: '列挙に失敗しました（exit=1）。' };
  }
  return { outcome: 'inconclusive', evidence: `未知の結果です（exit=${exitCode ?? 'null'}）。` };
}

export interface SandboxFileReadProbeInput {
  /** `cmd.exe /c type "<path>" >nul` の終了コード */
  exitCode: number | null;
  /** 対象ファイルが Agent 側（開発者身元）の `fs.stat()` で存在確認できたか */
  targetExists: boolean;
  /** 対照ファイル（プロジェクト内の既存ファイル）が同じ方法で「読めた」になったか */
  controlReadable: boolean;
}

/**
 * `cmd.exe /c type "<path>" >nul` の終了コードから読み取り可否を判定する（C1/b 対応の
 * `--acl-audit`）。SB-1a-1.1 時点は「読めなかった」と「対象が存在しない」が exit=1 で
 * 区別できなかった（両方「期待どおり読めていない」にしか見えなかった）既存の制約を、
 * 2 点で補強する:
 *   1. 対象は Agent 側で存在確認できたものだけに絞る（`targetExists=false` なら未確認）
 *   2. 対照（プロジェクト内の既存ファイル、同じ方法で読む）が読めなければ全体を未確認とする
 *      （「読めない」のが ACL の効果だと言えなくなるため）
 */
export function interpretSandboxFileReadProbe(input: SandboxFileReadProbeInput): SandboxReadProbeInterpretation {
  if (!input.targetExists) {
    return { outcome: 'inconclusive', evidence: '対象ファイルが存在しない（Agent 側で確認済み）ため、読み取り不可を ACL の効果と判定できません。' };
  }
  if (!input.controlReadable) {
    return {
      outcome: 'inconclusive',
      evidence: '対照（プロジェクト内の既存ファイル）が同じ方法で読めなかったため、ACL の効果か切り分けできず全体を未確認とします。',
    };
  }
  if (input.exitCode === 0) {
    return { outcome: 'readable', evidence: '読み取りに成功しました（exit=0）。対照は読めているため ACL の効果ではありません。' };
  }
  if (input.exitCode === 1) {
    return { outcome: 'not-readable', evidence: '読み取りに失敗しました（exit=1）。対象は存在し対照は読めているため ACL による拒否と判定します。' };
  }
  return { outcome: 'inconclusive', evidence: `未知の結果です（exit=${input.exitCode ?? 'null'}）。` };
}
