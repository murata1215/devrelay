/**
 * Usage 累計補正サイクル（2026-11-19）: Devin の usage が「セッション累計」で記録された行を補正する CLI。
 *
 *   pnpm --filter @devrelay/server devin:cumulative-fix                         # dry-run: 機体ごとの単調増加率と補正後の金額
 *   pnpm --filter @devrelay/server devin:cumulative-fix -- --machine "PC45/exuser59"          # その機体の補正内容（dry-run）
 *   pnpm --filter @devrelay/server devin:cumulative-fix -- --machine "PC45/exuser59" --apply  # 書き換え
 *
 * オプション: --from YYYY-MM-DD（既定 2026-09-01、UTC）/ --machine <名前>（複数可）/ --apply
 * 書き換えは --machine 指定時のみ。元の累計は usageData.cumulativeUsage に残し usageMode='delta-fixed' にする
 * （何度実行しても同じ結果）。金額は会話履歴と同じ resolveMessageCost()。
 */

import 'dotenv/config';
import { resolveMessageCost } from '@devrelay/shared';
import { prisma } from '../db/client.js';
import { planCumulativeFix, applyFixToUsageData, toTokenUsage, looksCumulative, type FixTurnPlan } from '../services/devin-cumulative-fix-rules.js';

interface Args {
  from: string;
  machines: string[];
  apply: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { from: '2026-09-01', machines: [], apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') args.from = argv[++i] ?? '';
    else if (a === '--machine') args.machines.push(argv[++i] ?? '');
    else if (a === '--apply') args.apply = true;
    else if (a === '--') continue;
    else throw new Error(`不明なオプション: ${a}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.from)) throw new Error(`--from は YYYY-MM-DD 形式で指定してください: ${args.from}`);
  if (args.apply && args.machines.length === 0) throw new Error('--apply には --machine の指定が必要です');
  return args;
}

const usd = (n: number) => `$${n.toFixed(2)}`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const messages = await prisma.message.findMany({
    where: {
      role: 'ai',
      usageData: { path: ['tool'], equals: 'devin' },
      createdAt: { gte: new Date(`${args.from}T00:00:00Z`) },
      ...(args.machines.length > 0 ? { session: { machine: { name: { in: args.machines } } } } : {}),
    },
    orderBy: [{ sessionId: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      sessionId: true,
      createdAt: true,
      usageData: true,
      session: { select: { machine: { select: { name: true } }, user: { select: { name: true, email: true } } } },
    },
  });

  // 機体 → スレッド → ターン（古い順）
  const byMachine = new Map<string, { user: string; sessions: Map<string, typeof messages> }>();
  for (const m of messages) {
    const key = m.session.machine.name;
    let e = byMachine.get(key);
    if (!e) {
      e = { user: m.session.user.name ?? m.session.user.email ?? '', sessions: new Map() };
      byMachine.set(key, e);
    }
    const arr = e.sessions.get(m.sessionId);
    if (arr) arr.push(m);
    else e.sessions.set(m.sessionId, [m]);
  }

  console.log(`対象: Devin ターン ${messages.length} 件（${args.from} 以降）${args.apply ? '【書き換えます】' : '（dry-run）'}`);
  console.log('機体 | 利用者 | 続きターン | うち累計に見える | 現在の金額 | 補正後の金額');

  const toApply: Array<{ id: string; usageData: unknown; plan: FixTurnPlan }> = [];
  const rows: Array<{ line: string; ratio: number }> = [];
  for (const [machine, e] of byMachine) {
    let pairs = 0;
    let mono = 0;
    let before = 0;
    let after = 0;
    for (const turns of e.sessions.values()) {
      // 単調増加率（判定材料）: 補正済みの行は元の累計で比べる
      let prev = null as ReturnType<typeof toTokenUsage>;
      for (const t of turns) {
        const d = (t.usageData ?? {}) as Record<string, unknown>;
        const cum = toTokenUsage(d.cumulativeUsage) ?? toTokenUsage(d.usage);
        if (!cum) continue;
        if (prev) {
          pairs++;
          if (looksCumulative(prev, cum)) mono++;
        }
        prev = cum;
      }
      const plans = new Map(planCumulativeFix(turns.map((t) => ({ id: t.id, usageData: t.usageData }))).map((p) => [p.id, p]));
      for (const t of turns) {
        const cur = resolveMessageCost(t.usageData as any).usd ?? 0;
        before += cur;
        const p = plans.get(t.id);
        if (!p) {
          after += cur;
          continue;
        }
        const fixed = applyFixToUsageData(t.usageData, p);
        after += resolveMessageCost(fixed as any).usd ?? 0;
        if (p.changed) toApply.push({ id: t.id, usageData: t.usageData, plan: p });
      }
    }
    const ratio = pairs > 0 ? mono / pairs : 0;
    rows.push({ line: `${machine} | ${e.user} | ${pairs} | ${mono} (${Math.round(ratio * 100)}%) | ${usd(before)} | ${usd(after)}`, ratio });
  }
  rows.sort((a, b) => b.ratio - a.ratio);
  for (const r of rows) console.log(r.line);

  if (args.machines.length === 0) {
    console.log('\n※ 累計型と判断した機体を --machine で指定すると補正内容を確認でき、--apply で書き換えます。');
    return;
  }
  console.log(`\n書き換え対象: ${toApply.length} 行`);
  if (!args.apply) return;

  let done = 0;
  for (const r of toApply) {
    await prisma.message.update({ where: { id: r.id }, data: { usageData: applyFixToUsageData(r.usageData, r.plan) as any } });
    done++;
  }
  console.log(`書き換え完了: ${done} 行`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
