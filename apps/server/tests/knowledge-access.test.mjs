// 高辻ナレッジ サイクル2: apps/server/src/services/knowledge-access.ts の単体テスト。
// 外部 import ゼロの純関数をコンパイル済み dist から直接 import する
// （knowledge-rank.test.mjs と同じ流儀）。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLASSIFICATION_LEVEL_MIN,
  CLASSIFICATION_LEVEL_MAX,
  COMPARTMENT_MAX_LENGTH,
  COMPARTMENT_WILDCARD,
  resolveEffectiveClassification,
  isTurnVisible,
  buildVisibilityPredicate,
  buildClassificationFilterPredicate,
  normalizeCompartment,
  normalizeLevel,
  canAssignClassification,
  decideAuditTargets,
  normalizeClearanceInput,
} from '../dist/services/knowledge-access.js';

/** テスト用の最小 viewer を作る（指定したフィールドだけ上書き）。 */
function makeViewer(overrides = {}) {
  return {
    userId: 'u-viewer',
    organizationId: 'org-1',
    readLevel: 0,
    writeLevel: 0,
    compartments: [],
    isOrgAdmin: false,
    ...overrides,
  };
}

/** テスト用の最小 turn を作る。 */
function makeTurn(overrides = {}) {
  return {
    ownerUserId: 'u-owner',
    ownerOrganizationId: 'org-1',
    effectiveLevel: 0,
    effectiveCompartment: null,
    ...overrides,
  };
}

// --- resolveEffectiveClassification ---

describe('resolveEffectiveClassification', () => {
  test('session に level/compartment がある → それを使う', () => {
    const result = resolveEffectiveClassification(
      { level: 3, compartment: 'LAFIT' },
      { defaultLevel: 5, defaultCompartment: 'SERIO' }
    );
    assert.deepEqual(result, { level: 3, compartment: 'LAFIT' });
  });

  test('session が null → project の既定値を継承', () => {
    const result = resolveEffectiveClassification(
      { level: null, compartment: null },
      { defaultLevel: 5, defaultCompartment: 'SERIO' }
    );
    assert.deepEqual(result, { level: 5, compartment: 'SERIO' });
  });

  test('session も project も null → level 0・壁なし', () => {
    const result = resolveEffectiveClassification(
      { level: null, compartment: null },
      { defaultLevel: null, defaultCompartment: null }
    );
    assert.deepEqual(result, { level: 0, compartment: null });
  });

  test('level=0 は明示指定として尊重される（?? は 0 を継承しない）', () => {
    const result = resolveEffectiveClassification(
      { level: 0, compartment: undefined },
      { defaultLevel: 5, defaultCompartment: 'SERIO' }
    );
    assert.deepEqual(result, { level: 0, compartment: 'SERIO' });
  });
});

// --- isTurnVisible ---

