/**
 * サイクルSB-1b: チャット画面の「Sandbox」トグル（`terminalMode` と同形、Project 単位）が
 * 押せる状態かどうかを判定する純関数（外部 import ゼロ。`thread-switch-rules.ts` /
 * `uninstall-command-rules.ts` と同じ流儀。node:test から dist-test/ を直接 import する）。
 *
 * `GET /api/projects/:id/sandbox` のレスポンス（`{ sandboxEnabled, supported, reason }`）を
 * そのまま渡す想定。`supported` は宛先 Agent が接続中かつ `'sandbox-host'` capability を
 * 申告しているかどうか（サーバー側 `agentHasCapability()` の結果）。
 *
 * 非対応になった後も ON のまま押せなくなる「行き止まり」を作らないため、`sandboxEnabled` が
 * 既に true の場合は `supported` に関わらず押せる状態にする（OFF へはいつでも戻せる）。
 */

export type SandboxToggleReason = 'ok' | 'offline' | 'unsupported';

export interface SandboxToggleState {
  sandboxEnabled: boolean;
  supported: boolean;
  reason: SandboxToggleReason;
}

export interface SandboxToggleDecision {
  /** トグルをクリック可能にしてよいか */
  clickable: boolean;
  /** `title` 属性に出す理由の i18n キー（`clickable:true` のときは通常表示用のキー） */
  titleKey: 'chat.sandboxOn' | 'chat.sandboxOff' | 'chat.sandboxOffline' | 'chat.sandboxUnsupported';
}

/**
 * Sandbox トグルを押せる状態か判定する。
 * - `supported === true` なら常に押せる
 * - `sandboxEnabled === true`（ON のまま非対応になった）なら、OFF へ戻せるよう押せる状態にする
 * - それ以外（OFF かつ非対応）は押せない。`reason` に応じた理由キーを返す
 */
export function decideSandboxToggle(state: SandboxToggleState): SandboxToggleDecision {
  if (state.supported) {
    return { clickable: true, titleKey: state.sandboxEnabled ? 'chat.sandboxOn' : 'chat.sandboxOff' };
  }
  if (state.sandboxEnabled) {
    // 非対応になった後も ON を解除できるようにする（行き止まりを作らない）
    return { clickable: true, titleKey: 'chat.sandboxOn' };
  }
  if (state.reason === 'offline') {
    return { clickable: false, titleKey: 'chat.sandboxOffline' };
  }
  return { clickable: false, titleKey: 'chat.sandboxUnsupported' };
}
