/**
 * テストフライトサービス管理
 *
 * DevRelay コマンドからサービスの作成・一覧・削除を自動化する。
 * ディレクトリ作成、PostgreSQL DB 作成、Caddy 設定、プレースホルダーページの一括セットアップ。
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { prisma } from '../db/client.js';
import { AGREEMENT_MARKER, AGREEMENT_END_MARKER, DEFAULT_RULES_TEMPLATE } from './agreement-template.js';
import {
  PHASER_TEMPLATE_FILES,
  PHASER_CLAUDE_MD,
  PHASER_PROJECT_RULES,
} from '../templates/phaser-templates.js';

const execAsync = promisify(exec);

/** テストフライトの基本ディレクトリ */
const TESTFLIGHT_BASE_DIR = '/home/devrelay/testflight';
/** テストフライト用ポートの開始番号 */
const TESTFLIGHT_PORT_START = 9001;
/** Caddy のサイト設定ディレクトリ */
const CADDY_SITES_DIR = '/etc/caddy/sites.d';
/** ドメインサフィックス */
const DOMAIN_SUFFIX = 'devrelay.io';

/**
 * サービス名のバリデーション
 * 英小文字で始まり、英小文字・数字・ハイフンで構成、3〜30文字
 * @returns エラーメッセージ（null ならバリデーション成功）
 */
function validateServiceName(name: string): string | null {
  if (!/^[a-z][a-z0-9-]{2,29}$/.test(name)) {
    return '⚠️ サービス名は英小文字で始まり、英小文字・数字・ハイフンで構成、3〜30文字にしてください。';
  }
  // 予約語チェック
  const reserved = ['devrelay', 'app', 'api', 'www', 'mail', 'admin', 'test', 'staging', 'prod'];
  if (reserved.includes(name)) {
    return `⚠️ \`${name}\` は予約済みのため使用できません。`;
  }
  return null;
}

/**
 * 次に利用可能なポート番号を取得
 */
async function getNextPort(): Promise<number> {
  const latest = await prisma.testflightService.findFirst({
    orderBy: { port: 'desc' },
    select: { port: true },
  });
  return latest ? latest.port + 1 : TESTFLIGHT_PORT_START;
}

/**
 * ランダムなパスワードを生成（DB ユーザー用）
 */
function generatePassword(): string {
  return randomBytes(16).toString('hex');
}

/**
 * プレースホルダー HTML を生成
 */
