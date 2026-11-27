// スレッド状態バッジ（プラン作成済み/実行済み/回答済み）: thread-state-rules.ts の単体テスト。
// 外部 import ゼロの純関数をコンパイル済み dist から直接 import する
// （thread-activity.test.mjs / thread-label-source.test.mjs と同じ流儀）。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  isThreadStateBadgeEnabled,
  hasPlanMarkerLine,
  stripPlanMarkerLine,
  resolveThreadState,
  PLAN_MARKER_LINE,
  PLAN_MARKER_PROMPT_LINE,
} from '../dist/services/thread-state-rules.js';

describe('isThreadStateBadgeEnabled', () => {
  test('未設定（undefined）は有効', () => {
    assert.equal(isThreadStateBadgeEnabled(undefined), true);
  });
  test("'0' は無効", () => {
    assert.equal(isThreadStateBadgeEnabled('0'), false);
  });
  test("未知の値（'x' 等）は有効（'0' のときだけ無効という既存キルスイッチと同じ流儀）", () => {
    assert.equal(isThreadStateBadgeEnabled('x'), true);
  });
});

describe('PLAN_MARKER_PROMPT_LINE', () => {
  test('マーカー文字列自体を含む（文言を変えても印の形式だけは固定される）', () => {
    assert.ok(PLAN_MARKER_PROMPT_LINE.includes(PLAN_MARKER_LINE));
  });
});

describe('hasPlanMarkerLine', () => {
  test('単独行で一致すれば true', () => {
    assert.equal(hasPlanMarkerLine(`プランの内容です。\n\n${PLAN_MARKER_LINE}`), true);
  });
  test('前後に空白があっても一致する', () => {
    assert.equal(hasPlanMarkerLine(`本文\n  ${PLAN_MARKER_LINE}  \n`), true);
  });
  test('印が無ければ false', () => {
    assert.equal(hasPlanMarkerLine('ただの回答です。'), false);
  });
  test('コードブロック内の印は記法の例示として無視する', () => {
    const text = [
      '説明します。',
      '```',
      PLAN_MARKER_LINE,
      '```',
      '以上です。',
    ].join('\n');
    assert.equal(hasPlanMarkerLine(text), false);
  });
  test('コードブロックの外にある印は検出する（ブロックの前後関係が正しく追跡される）', () => {
    const text = [
      '```',
      '例: このように書きます',
      '```',
      PLAN_MARKER_LINE,
    ].join('\n');
    assert.equal(hasPlanMarkerLine(text), true);
  });
  test('非文字列は false', () => {
    assert.equal(hasPlanMarkerLine(undefined), false);
    assert.equal(hasPlanMarkerLine(null), false);
  });
});

describe('stripPlanMarkerLine', () => {
  test('印の行を取り除き、末尾の空行も畳む', () => {
    const result = stripPlanMarkerLine(`このプランでよければ実行してください。\n\n${PLAN_MARKER_LINE}`);
    assert.equal(result, 'このプランでよければ実行してください。');
  });
  test('コードブロック内の印は温存する（記法の例示を壊さない）', () => {
    const text = `説明\n\`\`\`\n${PLAN_MARKER_LINE}\n\`\`\``;
    assert.equal(stripPlanMarkerLine(text), text);
  });
  test('印が無ければ無変更', () => {
    assert.equal(stripPlanMarkerLine('ただの回答です。'), 'ただの回答です。');
  });
  test('非文字列はそのまま返す（呼び出し側の分岐を単純にする fail-soft）', () => {
    assert.equal(stripPlanMarkerLine(undefined), undefined);
  });
});

describe('resolveThreadState', () => {
  test('enabled=false のときは常に undefined（他の引数に関わらず）', () => {
    assert.equal(resolveThreadState({
      enabled: false,
      hasAiMessage: true,
      execCompletedAt: new Date(),
      planReadyAt: new Date(),
    }), undefined);
  });

  test('execCompletedAt があれば executed（planReadyAt があっても優先）', () => {
    assert.equal(resolveThreadState({
      enabled: true,
      hasAiMessage: true,
      execCompletedAt: new Date(),
      planReadyAt: new Date(),
    }), 'executed');
  });

  test('execCompletedAt が無く planReadyAt があれば planned', () => {
    assert.equal(resolveThreadState({
      enabled: true,
      hasAiMessage: true,
      execCompletedAt: null,
      planReadyAt: new Date(),
    }), 'planned');
  });

  test('どちらも無く hasAiMessage=true なら answered', () => {
    assert.equal(resolveThreadState({
      enabled: true,
      hasAiMessage: true,
      execCompletedAt: null,
      planReadyAt: null,
    }), 'answered');
  });

  test('AI 応答が1件も無ければ null（新規スレッド等。バッジなし）', () => {
    assert.equal(resolveThreadState({
      enabled: true,
      hasAiMessage: false,
      execCompletedAt: null,
      planReadyAt: null,
    }), null);
  });
});