describe('isTurnVisible', () => {
  test('本人の会話は常に見える（level/compartment を超えていても）', () => {
    const viewer = makeViewer({ userId: 'u-owner', readLevel: 0, compartments: [] });
    const turn = makeTurn({ ownerUserId: 'u-owner', effectiveLevel: 10, effectiveCompartment: 'LAFIT' });
    assert.equal(isTurnVisible(viewer, turn), true);
  });

  test('組織未所属の viewer には他人の会話が見えない', () => {
    const viewer = makeViewer({ organizationId: null, readLevel: 10, compartments: [COMPARTMENT_WILDCARD] });
    const turn = makeTurn({ effectiveLevel: 0, effectiveCompartment: null });
    assert.equal(isTurnVisible(viewer, turn), false);
  });

  test('別組織の会話は見えない', () => {
    const viewer = makeViewer({ organizationId: 'org-1', readLevel: 10, compartments: [COMPARTMENT_WILDCARD] });
    const turn = makeTurn({ ownerOrganizationId: 'org-2', effectiveLevel: 0, effectiveCompartment: null });
    assert.equal(isTurnVisible(viewer, turn), false);
  });

  test('level が readLevel と等しい → 見える', () => {
    const viewer = makeViewer({ readLevel: 3 });
    const turn = makeTurn({ effectiveLevel: 3, effectiveCompartment: null });
    assert.equal(isTurnVisible(viewer, turn), true);
  });

  test('level が readLevel を 1 超える → 見えない', () => {
    const viewer = makeViewer({ readLevel: 3 });
    const turn = makeTurn({ effectiveLevel: 4, effectiveCompartment: null });
    assert.equal(isTurnVisible(viewer, turn), false);
  });

  test('compartment が null なら誰でも見える（readLevel 条件のみ）', () => {
    const viewer = makeViewer({ readLevel: 0, compartments: [] });
    const turn = makeTurn({ effectiveLevel: 0, effectiveCompartment: null });
    assert.equal(isTurnVisible(viewer, turn), true);
  });

  test('"*" を持つ viewer はどの compartment でも見える', () => {
    const viewer = makeViewer({ readLevel: 0, compartments: [COMPARTMENT_WILDCARD] });
    const turn = makeTurn({ effectiveLevel: 0, effectiveCompartment: 'ANYTHING' });
    assert.equal(isTurnVisible(viewer, turn), true);
  });

  test('compartment が一致 → 見える', () => {
    const viewer = makeViewer({ readLevel: 0, compartments: ['LAFIT'] });
    const turn = makeTurn({ effectiveLevel: 0, effectiveCompartment: 'LAFIT' });
    assert.equal(isTurnVisible(viewer, turn), true);
  });

  test('compartment が不一致 → 見えない', () => {
    const viewer = makeViewer({ readLevel: 0, compartments: ['LAFIT'] });
    const turn = makeTurn({ effectiveLevel: 0, effectiveCompartment: 'SERIO' });
    assert.equal(isTurnVisible(viewer, turn), false);
  });

  test('compartments が空で compartment がある会話は見えない', () => {
    const viewer = makeViewer({ readLevel: 10, compartments: [] });
    const turn = makeTurn({ effectiveLevel: 0, effectiveCompartment: 'LAFIT' });
    assert.equal(isTurnVisible(viewer, turn), false);
  });
});

// --- buildVisibilityPredicate ---

describe('buildVisibilityPredicate', () => {
  test('scope=mine は kc."userId" = $n の 1 本のみ', () => {
    const viewer = makeViewer();
    const result = buildVisibilityPredicate(viewer, 'mine', 3);
    assert.equal(result.sql, 'kc."userId" = $3');
    assert.deepEqual(result.params, ['u-viewer']);
    assert.equal(result.nextIndex, 4);
  });

  test('scope=all かつ組織なしは scope=mine と同じ形に落ちる（組織なしなら自分だけ）', () => {
    const viewer = makeViewer({ organizationId: null });
    const result = buildVisibilityPredicate(viewer, 'all', 3);
    assert.equal(result.sql, 'kc."userId" = $3');
    assert.deepEqual(result.params, ['u-viewer']);
    assert.equal(result.nextIndex, 4);
  });

  test('scope=all かつ組織あり・compartments 空 → compartment IS NULL 節のみ', () => {
    const viewer = makeViewer({ organizationId: 'org-1', readLevel: 3, compartments: [] });
    const result = buildVisibilityPredicate(viewer, 'all', 1);
    assert.equal(
      result.sql,
      '(kc."userId" = $1 OR (om."organizationId" = $2 AND COALESCE(s."level", p."defaultLevel", 0) <= $3' +
        ' AND COALESCE(s."compartment", p."defaultCompartment") IS NULL))'
    );
    assert.deepEqual(result.params, ['u-viewer', 'org-1', 3]);
    assert.equal(result.nextIndex, 4);
  });

  test('"*" を持つ viewer は compartment 節ごと省略', () => {
    const viewer = makeViewer({ organizationId: 'org-1', readLevel: 5, compartments: [COMPARTMENT_WILDCARD] });
    const result = buildVisibilityPredicate(viewer, 'all', 1);
    assert.equal(
      result.sql,
      '(kc."userId" = $1 OR (om."organizationId" = $2 AND COALESCE(s."level", p."defaultLevel", 0) <= $3))'
    );
    assert.deepEqual(result.params, ['u-viewer', 'org-1', 5]);
    assert.equal(result.nextIndex, 4);
  });

  test('compartments 複数 → IN ($n, $n+1, …) に個別展開される（採番が連続する）', () => {
    const viewer = makeViewer({ organizationId: 'org-1', readLevel: 5, compartments: ['LAFIT', 'SERIO'] });
    const result = buildVisibilityPredicate(viewer, 'all', 1);
    assert.equal(
      result.sql,
      '(kc."userId" = $1 OR (om."organizationId" = $2 AND COALESCE(s."level", p."defaultLevel", 0) <= $3' +
        ' AND (COALESCE(s."compartment", p."defaultCompartment") IS NULL' +
        ' OR COALESCE(s."compartment", p."defaultCompartment") IN ($4, $5))))'
    );
    assert.deepEqual(result.params, ['u-viewer', 'org-1', 5, 'LAFIT', 'SERIO']);
    assert.equal(result.nextIndex, 6);
  });

  test('startIndex が 1 以外から始まっても採番が連続する', () => {
    const viewer = makeViewer({ organizationId: 'org-1', readLevel: 2, compartments: ['LAFIT'] });
    const result = buildVisibilityPredicate(viewer, 'all', 7);
    assert.match(result.sql, /\$7.*\$8.*\$9.*\$10/s);
    assert.equal(result.nextIndex, 11);
  });
});

