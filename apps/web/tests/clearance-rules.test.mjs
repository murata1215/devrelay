// 高辻ナレッジ サイクル3（WebUI）: clearance-rules.ts の単体テスト。
// 外部 import ゼロの純関数をコンパイル済み dist-test から直接 import する。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  canViewClearance,
  canEditClearance,
  canEditOwnClearance,
  canEditClassification,
  canShowThreadEditor,
  parseCompartmentInput,
  normalizeCompartmentList,
  serializeCompartmentList,
  compartmentConflict,
  applyWildcardExclusivity,
  hasCompartmentAccess,
  parseLevelInput,
  validateClearanceDraft,
  toClearanceDraft,
  isClearanceDirty,
  buildClassificationPatch,
  isClassificationDirty,
  describeEffectiveClassification,
  isOrgLessError,
  isAdminRequiredError,
  isClassificationForbiddenError,
  ORG_LESS_MESSAGE,
  ADMIN_REQUIRED_MESSAGE,
} from '../dist-test/lib/clearance-rules.js';

// ---- role ゲート ----

describe('canViewClearance', () => {
  test('admin は true', () => assert.equal(canViewClearance('admin'), true));
  test('manager は true', () => assert.equal(canViewClearance('manager'), true));
  test('member は false', () => assert.equal(canViewClearance('member'), false));
  test('null は false', () => assert.equal(canViewClearance(null), false));
  test('undefined は false', () => assert.equal(canViewClearance(undefined), false));
});

describe('canEditClearance', () => {
  test('admin のみ true', () => {
    assert.equal(canEditClearance('admin'), true);
    assert.equal(canEditClearance('manager'), false);
    assert.equal(canEditClearance('member'), false);
    assert.equal(canEditClearance(null), false);
  });
});

describe('canEditOwnClearance', () => {
  test('自分自身なら role に関係なく true', () => {
    assert.equal(canEditOwnClearance(null, 'u1', 'u1'), true);
    assert.equal(canEditOwnClearance('member', 'u1', 'u1'), true);
  });
  test('他人なら admin のときだけ true', () => {
    assert.equal(canEditOwnClearance('admin', 'u1', 'u2'), true);
    assert.equal(canEditOwnClearance('manager', 'u1', 'u2'), false);
  });
});

describe('canEditClassification', () => {
  test('member が自分のものを編集: true', () => {
    assert.equal(canEditClassification('member', 'u1', 'u1'), true);
  });
  test('member が他人のものを編集: false', () => {
    assert.equal(canEditClassification('member', 'u1', 'u2'), false);
  });
  test('manager が他人のものを編集: true', () => {
    assert.equal(canEditClassification('manager', 'u1', 'u2'), true);
  });
  test('null role + 自分: true（組織なし自己編集）', () => {
    assert.equal(canEditClassification(null, 'u1', 'u1'), true);
  });
  test('null role + 他人: false', () => {
    assert.equal(canEditClassification(null, 'u1', 'u2'), false);
  });
});

describe('canShowThreadEditor', () => {
  test('isOwn なら role 不問で true', () => {
    assert.equal(canShowThreadEditor({ isOwn: true, role: 'member' }), true);
    assert.equal(canShowThreadEditor({ isOwn: true, role: null }), true);
  });
  test('他人のスレッドは admin/manager のみ true', () => {
    assert.equal(canShowThreadEditor({ isOwn: false, role: 'admin' }), true);
    assert.equal(canShowThreadEditor({ isOwn: false, role: 'manager' }), true);
    assert.equal(canShowThreadEditor({ isOwn: false, role: 'member' }), false);
  });
});

// ---- 案件名チップ ----

describe('parseCompartmentInput', () => {
  test('半角カンマ区切り', () => {
    assert.deepEqual(parseCompartmentInput('A, B'), ['A', 'B']);
  });
  test('空白区切りは分割しない（カンマ・改行のみ分割対象）', () => {
    assert.deepEqual(parseCompartmentInput('A B'), ['A B']);
  });
  test('全角カンマ区切り', () => {
    assert.deepEqual(parseCompartmentInput('A，B'), ['A', 'B']);
  });
  test('連続カンマ・末尾カンマは空要素を作らない', () => {
    assert.deepEqual(parseCompartmentInput('a,,b,'), ['a', 'b']);
  });
  test('空白のみは空配列', () => {
    assert.deepEqual(parseCompartmentInput('   '), []);
  });
  test('重複は除去される', () => {
    assert.deepEqual(parseCompartmentInput('A,A,B'), ['A', 'B']);
  });
});

