import 'dotenv/config';
import { fileURLToPath } from 'url';
import { statSync } from 'fs';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { setupAgentWebSocket, startHeartbeatMonitor, stopHeartbeatMonitor } from './services/agent-manager.js';
import { setupWebClientWebSocket } from './platforms/web.js';
import { restoreSessionParticipants } from './services/session-manager.js';
import { startBotSupervisors, stopBotSupervisors, getBotsHealth } from './services/bot-supervisor.js';
import { prisma } from './db/client.js';
import { authRoutes } from './routes/auth.js';
import { apiRoutes } from './routes/api.js';
import { organizationRoutes } from './routes/organization.js';
import { publicApiRoutes } from './routes/public-api.js';
import { registerDocumentApiRoutes } from './routes/document-api.js';
import { registerAgentDocumentApiRoutes } from './routes/agent-document-api.js';
import { registerRawCompletionRoutes } from './routes/raw-completion-api.js';
import { agentRepoAuthRoutes } from './routes/agent-repo-auth-api.js';
import { initVapid } from './services/push-notification-service.js';
import { initFcm } from './services/fcm-service.js';
import { startAutoUpdateSweep } from './services/auto-updater.js';
import { startCapabilitySweep } from './services/capability-sweep.js';
import { sitesApiRoutes } from './routes/sites-api.js';
import { knowledgeApiRoutes } from './routes/knowledge-api.js';
import { knowledgeAdminApiRoutes } from './routes/knowledge-admin-api.js';
import { startSiteHealthChecker } from './services/sites/health-checker.js';
import { startAccessLogAggregator } from './services/sites/access-aggregator.js';
import { mcpRoutes } from './mcp/server.js';
import { initProxyDispatcher } from './services/proxy-dispatcher.js';

const PORT = parseInt(process.env.PORT || '3000');
const HOST = process.env.HOST || '0.0.0.0';

/**
 * `app.listen()` より前に行う初期化処理（DB メンテナンス・セッション復元・FCM 初期化）を、
 * `ms` 以内に終わらなければ諦めて続行する形で実行する。
 *
 * 2026-10-18 の起動ハング障害（Discord/Telegram bot の起動を listen より前で await していた）
 * の修正として bot 起動は listen より後ろへ移したが、`app.listen()` より前に残る DB アクセス
 * （全マシン offline 化・stale セッション掃除・`restoreSessionParticipants()`・`initFcm()`）も
 * 同じ理由（マシン再起動直後に PostgreSQL がまだ上がっていない等）でハング／クラッシュループの
 * 引き金になりうる。`main().catch()` を足すだけでは「bot で止まる」が「DB で止まる」に
 * 原因が移るだけなので、listen 前のすべての処理を非致命・時間制限付きにする。
 * 詳細: `doc/server_listen_hang_20261018.md`。
 */
