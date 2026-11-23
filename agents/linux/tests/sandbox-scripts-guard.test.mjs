// サイクル SB-1a-1.1: scripts/install-sandbox-host.ps1 / uninstall-sandbox-host.ps1 に対する
// 静的ガード（node:fs のみ、スクリプトを実行しない。apps/server の
// install-agent-repo-auth-guard.test.mjs と同じ手口）。
//
// これが無いと、将来の編集で以下が黙って再発しても気づけない:
// - A1: 非 ASCII 文字が混入し、Windows PowerShell 5.1 が BOM なし UTF-8 を ANSI として誤読して
//   ParserError になる（hp630g9 実機で発生した既存バグ）
// - A2: `sc.exe create` に `password=` が残り、PowerShell 5.1 で引数が欠落して exit=1639 になる
// - A3: IPv6 ブロックに無効な `"::/0"` が残る
// - A4: ファイアウォールのルールが未検証の `-Service` 形式に戻る
// - A5: 鍵生成が P-256 にならない `NamedCurves` 形式に戻る、または blob 検査が失われる
// - A6(a): サービス停止・削除がビルドより後に戻り、再インストールで exe がロックされる
// - A6(b): 秘密鍵の ACL 戻しが削除より後に戻り、再インストールでアクセス拒否になる

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

function readScriptBuffer(relPath) {
  return readFileSync(path.join(repoRoot, relPath));
}

/** 非 ASCII バイトが見つかった最初の位置を行・列・該当文字として返す（無ければ null）。 */
function findFirstNonAsciiByte(buf) {
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] >= 0x80) {
      // 行・列を計算する（デバッグしやすくするため）
      const textBefore = buf.subarray(0, i).toString('latin1');
      const lines = textBefore.split('\n');
      const line = lines.length;
      const col = lines[lines.length - 1].length + 1;
      return { index: i, line, col, byte: buf[i] };
    }
  }
  return null;
}

const SANDBOX_PS1_FILES = ['scripts/install-sandbox-host.ps1', 'scripts/uninstall-sandbox-host.ps1'];

describe('sandbox .ps1: ASCII のみ（A1: PowerShell 5.1 の ANSI 誤読によるParserError再発防止）', () => {
  for (const relPath of SANDBOX_PS1_FILES) {
    test(`${relPath} は全バイトが 0x80 未満（ASCII）`, () => {
      const buf = readScriptBuffer(relPath);
      const violation = findFirstNonAsciiByte(buf);
      assert.equal(
        violation,
        null,
        violation
          ? `${relPath}:${violation.line}:${violation.col} に非 ASCII バイト 0x${violation.byte.toString(16)} があります`
          : undefined,
      );
    });
  }
});

