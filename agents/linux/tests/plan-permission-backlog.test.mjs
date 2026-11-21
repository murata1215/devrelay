// Backlog 連携（2026-11-21）: devrelay-backlog スキルはプランモード（strictReadonly）でも使える。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideBashCommand, isBacklogSkillInvocation, tokenizeSegment } from '../dist/services/plan-permission.js';

const decide = (command) => decideBashCommand({ command, allowedTools: [], readonlyBashCommands: ['ls'], writeBashCommands: ['rm'] });

test('~ 形・WSL 形・Git bash 形・引用符付きの呼び出しは許可', () => {
  for (const cmd of [
    'bash ~/.claude/skills/devrelay-backlog/scripts/backlog.sh list',
    'bash /mnt/c/Users/Administrator/.claude/skills/devrelay-backlog/scripts/backlog.sh move ABC-1 start',
    'bash /c/Users/Administrator/.claude/skills/devrelay-backlog/scripts/backlog.sh show ABC-1',
    'bash "/home/u/.claude/skills/devrelay-backlog/scripts/backlog.sh" move ABC-1 done --comment "コミット abc: 修正"',
  ]) {
    assert.deepEqual(decide(cmd), { behavior: 'allow' }, cmd);
  }
});

test('別のスクリプト・相対パス・.. 混じり・複合コマンドは許可しない', () => {
  assert.equal(decide('bash ./.claude/skills/devrelay-backlog/scripts/backlog.sh list').behavior, 'deny');
  assert.equal(decide('bash ~/.claude/skills/devrelay-ask-member/scripts/ask.sh --list').behavior, 'deny');
  assert.equal(decide('bash /tmp/../home/u/.claude/skills/devrelay-backlog/scripts/backlog.sh list').behavior, 'deny');
  assert.equal(decide('bash ~/.claude/skills/devrelay-backlog/scripts/backlog.sh list; rm -rf x').behavior, 'deny');
  assert.equal(decide('bash ~/.claude/skills/devrelay-backlog/scripts/backlog.sh list > out.txt').behavior, 'deny');
  assert.equal(isBacklogSkillInvocation(tokenizeSegment('sh ~/.claude/skills/devrelay-backlog/scripts/backlog.sh list')), false);
});
