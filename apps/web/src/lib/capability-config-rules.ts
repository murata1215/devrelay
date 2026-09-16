/**
 * サイクルP1: Capability 配布基盤の Web UI ↔ `CapabilityConfig` 変換ロジック（外部 import ゼロの純関数）。
 * `MachinesPage.tsx`（フォーム状態の保持・保存ボタン等の I/O）から呼ばれる。
 *
 * v1 で UI が編集できるのは `providers.claude`（Marketplace name/source + plugin id タグ入力）だけ。
 * Provider 選択 UI（Claude/Codex/Devin）は置かない。将来 provider が増えたときはこのファイルに
 * 変換関数を追加するだけで済む構造にする（Server/DB/WS には手を入れない）。
 *
 * サイクルP3-B §5-1/§5-7: `devin:skill` provider opt-in（チェックボックス）は廃止した。
 * 索引宣言（`providers.claude`）を単一情報源として流用し、plugin id を 1 つ登録すれば
 * `claude:plugin`（Claude Code には plugin として）と `agent-skills:standard`
 * （Devin/Codex 等には Agent Skills 標準として）の items を**常に両方**生成する。
 * ツール別の opt-in チェックボックスという UI 概念自体が無くなったため、
 * `CapabilityConfigFormState.distributeToDevin` は削除した（型ごと廃止）。
 *
 * サイクルP3-C（T4）: `CapabilityConfigLike.providers.devin`（@deprecated 型）を削除した。
 * DB に残りうる旧 `providers.devin` キーは `SELECT ... WHERE "capabilityConfig"::text LIKE '%"devin"%'`
 * で 0 rows を確認済み。万一残っていても `capabilityConfigToFormState()` は元々 `providers.claude` と
 * `{provider:'claude',kind:'plugin'}` の item しか見ないため、型を削除しても実害はない。
 * 旧 `items[].provider==='devin'` （legacy items）側は本ファイルとは別経路で、Agent 側
 * `agents/linux/src/services/capability-rules.ts` の `normalizeCapabilityItems()` が吸収する
 * （型ではなく値でキーしているため、この型削除の影響を受けない）。
 */

/** UI フォームが保持する編集対象の状態（Claude セクションのみ） */
export interface CapabilityConfigFormState {
  marketplaceName: string;
  marketplaceSource: string;
  /** bare 名（例: 'unity'）の配列。表示時は `${id}@${marketplaceName}` に補完する */
  pluginIds: string[];
}

/** `capabilityConfig`（Server 保存形）の最小形（`@devrelay/shared` の `CapabilityConfig` と構造互換） */
export interface CapabilityConfigLike {
  providers: {
    claude?: { marketplaceName: string; marketplaceSource: string };
  };
  items: Array<{ provider: string; kind: string; id: string }>;
}

/** 空文字列を trim して除外した非空文字列だけを残す */
function nonEmptyTrimmed(values: string[]): string[] {
  return values.map(v => v.trim()).filter(v => v.length > 0);
}

/**
 * サーバー保存済みの `capabilityConfig`（null = 未設定）を UI フォーム初期値に変換する。
 * pluginIds の抽出元は `{provider:'claude',kind:'plugin'}` の item のみ（`agent-skills:standard` 側は
 * 同じ id が並行して入っているだけなので二重カウントしない。旧 `devin:skill` item も無視する）。
 */
export function capabilityConfigToFormState(config: CapabilityConfigLike | null): CapabilityConfigFormState {
  if (!config) {
    return { marketplaceName: '', marketplaceSource: '', pluginIds: [] };
  }
  const claude = config.providers.claude;
  const pluginIds = config.items
    .filter(item => item.provider === 'claude' && item.kind === 'plugin')
    .map(item => item.id);
  return {
    marketplaceName: claude?.marketplaceName ?? '',
    marketplaceSource: claude?.marketplaceSource ?? '',
    pluginIds,
  };
}

/** `validateCapabilityForm` が保存を拒否した理由（UI 文言はここに持たず MachinesPage.tsx 側で JSX にマップする） */
export type CapabilityFormErrorCode =
  | 'marketplace-name-required'
  | 'marketplace-source-required'
  | 'marketplace-required-for-plugins';

export type CapabilityFormValidation =
  | { ok: true; config: CapabilityConfigLike | null }
  | { ok: false; error: CapabilityFormErrorCode };

