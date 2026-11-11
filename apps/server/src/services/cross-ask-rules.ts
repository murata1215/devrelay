/**
 * クロスユーザー Team Phase C（購読/借用プロジェクトを Agents ツリーに出し WebUI から直接
 * ask する機能）の純関数群。外部 import ゼロ（`cross-team-guard.ts` / `cross-team-publish.ts`
 * と同じ流儀。DB・env は一切見ない。呼び出し側の DB ラッパ（`routes/api.ts` /
 * `services/cross-ask-runner.ts`）が行を集めてここに渡す）。
 */

/**
 * サイクルC3a-1: `GET /api/cross-team/ask-targets` の project 行に足す記憶状態
 * （`DEVRELAY_CROSS_ASK_RESET` が OFF のときはキーごと省略 — 旧レスポンスと構造同一にするため、
 * 呼び出し側は `memory` プロパティ自体を付けないこと。`undefined` を明示的にセットしても
 * JSON.stringify で落ちるが、構造的な一貫性のため型も optional にしておく）。
 */
export interface CrossAskTargetMemory {
  /** resume が効く見込み（宛先が覚えている） */
  remembers: boolean;
  reason?: 'featureOff' | 'isolationOff' | 'agentOutdated' | 'aiUnsafe';
  /** false = 質問自体が G の隔離判定で断られる見込み */
  askable: boolean;
  askDenyReason?: 'agent_outdated' | 'ai_unsafe';
  /** 現世代の往復数（Session 行数）。世代が無ければ 0 */
  turns?: number;
  /** `DEVRELAY_CROSS_ASK_RESUME_MAX_TURNS` の解決値（自動リセットの目安） */
  maxTurns?: number;
}

/** `buildCrossAskTargetGroups()` が受け取る 1 行（フラット。呼び出し側が DB から組み立てる）。 */
export interface CrossAskTargetRow {
  ownerLabel: string;
  machineId: string;
  machineName: string;
  /** `getConnectedAgents()` 等、DB 値ではなく実接続状態を渡すこと（`GET /api/machines` と同じ根拠に揃える） */
  status: 'online' | 'offline';
  projectId: string;
  label: string;
  teamId: string;
  teamName: string;
  origin: 'invite' | 'subscription';
  /** `DEVRELAY_CROSS_ASK_RESET` が OFF のときは省略する（省略時は `CrossAskTargetProject.memory` も省略される） */
  memory?: CrossAskTargetMemory;
}

export interface CrossAskTargetProject {
  projectId: string;
  label: string;
  teamId: string;
  teamName: string;
  origin: 'invite' | 'subscription';
  /** Phase C 時点では常に false（Phase 2 で exec を解禁するまでの型レベルの約束） */
  execAllowed: false;
  memory?: CrossAskTargetMemory;
}

export interface CrossAskTargetMachineGroup {
  machineId: string;
  machineName: string;
  status: 'online' | 'offline';
  projects: CrossAskTargetProject[];
}

export interface CrossAskTargetOwnerGroup {
  ownerLabel: string;
  machines: CrossAskTargetMachineGroup[];
}

/**
 * フラットな行を owner → machine → project の 3 段グループに整形する。
 * - online のマシンを優先、同条件なら名前の昇順
 * - owner も名前の昇順
 * - プロジェクトは label の昇順
 * `execAllowed` は常にリテラル `false` を返す（Phase 2 まで型レベルで固定）。
 */