function generatePlaceholderHtml(name: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${name} - Under Construction</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #0f0f23;
      color: #e0e0e0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    .container {
      text-align: center;
      padding: 2rem;
    }
    h1 {
      font-size: 2.5rem;
      margin-bottom: 1rem;
      background: linear-gradient(135deg, #667eea, #764ba2);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .status {
      font-size: 1.2rem;
      color: #888;
      margin-bottom: 2rem;
    }
    .powered-by {
      font-size: 0.85rem;
      color: #555;
    }
    .powered-by a {
      color: #667eea;
      text-decoration: none;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>${name}</h1>
    <p class="status">Under Construction</p>
    <p class="powered-by">Powered by <a href="https://devrelay.io">DevRelay</a> Testflight</p>
  </div>
</body>
</html>`;
}

/**
 * Caddy サイト設定を生成（reverse_proxy + file_server フォールバック）
 * バックエンド未起動時は handle_errors でプレースホルダー HTML を自動表示。
 * ※ /home/devrelay に chmod o+x が必要（Caddy ユーザーがディレクトリを通過できるように）
 */
function generateCaddyConfig(name: string, port: number, directory: string): string {
  return `${name}.${DOMAIN_SUFFIX} {
  reverse_proxy localhost:${port}
  handle_errors {
    rewrite * /index.html
    root * ${directory}/placeholder
    file_server
  }
}
`;
}

/**
 * テンプレートファイル内のプレースホルダーを置換
 */
function replacePlaceholders(content: string, name: string, port: number): string {
  return content.replace(/\{\{NAME\}\}/g, name).replace(/\{\{PORT\}\}/g, String(port));
}

/**
 * Phaser テンプレートを展開（ファイル生成 + pnpm install + build + PM2 起動）
 */
async function deployPhaserTemplate(
  name: string,
  directory: string,
  port: number,
  databaseUrl: string
): Promise<void> {
  console.log(`🎮 testflight [${name}]: deploying phaser template...`);

  // テンプレートファイルを展開
  for (const [relativePath, templateContent] of Object.entries(PHASER_TEMPLATE_FILES)) {
    const filePath = join(directory, relativePath);
    const dirPath = join(directory, relativePath.split('/').slice(0, -1).join('/'));
    if (dirPath !== directory) {
      await mkdir(dirPath, { recursive: true });
    }
    await writeFile(filePath, replacePlaceholders(templateContent, name, port), 'utf-8');
  }
  // public/assets ディレクトリを作成（空）
  await mkdir(join(directory, 'public', 'assets'), { recursive: true });
  console.log(`🎮 testflight [${name}]: template files written`);

  // CLAUDE.md を Phaser 版に上書き
  await writeFile(
    join(directory, 'CLAUDE.md'),
    replacePlaceholders(PHASER_CLAUDE_MD, name, port),
    'utf-8'
  );

  // rules/project.md を Phaser 版に上書き
  await writeFile(
    join(directory, 'rules', 'project.md'),
    PHASER_PROJECT_RULES,
    'utf-8'
  );

  // pnpm install（postinstall で prisma generate も実行される）
  console.log(`🎮 testflight [${name}]: running pnpm install...`);
  await execAsync('pnpm install', { cwd: directory, timeout: 120000 });
  console.log(`🎮 testflight [${name}]: pnpm install done`);

  // Prisma DB push（スキーマを DB に反映）
  // 親プロセス（devrelay-server）の DATABASE_URL は本体 devrelay DB を指すので、
  // 必ず testflight 個別の DATABASE_URL を明示注入する（過去に本体 DB を wipe した事故あり）
  console.log(`🎮 testflight [${name}]: running prisma db push...`);
  await execAsync('npx prisma db push --skip-generate --accept-data-loss', {
    cwd: directory,
    timeout: 60000,
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  console.log(`🎮 testflight [${name}]: prisma db push done`);

  // pnpm build（初回ビルド確認）
  console.log(`🎮 testflight [${name}]: running pnpm build...`);
  await execAsync('pnpm build', { cwd: directory, timeout: 120000 });
  console.log(`🎮 testflight [${name}]: pnpm build done`);

  // PM2 で dev サーバーを起動
  console.log(`🎮 testflight [${name}]: starting PM2 process tf-${name}...`);
  await execAsync(
    `pm2 start "pnpm dev --port ${port} --host 0.0.0.0" --name "tf-${name}" --cwd "${directory}"`,
    { timeout: 30000 }
  );
  await execAsync('pm2 save', { timeout: 10000 });
  console.log(`🎮 testflight [${name}]: PM2 process started`);
}

/**
 * テストフライトサービスを作成
 * @param template テンプレート種別（"phaser" 等、省略時は通常のプレースホルダー）
 */
export async function createTestflightService(userId: string, name: string, template?: string): Promise<string> {
  console.log(`🛫 testflight create: name=${name}, userId=${userId}, template=${template || 'none'}`);

  // 1. バリデーション
  const validationError = validateServiceName(name);
  if (validationError) {
    console.log(`🛫 testflight [${name}]: validation failed: ${validationError}`);
    return validationError;
  }

  // 2. 名前の重複チェック
  const existing = await prisma.testflightService.findUnique({
    where: { name },
  });
  if (existing) {
    console.log(`🛫 testflight [${name}]: already exists (status=${existing.status})`);
    if (existing.status === 'archived') {
      // archived レコードを削除して同名での再作成を許可
      await prisma.testflightService.delete({ where: { id: existing.id } });
      try {
        await execAsync(`rm -rf ${join(TESTFLIGHT_BASE_DIR, name)}`);
      } catch { /* ディレクトリが既にない場合は無視 */ }
      console.log(`🛫 testflight [${name}]: archived record deleted, allowing re-creation`);
    } else {
      return `⚠️ \`${name}\` は既に存在します。\n🌐 https://${name}.${DOMAIN_SUFFIX}`;
    }
  }

  // 3. ポート採番
  const port = await getNextPort();
  const domain = `${name}.${DOMAIN_SUFFIX}`;
  const directory = join(TESTFLIGHT_BASE_DIR, name);
  const dbPassword = generatePassword();
  console.log(`🛫 testflight [${name}]: port=${port}, domain=${domain}`);

  try {
    // 4. ディレクトリ作成
    await mkdir(join(directory, 'placeholder'), { recursive: true });
    console.log(`🛫 testflight [${name}]: mkdir done`);

    // 5. プレースホルダー HTML 配置
    await writeFile(
      join(directory, 'placeholder', 'index.html'),
      generatePlaceholderHtml(name),
      'utf-8'
    );

    // 5.5. Agreement 対応ファイル配置（CLAUDE.md + rules/ + doc/）
    await mkdir(join(directory, 'rules'), { recursive: true });
    await mkdir(join(directory, 'doc'), { recursive: true });

    /** CLAUDE.md にサービス構成情報を含めて生成（AI が即座にホスティング構成を把握できるように） */
    const claudeMdContent = [
      `${AGREEMENT_MARKER}`,
      'See `rules/devrelay.md` for DevRelay rules.',
      `${AGREEMENT_END_MARKER}`,
      '',
      '---',
      '',
      `# ${name}`,
      '',
      '## サービス情報',
      '',
      '| 項目 | 値 |',
      '|------|-----|',
      `| URL | https://${name}.${DOMAIN_SUFFIX} |`,
      `| Port | ${port} |`,
      `| DB | PostgreSQL \`${name}\`（user: \`${name}_user\`） |`,
      `| ディレクトリ | ${directory} |`,
      '',
      '## ホスティング構成',
      '',
      `- **リバースプロキシ**: Caddy（\`${name}.${DOMAIN_SUFFIX}\` → \`localhost:${port}\`）`,
      '- **バックエンド未起動時**: `placeholder/index.html` が自動表示される（Caddy handle_errors フォールバック）',
      `- **開発方法**: ポート ${port} で dev サーバーを起動すれば自動的にプロキシが通る`,
      '- **静的サイト**: `placeholder/index.html` を書き換えるだけでサイト表示が変わる（サーバー不要）',
      '',
      '## 環境変数',
      '',
      '`.env` に設定済み:',
      '- `DATABASE_URL` — PostgreSQL 接続文字列',
      '- `PORT` — サービスのポート番号',
      '',
    ].join('\n');
    await writeFile(join(directory, 'CLAUDE.md'), claudeMdContent, 'utf-8');

    await writeFile(join(directory, 'rules', 'devrelay.md'), DEFAULT_RULES_TEMPLATE, 'utf-8');
    await writeFile(join(directory, 'rules', 'project.md'), '# プロジェクト固有ルール\n', 'utf-8');
    await writeFile(join(directory, 'doc', 'changelog.md'), '# Changelog\n', 'utf-8');
    console.log(`🛫 testflight [${name}]: agreement files done`);

    // 6. .env ファイル作成
    const envContent = [
      `DATABASE_URL="postgresql://${name}_user:${dbPassword}@localhost:5432/${name}"`,
      `PORT=${port}`,
      '',
    ].join('\n');
    await writeFile(join(directory, '.env'), envContent, 'utf-8');

    // 7. PostgreSQL ユーザー・DB 作成
    try {
      await execAsync(
        `sudo -u postgres psql -c 'CREATE USER "${name}_user" WITH PASSWORD $$${dbPassword}$$'`
      );
    } catch (e: any) {
      // ユーザーが既に存在する場合はスキップ
      if (!e.stderr?.includes('already exists')) {
        throw new Error(`PostgreSQL ユーザー作成失敗: ${e.stderr || e.message}`);
      }
    }

    try {
      await execAsync(
        `sudo -u postgres createdb "${name}" -O "${name}_user"`
      );
    } catch (e: any) {
      if (!e.stderr?.includes('already exists')) {
        throw new Error(`PostgreSQL DB 作成失敗: ${e.stderr || e.message}`);
      }
    }
    console.log(`🛫 testflight [${name}]: postgres done`);

    // 8. Caddy 設定ファイル作成（temp file 経由でシェルエスケープ問題を回避）
    const caddyConfig = generateCaddyConfig(name, port, directory);
    const tmpFile = join('/tmp', `caddy-testflight-${name}.conf`);
    await writeFile(tmpFile, caddyConfig, 'utf-8');
    await execAsync(`cat ${tmpFile} | sudo tee ${CADDY_SITES_DIR}/${name}.${DOMAIN_SUFFIX} > /dev/null`);
    await execAsync(`rm ${tmpFile}`);
    console.log(`🛫 testflight [${name}]: caddy config written`);

    // 9. DB にレコード挿入（Caddy reload の前に完了させる）
    await prisma.testflightService.create({
      data: {
        userId,
        name,
        port,
        domain,
        directory,
        status: template ? 'active' : 'placeholder',
        template: template || null,
      },
    });
    console.log(`🛫 testflight [${name}]: db record created`);

    // 9.5. テンプレート展開（Phaser 等）
    if (template === 'phaser') {
      try {
        const databaseUrl = `postgresql://${name}_user:${dbPassword}@localhost:5432/${name}`;
        await deployPhaserTemplate(name, directory, port, databaseUrl);
      } catch (tmplError: any) {
        console.error(`❌ testflight [${name}]: phaser template deploy failed:`, tmplError.message);
        // テンプレート展開失敗してもサービス自体は作成済み。プレースホルダーにフォールバック
        await prisma.testflightService.update({
          where: { name },
          data: { status: 'placeholder', template: null },
        });
        // Caddy reload は続行させる（プレースホルダーページは表示可能）
      }
    }

    // 10. Caddy reload を非同期遅延実行
    // Caddy reload は WS 接続（Agent + WebUI）を一時切断するため、
    // 成功メッセージがクライアントに到達してから実行する
    const caddySiteFile = `${CADDY_SITES_DIR}/${name}.${DOMAIN_SUFFIX}`;
    setTimeout(async () => {
      try {
        await execAsync('caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile');
        await execAsync('sudo systemctl reload caddy');
        console.log(`🛫 testflight [${name}]: caddy reload done (async)`);
      } catch (error: any) {
        console.error(`❌ testflight [${name}]: caddy reload failed (async):`, error.message);
        // validate/reload 失敗時は設定ファイルを削除してロールバック
        try {
          await execAsync(`sudo rm ${caddySiteFile}`);
          console.log(`🛫 testflight [${name}]: rolled back caddy config`);
        } catch { /* 削除失敗は無視 */ }
      }
    }, 2000);

    // 11. 完了メッセージ（reload を待たずに即座に返す）
    const msgLines = [
      `✅ **${name}** を作成しました`,
      '',
      `🌐 https://${domain}`,
      `📁 ${directory}`,
      `🔌 Port: ${port}（dev サーバーをこのポートで起動すると自動で繋がります）`,
      `🗄️ DB: ${name}（PostgreSQL / user: ${name}_user）`,
      `📄 .env に DATABASE_URL, PORT を設定済み`,
    ];
    if (template === 'phaser') {
      msgLines.push('');
      msgLines.push('🎮 Phaser 3 ゲームテンプレートを展開しました');
      msgLines.push('🎯 サンプル: 棒消し（Nim）対戦ゲーム + 管理画面（/stats）');
      msgLines.push(`⚡ PM2 プロセス: tf-${name}（HMR 対応 dev サーバー常駐）`);
    }
    msgLines.push(`⏳ ドメイン反映まで数秒かかる場合があります`);
    const msg = msgLines.join('\n');
    console.log(`🛫 testflight [${name}]: returning success message (${msg.length} chars)`);
    return msg;

  } catch (error: any) {
    console.error(`❌ testflight create error [${name}]:`, error);
    return `❌ サービス作成に失敗しました: ${error.message}`;
  }
}