/**
 * UI フォーム状態を保存用の `CapabilityConfig` に変換する（検証つき）。
 * P1.1: marketplaceName/marketplaceSource が両方揃っていれば pluginIds が空でも有効な設定として保存する
 * （marketplace の登録だけ先に済ませ、plugin は後から追加する運用を想定）。
 * marketplaceName/marketplaceSource の片方だけが入力されている状態、または
 * pluginIds はあるのに marketplace が両方とも空の状態は、中途半端な設定として保存せず invalid を返す。
 * 3 つとも空なら「未設定」= `null`（機能 OFF、既存設定のクリア）として有効に扱う。
 *
 * サイクルP3-B §5-1/§5-7: `pluginIds` から `claude:plugin` と `agent-skills:standard` の items を
 * **常に両方**生成する（ツール別 opt-in は廃止）。`providers` に生成するのは `claude` のみ
 * （索引宣言は `providers.claude` を単一情報源として流用し、`providers.devin`/`providers['agent-skills']`
 * のような provider 別チェックボックスは復活させない＝ server 側 `capability-config-rules.ts` の
 * 「provider ごとに marketplaceName/marketplaceSource を必須にする」検証を一切変更せずに済む）。
 */
export function validateCapabilityForm(state: CapabilityConfigFormState): CapabilityFormValidation {
  const marketplaceName = state.marketplaceName.trim();
  const marketplaceSource = state.marketplaceSource.trim();
  const pluginIds = nonEmptyTrimmed(state.pluginIds);

  if (!marketplaceName && !marketplaceSource && pluginIds.length === 0) {
    return { ok: true, config: null };
  }
  if (marketplaceName && !marketplaceSource) {
    return { ok: false, error: 'marketplace-source-required' };
  }
  if (!marketplaceName && marketplaceSource) {
    return { ok: false, error: 'marketplace-name-required' };
  }
  if (!marketplaceName && !marketplaceSource) {
    // pluginIds.length > 0 はここまでの分岐で確定（上の全空チェックで弾かれているため）
    return { ok: false, error: 'marketplace-required-for-plugins' };
  }

  return {
    ok: true,
    config: {
      providers: {
        claude: { marketplaceName, marketplaceSource },
      },
      items: [
        ...pluginIds.map(id => ({ provider: 'claude', kind: 'plugin', id })),
        ...pluginIds.map(id => ({ provider: 'agent-skills', kind: 'standard', id })),
      ],
    },
  };
}

/** タグ表示用に bare 名へ marketplace 修飾子を補完する（例: 'unity' → 'unity@devrelay'） */
export function formatPluginTag(id: string, marketplaceName: string): string {
  if (!marketplaceName) return id;
  const suffix = `@${marketplaceName}`;
  // サイクルP3-B §5-9(b): 既に `@<marketplaceName>` で終わっていれば二重に付与しない
  return id.endsWith(suffix) ? id : `${id}${suffix}`;
}

/** `normalizePluginIdInput` の結果（`ok:false` の reason で UI の警告文言を出し分ける） */
export type NormalizePluginIdResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'empty' | 'duplicate' };

/**
 * サイクルP3-B §5-9(a): plugin id 追加欄からの生入力を正規化する（web 入力時の多重防御・第1段）。
 * 1. trim
 * 2. 末尾が `@<marketplaceName>` なら 1 回だけ剥がして bare id 化する（`context7@devrelay` → `context7`）
 * 3. 剥がした結果が空なら `reason:'empty'` で reject
 * 4. `existingIds`（現在のタグ一覧）に既に同じ bare id があれば `reason:'duplicate'` で reject（追加しない）
 *
 * 既に DB に入ってしまっている二重サフィックス値（`foo@mp@mp`）はここでは救わない（末尾一致は1回だけ剥がす
 * ため素通りする）。それは表示側 `formatPluginTag` と Agent 側 `buildQualifiedPluginId` の多重防御で吸収する。
 */
export function normalizePluginIdInput(
  raw: string,
  marketplaceName: string,
  existingIds: string[] = [],
): NormalizePluginIdResult {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: 'empty' };

  const suffix = marketplaceName.trim() ? `@${marketplaceName.trim()}` : '';
  const stripped = suffix && trimmed.endsWith(suffix) ? trimmed.slice(0, -suffix.length).trim() : trimmed;
  if (!stripped) return { ok: false, reason: 'empty' };

  if (existingIds.includes(stripped)) return { ok: false, reason: 'duplicate' };
  return { ok: true, id: stripped };
}