export function buildCrossAskTargetGroups(rows: CrossAskTargetRow[]): CrossAskTargetOwnerGroup[] {
  const ownerMap = new Map<string, Map<string, CrossAskTargetMachineGroup>>();

  for (const row of rows) {
    let machineMap = ownerMap.get(row.ownerLabel);
    if (!machineMap) {
      machineMap = new Map();
      ownerMap.set(row.ownerLabel, machineMap);
    }
    let machineGroup = machineMap.get(row.machineId);
    if (!machineGroup) {
      machineGroup = { machineId: row.machineId, machineName: row.machineName, status: row.status, projects: [] };
      machineMap.set(row.machineId, machineGroup);
    }
    machineGroup.projects.push({
      projectId: row.projectId,
      label: row.label,
      teamId: row.teamId,
      teamName: row.teamName,
      origin: row.origin,
      execAllowed: false,
      // row.memory が undefined（キルスイッチ OFF）なら、キー自体を付けず旧レスポンスと構造同一にする。
      ...(row.memory ? { memory: row.memory } : {}),
    });
  }

  const owners: CrossAskTargetOwnerGroup[] = [];
  for (const [ownerLabel, machineMap] of ownerMap) {
    const machines = [...machineMap.values()]
      .map((m) => ({ ...m, projects: [...m.projects].sort((a, b) => a.label.localeCompare(b.label)) }))
      .sort((a, b) => {
        if (a.status === 'online' && b.status !== 'online') return -1;
        if (a.status !== 'online' && b.status === 'online') return 1;
        return a.machineName.localeCompare(b.machineName);
      });
    owners.push({ ownerLabel, machines });
  }
  owners.sort((a, b) => a.ownerLabel.localeCompare(b.ownerLabel));
  return owners;
}

/** `origin` を `CrossTeamGrant.id` の採番規約から判定する（`sub:` 始まり = 公開型購読由来）。 */
export function resolveCrossAskOrigin(grantId: string): 'invite' | 'subscription' {
  return grantId.startsWith('sub:') ? 'subscription' : 'invite';
}

/** クロス ask の質問本文に対する最小限の入力検証（空文字のみ拒否。長さ検証は既存の ASK_QUESTION_MAX_LENGTH を別途適用）。 */
export function decideCrossAskInput(input: { text: string }): { ok: true } | { ok: false; error: 'empty' } {
  if (input.text.trim().length === 0) return { ok: false, error: 'empty' };
  return { ok: true };
}

/** `buildCrossAskContextPrefix()` が受け取る過去メッセージ 1 件。 */
export interface CrossAskHistoryMessage {
  role: string;
  content: string;
}

/** 文脈前置のデフォルト文字数上限（既定 6,000 文字。環境変数で調整可能にはしない固定値 v1）。 */
export const CROSS_ASK_CONTEXT_PREFIX_MAX_CHARS = 6000;

/** 文脈前置に含める往復数（直近 N 往復 = user+ai のペア）。 */
export const CROSS_ASK_CONTEXT_PREFIX_TURNS = 3;

/**
 * 直近の往復から「これまでのやりとり（参考）」前置文を組み立てる（案 B: サーバーのみでの
 * 会話継続。Agent 改修なし）。
 *
 * - 直近 `CROSS_ASK_CONTEXT_PREFIX_TURNS` 往復（user→ai のペア）のみを使う
 * - 全体を `maxChars` で truncate する（課金膨張防止。古い方から切り捨てる）
 * - メッセージが無ければ空文字を返す（＝前置なし。呼び出し側はこの場合 fence しない）
 * - 無害化（`neutralizeHumanInputTag` 相当）はここでは行わない。呼び出し側
 *   （`cross-ask-runner.ts`）が各メッセージの content に適用してから渡すこと
 *   （本関数は文字列の整形・truncate のみの責務に留める）
 */
export function buildCrossAskContextPrefix(
  messages: CrossAskHistoryMessage[],
  maxChars: number = CROSS_ASK_CONTEXT_PREFIX_MAX_CHARS,
  turns: number = CROSS_ASK_CONTEXT_PREFIX_TURNS,
): string {
  if (messages.length === 0) return '';

  // 直近 N 往復 = 直近 N*2 件（user, ai が交互に並んでいる前提。並びが崩れていても
  // 単純に末尾 N*2 件を取るだけなので安全側に倒れる）
  const recent = messages.slice(-turns * 2);
  if (recent.length === 0) return '';

  const lines = recent.map((m) => {
    const speaker = m.role === 'user' ? '依頼者' : '回答';
    return `[${speaker}] ${m.content}`;
  });
  let body = lines.join('\n\n');
  if (body.length > maxChars) {
    body = body.slice(body.length - maxChars);
  }

  return `--- これまでのやりとり（参考） ---\n${body}\n--- ここまで ---`;
}
