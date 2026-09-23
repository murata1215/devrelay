// DevRelay Sites Phase 1-B: site-log-rules.ts の単体テスト（修正1 の必須テスト）。
// polling 除外 regex（実 endpoint 対応版）・roll 設定の fail-closed ガード・W3 除外を固定する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SITE_LOG_RULES,
  PILOT_ROLL_CONFIG,
  ROLLOUT_ROLL_CONFIG,
  W2_TARGET_HOSTS,
  W4_TARGET_HOSTS,
  W4_EXPECTED,
  HEALTH_CHECK_UA,
  HEALTH_SKIP_MATCHER_NAME,
  RollConfigNotConfirmedError,
  allSkipRuleMatcherNames,
  isExcludedByRules,
  isEligibleForAutoLog,
  isW3ExcludedHost,
  renderHealthSkipDirectives,
  renderInlineLogBlock,
  renderSkipDirectives,
  renderSnippet,
  resolveRollConfig,
  resolveRollConfigFrom,
} from '../dist/services/sites/site-log-rules.js';

const HOST = 'dangou-card-viewer.devrelay.io';

test('polling 除外: /api/games/<trial>/<game>/state は除外対象', () => {
  assert.equal(isExcludedByRules(HOST, 'GET', '/api/games/trial_C_l6r1_light_602/game01/state'), true);
});

test('polling 除外: query（?view=god）は path matcher の対象外なので同じルールで除外される', () => {
  // isExcludedByRules は path のみを受け取る（query を含まない）— 呼び出し側（access-log-parser）が
  // uri を path/query に分割済みであることの契約を明示するテスト。
  assert.equal(isExcludedByRules(HOST, 'GET', '/api/games/trial_C_l6r1_light_602/game01/state'), true);
});

test('polling 除外: 末尾スラッシュ付きも除外対象', () => {
  assert.equal(isExcludedByRules(HOST, 'GET', '/api/games/trial_C_l6r1_light_602/game01/state/'), true);
});

test('polling 除外: /api/games は除外しない', () => {
  assert.equal(isExcludedByRules(HOST, 'GET', '/api/games'), false);
});

test('polling 除外: /api/games/<trial>/<game> は除外しない（2 階層目までしかマッチしない）', () => {
  assert.equal(isExcludedByRules(HOST, 'GET', '/api/games/trial_C_l6r1_light_602/game01'), false);
});

test('polling 除外: /api/games/<trial> は除外しない（1 階層のみ）', () => {
  assert.equal(isExcludedByRules(HOST, 'GET', '/api/games/trial_C_l6r1_light_602'), false);
});

test('polling 除外: /api/games/<trial>/<game>/state/history は除外しない', () => {
  assert.equal(isExcludedByRules(HOST, 'GET', '/api/games/trial_C_l6r1_light_602/game01/state/history'), false);
});

test('polling 除外: / は PV（除外しない）', () => {
  assert.equal(isExcludedByRules(HOST, 'GET', '/'), false);
});

test('polling 除外: /watch は PV（除外しない）', () => {
  assert.equal(isExcludedByRules(HOST, 'GET', '/watch'), false);
});

test('polling 除外: POST /api/games/<trial>/<game>/state は除外しない（method GET 併用）', () => {
  assert.equal(isExcludedByRules(HOST, 'POST', '/api/games/trial_C_l6r1_light_602/game01/state'), false);
});

test('他 host には skip ルールが無い', () => {
  assert.equal(isExcludedByRules('chrome-bookmark.devrelay.io', 'GET', '/api/games/x/y/state'), false);
});

test('生成 Caddy テキストのスナップショット: 確定 regex を含む', () => {
  const rule = SITE_LOG_RULES.find((r) => r.host === HOST);
  const text = renderSkipDirectives(rule);
  assert.match(text, /path_regexp \^\/api\/games\/\[\^\/\]\+\/\[\^\/\]\+\/state\/\?\$/);
  assert.match(text, /method GET/);
  assert.match(text, /log_skip @drl_skip_poll_game_state/);
});

test('採用仕様 A の固定: polling は成功も 5xx も両方ログに残らない（無条件除外。B 案への回帰検知用）', () => {
  // isExcludedByRules は status を引数に取らない = 常に無条件除外である設計を型レベルで保証。
  // ここでは「method + path のみで判定される」ことを再確認する。
  assert.equal(isExcludedByRules(HOST, 'GET', '/api/games/t/g/state'), true);
});

