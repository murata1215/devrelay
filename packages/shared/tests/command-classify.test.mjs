// Usage 案件必須サイクル: server から shared へ移した isTraditionalCommand() の判定が変わらないことの確認。
import test from 'node:test';
import assert from 'node:assert/strict';
import { isTraditionalCommand } from '../dist/command-classify.js';

test('コマンドと判定するもの', () => {
  for (const t of ['e', 'exec', 'x', 'h', 'u', 'k', 'n', 'n make', 'n 2', '3', 'e, この方針で', 'l', 'l plan:haiku', 'a 1', 'ai:claude', 'u force', 'log20', 'sum7d', 'testflight list', 'login cancel']) {
    assert.equal(isTraditionalCommand(t), true, t);
  }
});

test('AI プロンプトと判定するもの', () => {
  for (const t of ['ログ画面を直して', 'exit the loop', 'x を消して', 'please fix', 'n を増やして']) {
    assert.equal(isTraditionalCommand(t), false, t);
  }
});
