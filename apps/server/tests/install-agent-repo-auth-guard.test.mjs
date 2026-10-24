// 読取PATのサーバー配布サイクル: scripts/install-agent.sh / install-agent.ps1 の
// サーバー配布 PAT 取り込み部分に対する静的ガード（node:fs のみ、スクリプトを実行しない）。
//
// これが無いと、将来の編集で以下が黙って崩れても気づけない:
// - レスポンス本文（authHeader/SERVER_REPO_HEADER 相当）を echo/Write-Host でそのまま出す事故
// - HTTPS 以外（http/SSH 等）でも PAT 配布エンドポイントを叩いてしまう後退
// - 手入力 PAT フォールバック（prompt_repo_token/Read-RepoToken）の消失
// - set -x の混入（bash の実行トレースで変数展開が丸ごと出力される）

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..');

function readScript(relPath) {
  return readFileSync(path.join(repoRoot, relPath), 'utf8');
}

describe('install-agent.sh', () => {
  const source = readScript('scripts/install-agent.sh');

  test('fetch_server_repo_auth 関数がある', () => {
    assert.match(source, /fetch_server_repo_auth\(\)\s*\{/);
  });

  test('HTTPS 以外（https://* 以外）では早期 return する分岐がある', () => {
    assert.match(source, /case "\$1" in\s*\n\s*https:\/\/\*\)/);
  });

  test('curl の応答本文（$response）をパース用途（grep へのパイプ）以外で出力する行が無い', () => {
    const lines = source.split('\n');
    // grep/cut へのパイプ無しで $response をそのまま echo/cat する行だけを「生ダンプ」として検出する
    // （`echo "$response" | grep ...` によるフィールド抽出は安全な用途として除外する）
    const offenders = lines.filter((l) => /(echo|cat)\s+"\$response"(?!\s*\|)/.test(l));
    assert.deepEqual(offenders, [], `$response を生ダンプする行が無いこと: ${offenders.join(' / ')}`);
  });

  test('set -x が無い（実行トレースで変数展開が丸ごと出力される事故を防ぐ）', () => {
    assert.ok(!/^\s*set -x\b/m.test(source), 'set -x が含まれていないこと');
  });

  test('--repo-auth-only 経路に手入力フォールバック（prompt_repo_token）が残っている', () => {
    const blockMatch = source.match(/if \[ "\$REPO_AUTH_ONLY" = true \];[\s\S]*?^fi/m);
    assert.ok(blockMatch, '--repo-auth-only ブロックが見つかること');
    assert.match(blockMatch[0], /prompt_repo_token/);
  });

  test('Step2（通常インストール）の明示 --repo 経路にも手入力フォールバックが残っている', () => {
    assert.match(source, /REPO_URL_EXPLICIT" = true \] && \[ -z "\$REPO_TOKEN" \]/);
    const idx = source.indexOf('REPO_URL_EXPLICIT" = true ] && [ -z "$REPO_TOKEN" ]');
    const nearby = source.slice(idx, idx + 600);
    assert.match(nearby, /prompt_repo_token/);
  });

  test('write_repo_auth_header 関数がある（サーバー配布ヘッダ値の書き込み専用）', () => {
    assert.match(source, /write_repo_auth_header\(\)\s*\{/);
  });

  test('スクリプト末尾で SERVER_REPO_HEADER / REPO_TOKEN を unset している', () => {
    assert.match(source, /unset .*SERVER_REPO_HEADER/);
  });
});

describe('install-agent.ps1', () => {
  const source = readScript('scripts/install-agent.ps1');

  test('Get-ServerRepoAuth 関数がある', () => {
    assert.match(source, /function Get-ServerRepoAuth\s*\{/);
  });

  test('HTTPS 以外では早期 return する分岐がある', () => {
    assert.match(source, /if \(-not \(\$ApiBaseUrl -match "\^https:\/\/"\)\) \{ return \}/);
  });

  test('レスポンス本文を Write-Host でそのまま出す行が無い', () => {
    const lines = source.split('\n');
    const offenders = lines.filter((l) => /Write-Host.*\$response\b/.test(l));
    assert.deepEqual(offenders, [], '$response をそのまま Write-Host していないこと');
  });

  test('$RepoAuthOnly 経路に手入力フォールバック（Read-RepoToken）が残っている', () => {
    const idx = source.indexOf('if ($RepoAuthOnly) {');
    assert.ok(idx !== -1, '$RepoAuthOnly ブロックが見つかること');
    const nearby = source.slice(idx, idx + 2000);
    assert.match(nearby, /Read-RepoToken/);
  });

  test('Write-RepoAuthHeader 関数がある（サーバー配布ヘッダ値の書き込み専用）', () => {
    assert.match(source, /function Write-RepoAuthHeader\s*\{/);
  });

  test('スクリプト末尾で $script:ServerRepoHeader を $null クリアしている', () => {
    assert.match(source, /\$script:ServerRepoHeader = \$null/);
  });
});
