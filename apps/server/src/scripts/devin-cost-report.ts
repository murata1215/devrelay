/**
 * Devin 請求照合用のコスト集計 CLI（読み取り専用。DB へは一切書き込まない）。
 *
 * 実行方法: `pnpm --filter server devin:cost-report -- [options]`
 * （`package.json` の `devin:cost-report` が `node dist/scripts/devin-cost-report.js` を実行。
 * 事前に `pnpm build` が必要）
 *
 * オプション:
 *   --from <YYYY-MM-DD>  集計開始日（米国太平洋時間の日付。この日を含む）。省略時は 30 日前
 *   --to <YYYY-MM-DD>    集計終了日（米国太平洋時間の日付。この日を含まない）。省略時は明日
 *   --daily              マシン×日ごとの内訳も出力する
 *
 * Devin の請求サイクルは米国太平洋時間（America/Los_Angeles）の 0 時区切り（2026-11-09 照合で確定:
 * サイクル Nov 4 – Dec 4 の開始は 2026-11-04 08:00 UTC）。管理画面の「今回のサイクル (Nov 4 – Dec 4)」
 * と照合する場合は `--from 2026-11-04 --to 2026-12-04` を指定する。
 *
 * 金額は WebUI の会話履歴と同じ `resolveMessageCost()`（@devrelay/shared）で計算するため、
 * 画面表示とずれない。マシン単位で集計する（Devin のアカウントはマシンにログインしているもの）。
 * 出力は CSV（標準出力）。Devin 管理画面の「CSVにエクスポート」と並べて比較する。
 */

import 'dotenv/config';
import { resolveMessageCost } from '@devrelay/shared';
import { prisma } from '../db/client.js';

/** Devin の請求サイクル境界のタイムゾーン */
const BILLING_TZ = 'America/Los_Angeles';

interface Args {
  from: string;
  to: string;
  daily: boolean;
}

/** Date を BILLING_TZ の `YYYY-MM-DD` に変換する */
function billingDay(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BILLING_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

/** 日付文字列 `YYYY-MM-DD` に日数を足す（UTC 正午基準で計算し DST の影響を受けない） */
function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function parseArgs(argv: string[]): Args {
  const today = billingDay(new Date());
  const args: Args = { from: addDays(today, -30), to: addDays(today, 1), daily: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') args.from = argv[++i] ?? '';
    else if (a === '--to') args.to = argv[++i] ?? '';
    else if (a === '--daily') args.daily = true;
    else if (a === '--') continue;
    else throw new Error(`不明なオプション: ${a}`);
  }
  for (const [k, v] of [['--from', args.from], ['--to', args.to]] as const) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`${k} は YYYY-MM-DD 形式で指定してください: ${v}`);
  }
  if (args.from >= args.to) throw new Error(`--from（${args.from}）は --to（${args.to}）より前にしてください`);
  return args;
}

interface Bucket {
  turns: number;
  unknownTurns: number;
  input: number;
  cacheRead: number;
  output: number;
  usd: number;
}

function emptyBucket(): Bucket {
  return { turns: 0, unknownTurns: 0, input: 0, cacheRead: 0, output: 0, usd: 0 };
}

/** CSV 1 セル分のエスケープ */
function csv(value: string | number): string {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // 太平洋時間の日付境界は UTC-7/-8 のため、前後 1 日広めに取得してから日付キーで絞る
  const messages = await prisma.message.findMany({
    where: {
      role: 'ai',
      usageData: { path: ['tool'], equals: 'devin' },
      createdAt: {
        gte: new Date(`${addDays(args.from, -1)}T00:00:00Z`),
        lt: new Date(`${addDays(args.to, 1)}T00:00:00Z`),
      },
    },
    select: {
      createdAt: true,
      usageData: true,
      session: {
        select: {
          project: {
            select: { machine: { select: { name: true, user: { select: { email: true } } } } },
          },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  const summary = new Map<string, Bucket>();
  const daily = new Map<string, Bucket>();
  const owners = new Map<string, string>();

  for (const m of messages) {
    const day = billingDay(m.createdAt);
    if (day < args.from || day >= args.to) continue;

    const machine = m.session.project.machine;
    const machineName = machine?.name ?? '(unknown)';
    owners.set(machineName, machine?.user?.email ?? '');

    const usageData = m.usageData as Record<string, any> | null;
    const usage = (usageData?.usage ?? {}) as Record<string, number | undefined>;
    const cost = resolveMessageCost(usageData as any);

    for (const [map, key] of [[summary, machineName], [daily, `${machineName}\t${day}`]] as const) {
      const b = map.get(key) ?? emptyBucket();
      b.turns++;
      b.input += usage.input_tokens ?? 0;
      b.cacheRead += usage.cache_read_input_tokens ?? 0;
      b.output += usage.output_tokens ?? 0;
      if (cost.usd === null) b.unknownTurns++;
      else b.usd += cost.usd;
      map.set(key, b);
    }
  }

  const header = ['machine', 'devrelayUser', 'turns', 'unknownCostTurns', 'inputTokens', 'cacheReadTokens', 'outputTokens', 'usd'];
  const row = (cells: (string | number)[]) => cells.map(csv).join(',');

  console.log(`# Devin cost report ${args.from} 〜 ${args.to}（${BILLING_TZ} の日付、--to は含まない）`);
  console.log(row(header));
  let total = 0;
  for (const [machineName, b] of [...summary.entries()].sort((a, z) => z[1].usd - a[1].usd)) {
    total += b.usd;
    console.log(row([machineName, owners.get(machineName) ?? '', b.turns, b.unknownTurns, b.input, b.cacheRead, b.output, b.usd.toFixed(2)]));
  }
  console.log(row(['TOTAL', '', '', '', '', '', '', total.toFixed(2)]));

  if (args.daily) {
    console.log('');
    console.log(row(['machine', 'day', 'turns', 'unknownCostTurns', 'inputTokens', 'cacheReadTokens', 'outputTokens', 'usd']));
    for (const [key, b] of [...daily.entries()].sort((a, z) => a[0].localeCompare(z[0]))) {
      const [machineName, day] = key.split('\t');
      console.log(row([machineName, day, b.turns, b.unknownTurns, b.input, b.cacheRead, b.output, b.usd.toFixed(2)]));
    }
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
