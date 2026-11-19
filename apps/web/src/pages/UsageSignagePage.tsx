import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { formatUsageUsd, usageChangeRatio } from '@devrelay/shared';
import { apiUrl } from '../lib/base';

/**
 * Usage サイネージ（ログイン不要・`/signage/usage?token=…[&by=user]`）。
 * 1920×1080 のディスプレイに常時表示する前提で、文字サイズは画面の高さ（vh）基準。
 * 5 分ごとに自動更新。通信エラー時は直前の表示を残す。
 */

interface SignageItem {
  label: string | null;
  costUsd: number;
  turns: number;
}
interface SignageGroup {
  group: string | null;
  costUsd: number;
  prevCostUsd: number;
  turns: number;
  unknownTurns: number;
  items: SignageItem[];
}
interface SignageData {
  organizationName: string;
  month: string;
  prevMonth: string;
  by: 'case' | 'user' | 'project';
  total: { costUsd: number; turns: number; unknownTurns: number };
  prevTotal: { costUsd: number; turns: number; unknownTurns: number };
  groups: SignageGroup[];
  generatedAt: string;
}

const REFRESH_MS = 5 * 60 * 1000;
/** カード 1 枚に出す横棒の最大本数（超えた分は「その他」にまとめる） */
const MAX_ITEMS = 8;

const INK = '#3b2226';
const INK_MUTED = '#8a6b70';
const BAR = '#c8414f';
const BAR_TRACK = '#f6e3e5';

function monthLabel(key: string): string {
  const [y, m] = key.split('-');
  return `${y}年${Number(m)}月`;
}

function ratioText(cur: number, prev: number): { text: string; color: string } {
  const r = usageChangeRatio(cur, prev);
  if (r === null) return { text: '—', color: INK_MUTED };
  const sign = r > 0 ? '+' : '';
  return { text: `${sign}${r.toFixed(0)}%`, color: INK };
}

function noneItemLabel(by: SignageData['by']): string {
  return by === 'case' ? '案件なし' : by === 'user' ? '(不明)' : '(不明)';
}

function foldItems(items: SignageItem[]): SignageItem[] {
  if (items.length <= MAX_ITEMS) return items;
  const head = items.slice(0, MAX_ITEMS - 1);
  const rest = items.slice(MAX_ITEMS - 1);
  return [
    ...head,
    { label: `その他 ${rest.length} 件`, costUsd: rest.reduce((s, i) => s + i.costUsd, 0), turns: rest.reduce((s, i) => s + i.turns, 0) },
  ];
}