test('roll 設定: PILOT_ROLL_CONFIG は provisional=true（確定値ではない・pilot 回帰なし）', () => {
  assert.equal(PILOT_ROLL_CONFIG.provisional, true);
  assert.equal(PILOT_ROLL_CONFIG.rollSize, '32MiB');
  assert.equal(PILOT_ROLL_CONFIG.rollKeep, 8);
  assert.equal(PILOT_ROLL_CONFIG.rollKeepFor, '168h');
  assert.equal(resolveRollConfig('pilot'), PILOT_ROLL_CONFIG);
});

test('roll 設定（pre-W2 修正 G）: ROLLOUT_ROLL_CONFIG は B2-4 確定値（64MiB/12/1440h・provisional=false）', () => {
  assert.deepEqual(ROLLOUT_ROLL_CONFIG, {
    rollSize: '64MiB',
    rollKeep: 12,
    rollKeepFor: '1440h',
    provisional: false,
  });
});

test('roll 設定: resolveRollConfig(\'rollout\') は ROLLOUT_ROLL_CONFIG をそのまま返す（fail-closed 解除済み）', () => {
  assert.equal(resolveRollConfig('rollout'), ROLLOUT_ROLL_CONFIG);
});

test('roll 設定: resolveRollConfigFrom(\'rollout\', null) は依然 fail-closed（回帰検知用）', () => {
  assert.throws(() => resolveRollConfigFrom('rollout', null), RollConfigNotConfirmedError);
});

test('roll 設定: resolveRollConfigFrom(\'pilot\', null) は rolloutConfig を無視して PILOT_ROLL_CONFIG を返す', () => {
  assert.equal(resolveRollConfigFrom('pilot', null), PILOT_ROLL_CONFIG);
});

test('roll 設定: snippet テキストは pilot 設定から生成され、手書きではない', () => {
  const text = renderSnippet(PILOT_ROLL_CONFIG);
  assert.match(text, /roll_size 32MiB/);
  assert.match(text, /roll_keep 8/);
  assert.match(text, /roll_keep_for 168h/);
});

test('roll 設定: snippet テキストは ROLLOUT_ROLL_CONFIG（64MiB/12/1440h）からも生成できる', () => {
  const text = renderSnippet(ROLLOUT_ROLL_CONFIG);
  assert.match(text, /roll_size 64MiB/);
  assert.match(text, /roll_keep 12/);
  assert.match(text, /roll_keep_for 1440h/);
});

// ---------------------------------------------------------------------------
// health checker 除外（pre-W2 修正 F・B2-4 D2）
// ---------------------------------------------------------------------------

test('health 除外: UA 完全一致 1 条件のみ（DevRelay-Sites/1.0）', () => {
  assert.equal(HEALTH_CHECK_UA, 'DevRelay-Sites/1.0');
  const text = renderHealthSkipDirectives();
  assert.match(text, /header User-Agent DevRelay-Sites\/1\.0/);
  assert.match(text, /log_skip @drl_skip_health/);
});

test('health 除外: path 条件を含まない（前方一致にも path にもならない完全一致のみ）', () => {
  const text = renderHealthSkipDirectives();
  assert.doesNotMatch(text, /path_regexp/);
  // 「DevRelay-Sites/1.0」に対する前方一致ではなく、ヘッダー値そのものの完全一致であることを
  // header ディレクティブの引数が UA 文字列 1 個のみであることで確認する。
  assert.match(text, /^\t@drl_skip_health header User-Agent DevRelay-Sites\/1\.0$/m);
});

test('health 除外: snippet（renderSnippet）に health skip が 1 箇所だけ含まれる', () => {
  const text = renderSnippet(ROLLOUT_ROLL_CONFIG);
  const occurrences = (text.match(/@drl_skip_health/g) ?? []).length;
  // matcher 定義 1 回 + log_skip 1 回 = 2 回
  assert.equal(occurrences, 2);
});

test('health 除外: renderInlineLogBlock にも health skip が含まれる（inline fallback でも除外が効く）', () => {
  const text = renderInlineLogBlock(ROLLOUT_ROLL_CONFIG);
  assert.match(text, /header User-Agent DevRelay-Sites\/1\.0/);
});

test('health 除外: 予約 matcher 名 @drl_skip_health は SITE_LOG_RULES のどの id とも衝突しない', () => {
  const names = allSkipRuleMatcherNames();
  assert.ok(!names.includes(HEALTH_SKIP_MATCHER_NAME), `衝突あり: ${names.join(', ')}`);
});

