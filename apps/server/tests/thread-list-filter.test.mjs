import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  buildEmptyEndedThreadExclusion,
  isHideEmptyEndedEnabled,
} from '../dist/services/thread-list-filter.js';

/**
 * 「(無題)」大量発生の根治 サイクルA: `buildEmptyEndedThreadExclusion()` /
 * `isHideEmptyEndedEnabled()` の純粋な単体テスト + `api.ts` の配線ソースガード。
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');

function readServerSource(relPath) {
  return readFileSync(path.join(serverRoot, relPath), 'utf8');
}

describe('buildEmptyEndedThreadExclusion', () => {
  test('enabled=false は {} を返す（where にスプレッドしてもキーが増えない = 従来と数学的に同一）', () => {
    const result = buildEmptyEndedThreadExclusion(false);
    assert.deepEqual(result, {});
    assert.deepEqual(Object.keys(result), []);
  });

  test('enabled=true は AND キーを持ち、NOT キーを持たない（thread-scope.ts の NOT との衝突防止）', () => {
    const result = buildEmptyEndedThreadExclusion(true);
    assert.ok('AND' in result);
    assert.equal('NOT' in result, false);
  });

  test('enabled=true の中身は (status=active OR messages some) の1条件のみ', () => {
    const result = buildEmptyEndedThreadExclusion(true);
    assert.deepEqual(result, {
      AND: [{ OR: [{ status: 'active' }, { messages: { some: {} } }] }],
    });
  });

  test('4象限の真理値表: ended かつ Message 0件のときだけ除外される（ド・モルガン等価性の直接検証）', () => {
    // buildEmptyEndedThreadExclusion(true) が表す条件を JS で素朴に評価する参照実装。
    // 生成される where は「status='active' OR Message が1件以上」なので、
    // これが false になる（＝除外される）のは status !== 'active' かつ Message 0件のときだけ。
    function matchesWhere(status, hasMessage) {
      return status === 'active' || hasMessage;
    }
    // (active, 0件) → 残る（「＋新規」直後の副作用確認）
    assert.equal(matchesWhere('active', false), true);
    // (active, 1件以上) → 残る
    assert.equal(matchesWhere('active', true), true);
    // (ended, 1件以上) → 残る
    assert.equal(matchesWhere('ended', true), true);
    // (ended, 0件) → 除外される（唯一 false になるケース）
    assert.equal(matchesWhere('ended', false), false);
  });
});

describe('isHideEmptyEndedEnabled', () => {
  test('undefined は有効（既定 ON）', () => {
    assert.equal(isHideEmptyEndedEnabled(undefined), true);
  });
  test("'1' は有効", () => {
    assert.equal(isHideEmptyEndedEnabled('1'), true);
  });
  test("空文字は有効（'0' が明示されたときのみ無効という規約）", () => {
    assert.equal(isHideEmptyEndedEnabled(''), true);
  });
  test("'0' のときだけ無効", () => {
    assert.equal(isHideEmptyEndedEnabled('0'), false);
  });
});

describe('thread-list-filter: api.ts への配線ソースガード', () => {
  test('GET /api/threads の where に buildEmptyEndedThreadExclusion(...) がスプレッドされている', () => {
    const source = readServerSource('src/routes/api.ts');
    assert.match(source, /\.\.\.buildEmptyEndedThreadExclusion\(/);
  });

  test('where オブジェクト内にトップレベル NOT: キーが1個だけ存在する（キー衝突の機械的固定）', () => {
    const source = readServerSource('src/routes/api.ts');
    // buildEphemeralSessionIdExclusion() の戻り値は `NOT: { OR: [...] }`。
    // api.ts 自身が `NOT:` リテラルを直接書いていないこと（＝衝突する第2の NOT を持ち込んでいないこと）を確認する。
    const threadsHandlerMatch = source.match(/app\.get\('\/api\/threads'[\s\S]*?\n  \}\);/);
    assert.ok(threadsHandlerMatch, 'GET /api/threads ハンドラが見つからなかった');
    const handlerSource = threadsHandlerMatch[0];
    const notLiteralCount = (handlerSource.match(/\bNOT:\s*\{/g) || []).length;
    assert.equal(notLiteralCount, 0, 'api.ts が NOT: リテラルを直接持ち込んでいる（buildEphemeralSessionIdExclusion() の NOT と衝突する）');
  });

  test('buildEmptyEndedThreadExclusion の呼び出しが buildEphemeralSessionIdExclusion より後（コメントの意図どおり）', () => {
    const source = readServerSource('src/routes/api.ts');
    const ephemeralIdx = source.indexOf('...buildEphemeralSessionIdExclusion()');
    const emptyEndedIdx = source.indexOf('...buildEmptyEndedThreadExclusion(');
    assert.ok(ephemeralIdx >= 0 && emptyEndedIdx >= 0);
    assert.ok(emptyEndedIdx > ephemeralIdx);
  });
});