describe('install-sandbox-host.ps1', () => {
  const source = readScript('scripts/install-sandbox-host.ps1');

  test('A2: sc.exe create に password= が無い', () => {
    const createLineMatch = /sc\.exe create \$ServiceName[^\n]*/.exec(source);
    assert.ok(createLineMatch, 'sc.exe create 行が見つかること');
    assert.ok(!createLineMatch[0].includes('password='), 'password= を含まないこと');
    assert.match(createLineMatch[0], /obj=\s*"\$ServiceAccountName"/, 'obj= を含むこと');
  });

  test('A2: sc create の出力を Out-Null で捨てず、失敗時に表示する', () => {
    const idx = source.indexOf('sc.exe create $ServiceName');
    assert.ok(idx !== -1);
    const body = source.slice(idx, idx + 600);
    assert.ok(!/sc\.exe create \$ServiceName[^\n]*\|\s*Out-Null/.test(body), 'create の出力を無言で捨てていないこと');
    assert.match(body, /LASTEXITCODE -ne 0/);
    assert.match(body, /ForEach-Object\s*\{\s*Write-Host/);
  });

  test('A3: IPv6 ブロックは "::/1","8000::/1" を使い、"::/0" は使わない', () => {
    // コメント（旧バグの説明として `"::/0"` を引用する行）は許可する。実行されるコード行
    // （# で始まらない行）にのみ現れていないことを確認する。
    const codeLines = source.split('\n').filter((line) => !line.trim().startsWith('#'));
    const codeWithOldRange = codeLines.filter((line) => line.includes('"::/0"'));
    assert.deepEqual(codeWithOldRange, [], 'コード行（コメント以外）に "::/0" が無いこと');
    assert.match(source, /"::\/1"\s*,\s*"8000::\/1"/);
  });

  test('A4: ファイアウォールのルール3本すべて -LocalUser を使い、-Service は使わない', () => {
    // 行頭から始まる実呼び出しのみを対象にする（コメント内の "New-NetFirewallRule" という
    // 言及（例: "rejected by New-NetFirewallRule with ..."）を実呼び出しと誤認しないため）。
    const ruleBlocks = [...source.matchAll(/^New-NetFirewallRule[\s\S]*?\| Out-Null/gm)];
    assert.equal(ruleBlocks.length, 3, 'New-NetFirewallRule の呼び出しは3本であること');
    for (const block of ruleBlocks) {
      assert.match(block[0], /-LocalUser/, `-LocalUser を使うこと: ${block[0].slice(0, 80)}...`);
      assert.ok(!/-Service\b/.test(block[0]), `-Service を使わないこと: ${block[0].slice(0, 80)}...`);
    }
  });

  test('A5: 鍵生成は ECDsaCng(256) を使い、コード本体では NamedCurves を使わない', () => {
    assert.match(source, /New-Object System\.Security\.Cryptography\.ECDsaCng\(256\)/);
    // コメント（旧バグの説明として `NamedCurves` を引用する行）は許可する。実行されるコード行
    // （# で始まらない行）にのみ現れていないことを確認する。
    const codeLines = source.split('\n').filter((line) => !line.trim().startsWith('#'));
    const codeWithNamedCurves = codeLines.filter((line) => line.includes('NamedCurves'));
    assert.deepEqual(codeWithNamedCurves, [], 'コード行（コメント以外）に NamedCurves が無いこと');
  });

  test('A5: 公開鍵 blob の長さ（72バイト）と magic バイトを検査している', () => {
    assert.match(source, /pubBlob\.Length -ne 72/);
    assert.match(source, /0x45,\s*0x43,\s*0x53,\s*0x31/); // "ECS1" magic
  });

  test('A6(a): サービスの停止・削除がビルド（csc.exe 呼び出し）より前にある', () => {
    const stopIdx = source.indexOf('Stop-Service -Name $ServiceName');
    const deleteIdx = source.indexOf('sc.exe delete $ServiceName');
    const buildIdx = source.indexOf('& $CscPath $buildArgs');
    assert.ok(stopIdx !== -1 && deleteIdx !== -1 && buildIdx !== -1, '3箇所とも見つかること');
    assert.ok(stopIdx < buildIdx, 'サービス停止がビルドより前であること');
    assert.ok(deleteIdx < buildIdx, 'サービス削除がビルドより前であること');
  });

  test('A6(b): 秘密鍵の書き込み前に Administrators へ ACL を戻してから削除している', () => {
    const grantIdx = source.indexOf('icacls $PrivKeyPath /grant "*S-1-5-32-544:(F)"');
    const removeIdx = source.indexOf('Remove-Item -Path $PrivKeyPath -Force');
    const writeIdx = source.indexOf('[System.IO.File]::WriteAllBytes($PrivKeyPath, $privBlob)');
    assert.ok(grantIdx !== -1 && removeIdx !== -1 && writeIdx !== -1, '3箇所とも見つかること');
    assert.ok(grantIdx < removeIdx, 'ACL 付与が削除より前であること');
    assert.ok(removeIdx < writeIdx, '削除が書き込みより前であること');
  });

  test('A7/B1: 完了メッセージが devrelay コマンドを前提にしていない（node + cli/index.js の実コマンドを組み立てている）', () => {
    assert.ok(!/devrelay\s+sandbox/.test(source), '裸の `devrelay sandbox ...` を案内に含まないこと');
    assert.match(source, /Format-SandboxCliCommand/);
  });

  test('トークンの文字列を出力・ログに含めない（鍵・トークン関連のテキストを素通りさせない）', () => {
    // sandbox-token の内容を読む・表示する処理がないこと（このスクリプトはトークンを扱わない）
    assert.ok(!source.includes('sandbox-token'), 'このスクリプトは sandbox-token を直接扱わないこと');
  });
});

describe('uninstall-sandbox-host.ps1', () => {
  const source = readScript('scripts/uninstall-sandbox-host.ps1');

  test('削除前に秘密鍵の ACL を戻している', () => {
    const grantIdx = source.indexOf('icacls $PrivKeyPath /grant "*S-1-5-32-544:(F)"');
    const removeDirIdx = source.indexOf('Remove-Item -Path $ProgramDataDir -Recurse -Force');
    assert.ok(grantIdx !== -1 && removeDirIdx !== -1);
    assert.ok(grantIdx < removeDirIdx, 'ACL 付与がディレクトリ削除より前であること');
  });

  test('A7/B1: 案内が devrelay コマンドを前提にしていない', () => {
    assert.ok(!/devrelay\s+sandbox/.test(source));
    assert.match(source, /sandbox set-token/);
  });
});