// -----------------------------------------------------------------------------
// 同期ステータス表示（Auto Update の「最終自動更新」行と同じ流儀）
// -----------------------------------------------------------------------------

/**
 * サイクルP3-C（T2）: `agent-skills-rules.ts` の `buildDesiredSkillPlan()` が skill を持たないプラグインに
 * 対して `present` へ積む `<pluginId>:no-skills` エントリの接尾辞。payload の形は一切変えず、
 * web 側でこの接尾辞を目印に「通常 present」と「skill なし」を分離する。
 */
export const NO_SKILLS_SUFFIX = ':no-skills';

/**
 * `present` 配列（Agent 由来の未検証 JSON 要素）を「通常の present id」と「`:no-skills` の plugin id」に
 * 分解する（純関数・fail-open）。文字列でない要素は `normalizeCapabilityResults` と同じ方針で捨てる。
 * skill id は `<pluginId>/<skillName>` 形式で区切りが `/` のため、`:no-skills` の末尾一致は誤爆しない。
 */
export function partitionPresentIds(present: unknown[]): { present: string[]; noSkills: string[] } {
  const presentIds: string[] = [];
  const noSkills: string[] = [];
  for (const item of present) {
    if (typeof item !== 'string') continue;
    if (item.endsWith(NO_SKILLS_SUFFIX)) {
      noSkills.push(item.slice(0, -NO_SKILLS_SUFFIX.length));
    } else {
      presentIds.push(item);
    }
  }
  return { present: presentIds, noSkills };
}

/** provider×kind 1 組ぶんの reconcile 結果（`@devrelay/shared` の `CapabilityResult` と構造互換） */
export interface CapabilityResultLike {
  provider: string;
  kind: string;
  runtimeVersion: string | null;
  installed: string[];
  updated: string[];
  present: string[];
  failed: Array<{ id: string; reason: string }>;
  notAllowed: string[];
  /**
   * 撤去した管理下 ID（純加算・非空のときだけ存在）。
   * サイクルP3-B §5-4/§4: `agent-skills:standard` の legacy 回収分は `legacy:<pluginId>/<skillName>` の
   * prefix 付きで載る（新配布先からの削除と区別できるようにする。集計上は removedCount に合算する）。
   */
  removed?: string[];
}

/** `Machine.capabilitySyncStatus`（保存形）の最小形 */
export interface CapabilitySyncStatusLike {
  status: 'done' | 'error' | 'skipped';
  results: CapabilityResultLike[];
  durationMs: number;
  trigger: string;
  receivedAt: string;
}

/**
 * P1.1: `status.status` が 'skipped'/'error' の場合も 0 件表示と区別できるよう種別を分ける。
 * - 'skipped-no-config': capabilityConfig 自体が未保存（Web 側で保存前と判定できる場合）
 * - 'skipped-agent-stale': 設定は保存済みだが Agent にまだ届いていない（Sync now 待ち・再接続待ち）
 * - 'error': reconcile 中にいずれかの provider が failed を出した
 */
export type SyncStatusDisplayKind =
  | 'unsynced-unsupported'
  | 'unsynced'
  | 'skipped-no-config'
  | 'skipped-agent-stale'
  | 'error'
  | 'synced';

/** error 表示時に列挙する failed 明細の上限件数（超過分は summary.failedCount との差分で「ほか n 件」表示） */
export const MAX_FAILURE_DETAILS = 5;