export function UsageSignagePage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const by = params.get('by') ?? '';
  const [data, setData] = useState<SignageData | null>(null);
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const q = `token=${encodeURIComponent(token)}${by ? `&by=${encodeURIComponent(by)}` : ''}`;
        const res = await fetch(apiUrl(`/public/usage-signage?${q}`), { cache: 'no-store' });
        if (res.status === 404) {
          if (!cancelled) {
            setData(null);
            setError('この URL は無効です（停止または再発行された可能性があります）');
          }
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as SignageData;
        if (!cancelled) {
          setData(body);
          setError('');
        }
      } catch (e) {
        // 一時的な通信エラーは直前の表示を残す
        if (!cancelled) setError(e instanceof Error ? `更新に失敗しました（${e.message}）` : '更新に失敗しました');
      }
    };
    void load();
    const t = setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [token, by]);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 10_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const prev = document.title;
    document.title = 'Usage サイネージ';
    return () => {
      document.title = prev;
    };
  }, []);

  const clock = now.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const groups = data?.groups ?? [];
  const cols = Math.min(4, Math.max(1, groups.length));
  const maxItem = Math.max(0.0001, ...groups.flatMap((g) => g.items.map((i) => i.costUsd)));
  const totalRatio = data ? ratioText(data.total.costUsd, data.prevTotal.costUsd) : null;

  return (
    <div
      style={{ background: '#fbe9ea', color: INK, fontFamily: '"Noto Sans JP", "Yu Gothic UI", "Meiryo", system-ui, sans-serif' }}
      className="w-screen h-screen overflow-hidden flex flex-col"
    >
      {/* タイトル帯 */}
      <header className="flex items-end justify-between" style={{ padding: '2.2vh 2.5vw 1.2vh' }}>
        <div>
          <div style={{ fontSize: '4.2vh', fontWeight: 800, lineHeight: 1.1 }}>AI 利用コスト</div>
          <div style={{ fontSize: '2vh', color: INK_MUTED, marginTop: '0.5vh' }}>
            {data ? `${data.organizationName} ・ ${monthLabel(data.month)}（日本時間・暦月）・ ${data.by === 'user' ? '利用者別' : data.by === 'project' ? 'プロジェクト別' : '案件別'}` : ' '}
          </div>
        </div>
        <div style={{ fontSize: '3.4vh', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{clock}</div>
      </header>

      {!data ? (
        <div className="flex-1 flex items-center justify-center" style={{ fontSize: '3vh', color: INK_MUTED }}>
          {error || '読み込み中...'}
        </div>
      ) : (
        <>
          {/* 上段: 当月・前月・前月比 */}
          <section className="grid grid-cols-3" style={{ gap: '1.5vw', padding: '0 2.5vw 2vh' }}>
            {[
              { label: `今月（${monthLabel(data.month)}）`, value: formatUsageUsd(data.total.costUsd), color: INK, sub: `${data.total.turns.toLocaleString()} ターン` },
              { label: `先月（${monthLabel(data.prevMonth)}）`, value: formatUsageUsd(data.prevTotal.costUsd), color: INK_MUTED, sub: `${data.prevTotal.turns.toLocaleString()} ターン` },
              { label: '前月比', value: totalRatio!.text, color: totalRatio!.color, sub: '今月の途中経過 ÷ 先月の合計' },
            ].map((c) => (
              <div key={c.label} className="bg-white rounded-2xl shadow-sm" style={{ padding: '2vh 1.8vw' }}>
                <div style={{ fontSize: '2.2vh', color: INK_MUTED, fontWeight: 600 }}>{c.label}</div>
                <div style={{ fontSize: '8vh', fontWeight: 800, lineHeight: 1.1, color: c.color, fontVariantNumeric: 'tabular-nums' }}>{c.value}</div>
                <div style={{ fontSize: '1.8vh', color: INK_MUTED }}>{c.sub}</div>
              </div>
            ))}
          </section>

          {/* 下段: グループごとのカード */}
          <section
            className="flex-1 grid min-h-0"
            style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: '1.5vw', padding: '0 2.5vw 1vh' }}
          >
            {groups.length === 0 && (
              <div className="bg-white rounded-2xl flex items-center justify-center" style={{ fontSize: '3vh', color: INK_MUTED }}>
                今月の利用はまだありません
              </div>
            )}
            {groups.map((g) => {
              const r = ratioText(g.costUsd, g.prevCostUsd);
              const items = foldItems(g.items);
              return (
                <div key={g.group ?? '\u0000none'} className="bg-white rounded-2xl shadow-sm flex flex-col min-h-0 overflow-hidden" style={{ padding: '2vh 1.5vw' }}>
                  <div className="flex items-baseline justify-between" style={{ gap: '1vw' }}>
                    <div className="truncate" style={{ fontSize: '3.6vh', fontWeight: 800, color: g.group ? INK : INK_MUTED }}>
                      {g.group ?? 'タグなし'}
                    </div>
                    <div style={{ fontSize: '4.4vh', fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{formatUsageUsd(g.costUsd)}</div>
                  </div>
                  <div className="flex justify-between" style={{ fontSize: '1.9vh', color: INK_MUTED, borderBottom: `2px solid ${BAR_TRACK}`, paddingBottom: '1vh', marginBottom: '1.2vh' }}>
                    <span>先月 {formatUsageUsd(g.prevCostUsd)}</span>
                    <span style={{ color: r.color, fontWeight: 700 }}>前月比 {r.text}</span>
                  </div>
                  <div className="flex-1 min-h-0 flex flex-col" style={{ gap: '1.1vh' }}>
                    {items.map((i, idx) => (
                      <div key={`${i.label ?? ''}-${idx}`} title={`${i.label ?? noneItemLabel(data.by)}: ${formatUsageUsd(i.costUsd)} / ${i.turns} ターン`}>
                        <div className="flex justify-between" style={{ fontSize: '2.1vh', gap: '0.8vw' }}>
                          <span className="truncate" style={{ color: i.label ? INK : INK_MUTED, fontWeight: 600 }}>{i.label ?? noneItemLabel(data.by)}</span>
                          <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{formatUsageUsd(i.costUsd)}</span>
                        </div>
                        <div style={{ height: '1.1vh', background: BAR_TRACK, borderRadius: 4, marginTop: '0.4vh' }}>
                          <div style={{ height: '100%', width: `${Math.max(0.5, (i.costUsd / maxItem) * 100)}%`, background: BAR, borderRadius: 4 }} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </section>
        </>
      )}

      {/* フッター */}
      <footer className="flex justify-between" style={{ padding: '0.8vh 2.5vw 1.4vh', fontSize: '1.7vh', color: INK_MUTED }}>
        <span>
          Auto-refresh: 5min
          {data && ` ・ 最終更新 ${new Date(data.generatedAt).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' })}`}
          {data && error && ` ・ ${error}`}
        </span>
        <span>
          {data && data.total.unknownTurns > 0 ? `金額不明 ${data.total.unknownTurns} ターン（0 円で集計）・ ` : ''}金額は推定値（~）を含む USD
        </span>
      </footer>
    </div>
  );
}
