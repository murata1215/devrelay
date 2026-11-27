import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');

function readSource(relPath) {
  return readFileSync(path.join(serverRoot, relPath), 'utf8');
}

describe('Session.origin wiring', () => {
  test('createSession は作成元を保存し、未指定時は interactive にする', () => {
    const source = readSource('src/services/session-manager.ts');
    assert.match(source, /origin:\s*options\?\.origin\s*\?\?\s*'interactive'/);
  });

  test('MCP の instruction と ask の両方が mcp 作成元を渡す', () => {
    const source = readSource('src/mcp/tools.ts');
    const matches = source.match(/createSession\([\s\S]{0,500}?origin:\s*'mcp'/g) ?? [];
    assert.ok(matches.length >= 2, 'submit_instruction と ask_project の両方で origin:mcp を渡す');
  });

  test('一覧 API は origin を検証・絞り込み・応答へ反映する', () => {
    const source = readSource('src/routes/api.ts');
    assert.match(source, /parseThreadOrigin\(request\.query\.origin\)/);
    assert.match(source, /\.\.\.\(origin \? \{ origin \} : \{\}\)/);
    assert.match(source, /origin:\s*s\.origin/);
  });
});
