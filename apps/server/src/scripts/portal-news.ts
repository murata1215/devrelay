/**
 * ポータル サイクル P1: DevRelay のコミット歴をポータルのニュース（アップデート）にする CLI。
 *
 *   cd apps/server && node dist/scripts/portal-news.js [--dry-run] [--no-ai] [--days N]
 *   （= pnpm --filter @devrelay/server portal:news。毎日 C:\tools\portal-news.cmd をタスク スケジューラで実行する想定）
 *
 * ルール（エクスポート → 加工の 2 段）:
 * 1. エクスポート: リポジトリ（既定はこの CLI が置かれた DevRelay のリポジトリ、`DEVRELAY_PORTAL_NEWS_REPO` で変更可）の
 *    HEAD について、前回位置（`<DIR>/news/state.json` の lastHash）以降のコミットを
 *    `<DIR>/news/commits/YYYY-MM-DD.jsonl`（実行日・JST）にそのまま追記する。生データは消さない。
 *    初回（state 無し）・前回位置が履歴に無い場合は直近 `--days`（既定 14）日分。
 * 2. 加工: 今回の新規コミットをまとめてニュース 1 件にする。`DEVRELAY_ANSWER_API_KEY` があれば OpenAI
 *    （`DEVRELAY_ANSWER_MODEL`、既定 gpt-4o-mini）で社員向けに要約、無い・失敗したら件名を整えて箇条書き。
 *    `<DIR>/news/items.json` に id 重複なしで追記する（同じ id の既存行は上書きしない＝手直しを保護）。
 *
 * `dotenv/config` を明示 import する（db-status.ts と同じ理由: cwd の .env を読む。apps/server で実行すること）。
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { initProxyDispatcher } from '../services/proxy-dispatcher.js';
import { resolveChatProvider } from '../services/chat-provider.js';
import { resolveAnswerKey } from '../services/knowledge-answer-rules.js';
import {
  AI_NEWS_SYSTEM_PROMPT,
  buildAiNewsUserPrompt,
  buildRuleBasedUpdateItem,
  GIT_LOG_FORMAT,
  isNewsworthyCommit,
  jstDateKey,
  mergeNewsItems,
  normalizeNewsItems,
  parseAiNewsJson,
  parseGitLog,
  resolvePortalDir,
  type PortalCommit,
  type PortalNewsItem,
} from '../services/portal-rules.js';
import {
  PORTAL_NEWS_COMMITS_DIR,
  PORTAL_NEWS_DIR,
  PORTAL_NEWS_FILE,
  PORTAL_NEWS_STATE_FILE,
  readPortalJson,
  writeJsonAtomic,
} from '../services/portal-service.js';

const AI_TIMEOUT_MS = 60_000;

function parseArgs(argv: string[]) {
  const args = { dryRun: false, noAi: false, days: 14 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--no-ai') args.noAi = true;
    else if (a === '--days') {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n >= 1 && n <= 365) args.days = Math.floor(n);
    }
  }
  return args;
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

function isAncestor(repo: string, hash: string): boolean {
  try {
    execFileSync('git', ['-C', repo, 'merge-base', '--is-ancestor', hash, 'HEAD'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function summarizeWithAi(date: string, commits: PortalCommit[]): Promise<{ title: string; body: string } | null> {
  const key = resolveAnswerKey({ envAnswerKey: process.env.DEVRELAY_ANSWER_API_KEY, envModel: process.env.DEVRELAY_ANSWER_MODEL });
  if (!key.ok) {
    console.log('ℹ️  DEVRELAY_ANSWER_API_KEY が未設定のため、件名の整形だけでニュースを作ります');
    return null;
  }
  try {
    const provider = await resolveChatProvider('portal-news', key.provider, key.apiKey, key.model);
    const result = await Promise.race([
      provider.chat({
        system: AI_NEWS_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildAiNewsUserPrompt(date, commits) }],
        jsonMode: true,
        maxTokens: 800,
        temperature: 0.2,
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timeout ${AI_TIMEOUT_MS}ms`)), AI_TIMEOUT_MS)),
    ]);
    const parsed = parseAiNewsJson(result.text);
    if (!parsed) console.warn('⚠️  AI の応答を解釈できなかったため、件名の整形に切り替えます');
    else console.log(`🤖 AI で要約しました（${key.model}${result.usage ? `, in ${result.usage.input} / out ${result.usage.output} tokens` : ''}）`);
    return parsed;
  } catch (err) {
    console.warn(`⚠️  AI 要約に失敗したため、件名の整形に切り替えます: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = resolvePortalDir(process.env.DEVRELAY_PORTAL_DIR);
  if (!root) {
    console.error('❌ DEVRELAY_PORTAL_DIR が未設定です（apps/server/.env に例: DEVRELAY_PORTAL_DIR=D:\\portal）');
    process.exit(2);
  }
  initProxyDispatcher();

  const selfDir = path.dirname(fileURLToPath(import.meta.url));
  const repo = (process.env.DEVRELAY_PORTAL_NEWS_REPO ?? '').trim() || git(selfDir, ['rev-parse', '--show-toplevel']).trim();
  const head = git(repo, ['rev-parse', 'HEAD']).trim();
  const headShort = head.slice(0, 7);

  const newsDir = path.join(root, PORTAL_NEWS_DIR);
  const statePath = path.join(newsDir, PORTAL_NEWS_STATE_FILE);
  const state = (await readPortalJson(statePath)) as { lastHash?: unknown } | null;
  const lastHash = typeof state?.lastHash === 'string' && /^[0-9a-f]{40}$/.test(state.lastHash) ? state.lastHash : null;

  if (lastHash === head) {
    console.log(`✅ 新しいコミットはありません（HEAD ${headShort}）`);
    return;
  }
  const range = lastHash && isAncestor(repo, lastHash) ? [`${lastHash}..HEAD`] : ['HEAD', `--since=${args.days} days ago`];
  if (!lastHash || range.length === 2) console.log(`ℹ️  前回位置が無いため直近 ${args.days} 日分を対象にします`);
  const commits = parseGitLog(git(repo, ['log', `--format=${GIT_LOG_FORMAT}`, ...range]));
  const today = jstDateKey(new Date());
  console.log(`📦 ${repo} HEAD ${headShort}: 新規コミット ${commits.length} 件（うちニュース対象 ${commits.filter((c) => isNewsworthyCommit(c.subject)).length} 件）`);

  let item: PortalNewsItem | null = null;
  const newsworthy = commits.filter((c) => isNewsworthyCommit(c.subject));
  if (newsworthy.length > 0) {
    const ruleItem = buildRuleBasedUpdateItem(today, headShort, commits);
    const ai = args.noAi ? null : await summarizeWithAi(today, newsworthy);
    item = ruleItem && ai ? { ...ruleItem, title: ai.title, body: ai.body, source: 'ai' } : ruleItem;
  }

  if (args.dryRun) {
    console.log('--- dry-run（ファイルは書きません）---');
    console.log(JSON.stringify(item, null, 2));
    return;
  }

  // 1. エクスポート（生データ、追記のみ）
  if (commits.length > 0) {
    const commitsDir = path.join(newsDir, PORTAL_NEWS_COMMITS_DIR);
    await fs.promises.mkdir(commitsDir, { recursive: true });
    const lines = commits
      .slice()
      .reverse()
      .map((c) => JSON.stringify({ exportedAt: new Date().toISOString(), repo: path.basename(repo), ...c }))
      .join('\n');
    await fs.promises.appendFile(path.join(commitsDir, `${today}.jsonl`), lines + '\n', 'utf8');
  }

  // 2. 加工結果をニュースに追記
  if (item) {
    const newsPath = path.join(newsDir, PORTAL_NEWS_FILE);
    const existing = normalizeNewsItems(await readPortalJson(newsPath));
    const merged = mergeNewsItems(existing, [item]);
    await writeJsonAtomic(newsPath, { updatedAt: new Date().toISOString(), items: merged });
    console.log(`📰 ニュースを追加しました: ${item.title}`);
  } else {
    console.log('ℹ️  ニュース対象のコミットが無いため、ニュースは追加しません（生データのみ書き出し）');
  }
  await writeJsonAtomic(statePath, { lastHash: head, updatedAt: new Date().toISOString() });
}

main().catch((err) => {
  console.error('❌ portal:news failed:', err);
  process.exit(1);
});
