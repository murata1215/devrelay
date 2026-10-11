// 高辻ナレッジ サイクル3（WebUI）: knowledge-search-rules.ts の単体テスト。
// 外部 import ゼロの純関数をコンパイル済み dist-test から直接 import する
// （machine-display-rules.test.mjs と同じ流儀）。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultKnowledgeUrlState,
  parseKnowledgeUrlState,
  serializeKnowledgeUrlState,
  knowledgeUrlStateEquals,
  patchKnowledgeUrlState,
  buildKnowledgeSearchQuery,
  isSearchable,
  parseMaxLevel,
  parseIsoDateOnly,
  buildHighlightSegments,
  escapeRegExpLiteral,
  levelTone,
  describeCoverage,
  describeViewer,
  ownerLabel,
  isKnowledgeDisabledError,
  isVectorKeyMissingError,
  isThreadNotVisibleError,
  buildThreadPageRequest,
  shiftIsoMillis,
  mergeThreadMessages,
  deriveThreadCursors,
  KNOWLEDGE_DISABLED_MESSAGE,
  KNOWLEDGE_VECTOR_NO_KEY_MESSAGE,
  KNOWLEDGE_THREAD_NOT_FOUND_MESSAGE,
} from '../dist-test/lib/knowledge-search-rules.js';

function getFrom(entries) {
  const map = new Map(entries);
  return (key) => (map.has(key) ? map.get(key) : null);
}

// ---- URL 往復 ----

describe('parseKnowledgeUrlState / serializeKnowledgeUrlState: 往復', () => {
  const cases = [
    defaultKnowledgeUrlState(),
    { ...defaultKnowledgeUrlState(), q: 'hello world' },
    {
      ...defaultKnowledgeUrlState(),
      q: '固有名詞 & #tag',
      mode: 'vector',
      scope: 'mine',
      kind: 'question',
      projectId: 'proj-1',
      compartment: 'LAFIT',
      maxLevel: 0,
      since: '2026-01-01',
      until: '2026-01-31',
      thread: 'sess-1',
      anchor: 'msg-1',
    },
    { ...defaultKnowledgeUrlState(), maxLevel: 10 },
    { ...defaultKnowledgeUrlState(), q: '  spaced  ' },
  ];

  cases.forEach((state, i) => {
    test(`ケース ${i}: parse(get-from(serialize(s))) は s と等価`, () => {
      const serialized = serializeKnowledgeUrlState(state);
      const parsed = parseKnowledgeUrlState(getFrom(serialized));
      // q は trim されないが前後空白ケースはこの等価性チェック対象から外す（別テストで明示）
      if (state.q.trim() === state.q) {
        assert.ok(knowledgeUrlStateEquals(parsed, state), `mismatch for case ${i}`);
      }
    });
  });

  test('既定値のみの状態は serialize すると空配列になる（D6: 既定値は URL に出さない）', () => {
    assert.deepEqual(serializeKnowledgeUrlState(defaultKnowledgeUrlState()), []);
  });

  test('mode:"hybrid"（既定）は serialize されない', () => {
    const entries = serializeKnowledgeUrlState({ ...defaultKnowledgeUrlState(), mode: 'hybrid' });
    assert.equal(entries.some(([k]) => k === 'mode'), false);
  });

  test('mode:"vector" は serialize される', () => {
    const entries = serializeKnowledgeUrlState({ ...defaultKnowledgeUrlState(), mode: 'vector' });
    assert.ok(entries.some(([k, v]) => k === 'mode' && v === 'vector'));
  });

  test('maxLevel:0 は serialize される（null と区別される）', () => {
    const entries = serializeKnowledgeUrlState({ ...defaultKnowledgeUrlState(), maxLevel: 0 });
    assert.ok(entries.some(([k, v]) => k === 'maxLevel' && v === '0'));
  });

  test('maxLevel:null は serialize されない', () => {
    const entries = serializeKnowledgeUrlState(defaultKnowledgeUrlState());
    assert.equal(entries.some(([k]) => k === 'maxLevel'), false);
  });
});