// --- buildClassificationFilterPredicate ---

describe('buildClassificationFilterPredicate', () => {
  test('どちらも未指定 → sql は null', () => {
    const result = buildClassificationFilterPredicate({}, 5);
    assert.equal(result.sql, null);
    assert.deepEqual(result.params, []);
    assert.equal(result.nextIndex, 5);
  });

  test('compartment のみ', () => {
    const result = buildClassificationFilterPredicate({ compartment: 'LAFIT' }, 5);
    assert.equal(result.sql, 'COALESCE(s."compartment", p."defaultCompartment") = $5');
    assert.deepEqual(result.params, ['LAFIT']);
    assert.equal(result.nextIndex, 6);
  });

  test('maxLevel のみ', () => {
    const result = buildClassificationFilterPredicate({ maxLevel: 3 }, 5);
    assert.equal(result.sql, 'COALESCE(s."level", p."defaultLevel", 0) <= $5');
    assert.deepEqual(result.params, [3]);
    assert.equal(result.nextIndex, 6);
  });

  test('両方指定 → AND で連結、採番が連続する', () => {
    const result = buildClassificationFilterPredicate({ compartment: 'LAFIT', maxLevel: 3 }, 5);
    assert.equal(
      result.sql,
      'COALESCE(s."compartment", p."defaultCompartment") = $5 AND COALESCE(s."level", p."defaultLevel", 0) <= $6'
    );
    assert.deepEqual(result.params, ['LAFIT', 3]);
    assert.equal(result.nextIndex, 7);
  });
});

// --- normalizeCompartment ---

describe('normalizeCompartment', () => {
  test('null/undefined → null', () => {
    assert.deepEqual(normalizeCompartment(null), { ok: true, value: null });
    assert.deepEqual(normalizeCompartment(undefined), { ok: true, value: null });
  });

  test('前後の空白は trim される', () => {
    assert.deepEqual(normalizeCompartment('  LAFIT  '), { ok: true, value: 'LAFIT' });
  });

  test('全角は NFKC で半角に正規化される', () => {
    // "LAFIT" の全角表記（Ａ-Ｚ 等）→ 半角 "LAFIT" に正規化される
    assert.deepEqual(normalizeCompartment('ＬＡＦＩＴ'), { ok: true, value: 'LAFIT' });
  });

  test('空文字・空白のみ → null', () => {
    assert.deepEqual(normalizeCompartment(''), { ok: true, value: null });
    assert.deepEqual(normalizeCompartment('   '), { ok: true, value: null });
  });

  test('64 文字はそのまま通る', () => {
    const s = 'A'.repeat(COMPARTMENT_MAX_LENGTH);
    assert.deepEqual(normalizeCompartment(s), { ok: true, value: s });
  });

  test('65 文字はエラー', () => {
    const s = 'A'.repeat(COMPARTMENT_MAX_LENGTH + 1);
    const result = normalizeCompartment(s);
    assert.equal(result.ok, false);
  });

  test('大文字小文字は別物として扱う（正規化で揃えない）', () => {
    assert.deepEqual(normalizeCompartment('lafit'), { ok: true, value: 'lafit' });
    assert.notDeepEqual(normalizeCompartment('lafit'), normalizeCompartment('LAFIT'));
  });
});