describe('*排他', () => {
  test('compartmentConflict: "*" と他案件が同時だと conflict', () => {
    const r = compartmentConflict(['*', 'FIN']);
    assert.equal(r.conflict, true);
    assert.equal(r.kind, 'wildcard-exclusive');
  });
  test('compartmentConflict: "*" のみは conflict しない', () => {
    assert.equal(compartmentConflict(['*']).conflict, false);
  });
  test('compartmentConflict: 空配列は conflict しない', () => {
    assert.equal(compartmentConflict([]).conflict, false);
  });
  test('applyWildcardExclusivity: on=true で ["*"] のみになる', () => {
    assert.deepEqual(applyWildcardExclusivity(['FIN', 'OPS'], true), ['*']);
  });
  test('applyWildcardExclusivity: on=false で "*" を除く', () => {
    assert.deepEqual(applyWildcardExclusivity(['*', 'FIN'], false), ['FIN']);
  });
  test('applyWildcardExclusivity: on 省略時は現状に "*" があれば ["*"] に畳む', () => {
    assert.deepEqual(applyWildcardExclusivity(['FIN', '*', 'OPS']), ['*']);
  });
});

describe('normalizeCompartmentList / serializeCompartmentList', () => {
  test('"*" が先頭に来る', () => {
    assert.deepEqual(normalizeCompartmentList(['ZZZ', '*', 'AAA']), ['*', 'AAA', 'ZZZ']);
  });
  test('往復: serialize した文字列を再度 parse すると同じ集合になる', () => {
    const values = ['FIN', 'OPS'];
    const serialized = serializeCompartmentList(values);
    assert.deepEqual(normalizeCompartmentList(parseCompartmentInput(serialized)), normalizeCompartmentList(values));
  });
  test('既に正規形の入力は安定', () => {
    assert.deepEqual(normalizeCompartmentList(['A', 'B']), ['A', 'B']);
  });
});

describe('hasCompartmentAccess', () => {
  test('"*" を持てば何でもアクセス可', () => {
    assert.equal(hasCompartmentAccess(['*'], 'FIN'), true);
  });
  test('required が null（壁なし）なら誰でもアクセス可', () => {
    assert.equal(hasCompartmentAccess([], null), true);
  });
  test('required があり自分の案件名リストに無ければ false', () => {
    assert.equal(hasCompartmentAccess([], 'FIN'), false);
    assert.equal(hasCompartmentAccess(['OPS'], 'FIN'), false);
  });
  test('required が自分の案件名リストにあれば true', () => {
    assert.equal(hasCompartmentAccess(['FIN'], 'FIN'), true);
  });
});

// ---- level 検証 ----

describe('parseLevelInput', () => {
  test('空文字は empty エラー（0 ではない）', () => {
    const r = parseLevelInput('');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'empty');
  });
  test('"0" は 0', () => {
    assert.deepEqual(parseLevelInput('0'), { ok: true, value: 0 });
  });
  test('"10" は 10', () => {
    assert.deepEqual(parseLevelInput('10'), { ok: true, value: 10 });
  });
  test('"11"/"-1" は out-of-range', () => {
    assert.equal(parseLevelInput('11').reason, 'out-of-range');
    assert.equal(parseLevelInput('-1').reason, 'out-of-range');
  });
  test('"3.5"/"3abc" は not-integer', () => {
    assert.equal(parseLevelInput('3.5').reason, 'not-integer');
    assert.equal(parseLevelInput('3abc').reason, 'not-integer');
  });
  test('空白のみは empty', () => {
    assert.equal(parseLevelInput(' ').reason, 'empty');
  });
  test('"03" は 3', () => {
    assert.deepEqual(parseLevelInput('03'), { ok: true, value: 3 });
  });
});

// ---- validateClearanceDraft ----

describe('validateClearanceDraft', () => {
  test('有効な入力は 3 フィールド揃ったボディを返す', () => {
    const r = validateClearanceDraft({ readLevel: '3', writeLevel: '2', compartmentsInput: 'FIN, OPS' });
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, { readLevel: 3, writeLevel: 2, compartments: ['FIN', 'OPS'] });
  });

  test('read と write が両方不正なら両方エラーを報告する（短絡させない）', () => {
    const r = validateClearanceDraft({ readLevel: '', writeLevel: '99', compartmentsInput: '' });
    assert.equal(r.ok, false);
    const fields = r.errors.map((e) => e.field);
    assert.ok(fields.includes('readLevel'));
    assert.ok(fields.includes('writeLevel'));
  });

  test('"*,FIN" は compartments エラー', () => {
    const r = validateClearanceDraft({ readLevel: '0', writeLevel: '0', compartmentsInput: '*,FIN' });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.field === 'compartments'));
  });
});