export interface SyncStatusDisplay {
  kind: SyncStatusDisplayKind;
  /** kind==='skipped-*'|'error'|'synced' のときだけ埋まる集計値 */
  summary?: {
    receivedAt: string;
    installedCount: number;
    updatedCount: number;
    /**
     * サイクルP3-B §5-10: 「配布されたのか present（既に配布済みで無変更）なのか」を区別できるようにする。
     * サイクルP3-C（T2）: `<pluginId>:no-skills`（skill を持たないプラグイン）は除いた実 present 件数。
     * 従来の合計値が欲しい場合は `presentCount + noSkillsCount` を参照する（仕様書 §9 参照）。
     */
    presentCount: number;
    /** サイクルP3-C（T2）: skill を持たないプラグインの件数（`present` から分離した内訳） */
    noSkillsCount: number;
    failedCount: number;
    notAllowedCount: number;
    /** サイクルP3-B §5-10: legacy 回収分も含めた撤去件数（prefix 付きの詳細は perProvider/results 側で見る） */
    removedCount: number;
    trigger: string;
  };
  /** kind==='error' のときだけ埋まる failed 明細（最大 MAX_FAILURE_DETAILS 件。総数は summary.failedCount） */
  failures?: Array<{ id: string; reason: string }>;
  /**
   * kind==='synced' かつ results が空（配布対象ゼロ）のときだけ true。他の場合はキー自体を生やさない。
   * サイクルP1.2以降: Agent 側は `providers.<provider>` が設定されていれば items が 0 件でも
   * marketplace 登録/update までは行い `results.length` が 1 以上になるため、`emptyTargets` が立つのは
   * 「有効な provider 設定自体が無い（配布設定が実質空）」場合のみになる。P1.1 時点の意味
   * （＝「Plugin 未指定」）とは異なる点に注意（MachinesPage.tsx の文言もこれに合わせて更新済み）。
   */
  emptyTargets?: true;
  /**
   * `results.length >= 1` のときに生やす provider 別の内訳。
   * サイクルP3-B §5-10: 従来は `results.length > 1` のときだけだったが、provider が
   * 常に 2 つ（`claude:plugin` + `agent-skills:standard`）になったため 1 件でも出すよう条件を撤去した
   * （cleanup-only 等で results が 1 件だけになる応答でも breakdown を隠さない）。
   */
  perProvider?: Array<{
    provider: string;
    kind: string;
    installedCount: number;
    updatedCount: number;
    /** サイクルP3-C（T2）: `<pluginId>:no-skills` を除いた実 present 件数（summary.presentCount と同じ方針） */
    presentCount: number;
    /** サイクルP3-C（T2）: この provider×kind で skill を持たなかったプラグインの件数 */
    noSkillsCount: number;
    /** サイクルP3-C（T2）: skill を持たなかったプラグイン id 一覧（非空のときだけキーを生やす） */
    noSkillsIds?: string[];
    failedCount: number;
    notAllowedCount: number;
    removedCount: number;
    /**
     * サイクルP3-B §5-6/§5-10: 配布判断には一切影響しない診断専用の文字列（例:
     * `"Devin 3000.6.7 検出 / Codex 設定なし"`）。`runtimeVersion` が null の provider は undefined。
     */
    runtimeDiagnostics?: string;
  }>;
}

/**
 * `status.results`（Agent 由来の未検証 JSON。`Machine.capabilitySyncStatus` は Server が
 * 無検証で保存する `Json?`）を安全な配列に正規化する（純関数・fail-open）。
 * - `results` 自体が配列でなければ `[]` とみなす。
 * - 各要素の `installed`/`updated`/`present`/`failed`/`notAllowed` が配列でなければ `[]` として扱う
 *   （`removed` は元々 optional 扱いなので、配列であるときだけキーを残す）。
 * - `provider`/`kind` が string でなければ `''` にフォールバックする（要素自体は捨てない。捨てると
 *   provider 別内訳と results の対応関係が崩れるため）。
 * ここは承認カードのような安全性判断には使われないただの表示用集計なので fail-open が正しい選択
 * （壊れていても「0 件」として表示を継続し、`machine-display-rules.ts` の Error Boundary 到達を待たず
 * 画面を落とさないことを優先する）。
 */
function normalizeCapabilityResults(results: unknown): CapabilityResultLike[] {
  if (!Array.isArray(results)) return [];
  return results.map((r): CapabilityResultLike => {
    const obj = r !== null && typeof r === 'object' ? (r as Record<string, unknown>) : {};
    return {
      provider: typeof obj.provider === 'string' ? obj.provider : '',
      kind: typeof obj.kind === 'string' ? obj.kind : '',
      runtimeVersion: typeof obj.runtimeVersion === 'string' ? obj.runtimeVersion : null,
      installed: Array.isArray(obj.installed) ? (obj.installed as string[]) : [],
      updated: Array.isArray(obj.updated) ? (obj.updated as string[]) : [],
      present: Array.isArray(obj.present) ? (obj.present as string[]) : [],
      failed: Array.isArray(obj.failed) ? (obj.failed as Array<{ id: string; reason: string }>) : [],
      notAllowed: Array.isArray(obj.notAllowed) ? (obj.notAllowed as string[]) : [],
      ...(Array.isArray(obj.removed) ? { removed: obj.removed as string[] } : {}),
    };
  });
}

/**
 * provider 別の内訳配列を作る（純関数）。`results` が 0 件のときだけ undefined。
 */
