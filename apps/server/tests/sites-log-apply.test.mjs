// DevRelay Sites Phase 1-B — pre-W2 必須修正（サイクル1.9）: site-log-apply.ts の単体テスト。
// 適用冪等性・パス制約・manifest round-trip・exact batch rollback・adapt 構造検証を固定する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertSitesDPath,
  detectAppliedState,
  classifyHostForApply,
  applyLogConfig,
  replaceLegacyLogWithSnippetImport,
  assertNoReservedMatcherCollision,
  newBatchId,
  isValidBatchId,
  sha256Hex,
  parseManifest,
  planRollback,
  verifyAdaptedConfig,
} from '../dist/services/sites/site-log-apply.js';
import { isEligibleForAutoLog } from '../dist/services/sites/site-log-rules.js';

const HOST = 'tetris.devrelay.io';
const ROLL_CONFIG = { rollSize: '64MiB', rollKeep: 12, rollKeepFor: '1440h', provisional: false };

function baseSiteContent(host = HOST) {
  return [
    `${host} {`,
    '  reverse_proxy localhost:9010',
    '  handle_errors {',
    '    rewrite * /index.html',
    '    root * /home/devrelay/testflight/tetris/placeholder',
    '    file_server',
    '  }',
    '}',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// assertSitesDPath（要件 B・パス制約）
// ---------------------------------------------------------------------------

test('assertSitesDPath: sites.d 配下の正常なパスは通る', () => {
  assert.doesNotThrow(() => assertSitesDPath('/etc/caddy/sites.d/tetris.devrelay.io'));
});

test('assertSitesDPath: 相対パスは拒否', () => {
  assert.throws(() => assertSitesDPath('etc/caddy/sites.d/tetris.devrelay.io'));
});

test('assertSitesDPath: path traversal（../）は拒否', () => {
  assert.throws(() => assertSitesDPath('/etc/caddy/sites.d/../Caddyfile'));
});

test('assertSitesDPath: sites.d 外のパスは拒否', () => {
  assert.throws(() => assertSitesDPath('/etc/caddy/Caddyfile'));
  assert.throws(() => assertSitesDPath('/etc/passwd'));
});

test('assertSitesDPath: サブディレクトリは拒否（sites.d 直下のみ許可）', () => {
  assert.throws(() => assertSitesDPath('/etc/caddy/sites.d/sub/host'));
});

test('assertSitesDPath: 空文字・NUL 文字は拒否', () => {
  assert.throws(() => assertSitesDPath(''));
  assert.throws(() => assertSitesDPath('/etc/caddy/sites.d/foo\0bar'));
});

// ---------------------------------------------------------------------------
// detectAppliedState / classifyHostForApply（要件 A: 冪等化の核心）
// ---------------------------------------------------------------------------

test('detectAppliedState: 未適用の内容は mode=none', () => {
  const state = detectAppliedState(baseSiteContent());
  assert.equal(state.mode, 'none');
  assert.equal(state.importCount, 0);
  assert.equal(state.inlineLogCount, 0);
});

test('detectAppliedState: import が 1 個なら mode=snippet', () => {
  const content = baseSiteContent().replace('{\n', '{\n\timport sites_access_log\n');
  const state = detectAppliedState(content);
  assert.equal(state.mode, 'snippet');
  assert.equal(state.importCount, 1);
});

test('detectAppliedState: import が 2 個なら importCount=2（mode は snippet のまま・呼び出し側で inconsistent 判定）', () => {
  const content = baseSiteContent().replace('{\n', '{\n\timport sites_access_log\n\timport sites_access_log\n');
  const state = detectAppliedState(content);
  assert.equal(state.importCount, 2);
});

test('classifyHostForApply: 8 行 host（未適用）は eligible', () => {
  const c = classifyHostForApply(HOST, baseSiteContent(), isEligibleForAutoLog);
  assert.equal(c.kind, 'eligible');
});

test('classifyHostForApply: 1 回適用後（9 行）は already-applied（eligible ではない = F3 の穴を塞ぐ）', () => {
  const applied = applyLogConfig(HOST, baseSiteContent(), 'snippet', ROLL_CONFIG, false).updated;
  const c = classifyHostForApply(HOST, applied, isEligibleForAutoLog);
  assert.equal(c.kind, 'already-applied');
  assert.equal(c.state.mode, 'snippet');
});

test('classifyHostForApply: import が 2 個混入した内容は inconsistent（run 全体を中止すべき）', () => {
  const content = baseSiteContent().replace('{\n', '{\n\timport sites_access_log\n\timport sites_access_log\n');
  const c = classifyHostForApply(HOST, content, isEligibleForAutoLog);
  assert.equal(c.kind, 'inconsistent');
});

test('classifyHostForApply: snippet と inline が混在した内容は inconsistent', () => {
  const content = baseSiteContent().replace(
    '{\n',
    '{\n\timport sites_access_log\n\tlog {\n\t\toutput file /var/log/caddy/sites/sites.access.log {\n\t\t}\n\t}\n',
  );
  const c = classifyHostForApply(HOST, content, isEligibleForAutoLog);
  assert.equal(c.kind, 'inconsistent');
});

test('classifyHostForApply: 手編集の長い設定（9行超・未適用）は ineligible', () => {
  const lines = ['pixterm-server.devrelay.io {', '  reverse_proxy localhost:9001'];
  for (let i = 0; i < 20; i++) lines.push(`  # extra line ${i}`);
  lines.push('}');
  const c = classifyHostForApply('pixterm-server.devrelay.io', lines.join('\n'), isEligibleForAutoLog);
  assert.equal(c.kind, 'ineligible');
});

// ---------------------------------------------------------------------------
// applyLogConfig（冪等性・自己検査）
// ---------------------------------------------------------------------------

test('applyLogConfig: snippet mode で import 1 行のみ挿入される', () => {
  const { updated, changed } = applyLogConfig(HOST, baseSiteContent(), 'snippet', ROLL_CONFIG, false);
  assert.equal(changed, true);
  const importCount = (updated.match(/import sites_access_log/g) ?? []).length;
  assert.equal(importCount, 1);
});

test('applyLogConfig: skip ルールがある host（dangou）には skip matcher も 1 個挿入される', () => {
  const dangouContent = baseSiteContent('dangou-card-viewer.devrelay.io');
  const { updated } = applyLogConfig('dangou-card-viewer.devrelay.io', dangouContent, 'snippet', ROLL_CONFIG, true);
  const matcherCount = (updated.match(/@drl_skip_poll_game_state/g) ?? []).length;
  // matcher 定義 1 回 + log_skip 1 回 = 2 回
  assert.equal(matcherCount, 2);
});

test('applyLogConfig: 既に適用済みの内容へ再度適用しようとすると import が重複し自己検査で throw する', () => {
  const applied = applyLogConfig(HOST, baseSiteContent(), 'snippet', ROLL_CONFIG, false).updated;
  assert.throws(() => applyLogConfig(HOST, applied, 'snippet', ROLL_CONFIG, false));
});

test('applyLogConfig: inline mode でも自己検査を通過する（health skip 込み）', () => {
  const { updated, changed } = applyLogConfig(HOST, baseSiteContent(), 'inline', ROLL_CONFIG, false);
  assert.equal(changed, true);
  assert.match(updated, /header User-Agent DevRelay-Sites\/1\.0/);
});

test('assertNoReservedMatcherCollision: 現在の SITE_LOG_RULES では衝突しない', () => {
  assert.doesNotThrow(() => assertNoReservedMatcherCollision());
});

// ---------------------------------------------------------------------------
// replaceLegacyLogWithSnippetImport（W4: 既存独自 logger の置換）
// ---------------------------------------------------------------------------

function legacySiteContent(host, legacyLogBlock) {
  return `${host} {\n\treverse_proxy localhost:9010${legacyLogBlock}}\n`;
}

test('replaceLegacyLogWithSnippetImport: legacy log ブロックを除去し import を 1 個だけ挿入する', () => {
  const legacyLogBlock = '\n\n\tlog {\n\t\toutput file /var/log/caddy/legacy.access.log {\n\t\t\troll_size 50MiB\n\t\t}\n\t}\n';
  const content = legacySiteContent('legacy.example.com', legacyLogBlock);
  const { updated, changed } = replaceLegacyLogWithSnippetImport('legacy.example.com', content, legacyLogBlock, ROLL_CONFIG);
  assert.equal(changed, true);
  assert.equal(updated.includes('legacy.access.log'), false);
  const state = detectAppliedState(updated);
  assert.equal(state.mode, 'snippet');
  assert.equal(state.importCount, 1);
  assert.equal(state.inlineLogCount, 0);
});

test('replaceLegacyLogWithSnippetImport: 複数 host を持つ 1 ブロックでも import は 1 個のみ', () => {
  const legacyLogBlock = '\n\n\tlog {\n\t\toutput file /home/foo/access.log {\n\t\t\tmode 0644\n\t\t}\n\t}\n';
  const content = `hostA.example.com, hostB.example.com {\n\troot * /var/www${legacyLogBlock}}\n`;
  const { updated } = replaceLegacyLogWithSnippetImport('hostA.example.com,hostB.example.com', content, legacyLogBlock, ROLL_CONFIG);
  assert.match(updated, /^hostA\.example\.com, hostB\.example\.com \{\n\timport sites_access_log\n/);
  assert.equal(updated.includes('/home/foo/access.log'), false);
});

test('replaceLegacyLogWithSnippetImport: legacy ブロックが 0 回（見つからない）なら throw', () => {
  const content = legacySiteContent('legacy.example.com', '\n\n');
  assert.throws(() => replaceLegacyLogWithSnippetImport('legacy.example.com', content, '\n\tlog { does-not-exist }\n', ROLL_CONFIG));
});

test('replaceLegacyLogWithSnippetImport: legacy ブロックが 2 回以上出現したら throw（二重適用の疑い）', () => {
  const legacyLogBlock = '\n\n\tlog {\n\t\toutput file /var/log/caddy/legacy.access.log {\n\t\t}\n\t}\n';
  const content = `dup.example.com {\n\treverse_proxy localhost:9010${legacyLogBlock}${legacyLogBlock}}\n`;
  assert.throws(() => replaceLegacyLogWithSnippetImport('dup.example.com', content, legacyLogBlock, ROLL_CONFIG));
});

// ---------------------------------------------------------------------------
// backup manifest（要件 C・D・E）
// ---------------------------------------------------------------------------

test('newBatchId / isValidBatchId: 生成した ID は自身の validator を通る', () => {
  const id = newBatchId(new Date('2026-09-23T13:36:42.123Z'), 'deadbeef');
  assert.equal(isValidBatchId(id), true);
});

test('isValidBatchId: 部分一致を狙った文字列は無効（exact batch matching の基盤）', () => {
  const id = newBatchId(new Date('2026-09-23T13:36:42.123Z'), 'deadbeef');
  assert.equal(isValidBatchId(id.slice(0, 10)), false);
  assert.equal(isValidBatchId(`${id}-extra`), false);
  assert.equal(isValidBatchId('../etc/passwd'), false);
  assert.equal(isValidBatchId(''), false);
});

test('parseManifest: 正常な manifest を受理する', () => {
  const raw = {
    version: 1,
    batchId: newBatchId(new Date(), 'cafebabe'),
    createdAt: new Date().toISOString(),
    mode: 'snippet',
    target: 'rollout',
    rollConfig: ROLL_CONFIG,
    entries: [
      {
        originalPath: '/etc/caddy/sites.d/tetris.devrelay.io',
        action: 'modified',
        backupFile: 'b0001.bak',
        sha256Before: sha256Hex('before'),
        sha256After: sha256Hex('after'),
      },
    ],
  };
  const manifest = parseManifest(raw);
  assert.equal(manifest.entries.length, 1);
});

test('parseManifest: entries が空の manifest は拒否（fail-closed）', () => {
  const raw = {
    version: 1,
    batchId: newBatchId(new Date(), '01234567'),
    createdAt: new Date().toISOString(),
    mode: 'snippet',
    target: 'rollout',
    rollConfig: ROLL_CONFIG,
    entries: [],
  };
  assert.throws(() => parseManifest(raw));
});

test('parseManifest: originalPath が sites.d 外を指す manifest は拒否（汚染 manifest への耐性）', () => {
  const raw = {
    version: 1,
    batchId: newBatchId(new Date(), '89abcdef'),
    createdAt: new Date().toISOString(),
    mode: 'snippet',
    target: 'rollout',
    rollConfig: ROLL_CONFIG,
    entries: [
      { originalPath: '/etc/passwd', action: 'modified', backupFile: 'b0001.bak', sha256Before: 'a', sha256After: 'b' },
    ],
  };
  assert.throws(() => parseManifest(raw));
});

test('manifest round-trip: アンダースコアを含む originalPath でも情報が失われない（`/`→`_` 逆変換の廃止）', () => {
  // 旧方式（backupName.replace(/_/g, '/')）ならこのパスは
  // `/etc/caddy/sites.d/my/site.example.com` のように誤って復元されていた。
  // manifest 方式では originalPath を文字列としてそのまま保持するため往復が安全。
  const originalPath = '/etc/caddy/sites.d/my_site.example.com';
  const raw = {
    version: 1,
    batchId: newBatchId(new Date(), 'fedcba98'),
    createdAt: new Date().toISOString(),
    mode: 'snippet',
    target: 'rollout',
    rollConfig: ROLL_CONFIG,
    entries: [
      { originalPath, action: 'modified', backupFile: 'b0001.bak', sha256Before: sha256Hex('x'), sha256After: sha256Hex('y') },
    ],
  };
  const manifest = parseManifest(raw);
  assert.equal(manifest.entries[0].originalPath, originalPath);
});

// ---------------------------------------------------------------------------
// planRollback（要件 D・E: exact batch matching・新規作成物の一般化）
// ---------------------------------------------------------------------------

function makeManifest(entries) {
  return {
    version: 1,
    batchId: newBatchId(new Date(), '11223344'),
    createdAt: new Date().toISOString(),
    mode: 'snippet',
    target: 'rollout',
    rollConfig: ROLL_CONFIG,
    entries,
  };
}

test('planRollback: modified entry で現在値が sha256After と一致すれば restore を計画する', () => {
  const path = '/etc/caddy/sites.d/tetris.devrelay.io';
  const manifest = makeManifest([
    { originalPath: path, action: 'modified', backupFile: 'b0001.bak', sha256Before: sha256Hex('before'), sha256After: sha256Hex('after') },
  ]);
  const ops = planRollback(manifest, new Map([[path, sha256Hex('after')]]));
  assert.equal(ops.length, 1);
  assert.equal(ops[0].kind, 'restore');
});

test('planRollback: 新規作成（created）entry は delete を計画する', () => {
  const path = '/etc/caddy/sites.d/00-snippets';
  const manifest = makeManifest([
    { originalPath: path, action: 'created', backupFile: null, sha256Before: null, sha256After: sha256Hex('snippet') },
  ]);
  const ops = planRollback(manifest, new Map([[path, sha256Hex('snippet')]]));
  assert.equal(ops.length, 1);
  assert.equal(ops[0].kind, 'delete');
});

test('planRollback: created entry が既に存在しない場合は delete 不要（計画から除外）', () => {
  const path = '/etc/caddy/sites.d/00-snippets';
  const manifest = makeManifest([
    { originalPath: path, action: 'created', backupFile: null, sha256Before: null, sha256After: sha256Hex('snippet') },
  ]);
  const ops = planRollback(manifest, new Map());
  assert.equal(ops.length, 0);
});

test('planRollback: 適用後に別の変更が入っている（sha256 不一致）場合は drift として報告する', () => {
  const path = '/etc/caddy/sites.d/tetris.devrelay.io';
  const manifest = makeManifest([
    { originalPath: path, action: 'modified', backupFile: 'b0001.bak', sha256Before: sha256Hex('before'), sha256After: sha256Hex('after') },
  ]);
  const ops = planRollback(manifest, new Map([[path, sha256Hex('someone-else-edited-this')]]));
  assert.equal(ops.length, 1);
  assert.equal(ops[0].kind, 'drift');
});

test('planRollback: modified entry のファイルが消えている場合も drift として報告する', () => {
  const path = '/etc/caddy/sites.d/tetris.devrelay.io';
  const manifest = makeManifest([
    { originalPath: path, action: 'modified', backupFile: 'b0001.bak', sha256Before: sha256Hex('before'), sha256After: sha256Hex('after') },
  ]);
  const ops = planRollback(manifest, new Map());
  assert.equal(ops.length, 1);
  assert.equal(ops[0].kind, 'drift');
});

// ---------------------------------------------------------------------------
// verifyAdaptedConfig（W2 前ゲート: caddy adapt 出力の構造検証）
// ---------------------------------------------------------------------------

function adaptJsonFor(loggerNamesByHost, sitesLoggerKeys, rollWriter, extraHealthOccurrences = 0) {
  const logs = {};
  for (const key of sitesLoggerKeys) {
    logs[key] = { writer: { filename: '/var/log/caddy/sites/sites.access.log', ...rollWriter } };
  }
  return {
    apps: { http: { servers: { srv0: { logs: { logger_names: loggerNamesByHost } } } } },
    logging: { logs },
    __healthPad: 'DevRelay-Sites/1.0 '.repeat(extraHealthOccurrences),
  };
}

test('verifyAdaptedConfig: 1 host = 1 logger・roll 1 種・health matcher 数一致なら PASS', () => {
  const json = adaptJsonFor(
    { 'a.example.com': ['log0'], 'b.example.com': ['log1'] },
    ['log0', 'log1'],
    { roll_size_mb: 64, roll_keep: 12, roll_keep_days: 60 },
    2, // 2 host 分の health matcher（logger 数と一致させる）
  );
  const result = verifyAdaptedConfig(json, { hosts: ['a.example.com', 'b.example.com'], blocks: 2, rollConfig: ROLL_CONFIG });
  assert.equal(result.ok, true, JSON.stringify(result.failures));
  assert.equal(result.stats.loggerCount, 2);
});

test('verifyAdaptedConfig: 1 host に複数 logger（二重適用相当）は FAIL', () => {
  const json = adaptJsonFor(
    { 'a.example.com': ['log0', 'log1'] },
    ['log0', 'log1'],
    { roll_size_mb: 64, roll_keep: 12, roll_keep_days: 60 },
    2,
  );
  const result = verifyAdaptedConfig(json, { hosts: ['a.example.com'], blocks: 2, rollConfig: ROLL_CONFIG });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.includes('1 host = 1 logger')));
  assert.deepEqual(result.stats.multiLoggerHosts, ['a.example.com']);
});

test('verifyAdaptedConfig: roll 設定が複数種類混在していれば FAIL', () => {
  const json = {
    apps: { http: { servers: { srv0: { logs: { logger_names: { 'a.example.com': ['log0'], 'b.example.com': ['log1'] } } } } } },
    logging: {
      logs: {
        log0: { writer: { filename: '/var/log/caddy/sites/sites.access.log', roll_size_mb: 64, roll_keep: 12, roll_keep_days: 60 } },
        log1: { writer: { filename: '/var/log/caddy/sites/sites.access.log', roll_size_mb: 32, roll_keep: 8, roll_keep_days: 7 } },
      },
    },
    __healthPad: 'DevRelay-Sites/1.0 DevRelay-Sites/1.0 ',
  };
  const result = verifyAdaptedConfig(json, { hosts: ['a.example.com', 'b.example.com'], blocks: 2, rollConfig: ROLL_CONFIG });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.includes('roll 設定')));
});