/**
 * テストフライトサービスの一覧を取得
 */
export async function listTestflightServices(userId: string): Promise<string> {
  const services = await prisma.testflightService.findMany({
    where: { userId, status: { not: 'archived' } },
    orderBy: { createdAt: 'desc' },
  });

  if (services.length === 0) {
    return [
      '📋 **Testflight サービス一覧**',
      '',
      '登録されたサービスはありません。',
      '',
      '`testflight <name>` で新規作成できます。',
    ].join('\n');
  }

  const statusEmoji: Record<string, string> = {
    placeholder: '🚧',
    active: '🟢',
    archived: '📦',
  };

  const lines = services.map((s) => {
    const emoji = statusEmoji[s.status] || '❓';
    const tmpl = s.template ? ` [${s.template}]` : '';
    return `${emoji} **${s.name}**${tmpl} — https://${s.domain} (port ${s.port})`;
  });

  return [
    `📋 **Testflight サービス一覧** (${services.length}件)`,
    '',
    ...lines,
    '',
    '`testflight <name>` で新規作成、`testflight info <name>` で詳細表示',
  ].join('\n');
}

/**
 * テストフライトサービスを削除（アーカイブ）
 */
export async function removeTestflightService(userId: string, name: string): Promise<string> {
  const service = await prisma.testflightService.findFirst({
    where: { name, userId },
  });

  if (!service) {
    return `⚠️ \`${name}\` が見つかりません。\`testflight\` で一覧を確認してください。`;
  }

  if (service.status === 'archived') {
    return `⚠️ \`${name}\` は既にアーカイブ済みです。`;
  }

  try {
    // PM2 プロセス停止・削除（テンプレートサービスの場合）
    if (service.template) {
      try {
        await execAsync(`pm2 delete tf-${name}`);
        await execAsync('pm2 save');
        console.log(`🛫 testflight [${name}]: PM2 process tf-${name} deleted`);
      } catch (e: any) {
        console.warn(`PM2 cleanup warning: ${e.message}`);
      }
    }

    // Caddy 設定ファイル削除（設定は即削除、reload は遅延実行）
    try {
      await execAsync(`sudo rm ${CADDY_SITES_DIR}/${name}.${DOMAIN_SUFFIX}`);
    } catch (e: any) {
      console.warn(`Caddy config removal warning: ${e.message}`);
    }
    // Caddy reload を遅延実行（応答がクライアントに届いてから実行。同期だと WS 切断で応答欠落する）
    setTimeout(async () => {
      try {
        await execAsync('sudo systemctl reload caddy');
        console.log(`🛫 testflight [${name}]: caddy reload done (async)`);
      } catch (e: any) {
        console.warn(`🛫 testflight [${name}]: caddy reload warning: ${e.message}`);
      }
    }, 2000);

    // PostgreSQL DB・ユーザー削除
    try {
      await execAsync(`sudo -u postgres dropdb --if-exists "${name}"`);
      await execAsync(`sudo -u postgres dropuser --if-exists "${name}_user"`);
    } catch (e: any) {
      console.warn(`PostgreSQL cleanup warning: ${e.message}`);
    }

    // ステータスを archived に更新
    await prisma.testflightService.update({
      where: { id: service.id },
      data: { status: 'archived' },
    });

    return [
      `📦 **${name}** をアーカイブしました`,
      '',
      `🌐 https://${service.domain} は無効化されました`,
      `🗄️ DB \`${name}\` は削除されました`,
      `📁 ディレクトリ ${service.directory} は残っています（手動で削除可能）`,
    ].join('\n');

  } catch (error: any) {
    console.error(`❌ testflight remove error:`, error);
    return `❌ アーカイブに失敗しました: ${error.message}`;
  }
}