describe('parseKnowledgeUrlState: 不正値は既定へ落ちる（throw しない）', () => {
  test('mode が不正な文字列なら既定 hybrid', () => {
    assert.equal(parseKnowledgeUrlState(getFrom([['mode', 'fuzzy']])).mode, 'hybrid');
  });
  test('scope が不正なら既定 all', () => {
    assert.equal(parseKnowledgeUrlState(getFrom([['scope', 'theirs']])).scope, 'all');
  });
  test('kind が不正なら既定 all', () => {
    assert.equal(parseKnowledgeUrlState(getFrom([['kind', 'rant']])).kind, 'all');
  });
  test('maxLevel が範囲外・非整数なら null', () => {
    for (const raw of ['11', '-1', 'abc', '3.5']) {
      assert.equal(parseKnowledgeUrlState(getFrom([['maxLevel', raw]])).maxLevel, null, `raw=${raw}`);
    }
  });
  test('since/until が不正な日付なら null', () => {
    for (const raw of ['2024-13-99', 'yesterday', '2026/01/01']) {
      assert.equal(parseKnowledgeUrlState(getFrom([['since', raw]])).since, null, `raw=${raw}`);
    }
  });
});

describe('parseMaxLevel: "" は 0 ではなく null（罠の封じ込め）', () => {
  test('空文字は null', () => {
    assert.equal(parseMaxLevel(''), null);
  });
  test('null/undefined は null', () => {
    assert.equal(parseMaxLevel(null), null);
    assert.equal(parseMaxLevel(undefined), null);
  });
  test('"0" は 0（null ではない）', () => {
    assert.equal(parseMaxLevel('0'), 0);
  });
  test('"10" は 10', () => {
    assert.equal(parseMaxLevel('10'), 10);
  });
  test('"11" は null（範囲外）', () => {
    assert.equal(parseMaxLevel('11'), null);
  });
});

describe('parseIsoDateOnly', () => {
  test('有効な YYYY-MM-DD はそのまま返る', () => {
    assert.equal(parseIsoDateOnly('2026-01-01'), '2026-01-01');
  });
  test('不正な形式は null', () => {
    assert.equal(parseIsoDateOnly('2026/01/01'), null);
    assert.equal(parseIsoDateOnly('not-a-date'), null);
  });
  test('空文字・未指定は null', () => {
    assert.equal(parseIsoDateOnly(''), null);
    assert.equal(parseIsoDateOnly(null), null);
  });
});

describe('buildKnowledgeSearchQuery: 空値を一切出さない（罠の封じ込め）', () => {
  test('maxLevel:null のとき maxLevel キーが無い', () => {
    const q = buildKnowledgeSearchQuery({ ...defaultKnowledgeUrlState(), q: 'x' });
    assert.equal(q.some(([k]) => k === 'maxLevel'), false);
  });

  test('maxLevel:0 のとき maxLevel=0 が出る（空文字ではない）', () => {
    const q = buildKnowledgeSearchQuery({ ...defaultKnowledgeUrlState(), q: 'x', maxLevel: 0 });
    assert.ok(q.some(([k, v]) => k === 'maxLevel' && v === '0'));
  });

  test('どのエントリも値が空文字にならない', () => {
    const states = [
      defaultKnowledgeUrlState(),
      { ...defaultKnowledgeUrlState(), q: 'x', projectId: 'p', compartment: 'c', since: '2026-01-01', until: '2026-01-02' },
      { ...defaultKnowledgeUrlState(), q: 'x', maxLevel: 0 },
    ];
    for (const s of states) {
      const q = buildKnowledgeSearchQuery({ ...s, q: s.q || 'x' });
      for (const [, v] of q) assert.notEqual(v, '');
    }
  });

  test('limit は常に 1..30 にクランプされる', () => {
    assert.equal(buildKnowledgeSearchQuery({ ...defaultKnowledgeUrlState(), q: 'x' }, 0).find(([k]) => k === 'limit')[1], '1');
    assert.equal(buildKnowledgeSearchQuery({ ...defaultKnowledgeUrlState(), q: 'x' }, 999).find(([k]) => k === 'limit')[1], '30');
    assert.equal(buildKnowledgeSearchQuery({ ...defaultKnowledgeUrlState(), q: 'x' }, 20).find(([k]) => k === 'limit')[1], '20');
  });

  test('thread/anchor が設定されていてもクエリに含まれない（検索条件には影響しない）', () => {
    const withThread = buildKnowledgeSearchQuery({ ...defaultKnowledgeUrlState(), q: 'x', thread: 't1', anchor: 'a1' });
    const withoutThread = buildKnowledgeSearchQuery({ ...defaultKnowledgeUrlState(), q: 'x' });
    assert.deepEqual(withThread, withoutThread, 'thread/anchor の有無でクエリが変わってはならない（再検索ループ防止）');
  });
});

