import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildToolApprovalPromptPayload } from '../dist/services/tool-approval-payload.js';

describe('buildToolApprovalPromptPayload（スレッド管理 サイクル4）', () => {
  test('sessionId は必ず載る（承認要求の完全な payload）', () => {
    const payload = buildToolApprovalPromptPayload({
      requestId: 'req1',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
      sessionId: 'sess1',
      title: 'タイトル',
      description: '説明',
      projectId: 'proj1',
      isQuestion: false,
      originProjectId: 'origin1',
    });
    assert.equal(payload.sessionId, 'sess1');
    assert.equal(payload.requestId, 'req1');
    assert.equal(payload.toolName, 'Bash');
    assert.deepEqual(payload.toolInput, { command: 'ls' });
    assert.equal(payload.title, 'タイトル');
    assert.equal(payload.description, '説明');
    assert.equal(payload.projectId, 'proj1');
    assert.equal(payload.originProjectId, 'origin1');
  });

  test('sessionId は必ず載る（復元経路の最小 payload、title/description/originProjectId 無し）', () => {
    const payload = buildToolApprovalPromptPayload({
      requestId: 'req2',
      toolName: 'AskUserQuestion',
      toolInput: { question: 'どちら？' },
      sessionId: 'sess2',
      projectId: 'proj2',
      isQuestion: true,
    });
    assert.equal(payload.sessionId, 'sess2');
    assert.equal(payload.isQuestion, true);
  });

  test('optional キーは値が無ければキー自体が存在しない（後方互換、JSON.stringify と同じ省略結果）', () => {
    const payload = buildToolApprovalPromptPayload({
      requestId: 'req3',
      toolName: 'Edit',
      toolInput: {},
      sessionId: 'sess3',
    });
    assert.deepEqual(payload, {
      requestId: 'req3',
      toolName: 'Edit',
      toolInput: {},
      sessionId: 'sess3',
    });
    assert.deepEqual(Object.keys(payload).sort(), ['requestId', 'sessionId', 'toolInput', 'toolName']);
  });

  test('null/undefined の optional キーは省略される', () => {
    const payload = buildToolApprovalPromptPayload({
      requestId: 'req4',
      toolName: 'Edit',
      toolInput: {},
      sessionId: 'sess4',
      title: null,
      description: undefined,
      projectId: null,
      isQuestion: undefined,
      originProjectId: null,
    });
    assert.deepEqual(Object.keys(payload).sort(), ['requestId', 'sessionId', 'toolInput', 'toolName']);
  });

  test('isQuestion:false は省略される（isQuestion:true のときだけ現行実装と同様に載る）', () => {
    const payload = buildToolApprovalPromptPayload({
      requestId: 'req5',
      toolName: 'Bash',
      toolInput: {},
      sessionId: 'sess5',
      isQuestion: false,
    });
    assert.equal('isQuestion' in payload, false);
  });
});