/**
 * テストフライトサービスを複製
 * ディレクトリ・PostgreSQL DB・Caddy 設定・PM2 プロセスを丸ごとコピーする。
 */
export async function copyTestflightService(userId: string, srcName: string, destName: string): Promise<string> {
  console.log(`📋 testflight cp: ${srcName} → ${destName}, userId=${userId}`);

  // 1. 新名前のバリデーション
  const validationError = validateServiceName(destName);
  if (validationError) {
    return validationError;
  }

  // 2. コピー元の存在確認
  const srcService = await prisma.testflightService.findFirst({
    where: { name: srcName, userId },
  });
  if (!srcService) {
    return `⚠️ \`${srcName}\` が見つかりません。\`testflight\` で一覧を確認してください。`;
  }
  if (srcService.status === 'archived') {
    return `⚠️ \`${srcName}\` はアーカイブ済みのためコピーできません。`;
  }

  // 3. コピー先の重複チェック
  const existing = await prisma.testflightService.findUnique({
    where: { name: destName },
  });
  if (existing) {
    if (existing.status === 'archived') {
      return `⚠️ \`${destName}\` はアーカイブ済みです。別の名前を使用してください。`;
    }
    return `⚠️ \`${destName}\` は既に存在します。\n🌐 https://${destName}.${DOMAIN_SUFFIX}`;
  }

  // 4. ポート採番
  const port = await getNextPort();
  const domain = `${destName}.${DOMAIN_SUFFIX}`;
  const destDir = join(TESTFLIGHT_BASE_DIR, destName);
  const dbPassword = generatePassword();
  console.log(`📋 testflight cp [${destName}]: port=${port}, domain=${domain}`);

  try {
    // 5. ディレクトリ複製
    await execAsync(`cp -a ${join(TESTFLIGHT_BASE_DIR, srcName)} ${destDir}`);
    console.log(`📋 testflight cp [${destName}]: directory copied`);

    // 6. ファイル内容書き換え
    // 6a. .env を新しい接続情報で上書き
    const envContent = [
      `DATABASE_URL="postgresql://${destName}_user:${dbPassword}@localhost:5432/${destName}"`,
      `PORT=${port}`,
      '',
    ].join('\n');
    await writeFile(join(destDir, '.env'), envContent, 'utf-8');

    // 6b. プレースホルダー HTML を再生成
    await writeFile(
      join(destDir, 'placeholder', 'index.html'),
      generatePlaceholderHtml(destName),
      'utf-8'
    );

    // 6c. CLAUDE.md のサービス情報を書き換え（src 名を dest 名に、ポートも更新）
    try {
      const { readFile } = await import('fs/promises');
      let claudeMd = await readFile(join(destDir, 'CLAUDE.md'), 'utf-8');
      claudeMd = claudeMd
        .replace(new RegExp(srcName, 'g'), destName)
        .replace(new RegExp(String(srcService.port), 'g'), String(port));
      await writeFile(join(destDir, 'CLAUDE.md'), claudeMd, 'utf-8');
    } catch (e: any) {
      console.warn(`📋 testflight cp [${destName}]: CLAUDE.md rewrite skipped: ${e.message}`);
    }

    // 6d. vite.config.ts のホスト名を書き換え（allowedHosts 対応）
    try {
      const { readFile } = await import('fs/promises');
      const viteConfigPath = join(destDir, 'vite.config.ts');
      let viteConfig = await readFile(viteConfigPath, 'utf-8');
      viteConfig = viteConfig.replace(
        new RegExp(`${srcName}\\.devrelay\\.io`, 'g'),
        `${destName}.devrelay.io`
      );
      await writeFile(viteConfigPath, viteConfig, 'utf-8');
    } catch (e: any) {
      console.warn(`📋 testflight cp [${destName}]: vite.config.ts rewrite skipped: ${e.message}`);
    }

    // 7. PostgreSQL 複製
    // 7a. 新ユーザー作成
    try {
      await execAsync(
        `sudo -u postgres psql -c 'CREATE USER "${destName}_user" WITH PASSWORD $$${dbPassword}$$'`
      );
    } catch (e: any) {
      if (!e.stderr?.includes('already exists')) {
        throw new Error(`PostgreSQL ユーザー作成失敗: ${e.stderr || e.message}`);
      }
    }

    // 7b. 新 DB 作成
    try {
      await execAsync(`sudo -u postgres createdb "${destName}" -O "${destName}_user"`);
    } catch (e: any) {
      if (!e.stderr?.includes('already exists')) {
        throw new Error(`PostgreSQL DB 作成失敗: ${e.stderr || e.message}`);
      }
    }

    // 7c. データフルコピー（pg_dump | psql）
    try {
      await execAsync(
        `sudo -u postgres pg_dump "${srcName}" | sudo -u postgres psql "${destName}"`,
        { timeout: 120000 }
      );
      console.log(`📋 testflight cp [${destName}]: pg_dump → psql done`);
    } catch (e: any) {
      console.warn(`📋 testflight cp [${destName}]: pg_dump warning: ${e.message}`);
    }

    // 7d. 新ユーザーに権限付与
    try {
      await execAsync(
        `sudo -u postgres psql -d "${destName}" -c 'GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO "${destName}_user"; GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO "${destName}_user";'`
      );
    } catch (e: any) {
      console.warn(`📋 testflight cp [${destName}]: grant warning: ${e.message}`);
    }
    console.log(`📋 testflight cp [${destName}]: postgres done`);

    // 8. Caddy 設定作成
    const caddyConfig = generateCaddyConfig(destName, port, destDir);
    const tmpFile = join('/tmp', `caddy-testflight-${destName}.conf`);
    await writeFile(tmpFile, caddyConfig, 'utf-8');
    await execAsync(`cat ${tmpFile} | sudo tee ${CADDY_SITES_DIR}/${destName}.${DOMAIN_SUFFIX} > /dev/null`);
    await execAsync(`rm ${tmpFile}`);
    console.log(`📋 testflight cp [${destName}]: caddy config written`);

    // 9. DB レコード作成（src の template/status を引き継ぎ）
    await prisma.testflightService.create({
      data: {
        userId,
        name: destName,
        port,
        domain,
        directory: destDir,
        status: srcService.status,
        template: srcService.template,
      },
    });
    console.log(`📋 testflight cp [${destName}]: db record created`);

    // 10. PM2 起動（テンプレートサービスの場合）
    if (srcService.template) {
      try {
        await execAsync(
          `pm2 start "pnpm dev --port ${port} --host 0.0.0.0" --name "tf-${destName}" --cwd "${destDir}"`,
          { timeout: 30000 }
        );
        await execAsync('pm2 save', { timeout: 10000 });
        console.log(`📋 testflight cp [${destName}]: PM2 process tf-${destName} started`);
      } catch (e: any) {
        console.warn(`📋 testflight cp [${destName}]: PM2 start warning: ${e.message}`);
      }
    }

    // 11. Caddy reload（2秒遅延で非同期実行）
    const caddySiteFile = `${CADDY_SITES_DIR}/${destName}.${DOMAIN_SUFFIX}`;
    setTimeout(async () => {
      try {
        await execAsync('caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile');
        await execAsync('sudo systemctl reload caddy');
        console.log(`📋 testflight cp [${destName}]: caddy reload done (async)`);
      } catch (error: any) {
        console.error(`❌ testflight cp [${destName}]: caddy reload failed (async):`, error.message);
        try {
          await execAsync(`sudo rm ${caddySiteFile}`);
        } catch { /* 削除失敗は無視 */ }
      }
    }, 2000);

    // 12. 完了メッセージ
    const msgLines = [
      `✅ **${srcName}** → **${destName}** に複製しました`,
      '',
      `🌐 https://${domain}`,
      `📁 ${destDir}`,
      `🔌 Port: ${port}`,
      `🗄️ DB: ${destName}（user: ${destName}_user / データコピー済み）`,
    ];
    if (srcService.template) {
      msgLines.push(`⚡ PM2 プロセス: tf-${destName}`);
    }
    msgLines.push(`⏳ ドメイン反映まで数秒かかる場合があります`);
    return msgLines.join('\n');

  } catch (error: any) {
    console.error(`❌ testflight cp error [${destName}]:`, error);
    return `❌ 複製に失敗しました: ${error.message}`;
  }
}

/**
 * テストフライトサービスの詳細を表示
 */
export async function getTestflightServiceInfo(userId: string, name: string): Promise<string> {
  const service = await prisma.testflightService.findFirst({
    where: { name, userId },
  });

  if (!service) {
    return `⚠️ \`${name}\` が見つかりません。\`testflight\` で一覧を確認してください。`;
  }

  const statusLabel: Record<string, string> = {
    placeholder: '🚧 プレースホルダー（バックエンド未起動）',
    active: '🟢 アクティブ',
    archived: '📦 アーカイブ済み',
  };

  return [
    `📋 **${service.name}** の詳細`,
    '',
    `🌐 https://${service.domain}`,
    `📁 ${service.directory}`,
    `🔌 Port: ${service.port}`,
    `🗄️ DB: ${service.name}（user: ${service.name}_user）`,
    `📊 Status: ${statusLabel[service.status] || service.status}`,
    `📅 作成日: ${service.createdAt.toISOString().slice(0, 10)}`,
    service.gitRepo ? `🔗 Git: ${service.gitRepo}` : '',
    service.description ? `📝 ${service.description}` : '',
  ].filter(Boolean).join('\n');
}