async function runStartupInitWithTimeout(name: string, fn: () => Promise<void>, ms = 20_000): Promise<void> {
  let timer: NodeJS.Timeout | null = null;
  try {
    await Promise.race([
      fn(),
      new Promise<void>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
        timer.unref();
      }),
    ]);
  } catch (err) {
    console.error(`⚠️  起動前処理「${name}」に失敗しました（続行します）:`, err);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 期限切れ AuthSession を定期削除するクリーンアップを開始する。
 * 起動直後に1回実行し、以降24時間間隔で expiresAt < now のセッションを deleteMany で除去する。
 * 失敗しても致命的でないため握りつぶす。
 */
function startExpiredSessionCleanup() {
  const runCleanup = async () => {
    try {
      const result = await prisma.authSession.deleteMany({
        where: { expiresAt: { lt: new Date() } },
      });
      if (result.count > 0) {
        console.log(`🧹 Cleaned up ${result.count} expired auth sessions`);
      }
    } catch (err) {
      console.error('⚠️  Expired auth session cleanup failed:', err);
    }
  };
  // 起動時に1回実行（await しない fire-and-forget）
  void runCleanup();
  // 以降24時間間隔で実行。unref でプロセス終了を妨げない
  const timer = setInterval(() => void runCleanup(), 24 * 60 * 60 * 1000);
  timer.unref();
}

async function main() {
  // 社内オンプレ移設対応: HTTPS_PROXY 等が設定されていれば undici の globalDispatcher に
  // ProxyAgent を登録する。未設定なら何もしない（VPS 環境の挙動は変わらない）
  initProxyDispatcher();

  // SETTINGS_ENCRYPTION_KEY 未設定時はリポジトリに書かれた公開デフォルト鍵にフォールバックする
  // （services/user-settings.ts）。社内など新規環境では必ず独自の鍵を設定すること。
  // 既存 VPS 環境（既にデフォルト鍵で暗号化済み）でこの警告を見て鍵を追加設定すると、
  // 既存の暗号化済み設定（API キー等）が復号不能になるため絶対に行わないこと。
  if (!process.env.SETTINGS_ENCRYPTION_KEY) {
    console.warn('⚠️  SETTINGS_ENCRYPTION_KEY が未設定です。デフォルトの公開鍵で暗号化されます（新規環境では必ず設定してください。稼働中の環境に後から追加設定すると既存データが復号不能になるため行わないでください）');
  }

  // trustProxy: Caddy 経由の X-Forwarded-For を信頼し request.ip を実クライアント IP にする（#285 IP 制限用）
  const app = Fastify({ logger: true, trustProxy: true });

  // 起動前の DB メンテナンス（全マシン offline 化・stale セッション掃除）。
  // マシン再起動直後に PostgreSQL がまだ上がっていないケースに備え、非致命・20s 上限で実行する
  // （失敗してもログを出すだけで listen には進む。runStartupInitWithTimeout の JSDoc 参照）。
  await runStartupInitWithTimeout('DB メンテナンス', async () => {
    // Reset all machines to offline on startup
    // (In case server crashed without proper disconnect handling)
    await prisma.machine.updateMany({
      where: { deletedAt: null },
      data: { status: 'offline' }
    });

    // Stale セッションクリーンアップ（24時間以上活動がない active セッション → ended）
    const staleThreshold = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const staleSessions = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT s.id FROM "Session" s
      WHERE s.status = 'active'
      AND COALESCE((SELECT MAX(m."createdAt") FROM "Message" m WHERE m."sessionId" = s.id), s."startedAt") < ${staleThreshold}
    `;
    if (staleSessions.length > 0) {
      const staleIds = staleSessions.map(s => s.id);
      await prisma.session.updateMany({ where: { id: { in: staleIds } }, data: { status: 'ended' } });
      // stale セッションの ChannelSession も削除
      await prisma.channelSession.deleteMany({ where: { currentSessionId: { in: staleIds } } });
      console.log(`🧹 Cleaned up ${staleSessions.length} stale active sessions (24h+ inactive)`);
    }
    // #294: 取り残されたクロスプロジェクトセッション（teamexec_ / crossquery_）を ended に
    // これらは HTTP リクエストの生存期間しか意味を持たず、サーバー再起動をまたいで active のままだと
    // document-api.ts の転送ホップ判定（findInflightTeamExec）が誤検知するため確実に閉じる
    const crossResult = await prisma.session.updateMany({
      where: {
        status: 'active',
        OR: [{ id: { startsWith: 'teamexec_' } }, { id: { startsWith: 'crossquery_' } }],
      },
      data: { status: 'ended' },
    });
    if (crossResult.count > 0) {
      console.log(`🧹 Closed ${crossResult.count} stale cross-project session(s) (teamexec/crossquery)`);
    }

    // raw-completion: 取り残された raw_ セッションを ended に（クラッシュ時の active 残骸の掃除）
    const rawResult = await prisma.session.updateMany({
      where: { status: 'active', id: { startsWith: 'raw_' } },
      data: { status: 'ended' },
    });
    if (rawResult.count > 0) {
      console.log(`🧹 Closed ${rawResult.count} stale raw-completion session(s)`);
    }

    // 30分以上経過した pending ツール承認を timeout に
    const approvalResult = await prisma.toolApproval.updateMany({
      where: { status: 'pending', createdAt: { lt: new Date(Date.now() - 30 * 60 * 1000) } },
      data: { status: 'timeout' },
    });
    if (approvalResult.count > 0) {
      console.log(`🧹 Timed out ${approvalResult.count} pending tool approval(s)`);
    }
  });

  // Restore session participants from ChannelSession
  // (So users can continue conversations after server restart)
  await runStartupInitWithTimeout('セッション復元', () => restoreSessionParticipants());

  // Web Push 通知の VAPID キー初期化
  initVapid();

  // FCM（Firebase Cloud Messaging）初期化。サービスアカウント読み込み等で詰まる可能性に備え
  // 同じく非致命・時間制限付きにする
  await runStartupInitWithTimeout('FCM 初期化', async () => { await initFcm(); });

  // #296: Agent 自動更新の定期スイープを開始（接続時トリガーは agent-manager 側）
  startAutoUpdateSweep();

  // サイクルP1: Capability 配布基盤の定期スイープを開始
  startCapabilitySweep();

  // DevRelay Sites Phase 1-A: 公開 site ヘルスチェックの定期スイープを開始
  // （Caddy 設定・ログには一切触れない read-only discovery。DEVRELAY_SITES_HEALTH=0 で無効化可）
  startSiteHealthChecker();

  // DevRelay Sites Phase 1-B: アクセスログ集計（PV/UU/Referer/UTM/bot/4xx5xx）の定期スイープを開始。
  // B1 時点では Caddy 側にログ設定が無いため実質 no-op（cold scan がファイル無しで完了するだけ）。
  // DEVRELAY_SITES_ACCESS_LOG=0 で無効化可。
  startAccessLogAggregator();

  // Plugins
  await app.register(cors, { origin: true });
  await app.register(websocket);

  // Health check
  // bot（discord/telegram）の状態を追加（常に 200 を返す。scripts/install-agent.sh が
  // curl -fsS で疎通判定に使っているため、bot 不調で 500 にしてはならない）。
  app.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString(), bots: getBotsHealth() }));

  // API routes
  await app.register(publicApiRoutes);  // 認証不要のパブリック API（インストーラー用トークン検証など）
  await app.register(agentRepoAuthRoutes);  // 読取PATのサーバー配布サイクル: マシントークン認証の PAT 配布 API
  await app.register(authRoutes);
  await app.register(apiRoutes);
  await app.register(organizationRoutes);  // エンタープライズモード（組織）API
  await app.register(mcpRoutes);  // MCP エンドポイント（/mcp）— 認証は MCP 内部で処理
  registerDocumentApiRoutes(app);  // Agent 向けドキュメント検索 API（マシントークン認証）
  registerAgentDocumentApiRoutes(app);  // エージェントドキュメント CRUD API（WebUI 認証）
  registerRawCompletionRoutes(app);  // raw-completion（ゲーム席用の素の completion API、マシントークン認証）
  await app.register(sitesApiRoutes);  // DevRelay Sites Phase 1-A: 公開 site 一覧・ヘルス（管理者限定・read-only）
  await app.register(knowledgeApiRoutes);  // 高辻ナレッジ サイクル1: 会話ターンのハイブリッド検索 API
  await app.register(knowledgeAdminApiRoutes);  // 高辻ナレッジ サイクル2: 人の権限・案件/スレッドの機密度・スレッド閲覧 API

  // Agent WebSocket endpoint
  app.register(async (fastify) => {
    fastify.get('/ws/agent', { websocket: true }, (connection, req) => {
      setupAgentWebSocket(connection, req);
    });
  });

  // Web Client WebSocket endpoint（ブラウザチャット用）
  app.register(async (fastify) => {
    fastify.get('/ws/web', { websocket: true }, (connection, req) => {
      setupWebClientWebSocket(connection, req);
    });
  });

  // Start heartbeat monitor for agent connection health
  startHeartbeatMonitor();

  // 期限切れ AuthSession の定期クリーンアップ（起動時 + 24時間間隔）
  startExpiredSessionCleanup();

  // Start server
  try {
    await app.listen({ port: PORT, host: HOST });
    console.log(`
┌─────────────────────────────────────────────────┐
│                                                 │
│   🌉 DevRelay Server                           │
│                                                 │
│   HTTP:      http://${HOST}:${PORT}              │
│   WebSocket: ws://${HOST}:${PORT}/ws/agent       │
│                                                 │
│   Status: Running ✅                            │
│                                                 │
└─────────────────────────────────────────────────┘
    `);
    // #319: 稼働中プロセスが最新ビルドをロードしているか一目で判断できるよう、
    // 自身の dist ファイルの mtime を1行ログ出力する（pm2 logs で stale 判定用）
    try {
      const selfPath = fileURLToPath(import.meta.url);
      const buildTime = statSync(selfPath).mtime.toISOString();
      console.log(`🏗️  build: ${buildTime} (${selfPath})`);
    } catch (err) {
      console.warn('⚠️  build timestamp log failed:', err);
    }

    // Discord/Telegram bot の起動は listen 成功後に開始する（await しない）。
    // 2026-10-18 の起動ハング障害の根治: 外部サービスに繋がるかどうかで本体の起動が
    // 左右されないようにし、bot はバックグラウンドで無制限リトライして自力復帰する。
    // listen 前ではなく後にするのは、HTTP/Agent WS が上がる前に Discord メッセージを処理して
    // 「マシンオフライン」を返す事故を避けるため。詳細: `doc/server_listen_hang_20261018.md`。
    startBotSupervisors();
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

// Graceful shutdown
// SIGINT: Ctrl+C（開発時・Linux/macOS 手動停止）
// SIGTERM: pm2/systemd 等の一般的なプロセスマネージャによる停止
// SIGBREAK: Windows サービス（NSSM 等）が送る停止シグナル。Windows には SIGTERM が無いため必須
let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n👋 Shutting down (${signal})...`);
  stopHeartbeatMonitor();
  // pm2 restart 等のオーバーラップで旧プロセスが Telegram の long poll / Discord gateway を
  // 掴んだままだと 409 Conflict や二重応答になるため、bot を確実に破棄する。
  // ただし shutdown 自体が hang しないよう 3 秒で打ち切る（stopBotSupervisors 内部でも race 済み）。
  await stopBotSupervisors();
  await prisma.$disconnect();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGBREAK', () => void shutdown('SIGBREAK'));

// listen 済みの健全なプロセスを bot 側の例外で落とさないための最後の砦。
// ログのみで握りつぶす（2026-10-18 障害の第2の牙 — 裸の promise reject による
// プロセス異常終了 → pm2 再起動ループ — を防ぐ）。
process.on('unhandledRejection', (reason) => {
  console.error('⚠️  Unhandled rejection:', reason);
});

main().catch((err) => {
  console.error('❌ Fatal error during startup:', err);
  process.exit(1);
});