// ---------------------------------------------------------------------------
// W2 対象 host の固定（pre-W2 修正・B2-4 D4）
// ---------------------------------------------------------------------------

test('W2_TARGET_HOSTS: 21 host が固定されている', () => {
  assert.equal(W2_TARGET_HOSTS.length, 21);
});

test('W2_TARGET_HOSTS: W3 denylist と交差ゼロ', () => {
  for (const host of W2_TARGET_HOSTS) {
    assert.equal(isW3ExcludedHost(host), false, `${host} は W3 denylist に含まれるべきではない`);
  }
});

test('W2_TARGET_HOSTS: dangou-card-viewer（W1 pilot 適用済み）は含まれない', () => {
  assert.ok(!W2_TARGET_HOSTS.includes('dangou-card-viewer.devrelay.io'));
});

test('W2_TARGET_HOSTS: known-broken host（game001, 502）を意図的に含む', () => {
  assert.ok(W2_TARGET_HOSTS.includes('game001.devrelay.io'));
});

test('W2_TARGET_HOSTS: 重複がない', () => {
  assert.equal(new Set(W2_TARGET_HOSTS).size, W2_TARGET_HOSTS.length);
});

test('W3: sites.d 手編集 3 件は対象外', () => {
  assert.equal(isW3ExcludedHost('pixterm-server.devrelay.io'), true);
  assert.equal(isW3ExcludedHost('pixterm.devrelay.io'), true);
  assert.equal(isW3ExcludedHost('ribbon-re.jp'), true);
});

test('W3: Caddyfile 直書き host は対象外', () => {
  assert.equal(isW3ExcludedHost('devrelay.io'), true);
  assert.equal(isW3ExcludedHost('pixblog.net'), true);
});

test('W3: 対象外 host は isEligibleForAutoLog も常に false', () => {
  const content = 'pixterm-server.devrelay.io {\n  reverse_proxy localhost:9001\n}\n';
  assert.equal(isEligibleForAutoLog('pixterm-server.devrelay.io', content), false);
});

// ---------------------------------------------------------------------------
// W4（pixblog.net / ribbon-re.jp — 既存独自 logger を Sites 共有 snippet へ置換）
// ---------------------------------------------------------------------------

test('W4_TARGET_HOSTS: pixblog.net / ribbon-re.jp / www.ribbon-re.jp の 3 件', () => {
  assert.deepEqual([...W4_TARGET_HOSTS].sort(), ['pixblog.net', 'ribbon-re.jp', 'www.ribbon-re.jp']);
});

test('W4: W3 denylist は W4 実装後も変化しない（W4 は denylist 解除ではなく専用パスで置換するため）', () => {
  assert.equal(isW3ExcludedHost('ribbon-re.jp'), true);
  assert.equal(isW3ExcludedHost('pixblog.net'), true);
});

test('W4_EXPECTED: host 34 / block 33 / health matcher 33（Plan §3 の最終値と一致）', () => {
  assert.deepEqual(W4_EXPECTED, { hosts: 34, blocks: 33, healthMatchers: 33 });
});

test('W4_EXPECTED: host 数と block 数の差はちょうど 1（ribbon の apex+www が 1 block を共有する分）', () => {
  assert.equal(W4_EXPECTED.hosts - W4_EXPECTED.blocks, 1);
});

test('自動変更対象判定: dangou 型（8行）は対象', () => {
  const content = [
    'dangou-card-viewer.devrelay.io {',
    '  reverse_proxy localhost:9023',
    '  handle_errors {',
    '    rewrite * /index.html',
    '    root * /home/devrelay/testflight/dangou-card-viewer/placeholder',
    '    file_server',
    '  }',
    '}',
  ].join('\n');
  assert.equal(isEligibleForAutoLog(HOST, content), true);
});

test('自動変更対象判定: 手編集想定の長い設定（9行超）は対象外', () => {
  const lines = ['pixterm-server.devrelay.io {', '  reverse_proxy localhost:9001'];
  for (let i = 0; i < 20; i++) lines.push(`  # extra line ${i}`);
  lines.push('}');
  assert.equal(isEligibleForAutoLog('pixterm-server.devrelay.io', lines.join('\n')), false);
});

test('自動変更対象判定: reverse_proxy localhost:N が無ければ対象外', () => {
  const content = 'game001.devrelay.io {\n  root * /var/www/game001\n  file_server\n}\n';
  assert.equal(isEligibleForAutoLog('game001.devrelay.io', content), false);
});
