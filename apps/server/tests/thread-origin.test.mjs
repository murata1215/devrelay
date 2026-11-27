import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseThreadOrigin } from '../dist/services/thread-origin.js';

describe('parseThreadOrigin', () => {
  test('未指定は全件取得として undefined を返す', () => {
    assert.equal(parseThreadOrigin(undefined), undefined);
  });

  test('interactive と mcp だけを受け入れる', () => {
    assert.equal(parseThreadOrigin('interactive'), 'interactive');
    assert.equal(parseThreadOrigin('mcp'), 'mcp');
  });

  test('未知の値は null を返す', () => {
    assert.equal(parseThreadOrigin('system'), null);
    assert.equal(parseThreadOrigin(''), null);
  });
});
