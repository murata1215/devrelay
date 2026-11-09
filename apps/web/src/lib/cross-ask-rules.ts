/**
 * クロスユーザー Team Phase C（購読/借用プロジェクトを Agents ツリーに出し、質問専用タブとして
 * 開く機能）の純粋関数群。外部 import ゼロ（`cross-team-publish-rules.ts` / `thread-routing-client.ts`
 * と同じ流儀）。
 *
 * **肝**: クロスタブは `//connect` を一切送らない（`shouldSendConnect()`）。既存タブ（`kind`
 * 未定義）は常に true を返すため、`//connect` を送信する 5 箇所にこの関数を経由させるだけで
 * 既存の挙動を 1 バイトも変えずにクロスタブだけをガードできる。
 */

/** `cross-ask-rules.ts` が扱う最小限のタブ形（`ChatPage.tsx` の `Tab` のうち判定に必要な部分だけ）。 */
export interface CrossAskTabLike {
  kind?: 'own' | 'cross';
}

/** クロス専用タブ（購読/借用プロジェクトの質問タブ）かどうかを判定する。 */
export function isCrossTab(tab: CrossAskTabLike | null | undefined): boolean {
  return tab?.kind === 'cross';
}

/**
 * `sendCommand('//connect <projectId>')` を送ってよいかどうかを判定する。
 * `kind` 未定義（= 既存タブ）は常に true（挙動不変の互換境界）。`kind === 'cross'` のみ false。
 */
export function shouldSendConnect(tab: CrossAskTabLike | null | undefined): boolean {
  return !isCrossTab(tab);
}

/** `decideComposerCapabilities()` の戻り値。クロスタブで無効化する操作をまとめて返す。 */
export interface ComposerCapabilities {
  allowFiles: boolean;
  allowCancel: boolean;
  allowExec: boolean;
  allowThreadList: boolean;
}

const OWN_TAB_CAPABILITIES: ComposerCapabilities = {
  allowFiles: true,
  allowCancel: true,
  allowExec: true,
  allowThreadList: true,
};

const CROSS_TAB_CAPABILITIES: ComposerCapabilities = {
  allowFiles: false,
  allowCancel: false,
  allowExec: false,
  allowThreadList: false,
};

/** タブの種別から、入力欄・停止ボタン・スレッド一覧等の有効/無効をまとめて判定する。 */
export function decideComposerCapabilities(tab: CrossAskTabLike | null | undefined): ComposerCapabilities {
  return isCrossTab(tab) ? CROSS_TAB_CAPABILITIES : OWN_TAB_CAPABILITIES;
}

/** クロスタブのヘッダに出す常時バナー文言を組み立てる。 */
export function buildCrossTabBanner(ownerLabel: string): string {
  return `🔗 ${ownerLabel} さんのプロジェクト（質問のみ・相手の契約で実行・やり取りは相手側にも保存されます）`;
}

/** クロスタブの行末バッジ文言（ツリー表示用）。 */
export function buildCrossTabBadge(origin: 'invite' | 'subscription'): string {
  return origin === 'subscription' ? '購読' : '借用';
}

/** `GET /api/cross-team/ask-targets` のレスポンス 1 プロジェクト分（API の形をそのまま使う）。 */
export interface CrossAskApiProject {
  projectId: string;
  label: string;
  teamId: string;
  teamName: string;
  origin: 'invite' | 'subscription';
  execAllowed: false;
}

export interface CrossAskApiMachineGroup {
  machineId: string;
  machineName: string;
  status: 'online' | 'offline';
  projects: CrossAskApiProject[];
}

export interface CrossAskApiOwnerGroup {
  ownerLabel: string;
  machines: CrossAskApiMachineGroup[];
}

/** ツリー行 1 件（クリック可否込み）。`buildCrossAskTreeRows()` が返す表示用の平坦なリスト。 */
export interface CrossAskTreeProjectRow {
  projectId: string;
  label: string;
  ownerLabel: string;
  machineName: string;
  teamName: string;
  origin: 'invite' | 'subscription';
  online: boolean;
}

/** クロスタブの履歴取得元（常に `GET /api/cross-team/projects/:id/messages`）。
 *  `resolveHistorySource()`（`thread-routing-client.ts`）とは独立した関数にする
 *  （自分のタブ用の分岐に `cross` ケースを足すと、`resolveOlderMessagesSource` /
 *  `isSameHistorySource` / `pickOlderCursorId` と既存テストに波及するため）。 */
export interface CrossHistorySource {
  kind: 'cross';
  projectId: string;
}

export function resolveCrossHistorySource(tab: { projectId: string }): CrossHistorySource {
  return { kind: 'cross', projectId: tab.projectId };
}

/** owner → machine → project のグループ構造を、ツリー描画用の平坦な行リストに変換する（表示順は API 側で確定済みのため並べ替えはしない）。 */
export function flattenCrossAskGroups(groups: CrossAskApiOwnerGroup[]): CrossAskTreeProjectRow[] {
  const rows: CrossAskTreeProjectRow[] = [];
  for (const owner of groups) {
    for (const machine of owner.machines) {
      for (const project of machine.projects) {
        rows.push({
          projectId: project.projectId,
          label: project.label,
          ownerLabel: owner.ownerLabel,
          machineName: machine.machineName,
          teamName: project.teamName,
          origin: project.origin,
          online: machine.status === 'online',
        });
      }
    }
  }
  return rows;
}
