/**
 * サイクルP1: Capability 配布設定の検証 + スイープ判定（純粋ロジック、外部 import ゼロ）
 *
 * `running-code-stale.ts`（#354）と同じ流儀: 型・ロジックのみで DB/WS/CLI に一切触れない。
 * provider（AI ベンダー識別子）/ kind（plugin/skill/mcp）固有の意味づけは一切行わない。
 * 「JSON の形が正しいか」と「このマシンに同期を送るべきか」だけを判定する。
 */

/** Capability 配布設定における provider 単位の設定（例: あるベンダーの marketplace 情報） */
export interface CapabilityConfigProviderConfig {
  marketplaceName: string;
  marketplaceSource: string;
}

/** Capability 配布設定の正規形（`Machine.capabilityConfig` に保存する JSON の形） */
export interface CapabilityConfigShape {
  providers: Record<string, CapabilityConfigProviderConfig>;
  items: Array<{ provider: string; kind: string; id: string }>;
}

export type ValidateCapabilityConfigResult =
  | { valid: true; config: CapabilityConfigShape | null }
  | { valid: false; error: string };

/**
 * PUT リクエストボディを検証する（純粋関数）。
 * null/undefined は「機能 OFF」として許可する。形が崩れている場合のみ invalid を返す。
 * provider/kind/id の値そのものは意味を問わず不透明な文字列として扱う。
 */
export function validateCapabilityConfigInput(input: unknown): ValidateCapabilityConfigResult {
  if (input === null || input === undefined) {
    return { valid: true, config: null };
  }
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, error: 'capabilityConfig must be an object or null' };
  }
  const obj = input as Record<string, unknown>;

  const providersRaw = obj.providers;
  if (providersRaw !== undefined && (typeof providersRaw !== 'object' || providersRaw === null || Array.isArray(providersRaw))) {
    return { valid: false, error: 'providers must be an object' };
  }
  const providers: Record<string, CapabilityConfigProviderConfig> = {};
  if (providersRaw) {
    for (const [key, value] of Object.entries(providersRaw as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return { valid: false, error: `providers.${key} must be an object` };
      }
      const v = value as Record<string, unknown>;
      if (typeof v.marketplaceName !== 'string' || v.marketplaceName.trim() === '') {
        return { valid: false, error: `providers.${key}.marketplaceName must be a non-empty string` };
      }
      if (typeof v.marketplaceSource !== 'string' || v.marketplaceSource.trim() === '') {
        return { valid: false, error: `providers.${key}.marketplaceSource must be a non-empty string` };
      }
      providers[key] = { marketplaceName: v.marketplaceName, marketplaceSource: v.marketplaceSource };
    }
  }

  const itemsRaw = obj.items;
  if (itemsRaw !== undefined && !Array.isArray(itemsRaw)) {
    return { valid: false, error: 'items must be an array' };
  }
  const items: Array<{ provider: string; kind: string; id: string }> = [];
  if (itemsRaw) {
    for (let i = 0; i < itemsRaw.length; i++) {
      const item = itemsRaw[i];
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        return { valid: false, error: `items[${i}] must be an object` };
      }
      const it = item as Record<string, unknown>;
      if (typeof it.provider !== 'string' || it.provider.trim() === '') {
        return { valid: false, error: `items[${i}].provider must be a non-empty string` };
      }
      if (typeof it.kind !== 'string' || it.kind.trim() === '') {
        return { valid: false, error: `items[${i}].kind must be a non-empty string` };
      }
      if (typeof it.id !== 'string' || it.id.trim() === '') {
        return { valid: false, error: `items[${i}].id must be a non-empty string` };
      }
      items.push({ provider: it.provider, kind: it.kind, id: it.id });
    }
  }

  return { valid: true, config: { providers, items } };
}

export interface SweepDecisionInput {
  /** DB に保存されている capabilityConfig（null なら未設定） */
  capabilityConfig: unknown;
  /** auto-updater.ts の isMachineBusy() を流用した busy 判定 */
  busy: boolean;
}

export type SweepDecision =
  | { action: 'sync'; reason: string }
  | { action: 'skip'; reason: string };

/**
 * 定期スイープでこのマシンに `server:capability:sync` を送るべきか判定する（純粋関数）。
 * capabilityConfig が null/未設定なら機能 OFF としてスキップ、busy なら作業の邪魔をしないためスキップ。
 * bake/cooldown/試行回数上限は自動更新（auto-updater.ts）固有の概念のためここには持ち込まない。
 */
export function decideSweepAction(input: SweepDecisionInput): SweepDecision {
  if (input.capabilityConfig === null || input.capabilityConfig === undefined) {
    return { action: 'skip', reason: 'capabilityConfig not set' };
  }
  if (input.busy) {
    return { action: 'skip', reason: 'busy' };
  }
  return { action: 'sync', reason: 'ok' };
}