// --- normalizeLevel ---

describe('normalizeLevel', () => {
  test('null/undefined → null（継承）', () => {
    assert.deepEqual(normalizeLevel(null), { ok: true, value: null });
    assert.deepEqual(normalizeLevel(undefined), { ok: true, value: null });
  });

  test('0〜10 の整数はそのまま通る', () => {
    assert.deepEqual(normalizeLevel(CLASSIFICATION_LEVEL_MIN), { ok: true, value: 0 });
    assert.deepEqual(normalizeLevel(CLASSIFICATION_LEVEL_MAX), { ok: true, value: 10 });
    assert.deepEqual(normalizeLevel(5), { ok: true, value: 5 });
  });

  test('範囲外（-1 / 11）はエラー', () => {
    assert.equal(normalizeLevel(-1).ok, false);
    assert.equal(normalizeLevel(11).ok, false);
  });

  test('小数（3.5）はエラー', () => {
    assert.equal(normalizeLevel(3.5).ok, false);
  });

  test('文字列・NaN はエラー', () => {
    assert.equal(normalizeLevel('3').ok, false);
    assert.equal(normalizeLevel(NaN).ok, false);
  });
});

// --- canAssignClassification ---

describe('canAssignClassification', () => {
  test('level 範囲外（-1 / 11）はエラー', () => {
    const viewer = makeViewer({ writeLevel: 10, compartments: [COMPARTMENT_WILDCARD] });
    assert.equal(canAssignClassification(viewer, { level: null, compartment: null }, { level: -1, compartment: null }).ok, false);
    assert.equal(canAssignClassification(viewer, { level: null, compartment: null }, { level: 11, compartment: null }).ok, false);
  });

  test('level 小数（3.5）はエラー', () => {
    const viewer = makeViewer({ writeLevel: 10, compartments: [COMPARTMENT_WILDCARD] });
    assert.equal(canAssignClassification(viewer, { level: null, compartment: null }, { level: 3.5, compartment: null }).ok, false);
  });

  test('writeLevel 境界: next.level === writeLevel は通る', () => {
    const viewer = makeViewer({ writeLevel: 3, compartments: [COMPARTMENT_WILDCARD] });
    const result = canAssignClassification(viewer, { level: null, compartment: null }, { level: 3, compartment: null });
    assert.equal(result.ok, true);
  });

  test('writeLevel 境界: next.level が writeLevel を 1 超えると NG', () => {
    const viewer = makeViewer({ writeLevel: 3, compartments: [COMPARTMENT_WILDCARD] });
    const result = canAssignClassification(viewer, { level: null, compartment: null }, { level: 4, compartment: null });
    assert.equal(result.ok, false);
  });

  test('未保有の compartment を新たに付けようとすると NG', () => {
    const viewer = makeViewer({ writeLevel: 10, compartments: ['LAFIT'] });
    const result = canAssignClassification(
      viewer,
      { level: null, compartment: null },
      { level: null, compartment: 'SERIO' }
    );
    assert.equal(result.ok, false);
  });

  test('保有している compartment は付けられる', () => {
    const viewer = makeViewer({ writeLevel: 10, compartments: ['LAFIT'] });
    const result = canAssignClassification(
      viewer,
      { level: null, compartment: null },
      { level: null, compartment: 'LAFIT' }
    );
    assert.equal(result.ok, true);
  });

  test('下げる側の判定: 現在 level=7 を 3 にするには writeLevel >= 7 が必要', () => {
    const viewerLow = makeViewer({ writeLevel: 6, compartments: [COMPARTMENT_WILDCARD] });
    const viewerHigh = makeViewer({ writeLevel: 7, compartments: [COMPARTMENT_WILDCARD] });
    const current = { level: 7, compartment: null };
    const next = { level: 3, compartment: null };
    assert.equal(canAssignClassification(viewerLow, current, next).ok, false);
    assert.equal(canAssignClassification(viewerHigh, current, next).ok, true);
  });

  test('下げる側の判定: 現在の compartment を外すにはそれを保有していることが必要', () => {
    const viewerWithout = makeViewer({ writeLevel: 10, compartments: [] });
    const viewerWith = makeViewer({ writeLevel: 10, compartments: ['LAFIT'] });
    const current = { level: null, compartment: 'LAFIT' };
    const next = { level: null, compartment: null };
    assert.equal(canAssignClassification(viewerWithout, current, next).ok, false);
    assert.equal(canAssignClassification(viewerWith, current, next).ok, true);
  });

  test('admin は writeLevel/compartments の制限を全てバイパスする', () => {
    const admin = makeViewer({ writeLevel: 0, compartments: [], isOrgAdmin: true });
    const result = canAssignClassification(
      admin,
      { level: 9, compartment: 'LAFIT' },
      { level: 10, compartment: 'SERIO' }
    );
    assert.equal(result.ok, true);
  });

  test('admin でも level 範囲外はエラー（D1 は常に効く）', () => {
    const admin = makeViewer({ isOrgAdmin: true });
    assert.equal(canAssignClassification(admin, { level: null, compartment: null }, { level: 11, compartment: null }).ok, false);
  });

  test('null（継承）への変更は制約なしで常に通る', () => {
    const viewer = makeViewer({ writeLevel: 0, compartments: [] });
    const result = canAssignClassification(viewer, { level: null, compartment: null }, { level: null, compartment: null });
    assert.equal(result.ok, true);
  });
});