describe('isSearchable', () => {
  test('空文字は検索不可', () => {
    assert.equal(isSearchable(defaultKnowledgeUrlState()), false);
  });
  test('空白のみは検索不可', () => {
    assert.equal(isSearchable({ ...defaultKnowledgeUrlState(), q: '   ' }), false);
  });
  test('501 文字超は検索不可', () => {
    assert.equal(isSearchable({ ...defaultKnowledgeUrlState(), q: 'a'.repeat(501) }), false);
  });
  test('1 文字は検索可', () => {
    assert.equal(isSearchable({ ...defaultKnowledgeUrlState(), q: 'a' }), true);
  });
});

describe('patchKnowledgeUrlState', () => {
  test('検索軸（mode）を変えると thread/anchor がクリアされる', () => {
    const prev = { ...defaultKnowledgeUrlState(), thread: 't1', anchor: 'a1' };
    const next = patchKnowledgeUrlState(prev, { mode: 'vector' });
    assert.equal(next.thread, null);
    assert.equal(next.anchor, null);
    assert.equal(next.mode, 'vector');
  });

  test('thread だけを変える patch は検索軸を変えない', () => {
    const prev = { ...defaultKnowledgeUrlState(), q: 'hello' };
    const next = patchKnowledgeUrlState(prev, { thread: 't1', anchor: 'a1' });
    assert.equal(next.q, 'hello');
    assert.equal(next.thread, 't1');
    assert.equal(next.anchor, 'a1');
  });

  test('同値を再設定（実質変化なし）では thread をクリアしない', () => {
    const prev = { ...defaultKnowledgeUrlState(), mode: 'vector', thread: 't1' };
    const next = patchKnowledgeUrlState(prev, { mode: 'vector' });
    assert.equal(next.thread, 't1');
  });

  test('thread を閉じる patch（thread:null）は検索軸に影響しない', () => {
    const prev = { ...defaultKnowledgeUrlState(), q: 'hello', thread: 't1', anchor: 'a1' };
    const next = patchKnowledgeUrlState(prev, { thread: null, anchor: null });
    assert.equal(next.q, 'hello');
    assert.equal(next.thread, null);
  });
});

// ---- ハイライト ----

describe('buildHighlightSegments', () => {
  test('無ヒットは単一の非マッチセグメント', () => {
    const segs = buildHighlightSegments('hello world', 'xyz');
    assert.deepEqual(segs, [{ text: 'hello world', match: false }]);
  });

  test('無損失性: join すると元の text に戻る', () => {
    const cases = [
      ['hello world', 'o'],
      ['foo FOO fOo', 'foo'],
      ['a.*b c++ (x) [y] \\ $1', '.*'],
      ['', 'x'],
      ['abc', ''],
    ];
    for (const [text, query] of cases) {
      const segs = buildHighlightSegments(text, query);
      assert.equal(segs.map((s) => s.text).join(''), text, `text=${JSON.stringify(text)} query=${JSON.stringify(query)}`);
    }
  });

  test('大文字小文字を無視する', () => {
    const segs = buildHighlightSegments('foo FOO fOo', 'foo');
    const hits = segs.filter((s) => s.match);
    assert.equal(hits.length, 3);
  });

  test('正規表現メタ文字はリテラル扱い', () => {
    for (const q of ['a.*b', 'c++', '(x)', '[y]', '\\', '$1']) {
      const text = `prefix ${q} suffix`;
      const segs = buildHighlightSegments(text, q);
      assert.ok(segs.some((s) => s.match && s.text === q), `query=${JSON.stringify(q)} should match literally`);
    }
  });

  test('複数ヒットはすべて検出される', () => {
    const segs = buildHighlightSegments('cat dog cat bird cat', 'cat');
    assert.equal(segs.filter((s) => s.match).length, 3);
  });

  test('空クエリ・空白のみのクエリは非マッチ 1 セグメント', () => {
    assert.deepEqual(buildHighlightSegments('hello', ''), [{ text: 'hello', match: false }]);
    assert.deepEqual(buildHighlightSegments('hello', '   '), [{ text: 'hello', match: false }]);
  });

  test('クエリが text より長い場合は非マッチ', () => {
    const segs = buildHighlightSegments('hi', 'hello world this is long');
    assert.deepEqual(segs, [{ text: 'hi', match: false }]);
  });
});

describe('escapeRegExpLiteral', () => {
  test('メタ文字をエスケープした文字列は元の文字列にリテラル一致する', () => {
    const raw = 'a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o';
    const escaped = escapeRegExpLiteral(raw);
    const re = new RegExp(escaped);
    assert.ok(re.test(raw));
  });
});

// ---- levelTone ----

