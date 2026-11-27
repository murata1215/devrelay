import { test } from 'node:test';
import assert from 'node:assert/strict';
import { beginReviewRun, endReviewRun, getReviewRunPhase, setReviewRunPhase } from '../dist/services/review-run-state.js';

test('review run state: 多重開始を拒否し、失敗時の解除後に再開できる', () => {
  const id = 'review-test';
  assert.equal(beginReviewRun(id), true);
  assert.equal(beginReviewRun(id), false);
  assert.equal(getReviewRunPhase(id), 'reviewing');
  setReviewRunPhase(id, 'reconsidering');
  assert.equal(getReviewRunPhase(id), 'reconsidering');
  endReviewRun(id);
  assert.equal(getReviewRunPhase(id), null);
  assert.equal(beginReviewRun(id), true);
  endReviewRun(id);
});
