import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reviewBody = readFileSync(path.join(root, 'src/components/ReviewMessageBody.tsx'), 'utf8');
const chat = readFileSync(path.join(root, 'src/pages/ChatPage.tsx'), 'utf8');
const markdown = readFileSync(path.join(root, 'src/components/MarkdownBody.tsx'), 'utf8');

test('review detail: [review] user message only is folded', () => {
  assert.match(reviewBody, /text\.startsWith\(REVIEW_PREFIX\)/);
  assert.match(chat, /isUser \? <ReviewMessageBody/);
  assert.doesNotMatch(markdown, /devrelay:detail/);
});