test('verifyAdaptedConfig: health matcher の出現数が logger 数と不一致なら FAIL', () => {
  const json = adaptJsonFor(
    { 'a.example.com': ['log0'], 'b.example.com': ['log1'] },
    ['log0', 'log1'],
    { roll_size_mb: 64, roll_keep: 12, roll_keep_days: 60 },
    1, // logger は 2 個なのに health matcher は 1 回しか無い
  );
  const result = verifyAdaptedConfig(json, { hosts: ['a.example.com', 'b.example.com'], blocks: 2, rollConfig: ROLL_CONFIG });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.includes('health matcher')));
});

test('verifyAdaptedConfig: 期待 host に logger が無ければ FAIL', () => {
  const json = adaptJsonFor({ 'a.example.com': ['log0'] }, ['log0'], { roll_size_mb: 64, roll_keep: 12, roll_keep_days: 60 }, 1);
  const result = verifyAdaptedConfig(json, { hosts: ['a.example.com', 'missing.example.com'], blocks: 1, rollConfig: ROLL_CONFIG });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.includes('missing.example.com')));
});

// ---------------------------------------------------------------------------
// verifyAdaptedConfig: blocks/hosts 分離（W4: 1 block が複数 host を担当するケース）
// ---------------------------------------------------------------------------

