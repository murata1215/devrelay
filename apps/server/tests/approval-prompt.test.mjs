// #331: approve_implementation の note 組み立てロジックの単体テスト。
// 外部 import ゼロの純粋関数（apps/server/src/mcp/approval-prompt.ts）を
// コンパイル済み dist から直接 import する（#308 のスタンドアロン・スモークテストと同じ流儀）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApprovalExecPrompt, DEFAULT_APPROVAL_EXEC_PROMPT } from '../dist/mcp/approval-prompt.js';

test('note 未指定（引数なし）は既定文字列と完全一致', () => {
  assert.equal(buildApprovalExecPrompt(), 'プランに従って実装を開始してください。');
  assert.equal(buildApprovalExecPrompt(), DEFAULT_APPROVAL_EXEC_PROMPT);
});

test('note が空白のみの場合も既定文字列と完全一致（従来と完全同形）', () => {
  assert.equal(buildApprovalExecPrompt('   '), 'プランに従って実装を開始してください。');
  assert.equal(buildApprovalExecPrompt('\n\t  \n'), DEFAULT_APPROVAL_EXEC_PROMPT);
});

test('note 指定時は既定文の直後に見出し付きで追記される', () => {
  const result = buildApprovalExecPrompt('案Bで進めて');
  assert.equal(
    result,
    'プランに従って実装を開始してください。\n\n## 承認時の人間からの追記\n案Bで進めて'
  );
});

test('複数行 / Markdown の note は改行を保持したまま追記される', () => {
  const note = '- 案Bで進めて\n- ただしDBは触らないで\n\n理由: 影響範囲を絞りたい';
  const result = buildApprovalExecPrompt(note);
  assert.equal(
    result,
    `プランに従って実装を開始してください。\n\n## 承認時の人間からの追記\n${note}`
  );
  // 改行が潰れていないことを明示的に確認
  assert.ok(result.includes('- 案Bで進めて\n- ただしDBは触らないで'));
});