describe('toClearanceDraft / isClearanceDirty', () => {
  const original = { readLevel: 3, writeLevel: 2, compartments: ['FIN', 'OPS'] };

  test('toClearanceDraft で生成したドラフトは dirty ではない', () => {
    assert.equal(isClearanceDirty(original, toClearanceDraft(original)), false);
  });

  test('空白だけの差は dirty ではない', () => {
    assert.equal(isClearanceDirty(original, { readLevel: '3 ', writeLevel: '2', compartmentsInput: 'FIN, OPS' }), false);
  });

  test('チップの並び順だけの差は dirty ではない', () => {
    assert.equal(isClearanceDirty(original, { readLevel: '3', writeLevel: '2', compartmentsInput: 'OPS, FIN' }), false);
  });

  test('実際の変更は dirty', () => {
    assert.equal(isClearanceDirty(original, { readLevel: '5', writeLevel: '2', compartmentsInput: 'FIN, OPS' }), true);
  });
});

// ---- classification patch ----

describe('buildClassificationPatch', () => {
  const original = { level: null, compartment: null };

  test('変更なしは {} を返す', () => {
    const r = buildClassificationPatch(original, { level: '', compartment: '' });
    assert.equal(r.ok, true);
    assert.deepEqual(r.patch, {});
  });

  test('level だけ変更した場合 compartment キーは含まれない', () => {
    const r = buildClassificationPatch(original, { level: '5', compartment: '' });
    assert.deepEqual(r.patch, { level: 5 });
  });

  test('compartment をクリア（元が値あり → 空文字）すると null が明示される', () => {
    const r = buildClassificationPatch({ level: 5, compartment: 'FIN' }, { level: '5', compartment: '' });
    assert.deepEqual(r.patch, { compartment: null });
  });

  test('level をクリア（元が値あり → 空文字）すると null が明示される', () => {
    const r = buildClassificationPatch({ level: 5, compartment: null }, { level: '', compartment: '' });
    assert.deepEqual(r.patch, { level: null });
  });

  test('両方変更すれば両方入る', () => {
    const r = buildClassificationPatch(original, { level: '7', compartment: 'OPS' });
    assert.deepEqual(r.patch, { level: 7, compartment: 'OPS' });
  });

  test('不正な level は ok:false', () => {
    const r = buildClassificationPatch(original, { level: '99', compartment: '' });
    assert.equal(r.ok, false);
    assert.equal(r.key, 'level');
  });
});

describe('isClassificationDirty', () => {
  test('変更なしは false', () => {
    assert.equal(isClassificationDirty({ level: null, compartment: null }, { level: '', compartment: '' }), false);
  });
  test('変更ありは true', () => {
    assert.equal(isClassificationDirty({ level: null, compartment: null }, { level: '3', compartment: '' }), true);
  });
});

describe('describeEffectiveClassification', () => {
  test('level:null は継承とみなす', () => {
    const d = describeEffectiveClassification({ level: null, compartment: null, effectiveLevel: 5, effectiveCompartment: 'FIN' });
    assert.equal(d.levelInherited, true);
    assert.equal(d.compartmentInherited, true);
    assert.equal(d.effectiveLevel, 5);
  });
  test('level に値があれば継承ではない', () => {
    const d = describeEffectiveClassification({ level: 5, compartment: 'FIN', effectiveLevel: 5, effectiveCompartment: 'FIN' });
    assert.equal(d.levelInherited, false);
    assert.equal(d.compartmentInherited, false);
  });
});

// ---- エラー文言判定 ----

describe('エラー文言判定', () => {
  test('isOrgLessError: 完全一致のみ true', () => {
    assert.equal(isOrgLessError(ORG_LESS_MESSAGE), true);
    assert.equal(isOrgLessError('something else'), false);
  });
  test('isAdminRequiredError: 完全一致のみ true', () => {
    assert.equal(isAdminRequiredError(ADMIN_REQUIRED_MESSAGE), true);
    assert.equal(isAdminRequiredError('something else'), false);
  });
  test('isClassificationForbiddenError: "Forbidden:" で始まれば true', () => {
    assert.equal(
      isClassificationForbiddenError('Forbidden: not an organization admin/manager and not the project owner'),
      true
    );
  });
  test('isClassificationForbiddenError: "Project not found" は false', () => {
    assert.equal(isClassificationForbiddenError('Project not found'), false);
  });
});
