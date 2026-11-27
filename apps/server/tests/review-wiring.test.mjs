import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const source = readFileSync(path.join(serverRoot, 'src/services/command-handler.ts'), 'utf8');

test('r review: Team reviewer を解決して ask は一度だけ行う', () => {
  const start = source.indexOf('async function handleReview');
  assert.ok(start >= 0, 'handleReview exists');
  const body = source.slice(start, source.indexOf('async function handleContinue', start));
  assert.match(body, /isReviewer: true/);
  assert.match(body, /runCrossProjectAsk\(/);
  assert.equal((body.match(/runCrossProjectAsk\(/g) ?? []).length, 1);
  assert.match(body, /includeContextPrefix: false/);
  assert.match(body, /internalQuestionMaxLength: REVIEW_QUESTION_MAX_LENGTH/);
  assert.match(body, /isSessionRunning/);
  assert.match(body, /beginReviewRun/);
  assert.match(body, /finally/);
  assert.match(body, /handleAiPrompt\(context, buildReconsiderPrompt/);
  assert.match(body, /permissionPolicy: 'strictReadonly'/);
  assert.match(body, /persistedUserContent: buildReviewStoredMessage/);
});

test('r review: 通常送信はレビュー中に拒否し、完了・タイムアウトで状態を解除する', () => {
  assert.match(source, /getReviewRunPhase\(context\.currentSessionId\)/);
  assert.match(source, /レビュー中です。完了後に送ってください/);
  const agent = readFileSync(path.join(serverRoot, 'src/services/agent-manager.ts'), 'utf8');
  const sessionManager = readFileSync(path.join(serverRoot, 'src/services/session-manager.ts'), 'utf8');
  assert.match(agent, /endReviewRun\(sessionId\)/);
  assert.match(sessionManager, /endReviewRun\(sessionId\)/);
});

test('help: r はレビューだけ、recent は履歴として表示する', () => {
  const parser = readFileSync(path.join(serverRoot, 'src/services/command-parser.ts'), 'utf8');
  assert.match(parser, /Ask this Team's reviewer/);
  assert.match(parser, /Recent work/);
  assert.doesNotMatch(parser, /r\\` - Recent work/);
});
