import { useEffect, useState, useCallback } from 'react';
import { sites as sitesApi } from '../lib/api';
import type { SiteRecord, SitesMeta, SiteConfidence, SiteHealthState, SiteStats } from '../lib/api';
import { useLanguage } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n/messages';

/** 一覧テーブルのヘッダー列（i18n キー）。技術列（Phase 1-A）は詳細ドロワーへ移動済み。 */
const TABLE_COLUMNS: TranslationKey[] = [
  'sites.colHost',
  'sites.colHealth',
  'sites.colTodayPv',
  'sites.col7dPv',
  'sites.colTodayUu',
  'sites.colLastAccess',
  'sites.colWarnings',
];

/**
 * DevRelay Sites Phase 1-A/1-B — 公開 site 一覧ページ（システム管理者限定）。
 *
 * Caddy 設定・アクセスログには一切書き込まない。Phase 1-A の値は「確定/条件付き/推測/不明」の
 * 信頼度バッジ付きで出す（サーバー側 `SiteRecord` の Evidence 構造をそのまま反映する）。
 * Phase 1-B のアクセス解析（PV/UU/Referer/UTM/bot/4xx5xx）はアクセスログ導入済み site のみ
 * `stats` が埋まる。未導入・集計未完了時は `stats: null`（一覧では「未計測」表示）。
 */

/** '(other)' に畳まれていない上位 N 件を表示する簡易リスト。 */
function CountList({ entries, emptyLabel }: { entries: { key: string; count: number }[]; emptyLabel: string }) {
  if (entries.length === 0) return <div className="text-[var(--text-faint)] pl-2">{emptyLabel}</div>;
  return (
    <ul className="space-y-0.5 pl-2">
      {entries.slice(0, 8).map((e) => (
        <li key={e.key} className="flex items-center justify-between gap-2 text-xs">
          <span className="font-mono truncate max-w-[70%]" title={e.key}>{e.key}</span>
          <span className="text-[var(--text-faint)]">{e.count.toLocaleString()}</span>
        </li>
      ))}
    </ul>
  );
}

/** 30 日 coverage バッジ（`complete` で表示を切り替え、「30日」を無条件に完全値と誤認させない）。 */
function CoverageBadge({ coverage, t }: { coverage: SiteStats['coverage']; t: (k: TranslationKey) => string }) {
  if (coverage.complete) {
    return (
      <span className="inline-block px-2 py-0.5 rounded text-xs font-medium border bg-green-500/15 text-green-500 border-green-500/30">
        {t('sites.coverageComplete')}
      </span>
    );
  }
  return (
    <span
      className="inline-block px-2 py-0.5 rounded text-xs font-medium border bg-yellow-500/15 text-yellow-600 border-yellow-500/30"
      title={t('sites.coverageTruncatedNote')}
    >
      {t('sites.coverageIncomplete').replace('{days}', String(coverage.coveredDays))}
    </span>
  );
}

/** 直近の daily 配列から、count > 0 の最新日を「Last access」として拾う（day 粒度の近似値）。 */
function lastAccessDate(stats: SiteStats | null): string | null {
  if (!stats) return null;
  for (let i = stats.last30d.daily.length - 1; i >= 0; i--) {
    const d = stats.last30d.daily[i];
    if (d.count !== null && d.count > 0) return d.date;
  }
  return null;
}