test('verifyAdaptedConfig（W4）: 1 block が 2 host（apex+www）を担当しても PASS する（host 数 > block 数）', () => {
  // ribbon-re.jp, www.ribbon-re.jp { ... } のように、2 host が同一 logger を指す状態を模す。
  const json = adaptJsonFor(
    { 'a.example.com': ['log0'], 'apex.example.com': ['log1'], 'www.example.com': ['log1'] },
    ['log0', 'log1'],
    { roll_size_mb: 64, roll_keep: 12, roll_keep_days: 60 },
    2, // block 数と一致（host 数ではない）
  );
  const result = verifyAdaptedConfig(json, {
    hosts: ['a.example.com', 'apex.example.com', 'www.example.com'],
    blocks: 2,
    rollConfig: ROLL_CONFIG,
  });
  assert.equal(result.ok, true, JSON.stringify(result.failures));
  assert.equal(result.stats.loggerCount, 2);
  assert.deepEqual(result.stats.multiLoggerHosts, []);
});

test('verifyAdaptedConfig（W4）: block 数が期待と不一致なら host 数が一致していても FAIL', () => {
  const json = adaptJsonFor(
    { 'apex.example.com': ['log0'], 'www.example.com': ['log0'] },
    ['log0'],
    { roll_size_mb: 64, roll_keep: 12, roll_keep_days: 60 },
    1,
  );
  // hosts は揃っているが blocks の期待値を意図的に 2 にする（1 logger を見落として2つあるべきと誤認した場合の検知）
  const result = verifyAdaptedConfig(json, {
    hosts: ['apex.example.com', 'www.example.com'],
    blocks: 2,
    rollConfig: ROLL_CONFIG,
  });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.includes('logger 数が期待値と不一致')));
});