function buildPerProviderBreakdown(results: CapabilityResultLike[]): SyncStatusDisplay['perProvider'] {
  if (results.length === 0) return undefined;
  return results.map(r => {
    const { present, noSkills } = partitionPresentIds(r.present);
    return {
      provider: r.provider,
      kind: r.kind,
      installedCount: r.installed.length,
      updatedCount: r.updated.length,
      presentCount: present.length,
      noSkillsCount: noSkills.length,
      ...(noSkills.length > 0 ? { noSkillsIds: noSkills } : {}),
      failedCount: r.failed.length,
      notAllowedCount: r.notAllowed.length,
      removedCount: r.removed?.length ?? 0,
      ...(r.runtimeVersion ? { runtimeDiagnostics: r.runtimeVersion } : {}),
    };
  });
}

/**
 * `capabilitySyncStatus` の表示区分を決める（純関数）。
 * - `capabilitySyncStatus` が null かつ Agent が capability-sync 未対応 → 「未同期（Agent 更新が必要）」
 * - null だが対応済み（まだ 1 回も reconcile していないだけ）→ 「未同期」
 * - status.status==='skipped' → savedConfigPresent で「未保存」か「Agent 未反映」かを分ける
 *   （savedConfigPresent が null＝判定不能なときは fail-open で 'skipped-agent-stale' 扱いにする）
 * - status.status==='error' → 集計値 + failed 明細（最大 MAX_FAILURE_DETAILS 件）を返す
 * - それ以外（'done'）→ 集計して 'synced'。results が空なら emptyTargets を立てる
 * @param capabilitySyncSupported Agent が 'capability-sync' capability を申告しているか（null = 判定不能。offline 等）
 * @param savedConfigPresent capabilityConfig が現在 DB に保存されているか（省略・null は判定不能）
 */
export function decideSyncStatusDisplay(
  status: CapabilitySyncStatusLike | null,
  capabilitySyncSupported: boolean | null,
  savedConfigPresent: boolean | null = null,
): SyncStatusDisplay {
  if (!status) {
    return { kind: capabilitySyncSupported === false ? 'unsynced-unsupported' : 'unsynced' };
  }
  // status.results/receivedAt は Agent 由来の未検証 JSON なので、ここで一度正規化してから使う
  // （fail-open: 壊れていても 0 件集計として表示を継続する）
  const results = normalizeCapabilityResults(status.results);
  const installedCount = results.reduce((sum, r) => sum + r.installed.length, 0);
  const updatedCount = results.reduce((sum, r) => sum + r.updated.length, 0);
  // サイクルP3-C（T2）: `<pluginId>:no-skills` を分離した実 present 件数 + skill なし件数。
  // 合計は従来の `present.length` の総和と一致する（仕様書 §9: presentCount + noSkillsCount = 従来の present 総数）。
  const partitioned = results.map(r => partitionPresentIds(r.present));
  const presentCount = partitioned.reduce((sum, p) => sum + p.present.length, 0);
  const noSkillsCount = partitioned.reduce((sum, p) => sum + p.noSkills.length, 0);
  const failedCount = results.reduce((sum, r) => sum + r.failed.length, 0);
  const notAllowedCount = results.reduce((sum, r) => sum + r.notAllowed.length, 0);
  const removedCount = results.reduce((sum, r) => sum + (r.removed?.length ?? 0), 0);
  const summary = {
    receivedAt: typeof status.receivedAt === 'string' ? status.receivedAt : '',
    installedCount,
    updatedCount,
    presentCount,
    noSkillsCount,
    failedCount,
    notAllowedCount,
    removedCount,
    trigger: status.trigger,
  };
  const perProvider = buildPerProviderBreakdown(results);

  if (status.status === 'skipped') {
    return {
      kind: savedConfigPresent === false ? 'skipped-no-config' : 'skipped-agent-stale',
      summary,
      ...(perProvider ? { perProvider } : {}),
    };
  }
  if (status.status === 'error') {
    const failures = results.flatMap(r => r.failed);
    return {
      kind: 'error',
      summary,
      failures: failures.slice(0, MAX_FAILURE_DETAILS),
      ...(perProvider ? { perProvider } : {}),
    };
  }
  return {
    kind: 'synced',
    summary,
    ...(results.length === 0 ? { emptyTargets: true as const } : {}),
    ...(perProvider ? { perProvider } : {}),
  };
}