/** 信頼度バッジの色分け（緑=確定 / 青=条件付き / 黄=推測 / 灰=不明）。 */
function ConfidenceBadge({ confidence }: { confidence: SiteConfidence }) {
  const styles: Record<SiteConfidence, string> = {
    confirmed: 'bg-green-500/15 text-green-500 border-green-500/30',
    conditional: 'bg-blue-500/15 text-blue-500 border-blue-500/30',
    inferred: 'bg-yellow-500/15 text-yellow-600 border-yellow-500/30',
    unknown: 'bg-gray-500/15 text-gray-400 border-gray-500/30',
  };
  const labels: Record<SiteConfidence, string> = {
    confirmed: '確定',
    conditional: '条件付き',
    inferred: '推測',
    unknown: '不明',
  };
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium border ${styles[confidence]}`}>
      {labels[confidence]}
    </span>
  );
}

/** ヘルス状態のバッジ。 */
function HealthBadge({ state, httpStatus }: { state: SiteHealthState; httpStatus: number | null }) {
  const styles: Record<SiteHealthState, string> = {
    up: 'bg-green-500/15 text-green-500 border-green-500/30',
    degraded: 'bg-yellow-500/15 text-yellow-600 border-yellow-500/30',
    down: 'bg-red-500/15 text-red-500 border-red-500/30',
    unknown: 'bg-gray-500/15 text-gray-400 border-gray-500/30',
  };
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium border ${styles[state]}`}>
      {state}
      {httpStatus !== null ? ` (${httpStatus})` : ''}
    </span>
  );
}