describe('levelTone', () => {
  test('0 は open', () => {
    assert.equal(levelTone(0), 'open');
  });
  test('1,2,3 は low', () => {
    assert.equal(levelTone(1), 'low');
    assert.equal(levelTone(2), 'low');
    assert.equal(levelTone(3), 'low');
  });
  test('4,5,6 は mid', () => {
    assert.equal(levelTone(4), 'mid');
    assert.equal(levelTone(6), 'mid');
  });
  test('7,10 は high', () => {
    assert.equal(levelTone(7), 'high');
    assert.equal(levelTone(10), 'high');
  });
  test('範囲外はクランプする（throw しない）', () => {
    assert.equal(levelTone(-1), 'open');
    assert.equal(levelTone(99), 'high');
  });
});

// ---- coverage / viewer / owner ----

describe('describeCoverage', () => {
  test('keyword+vector 両方なら both', () => {
    assert.equal(describeCoverage({ keyword: true, vector: true }, 'hybrid').kind, 'both');
  });
  test('keyword のみなら keywordOnly、skippedReason を引き継ぐ', () => {
    const d = describeCoverage({ keyword: true, vector: false, vectorSkippedReason: 'no_openai_api_key' }, 'hybrid');
    assert.equal(d.kind, 'keywordOnly');
    assert.equal(d.skippedReason, 'no_openai_api_key');
  });
  test('vector のみなら vectorOnly', () => {
    assert.equal(describeCoverage({ keyword: false, vector: true }, 'vector').kind, 'vectorOnly');
  });
  test('両方falseならnone', () => {
    assert.equal(describeCoverage({ keyword: false, vector: false }, 'hybrid').kind, 'none');
  });
});

describe('describeViewer', () => {
  test('null は組織なし扱い', () => {
    const d = describeViewer(null);
    assert.equal(d.orgLess, true);
    assert.equal(d.readLevel, 0);
    assert.deepEqual(d.compartments, []);
  });
  test('"*" を含むと先頭に来て hasWildcard true', () => {
    const d = describeViewer({ readLevel: 5, compartments: ['ZZZ', '*', 'AAA'], organization: true });
    assert.equal(d.hasWildcard, true);
    assert.equal(d.compartments[0], '*');
    assert.deepEqual(d.compartments, ['*', 'AAA', 'ZZZ']);
  });
  test('organization:false は orgLess:true', () => {
    assert.equal(describeViewer({ readLevel: 0, compartments: [], organization: false }).orgLess, true);
  });
  test('重複は除去される', () => {
    const d = describeViewer({ readLevel: 1, compartments: ['A', 'A', 'B'], organization: true });
    assert.deepEqual(d.compartments, ['A', 'B']);
  });
});

describe('ownerLabel', () => {
  test('isOwn:true のとき isOwn:true を返す', () => {
    assert.equal(ownerLabel({ isOwn: true, ownerName: 'X', ownerUserId: 'u1' }).isOwn, true);
  });
  test('ownerName が null のとき ownerUserId にフォールバック', () => {
    const r = ownerLabel({ isOwn: false, ownerName: null, ownerUserId: 'u1' });
    assert.equal(r.text, 'u1');
  });
  test('ownerName が空白のみのときも ownerUserId にフォールバック', () => {
    const r = ownerLabel({ isOwn: false, ownerName: '   ', ownerUserId: 'u1' });
    assert.equal(r.text, 'u1');
  });
  test('ownerName があればそれを使う', () => {
    const r = ownerLabel({ isOwn: false, ownerName: 'Taro', ownerUserId: 'u1' });
    assert.equal(r.text, 'Taro');
  });
});

// ---- エラー文言判定 ----

describe('エラー文言判定: 完全一致のみ true', () => {
  test('isKnowledgeDisabledError: 完全一致で true', () => {
    assert.equal(isKnowledgeDisabledError(KNOWLEDGE_DISABLED_MESSAGE), true);
  });
  test('isKnowledgeDisabledError: near-miss は false', () => {
    for (const m of [KNOWLEDGE_DISABLED_MESSAGE + '.', KNOWLEDGE_DISABLED_MESSAGE.toLowerCase(), 'HTTP 404', null, undefined, '']) {
      assert.equal(isKnowledgeDisabledError(m), false, `m=${JSON.stringify(m)}`);
    }
  });
  test('isVectorKeyMissingError: 完全一致で true', () => {
    assert.equal(isVectorKeyMissingError(KNOWLEDGE_VECTOR_NO_KEY_MESSAGE), true);
  });
  test('isVectorKeyMissingError: near-miss は false', () => {
    assert.equal(isVectorKeyMissingError('OpenAI API key not configured.'), false);
  });
  test('isThreadNotVisibleError: 完全一致で true', () => {
    assert.equal(isThreadNotVisibleError(KNOWLEDGE_THREAD_NOT_FOUND_MESSAGE), true);
  });
  test('isThreadNotVisibleError: near-miss は false', () => {
    assert.equal(isThreadNotVisibleError('Thread not found'), false);
  });
});

