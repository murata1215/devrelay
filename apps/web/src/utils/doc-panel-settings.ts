/**
 * チャット右側パネル（DocPanel: Approvals / Docs / Issues / Plan）の
 * タブごとの表示 ON/OFF を管理するユーティリティ。
 * - localStorage に JSON で永続化
 * - デフォルトは全 OFF（=「オプションで指定された時だけ表示」）
 * - 全タブ OFF の場合はパネル自体を非表示にする
 */

const STORAGE_KEY = 'devrelay-doc-panel-tabs';

/** 設定変更を ChatPage（常時マウント）へ即時通知するためのカスタムイベント名 */
export const DOC_PANEL_SETTINGS_EVENT = 'devrelay-doc-panel-settings-changed';

/** DocPanel の各タブの表示可否 */
export interface DocPanelSettings {
  approvals: boolean;
  docs: boolean;
  issues: boolean;
  plan: boolean;
}

/** デフォルト設定（全 OFF） */
const DEFAULT_SETTINGS: DocPanelSettings = {
  approvals: false,
  docs: false,
  issues: false,
  plan: false,
};

/** DocPanel の表示設定を取得する（未保存時は全 OFF） */
export function getDocPanelSettings(): DocPanelSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        approvals: !!parsed.approvals,
        docs: !!parsed.docs,
        issues: !!parsed.issues,
        plan: !!parsed.plan,
      };
    }
  } catch {
    /* 破損時はデフォルトへフォールバック */
  }
  return { ...DEFAULT_SETTINGS };
}

/** DocPanel の表示設定を保存し、変更イベントを発火する */
export function setDocPanelSettings(settings: DocPanelSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  // ChatPage は常時マウントのため、Settings 変更を即時反映するにはイベント通知が必要
  window.dispatchEvent(new CustomEvent(DOC_PANEL_SETTINGS_EVENT));
}

/** いずれかのタブが有効か（false ならパネルごと非表示） */
export function isAnyDocPanelTabEnabled(settings: DocPanelSettings): boolean {
  return settings.approvals || settings.docs || settings.issues || settings.plan;
}