/** warnings の重大度に応じたバッジ（件数のみ。詳細はドロワーで見せる）。 */
function WarningsBadge({ warnings }: { warnings: SiteRecord['warnings'] }) {
  if (warnings.length === 0) return <span className="text-[var(--text-faint)] text-xs">-</span>;
  const hasError = warnings.some((w) => w.severity === 'error');
  const hasWarn = warnings.some((w) => w.severity === 'warn');
  const style = hasError
    ? 'bg-red-500/15 text-red-500 border-red-500/30'
    : hasWarn
      ? 'bg-yellow-500/15 text-yellow-600 border-yellow-500/30'
      : 'bg-gray-500/15 text-gray-400 border-gray-500/30';
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium border ${style}`} title={warnings.map((w) => w.message).join('\n')}>
      {warnings.length}
    </span>
  );
}

/** 詳細ドロワー（1 site の全 Evidence を表示）。 */
function SiteDetailDrawer({ site, onClose, onHealthCheck, checking }: {
  site: SiteRecord;
  onClose: () => void;
  onHealthCheck: () => void;
  checking: boolean;
}) {
  const { t } = useLanguage();
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-[var(--bg-secondary)] rounded-lg p-4 sm:p-6 max-w-2xl w-full mx-4 max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-[var(--text-primary)] break-all">{site.host}</h2>
          <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {site.aliases.length > 0 && (
          <div className="text-xs text-[var(--text-faint)] mb-3">aliases: {site.aliases.join(', ')}</div>
        )}

        <div className="flex items-center gap-3 mb-4 flex-wrap">
          <HealthBadge state={site.health.state} httpStatus={site.health.httpStatus} />
          <span className="text-xs text-[var(--text-faint)]">
            {site.health.checkedAt ? new Date(site.health.checkedAt).toLocaleString() : t('sites.unknown')}
          </span>
          <button
            onClick={onHealthCheck}
            disabled={checking}
            className="ml-auto px-3 py-1 text-xs rounded bg-[var(--bg-tertiary)] hover:bg-[var(--bg-hover)] text-[var(--text-primary)] disabled:opacity-50"
          >
            {checking ? t('sites.checking') : t('sites.checkNow')}
          </button>
        </div>

        <div className="space-y-4 text-sm">
          {/* Phase 1-B: Traffic / 計測メタ / 除外ルール */}
          {site.stats ? (
            <>
              <section>
                <h3 className="text-[var(--text-muted)] text-xs uppercase font-medium mb-1">{t('sites.traffic')}</h3>
                <div className="bg-[var(--bg-tertiary)] rounded p-3 space-y-3">
                  <div className="flex flex-wrap gap-4">
                    <div>
                      <div className="text-[var(--text-faint)] text-xs">{t('sites.today')}</div>
                      <div>
                        {t('sites.pv')} {site.stats.today.pv.toLocaleString()} / {t('sites.uu')}{' '}
                        {site.stats.today.uu !== null ? site.stats.today.uu.toLocaleString() : t('sites.unknown')}
                        {site.stats.today.uuTruncated && <span className="text-[var(--text-faint)]">{'≥'}</span>}
                      </div>
                    </div>
                    <div>
                      <div className="text-[var(--text-faint)] text-xs">{t('sites.last7d')}</div>
                      <div>{t('sites.pv')} {site.stats.last7d.pv.toLocaleString()}</div>
                    </div>
                    <div>
                      <div className="text-[var(--text-faint)] text-xs">{t('sites.last30d')}</div>
                      <div>{t('sites.pv')} {site.stats.last30d.pv.toLocaleString()}</div>
                    </div>
                    <div>
                      <div className="text-[var(--text-faint)] text-xs">{t('sites.status4xx')} / {t('sites.status5xx')}</div>
                      <div>{site.stats.status4xx.toLocaleString()} / {site.stats.status5xx.toLocaleString()}</div>
                    </div>
                    <div>
                      <div className="text-[var(--text-faint)] text-xs">{t('sites.botRatio')}</div>
                      <div>{site.stats.botRatio !== null ? `${(site.stats.botRatio * 100).toFixed(1)}%` : t('sites.unknown')}</div>
                    </div>
                  </div>

                  {/* 30 日日別 PV バー（欠測は薄く描く） */}
                  <div className="flex items-end gap-[1px] h-10">
                    {site.stats.last30d.daily.map((d) => {
                      const max = Math.max(1, ...site.stats!.last30d.daily.map((x) => x.count ?? 0));
                      const heightPct = d.count !== null ? Math.max(4, (d.count / max) * 100) : 0;
                      return (
                        <div
                          key={d.date}
                          title={`${d.date}: ${d.count === null ? t('sites.noData') : d.count.toLocaleString()}`}
                          className={`flex-1 rounded-sm ${d.count === null ? 'bg-[var(--bg-hover)] opacity-30' : 'bg-blue-500/60'}`}
                          style={{ height: `${heightPct}%` }}
                        />
                      );
                    })}
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <div className="text-[var(--text-faint)] text-xs mb-1">{t('sites.topPaths')}</div>
                      <CountList entries={site.stats.topPaths} emptyLabel={t('sites.noData')} />
                    </div>
                    <div>
                      <div className="text-[var(--text-faint)] text-xs mb-1">{t('sites.referers')}</div>
                      <CountList entries={site.stats.referers} emptyLabel={t('sites.noData')} />
                    </div>
                  </div>
                  {(site.stats.utm.source.length > 0 || site.stats.utm.medium.length > 0 || site.stats.utm.campaign.length > 0) && (
                    <div>
                      <div className="text-[var(--text-faint)] text-xs mb-1">{t('sites.utm')}</div>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <CountList entries={site.stats.utm.source} emptyLabel="-" />
                        <CountList entries={site.stats.utm.medium} emptyLabel="-" />
                        <CountList entries={site.stats.utm.campaign} emptyLabel="-" />
                      </div>
                    </div>
                  )}
                  {site.stats.detailTruncated && (
                    <div className="text-[var(--text-faint)] text-xs">{t('sites.detailTruncated')}</div>
                  )}
                </div>
              </section>

              <section>
                <h3 className="text-[var(--text-muted)] text-xs uppercase font-medium mb-1">{t('sites.coverage')}</h3>
                <div className="bg-[var(--bg-tertiary)] rounded p-3 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <CoverageBadge coverage={site.stats.coverage} t={t} />
                    <span className="text-[var(--text-faint)] text-xs">
                      {t('sites.measuredSince')}: {site.stats.coverage.measuredSince ?? t('sites.unknown')}
                    </span>
                  </div>
                </div>
              </section>

              <section>
                <h3 className="text-[var(--text-muted)] text-xs uppercase font-medium mb-1">{t('sites.excludeRules')}</h3>
                <div className="bg-[var(--bg-tertiary)] rounded p-3 space-y-1">
                  {site.stats.excludedByRules ? (
                    <>
                      <span className="inline-block px-2 py-0.5 rounded text-xs font-medium border bg-blue-500/15 text-blue-500 border-blue-500/30">
                        {t('sites.excludeRules')}
                      </span>
                      <div className="text-[var(--text-faint)] text-xs mt-1">{t('sites.excludedNote')}</div>
                    </>
                  ) : (
                    <div className="text-[var(--text-faint)] text-xs">{t('sites.noExcludeRules')}</div>
                  )}
                </div>
              </section>
            </>
          ) : (
            <section>
              <h3 className="text-[var(--text-muted)] text-xs uppercase font-medium mb-1">{t('sites.traffic')}</h3>
              <div className="bg-[var(--bg-tertiary)] rounded p-3 text-[var(--text-faint)] text-xs">
                {site.hasAccessLog ? t('sites.statsNotReady') : t('sites.unmeasuredNote')}
              </div>
            </section>
          )}

          {/* Phase 1-A 技術情報 */}
          {/* Caddy 設定情報 */}
          <section>
            <h3 className="text-[var(--text-muted)] text-xs uppercase font-medium mb-1">Caddy</h3>
            <div className="bg-[var(--bg-tertiary)] rounded p-3 space-y-1">
              <div>kind: <span className="font-mono">{site.kind}</span> / configSource: <span className="font-mono">{site.configSource ?? t('sites.unknown')}</span></div>
              <div className="flex items-center gap-2">
                {t('sites.upstream')}: <span className="font-mono">{site.upstream.value?.dial ?? t('sites.unknown')}</span>
                <ConfidenceBadge confidence={site.upstream.confidence} />
              </div>
              <div className="flex items-center gap-2">
                {t('sites.staticRoot')}: <span className="font-mono break-all">{site.staticRoot.value ?? t('sites.unknown')}</span>
                <ConfidenceBadge confidence={site.staticRoot.confidence} />
                {site.staticRoot.note && <span className="text-[var(--text-faint)]">({site.staticRoot.note})</span>}
              </div>
              <div>{t('sites.colWarnings')} NO_ACCESS_LOG: {site.hasAccessLog ? t('sites.yes') : t('sites.no')}</div>
            </div>
          </section>

          {/* backend / listen / process */}
          <section>
            <h3 className="text-[var(--text-muted)] text-xs uppercase font-medium mb-1">Backend</h3>
            <div className="bg-[var(--bg-tertiary)] rounded p-3 space-y-1">
              <div className="flex items-center gap-2">
                LISTEN: {site.listen.value ? `${site.listen.value.bind} (uid ${site.listen.value.uid} / ${site.listen.value.unixUser ?? '?'})` : t('sites.unknown')}
                <ConfidenceBadge confidence={site.listen.confidence} />
              </div>
              {site.listen.value?.cgroupUnit && <div>cgroup unit: <span className="font-mono">{site.listen.value.cgroupUnit}</span></div>}
              {site.listen.note && <div className="text-[var(--text-faint)]">{site.listen.note}</div>}
              <div className="flex items-center gap-2">
                {t('sites.processInfo')}: {site.process.value ? `pid ${site.process.value.pid}` : t('sites.unknown')}
                <ConfidenceBadge confidence={site.process.confidence} />
              </div>
              {site.process.value?.cwd && <div className="break-all">cwd: <span className="font-mono">{site.process.value.cwd}</span></div>}
              {site.process.value?.cmdline && <div className="break-all text-[var(--text-faint)]">{site.process.value.cmdline}</div>}
              {site.process.note && <div className="text-[var(--text-faint)]">{site.process.note}</div>}
            </div>
          </section>

          {/* TestflightService */}
          <section>
            <h3 className="text-[var(--text-muted)] text-xs uppercase font-medium mb-1">{t('sites.colTestflight')}</h3>
            <div className="bg-[var(--bg-tertiary)] rounded p-3 space-y-1">
              {site.testflight.value ? (
                <>
                  <div className="flex items-center gap-2">
                    name: <span className="font-mono">{site.testflight.value.name}</span> / status: <span className="font-mono">{site.testflight.value.status}</span>
                    <ConfidenceBadge confidence={site.testflight.confidence} />
                  </div>
                  <div className="text-[var(--text-faint)]">{site.testflight.note}</div>
                  <div>template: {site.testflight.value.template ?? '-'} / createdAt: {new Date(site.testflight.value.createdAt).toLocaleDateString()}</div>
                </>
              ) : (
                <div className="text-[var(--text-faint)]">{site.testflight.note ?? t('sites.noData')}</div>
              )}
            </div>
          </section>

          {/* directory 3 分割: 登録上 / runtime 推定 / Project 候補 */}
          <section>
            <h3 className="text-[var(--text-muted)] text-xs uppercase font-medium mb-1">{t('sites.colDirectory')}</h3>
            <div className="bg-[var(--bg-tertiary)] rounded p-3 space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-[var(--text-faint)] w-20 inline-block">{t('sites.registered')}:</span>
                <span className="font-mono break-all">{site.directories.registered.value ?? t('sites.unknown')}</span>
                <ConfidenceBadge confidence={site.directories.registered.confidence} />
              </div>
              {site.directories.registered.note && <div className="text-[var(--text-faint)] pl-20">{site.directories.registered.note}</div>}
              <div className="flex items-center gap-2">
                <span className="text-[var(--text-faint)] w-20 inline-block">{t('sites.runtime')}:</span>
                <span className="font-mono break-all">{site.directories.runtime.value ?? t('sites.unknown')}</span>
                <ConfidenceBadge confidence={site.directories.runtime.confidence} />
              </div>
              {site.directories.runtime.note && <div className="text-[var(--text-faint)] pl-20">{site.directories.runtime.note}</div>}
              <div>
                <div className="text-[var(--text-faint)] mb-1">{t('sites.candidates')}:</div>
                {site.directories.candidates.length === 0 ? (
                  <div className="text-[var(--text-faint)] pl-4">{t('sites.noData')}</div>
                ) : (
                  <ul className="space-y-1 pl-4">
                    {site.directories.candidates.map((c) => (
                      <li key={c.id} className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono break-all">{c.path}</span>
                        <ConfidenceBadge confidence={c.confidence} />
                        <span className="text-[var(--text-faint)]">{c.reason}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </section>

          {/* Machine / Git */}
          <section>
            <h3 className="text-[var(--text-muted)] text-xs uppercase font-medium mb-1">{t('sites.machineInfo')} / {t('sites.gitInfo')}</h3>
            <div className="bg-[var(--bg-tertiary)] rounded p-3 space-y-1">
              <div className="flex items-center gap-2">
                {t('sites.machineInfo')}: {site.machine.value ? `${site.machine.value.name} (${site.machine.value.online ? 'online' : 'offline'})` : t('sites.unknown')}
                <ConfidenceBadge confidence={site.machine.confidence} />
              </div>
              <div className="flex items-center gap-2">
                {t('sites.gitInfo')}: {site.git.value?.head ? `${site.git.value.branch ?? '?'} @ ${site.git.value.head}` : t('sites.unknown')}
                <ConfidenceBadge confidence={site.git.confidence} />
              </div>
              {site.git.value?.remote && <div className="text-[var(--text-faint)] break-all">{site.git.value.remote}</div>}
            </div>
          </section>

          {/* warnings 全文 */}
          {site.warnings.length > 0 && (
            <section>
              <h3 className="text-[var(--text-muted)] text-xs uppercase font-medium mb-1">{t('sites.colWarnings')}</h3>
              <ul className="space-y-1">
                {site.warnings.map((w, i) => (
                  <li
                    key={i}
                    className={`text-xs px-2 py-1 rounded border ${
                      w.severity === 'error'
                        ? 'bg-red-500/10 border-red-500/30 text-red-500'
                        : w.severity === 'warn'
                          ? 'bg-yellow-500/10 border-yellow-500/30 text-yellow-600'
                          : 'bg-gray-500/10 border-gray-500/30 text-[var(--text-faint)]'
                    }`}
                  >
                    <span className="font-mono">{w.code}</span>: {w.message}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

export function SitesPage() {
  const { t } = useLanguage();
  const [data, setData] = useState<SiteRecord[]>([]);
  const [meta, setMeta] = useState<SitesMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<SiteRecord | null>(null);
  const [checkingHost, setCheckingHost] = useState<string | null>(null);

  const load = useCallback(async (refresh = false) => {
    try {
      const result = await sitesApi.list(refresh);
      // host 名順で安定ソート（ポーリングごとに順番が変わるのを防止）
      const sorted = [...result.sites].sort((a, b) => a.host.localeCompare(b.host));
      setData(sorted);
      setMeta(result.meta);
      if (error) setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load sites');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load(false);
  }, [load]);

  const handleHealthCheck = async (host: string) => {
    setCheckingHost(host);
    try {
      const health = await sitesApi.healthCheck(host);
      setData((prev) => prev.map((s) => (s.host === host ? { ...s, health } : s)));
      setSelected((prev) => (prev && prev.host === host ? { ...prev, health } : prev));
    } catch {
      // 単発チェックの失敗は致命的でないため握りつぶす（次回一覧更新で再取得される）
    } finally {
      setCheckingHost(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-[var(--text-muted)]">{t('sites.loading')}</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-[var(--bg-danger)] border border-[var(--border-danger)] text-[var(--text-danger)] px-4 py-3 rounded">
        {error}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">{t('sites.title')}</h1>
          <p className="text-sm text-[var(--text-muted)] mt-1">{t('sites.subtitle')}</p>
        </div>
        <button
          onClick={() => load(true)}
          className="px-3 py-1.5 text-sm rounded bg-[var(--bg-tertiary)] hover:bg-[var(--bg-hover)] text-[var(--text-primary)]"
        >
          {t('common.refresh')}
        </button>
      </div>

      {/* 上部サマリー（修正3: 全 site UU 合計は出さない。site をまたいだ UU 合算は構造的に不可能） */}
      {meta && (
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
          {[
            { label: t('sites.title'), value: data.length },
            { label: 'Up', value: meta.counts.up },
            { label: 'Degraded', value: meta.counts.degraded },
            { label: 'Down', value: meta.counts.down },
            { label: `${t('sites.today')} ${t('sites.pv')}`, value: data.reduce((acc, s) => acc + (s.stats?.today.pv ?? 0), 0) },
            { label: 'Orphan', value: meta.orphans.length },
            { label: t('sites.unmeasured'), value: meta.unmeasuredCount },
          ].map((item) => (
            <div key={item.label} className="bg-[var(--bg-secondary)] rounded-lg px-3 py-2">
              <div className="text-[10px] uppercase tracking-wide text-[var(--text-faint)]">{item.label}</div>
              <div className="text-lg font-semibold text-[var(--text-primary)]">{item.value.toLocaleString()}</div>
            </div>
          ))}
        </div>
      )}

      {/* 設定不備バナー */}
      {meta && (!meta.caddyAdminReachable || !meta.ssAvailable || !meta.statsReady || meta.orphans.length > 0) && (
        <div className="bg-yellow-500/10 border border-yellow-500/30 text-yellow-600 rounded-lg px-4 py-3 text-sm space-y-1">
          {!meta.caddyAdminReachable && <div>⚠️ {t('sites.metaCaddyUnreachable')}</div>}
          {!meta.ssAvailable && <div>⚠️ {t('sites.metaSsUnavailable')}</div>}
          {!meta.statsReady && <div>⏳ {t('sites.statsNotReady')}</div>}
          {meta.orphans.length > 0 && (
            <div>
              ⚠️ {meta.orphans.length} {t('sites.metaOrphans')}
              <ul className="mt-1 ml-4 list-disc">
                {meta.orphans.map((o) => (
                  <li key={`${o.kind}-${o.name}`} className="font-mono text-xs break-all">
                    [{o.kind}] {o.name} ({o.path}){o.status ? ` status=${o.status}` : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {data.length === 0 ? (
        <div className="bg-[var(--bg-secondary)] rounded-lg p-6 text-center">
          <p className="text-[var(--text-muted)]">No sites found.</p>
        </div>
      ) : (
        <>
        {/* デスクトップ テーブルビュー */}
        <div className="hidden md:block bg-[var(--bg-secondary)] rounded-lg overflow-x-auto">
          <table className="min-w-full divide-y divide-[var(--border-color)]">
            <thead className="bg-[var(--bg-tertiary)]/50">
              <tr>
                {TABLE_COLUMNS.map((key) => (
                  <th key={key} className="px-4 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider whitespace-nowrap">
                    {t(key)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-color)]">
              {data.map((site) => (
                <tr
                  key={site.host}
                  className="cursor-pointer hover:bg-[var(--bg-hover)]"
                  onClick={() => setSelected(site)}
                >
                  <td className="px-4 py-3 text-sm text-[var(--text-primary)] font-mono break-all max-w-[220px]">{site.host}</td>
                  <td className="px-4 py-3 text-sm"><HealthBadge state={site.health.state} httpStatus={site.health.httpStatus} /></td>
                  {site.stats ? (
                    <>
                      <td className="px-4 py-3 text-sm text-[var(--text-secondary)] font-mono">{site.stats.today.pv.toLocaleString()}</td>
                      <td className="px-4 py-3 text-sm text-[var(--text-secondary)] font-mono">{site.stats.last7d.pv.toLocaleString()}</td>
                      <td className="px-4 py-3 text-sm text-[var(--text-secondary)] font-mono">
                        {site.stats.today.uu !== null ? site.stats.today.uu.toLocaleString() : t('sites.unknown')}
                        {site.stats.today.uuTruncated && <span className="text-[var(--text-faint)]">{'≥'}</span>}
                      </td>
                      <td className="px-4 py-3 text-xs text-[var(--text-faint)] whitespace-nowrap">{lastAccessDate(site.stats) ?? '-'}</td>
                    </>
                  ) : (
                    <>
                      <td className="px-4 py-3 text-sm text-[var(--text-faint)]">
                        <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-medium border bg-gray-500/15 text-gray-400 border-gray-500/30">
                          {t('sites.unmeasured')}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm text-[var(--text-faint)]">-</td>
                      <td className="px-4 py-3 text-sm text-[var(--text-faint)]">-</td>
                      <td className="px-4 py-3 text-xs text-[var(--text-faint)]">-</td>
                    </>
                  )}
                  <td className="px-4 py-3 text-sm"><WarningsBadge warnings={site.warnings} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* モバイル カードビュー */}
        <div className="md:hidden space-y-3">
          {data.map((site) => (
            <div
              key={site.host}
              onClick={() => setSelected(site)}
              className="bg-[var(--bg-secondary)] rounded-lg p-4 cursor-pointer hover:bg-[var(--bg-tertiary)]/60 transition-colors"
            >
              <div className="flex items-start justify-between gap-2">
                <span className="text-sm font-mono text-[var(--text-primary)] break-all">{site.host}</span>
                <HealthBadge state={site.health.state} httpStatus={site.health.httpStatus} />
              </div>
              <div className="flex items-center justify-between gap-2 mt-2 text-xs text-[var(--text-faint)]">
                <span>{t('sites.colLastAccess')}: {lastAccessDate(site.stats) ?? '-'}</span>
                <WarningsBadge warnings={site.warnings} />
              </div>
              {site.stats ? (
                <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-[var(--text-secondary)]">
                  <span>{t('sites.colTodayPv')}: <span className="font-mono">{site.stats.today.pv.toLocaleString()}</span></span>
                  <span>{t('sites.col7dPv')}: <span className="font-mono">{site.stats.last7d.pv.toLocaleString()}</span></span>
                  <span>
                    {t('sites.colTodayUu')}: <span className="font-mono">
                      {site.stats.today.uu !== null ? site.stats.today.uu.toLocaleString() : t('sites.unknown')}
                    </span>
                    {site.stats.today.uuTruncated && <span className="text-[var(--text-faint)]">{'≥'}</span>}
                  </span>
                </div>
              ) : (
                <div className="mt-2">
                  <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-medium border bg-gray-500/15 text-gray-400 border-gray-500/30">
                    {t('sites.unmeasured')}
                  </span>
                </div>
              )}
            </div>
          ))}
        </div>
        </>
      )}

      {selected && (
        <SiteDetailDrawer
          site={selected}
          onClose={() => setSelected(null)}
          onHealthCheck={() => handleHealthCheck(selected.host)}
          checking={checkingHost === selected.host}
        />
      )}
    </div>
  );
}