// --- decideAuditTargets ---

describe('decideAuditTargets', () => {
  test('自分のみ → 空配列', () => {
    assert.deepEqual(decideAuditTargets('u-viewer', ['u-viewer', 'u-viewer']), []);
  });

  test('他人 2 人 → 2 件（重複除去）', () => {
    assert.deepEqual(decideAuditTargets('u-viewer', ['u-a', 'u-b', 'u-a']), ['u-a', 'u-b']);
  });

  test('自分と他人が混在 → 自分を除いた初出順', () => {
    assert.deepEqual(decideAuditTargets('u-viewer', ['u-a', 'u-viewer', 'u-b', 'u-a']), ['u-a', 'u-b']);
  });

  test('空配列 → 空配列', () => {
    assert.deepEqual(decideAuditTargets('u-viewer', []), []);
  });
});

// --- normalizeClearanceInput ---

describe('normalizeClearanceInput', () => {
  test('正常系', () => {
    const result = normalizeClearanceInput({ readLevel: 3, writeLevel: 5, compartments: ['LAFIT', ' SERIO '] });
    assert.deepEqual(result, { ok: true, value: { readLevel: 3, writeLevel: 5, compartments: ['LAFIT', 'SERIO'] } });
  });

  test('"*" はワイルドカードとして許可される', () => {
    const result = normalizeClearanceInput({ readLevel: 0, writeLevel: 0, compartments: [COMPARTMENT_WILDCARD] });
    assert.deepEqual(result, { ok: true, value: { readLevel: 0, writeLevel: 0, compartments: [COMPARTMENT_WILDCARD] } });
  });

  test('重複は除去される', () => {
    const result = normalizeClearanceInput({ readLevel: 0, writeLevel: 0, compartments: ['LAFIT', 'LAFIT'] });
    assert.deepEqual(result.value.compartments, ['LAFIT']);
  });

  test('readLevel/writeLevel 範囲外はエラー', () => {
    assert.equal(normalizeClearanceInput({ readLevel: -1, writeLevel: 0, compartments: [] }).ok, false);
    assert.equal(normalizeClearanceInput({ readLevel: 0, writeLevel: 11, compartments: [] }).ok, false);
  });

  test('compartments が配列でなければエラー', () => {
    assert.equal(normalizeClearanceInput({ readLevel: 0, writeLevel: 0, compartments: 'LAFIT' }).ok, false);
  });

  test('compartments の要素が長すぎるとエラー', () => {
    const result = normalizeClearanceInput({
      readLevel: 0,
      writeLevel: 0,
      compartments: ['A'.repeat(COMPARTMENT_MAX_LENGTH + 1)],
    });
    assert.equal(result.ok, false);
  });
});