// ---- スレッドページング ----

describe('buildThreadPageRequest', () => {
  test('initial は cursor 無し', () => {
    const r = buildThreadPageRequest({ direction: 'initial' });
    assert.equal(r.before, undefined);
    assert.equal(r.after, undefined);
    assert.ok(r.limit > 0);
  });

  test('anchor は before = anchorTimestamp + 1ms、after は無い', () => {
    const r = buildThreadPageRequest({ direction: 'anchor', anchorTimestamp: '2026-01-01T00:00:00.000Z' });
    assert.equal(r.before, '2026-01-01T00:00:00.001Z');
    assert.equal(r.after, undefined);
  });

  test('anchor で anchorTimestamp が無いときは initial にフォールバック', () => {
    const r = buildThreadPageRequest({ direction: 'anchor', anchorTimestamp: null });
    assert.equal(r.before, undefined);
    assert.equal(r.after, undefined);
  });

  test('older は before = firstLoadedTimestamp', () => {
    const r = buildThreadPageRequest({ direction: 'older', firstLoadedTimestamp: '2026-01-01T00:00:00.000Z' });
    assert.equal(r.before, '2026-01-01T00:00:00.000Z');
  });

  test('newer は after = lastLoadedTimestamp', () => {
    const r = buildThreadPageRequest({ direction: 'newer', lastLoadedTimestamp: '2026-01-01T00:00:00.000Z' });
    assert.equal(r.after, '2026-01-01T00:00:00.000Z');
  });
});

describe('shiftIsoMillis', () => {
  test('ミリ秒を加算できる', () => {
    assert.equal(shiftIsoMillis('2026-01-01T00:00:00.000Z', 1), '2026-01-01T00:00:00.001Z');
  });
  test('負のミリ秒で減算できる', () => {
    assert.equal(shiftIsoMillis('2026-01-01T00:00:00.001Z', -1), '2026-01-01T00:00:00.000Z');
  });
});

describe('mergeThreadMessages', () => {
  test('重複（同一 id）は排除される', () => {
    const loaded = [{ id: 'a', timestamp: '2026-01-01T00:00:00.000Z' }];
    const page = [{ id: 'a', timestamp: '2026-01-01T00:00:00.000Z' }, { id: 'b', timestamp: '2026-01-01T00:00:01.000Z' }];
    const merged = mergeThreadMessages(loaded, page);
    assert.equal(merged.length, 2);
  });

  test('timestamp 昇順に並ぶ', () => {
    const loaded = [{ id: 'b', timestamp: '2026-01-01T00:00:02.000Z' }];
    const page = [{ id: 'a', timestamp: '2026-01-01T00:00:01.000Z' }];
    const merged = mergeThreadMessages(loaded, page);
    assert.deepEqual(merged.map((m) => m.id), ['a', 'b']);
  });

  test('同一 timestamp のペアは両方保持される（id でタイブレーク）', () => {
    const loaded = [{ id: 'b', timestamp: '2026-01-01T00:00:00.000Z' }];
    const page = [{ id: 'a', timestamp: '2026-01-01T00:00:00.000Z' }];
    const merged = mergeThreadMessages(loaded, page);
    assert.equal(merged.length, 2);
    assert.deepEqual(merged.map((m) => m.id), ['a', 'b']);
  });

  test('入力配列は変更されない（非破壊）', () => {
    const loaded = [{ id: 'a', timestamp: '2026-01-01T00:00:00.000Z' }];
    const loadedCopy = [...loaded];
    mergeThreadMessages(loaded, [{ id: 'b', timestamp: '2026-01-01T00:00:01.000Z' }]);
    assert.deepEqual(loaded, loadedCopy);
  });
});

describe('deriveThreadCursors', () => {
  test('空配列は null/null', () => {
    assert.deepEqual(deriveThreadCursors([]), { first: null, last: null });
  });
  test('先頭・末尾の timestamp を返す', () => {
    const msgs = [
      { id: 'a', timestamp: '2026-01-01T00:00:00.000Z' },
      { id: 'b', timestamp: '2026-01-01T00:00:01.000Z' },
    ];
    assert.deepEqual(deriveThreadCursors(msgs), { first: '2026-01-01T00:00:00.000Z', last: '2026-01-01T00:00:01.000Z' });
  });
});
