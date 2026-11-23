// サイクル SB-1a-1.1 / SB-2.1: scripts/install-sandbox-host.ps1 / uninstall-sandbox-host.ps1 /
// apply-sandbox-allowlist.ps1 に対する静的ガード（node:fs のみ、スクリプトを実行しない。
// apps/server の install-agent-repo-auth-guard.test.mjs と同じ手口）。
//
// これが無いと、将来の編集で以下が黙って再発しても気づけない:
// - A1: 非 ASCII 文字が混入し、Windows PowerShell 5.1 が BOM なし UTF-8 を ANSI として誤読して
//   ParserError になる（hp630g9 実機で発生した既存バグ）
// - A2: `sc.exe create` に `password=` が残り、PowerShell 5.1 で引数が欠落して exit=1639 になる
// - A3: IPv6 ブロックに無効な `"::/0"` が残る
// - A4: ファイアウォールのルールが未検証の `-Service` 形式に戻る、または -Group/-Name を失う
//   （サイクル SB-2.1 で install 側のルールは 3 本→2 本に変わった。IPv4 の Block ルールは
//   apply-sandbox-allowlist.ps1 が digest 付きで管理するため、install 側は静的な2本
//   （IPv6 Block・loopback Allow）のみを作る）
// - A5: 鍵生成が P-256 にならない `NamedCurves` 形式に戻る、または blob 検査が失われる
// - A6(a): サービス停止・削除がビルドより後に戻り、再インストールで exe がロックされる
// - A6(b): 秘密鍵の ACL 戻しが削除より後に戻り、再インストールでアクセス拒否になる
// - B1: apply-sandbox-allowlist.ps1 がタスクの引数置換 `$(ArgN)` に依存する形に戻る
//   （schtasks /Run は引数を渡せないため、依存すると静かに壊れる）
// - B2: `netsh` / `Invoke-Expression` による文字列組み立てが紛れ込む
// - B3: `Get-NetFirewallRule` が `-Group` 無しで呼ばれ、無関係なルールまで対象にしてしまう
// - B4: `Remove-NetFirewallRule` が `-DisplayName` ワイルドカードのみで呼ばれ、意図しないルールを
//   消してしまう（apply 側は常に -Name か -Group 経由で削除対象を絞ること）
// - B5: `New-NetFirewallRule` が `-LocalUser`/`-Group`/`-Name` のいずれかを欠くか `-Service` を使う
// - B6: IPv4 補集合の自己検査関数（Test-Ipv4ComplementSelfCheck）が失われる
// - B7: request.json のリパースポイント確認が、内容を読む（Get-Content）より後に戻る
// - B8: 拒否エントリの原文（ip/port 等の値）が state.json の rejected に書き戻されるようになる
//   （index と固定の reason コードのみであるべき）
// - C1: install/uninstall のタスク登録・削除が非対称になる（install が登録したのと同じ
//   /TN を uninstall が消さない）
//
// サイクル SB-2.1.1 で追加（hp630g9 実機: install が `schtasks /Delete` で停止し、タスク登録・
// 開発者への実行権付与・最初のファイアウォール反映が一切行われなかった不具合の根治）:
// - D1: 外部コマンドへの `2>$null`/`2>&1` の直接リダイレクトが復活する（ヘルパー内の1箇所を除く。
//   PowerShell 5.1 は $ErrorActionPreference="Stop" の下でこのリダイレクトを無力化し、
//   stderr を出した外部コマンドが毎回スクリプトを終了させてしまう）
// - D2: 外部コマンドが `Invoke-NativeCommand` ヘルパーを経由せず直接 `&` 呼び出しに戻る
// - D3: ヘルパー自体が ErrorActionPreference の退避/復元・LASTEXITCODE リセット・
//   -AllowFailure 以外での exit のいずれかを失う
// - D4: install と uninstall のヘルパーがコピーのまま分岐し、修正が片方にしか当たらなくなる
// - D5: 「存在しなくても成功」であるべき削除系コマンドが -AllowFailure を失って無関係な初回
//   インストールまで失敗させる、または逆に失敗を握りつぶすべきでない ACL 付与が
//   -AllowFailure 付きになる

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

/** コメント行（# で始まる行）を除いた実行コード行のみを返す（旧バグの説明としてコメント内に
 *  引用される文字列を実行コードと誤認しないため、A3/A5/B6 等で使う既存の手口）。 */
function codeLinesOf(source) {
  return source.split('\n').filter((line) => !line.trim().startsWith('#'));
}

const SANDBOX_PS1_FILES = [
  'scripts/install-sandbox-host.ps1',
  'scripts/uninstall-sandbox-host.ps1',
  'scripts/apply-sandbox-allowlist.ps1',
];

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
    // SB-2.1.1: Invoke-NativeCommand 経由になったため判定は $scCreateResult.ExitCode
    // （旧: $LASTEXITCODE）。どちらの書き方でも通るようにする。
    assert.match(body, /(\$scCreateResult\.ExitCode|LASTEXITCODE)\s*-ne 0/);
    assert.match(body, /ForEach-Object\s*\{\s*Write-Host/);
  });

  test('A3: IPv6 ブロックは "::/1","8000::/1" を使い、"::/0" は使わない', () => {
    const codeWithOldRange = codeLinesOf(source).filter((line) => line.includes('"::/0"'));
    assert.deepEqual(codeWithOldRange, [], 'コード行（コメント以外）に "::/0" が無いこと');
    assert.match(source, /"::\/1"\s*,\s*"8000::\/1"/);
  });

  test('A4: ファイアウォールのルールは2本（静的な IPv6 Block・loopback Allow のみ）', () => {
    // 行頭から始まる実呼び出しのみを対象にする（コメント内の "New-NetFirewallRule" という
    // 言及（例: "rejected by New-NetFirewallRule with ..."）を実呼び出しと誤認しないため）。
    const ruleBlocks = [...source.matchAll(/^New-NetFirewallRule[\s\S]*?\| Out-Null/gm)];
    assert.equal(
      ruleBlocks.length,
      2,
      'install-sandbox-host.ps1 が直接作る New-NetFirewallRule の呼び出しは2本であること' +
        '（IPv4 の動的 Block ルールは apply-sandbox-allowlist.ps1 が digest 付きで管理する）',
    );
    for (const block of ruleBlocks) {
      assert.match(block[0], /-LocalUser/, `-LocalUser を使うこと: ${block[0].slice(0, 80)}...`);
      assert.match(block[0], /-Group \$FirewallGroup/, `-Group を使うこと: ${block[0].slice(0, 80)}...`);
      assert.match(block[0], /-Name "DevRelay-SandboxStatic-/, `-Name を使うこと: ${block[0].slice(0, 80)}...`);
      assert.ok(!/-Service\b/.test(block[0]), `-Service を使わないこと: ${block[0].slice(0, 80)}...`);
    }
  });

  test('A4: ファイアウォールのルール削除は DisplayName ワイルドカード と Group の両方を見る（旧スキーム・新スキームの両方を一掃する）', () => {
    assert.match(source, /Get-NetFirewallRule -DisplayName "DevRelay Sandbox\*"/);
    assert.match(source, /Get-NetFirewallRule -Group \$FirewallGroup/);
  });

  test('A5: 鍵生成は ECDsaCng(256) を使い、コード本体では NamedCurves を使わない', () => {
    assert.match(source, /New-Object System\.Security\.Cryptography\.ECDsaCng\(256\)/);
    const codeWithNamedCurves = codeLinesOf(source).filter((line) => line.includes('NamedCurves'));
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

  test('C1: 許可リスト反映タスク（\\DevRelay\\apply-sandbox-allowlist）を ONSTART / SYSTEM / HIGHEST で登録する', () => {
    const createIdx = source.indexOf('schtasks /Create /TN $TaskPath');
    assert.ok(createIdx !== -1, 'schtasks /Create 行が見つかること');
    const line = source.slice(createIdx, source.indexOf('\n', createIdx));
    assert.match(line, /\/SC ONSTART/);
    assert.match(line, /\/RU "SYSTEM"/);
    assert.match(line, /\/RL HIGHEST/);
    assert.match(line, /\/F\b/);
  });

  test('C1: apply-allowlist.ps1 の起動コマンドが引数置換 $(ArgN) に依存しない', () => {
    const codeWithArgToken = codeLinesOf(source).filter((line) => line.includes('$(Arg'));
    assert.deepEqual(codeWithArgToken, [], 'コード行（コメント以外）に $(Arg が無いこと');
  });

  test('allowlist-bin\\ のACLは developer に実行(RX)のみで変更権限(M/W)を与えない', () => {
    const idx = source.indexOf('& icacls $AllowlistBinDir /grant "*$($DeveloperSid)');
    assert.ok(idx !== -1, 'AllowlistBinDir への developer ACL 付与行が見つかること');
    const line = source.slice(idx, source.indexOf('\n', idx));
    assert.match(line, /\(RX\)/);
    assert.ok(!/\(M\)|\(W\)|\(F\)/.test(line), 'developer には Modify/Write/Full を与えないこと');
  });

  test('allowlist-request\\ / allowlist-result\\ / allowlist-deny\\ のいずれにもサービス SID への ACE を与えない', () => {
    const section = source.slice(
      source.indexOf('# --- Step 11b'),
      source.indexOf('Write-Host "[OK] Created allow-destinations directories and ACLs"'),
    );
    assert.ok(section.length > 0, 'Step 11b の本文が見つかること');
    assert.ok(!section.includes('$ServiceSid'), 'Step 11b の ACL 設定にサービス SID への言及が無いこと');
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

  test('A4: ファイアウォールのルール削除は DisplayName ワイルドカード と Group の両方を見る', () => {
    assert.match(source, /Get-NetFirewallRule -DisplayName "DevRelay Sandbox\*"/);
    assert.match(source, /Get-NetFirewallRule -Group \$FirewallGroup/);
  });

  test('C1: install が登録したタスク（\\DevRelay\\apply-sandbox-allowlist）を削除する', () => {
    assert.match(source, /schtasks \/Delete \/TN \$TaskPath \/F/);
    assert.match(source, /\$TaskPath = "\$TaskFolder\\\$TaskName"/);
  });
});

describe('apply-sandbox-allowlist.ps1', () => {
  const source = readScript('scripts/apply-sandbox-allowlist.ps1');

  test('B1: 引数置換 $(ArgN) に依存しない（schtasks /Run は引数を渡せないため）', () => {
    const codeWithArgToken = codeLinesOf(source).filter((line) => line.includes('$(Arg'));
    assert.deepEqual(codeWithArgToken, [], 'コード行（コメント以外）に $(Arg が無いこと');
  });

  test('B1: トップレベルの param() を持たない（ゼロ引数スクリプト）', () => {
    assert.ok(!/^param\(/m.test(source), 'トップレベルの param() が無いこと');
  });

  test('B2: netsh / Invoke-Expression を使わない', () => {
    assert.ok(!source.includes('netsh'), 'netsh を使わないこと');
    assert.ok(!source.includes('Invoke-Expression'), 'Invoke-Expression を使わないこと');
  });

  test('B3: Get-NetFirewallRule の呼び出しは常に -Group 付き', () => {
    const calls = [...source.matchAll(/Get-NetFirewallRule[^\n]*/g)];
    assert.ok(calls.length > 0, 'Get-NetFirewallRule の呼び出しが見つかること');
    for (const call of calls) {
      assert.match(call[0], /-(Group|Name)\b/, `-Group か -Name を使うこと: ${call[0]}`);
    }
  });

  test('B4: Remove-NetFirewallRule は -DisplayName ワイルドカード指定で呼ばない（-Name 絞り込み経由のみ）', () => {
    assert.ok(!/Remove-NetFirewallRule[^\n]*-DisplayName/.test(source), '-DisplayName 指定の Remove-NetFirewallRule が無いこと');
  });

  test('B5: New-NetFirewallRule はすべて -LocalUser/-Group/-Name 付きで -Service は使わない', () => {
    const ruleBlocks = [...source.matchAll(/New-NetFirewallRule[\s\S]*?\| Out-Null/g)];
    assert.ok(ruleBlocks.length >= 2, 'New-NetFirewallRule の呼び出しが2本以上見つかること（ipv4 + tcp か udp）');
    for (const block of ruleBlocks) {
      assert.match(block[0], /-LocalUser/, `-LocalUser を使うこと: ${block[0].slice(0, 80)}...`);
      assert.match(block[0], /-Group \$FirewallGroup/, `-Group を使うこと: ${block[0].slice(0, 80)}...`);
      assert.match(block[0], /-Name \$\w*RuleName\b/, `-Name を使うこと: ${block[0].slice(0, 80)}...`);
      assert.ok(!/-Service\b/.test(block[0]), `-Service を使わないこと: ${block[0].slice(0, 80)}...`);
    }
  });

  test('ルール名がすべて "DevRelay-SandboxGen-<digest>-" プレフィックスを使う（generation 切替の対象と一致させる）', () => {
    assert.match(source, /\$ipv4RuleName\s*=\s*"DevRelay-SandboxGen-\$gen-ipv4"/);
    assert.match(source, /\$tcpRuleName\s*=\s*"DevRelay-SandboxGen-\$gen-tcp-\$tcpIndex"/);
    assert.match(source, /\$udpRuleName\s*=\s*"DevRelay-SandboxGen-\$gen-udp"/);
  });

  test('決定1（追加4で訂正）: ICMPv4（ping）の Block ルールを作らない', () => {
    assert.ok(!source.includes('-Protocol ICMPv4'), 'ICMPv4 の Block ルールが無いこと（OS が代行し身元単位では止まらない）');
  });

  test('コード行に "::/0" が無い（IPv4 専用スクリプトだが、将来の IPv6 誤操作を防ぐ）', () => {
    const codeWithOldRange = codeLinesOf(source).filter((line) => line.includes('"::/0"'));
    assert.deepEqual(codeWithOldRange, []);
  });

  test('B6: IPv4 補集合の自己検査関数が存在し、違反時は firewall を変更せずに abort する', () => {
    assert.match(source, /function Test-Ipv4ComplementSelfCheck/);
    const idx = source.indexOf('if (-not (Test-Ipv4ComplementSelfCheck');
    assert.ok(idx !== -1, '自己検査の呼び出しが見つかること');
    const body = source.slice(idx, source.indexOf('exit 1', idx) + 'exit 1'.length);
    assert.match(body, /Write-SandboxAllowState/, '自己検査失敗時に state.json を書くこと');
    assert.ok(!/New-NetFirewallRule/.test(body), '自己検査失敗時のブロックが New-NetFirewallRule を呼ばないこと');
  });

  test('B7: request.json のリパースポイント確認が内容を読む（Get-Content）より前にある', () => {
    const reparseIdx = source.indexOf('[System.IO.FileAttributes]::ReparsePoint');
    const getContentIdx = source.indexOf('Get-Content -Path $RequestJsonPath -Raw');
    assert.ok(reparseIdx !== -1 && getContentIdx !== -1, '2箇所とも見つかること');
    assert.ok(reparseIdx < getContentIdx, 'リパースポイント確認が内容読み込みより前であること');
  });

  test('B8: 拒否エントリ（violations）は index と reason のみで、原文の値を含むキーを持たない', () => {
    const violationAdds = [...source.matchAll(/\$violations\.Add\(@\{[^}]*\}\)/g)];
    assert.ok(violationAdds.length > 0, '$violations.Add(...) の呼び出しが見つかること');
    for (const call of violationAdds) {
      // "index = ..." と "reason = ..." の2キーのみであること（ip / port / raw 等を含まない）
      assert.match(call[0], /index\s*=/, `index キーを持つこと: ${call[0]}`);
      assert.match(call[0], /reason\s*=/, `reason キーを持つこと: ${call[0]}`);
      assert.ok(!/\bip\s*=|\bport\s*=|\braw\s*=/.test(call[0]), `原文の値を含まないこと: ${call[0]}`);
    }
  });

  test('state.json は一時ファイルに書いてから Move-Item で置き換える（Agent が書きかけを読まない）', () => {
    assert.match(source, /\.tmp-\$PID-/);
    assert.match(source, /Move-Item -Path \$tmpPath -Destination \$StateJsonPath -Force/);
  });

  test('サービス SID は自前解決し、host.json を読む行は無い（コメントでの言及のみ許可）', () => {
    const codeWithHostJson = codeLinesOf(source).filter((line) => line.includes('host.json'));
    assert.deepEqual(codeWithHostJson, [], 'コード行（コメント以外）に host.json が無いこと');
    assert.match(source, /NTAccount\(\$ServiceAccountName\)/);
  });

  test('ルール作成に失敗した場合、このラン内で新規作成した分だけロールバックする（旧世代は残す）', () => {
    const idx = source.indexOf('} catch {\n        # Roll back only what THIS run created');
    assert.ok(idx !== -1, 'ロールバック処理のコメントが見つかること');
    const body = source.slice(idx, idx + 400);
    assert.match(body, /Remove-NetFirewallRule -Name \$name/);
  });
});

describe('SB-2.1.1: Invoke-NativeCommand 共有ヘルパー（hp630g9 の schtasks /Delete 停止の根治）', () => {
  const installSource = readScript('scripts/install-sandbox-host.ps1');
  const uninstallSource = readScript('scripts/uninstall-sandbox-host.ps1');
  const applySource = readScript('scripts/apply-sandbox-allowlist.ps1');

  test('D1: install/uninstall で "2>" を含むコード行はヘルパー内の1行（2>&1）だけ。apply は0行', () => {
    for (const [label, source] of [
      ['install-sandbox-host.ps1', installSource],
      ['uninstall-sandbox-host.ps1', uninstallSource],
    ]) {
      const linesWithRedirect = codeLinesOf(source).filter((line) => line.includes('2>'));
      assert.equal(
        linesWithRedirect.length,
        1,
        `${label}: "2>" を含むコード行は1行のみであること（実際 ${linesWithRedirect.length} 行: ${JSON.stringify(linesWithRedirect)}）`,
      );
      assert.match(linesWithRedirect[0], /2>&1/, `${label}: その1行は "2>&1" であること（"2>$null" ではない）`);
    }
    const applyLinesWithRedirect = codeLinesOf(applySource).filter((line) => line.includes('2>'));
    assert.deepEqual(applyLinesWithRedirect, [], 'apply-sandbox-allowlist.ps1 は外部コマンドを呼ばないため "2>" を含むコード行が無いこと');
  });

  test('D2: 外部コマンドの直接呼び出し（& 経由）は Invoke-NativeCommand ヘルパー経由のみ', () => {
    // 行頭、または { ; ( = の直後にある "& <変数/コマンド>" を実呼び出しとみなす。文字列
    // リテラル内（案内メッセージの組み立て等）は "=" の直後が引用符になるため一致しない。
    const callPattern = /(^|[{;(=])\s*&\s+[$\w]/;
    for (const [label, source] of [
      ['install-sandbox-host.ps1', installSource],
      ['uninstall-sandbox-host.ps1', uninstallSource],
    ]) {
      const callLines = codeLinesOf(source)
        .map((line) => line.trim())
        .filter((line) => callPattern.test(line));
      assert.ok(callLines.length > 0, `${label}: 呼び出し行が見つかること`);
      for (const line of callLines) {
        const isHelperInternalCall = line.startsWith('& $Command');
        assert.ok(
          isHelperInternalCall || line.includes('Invoke-NativeCommand'),
          `${label}: 外部コマンドの直接呼び出しがヘルパー経由でないこと: ${line}`,
        );
      }
    }
  });

  test('D3: ヘルパーは ErrorActionPreference の退避/復元・LASTEXITCODE リセット・-AllowFailure 以外での中止を持つ', () => {
    for (const [label, source] of [
      ['install-sandbox-host.ps1', installSource],
      ['uninstall-sandbox-host.ps1', uninstallSource],
    ]) {
      assert.match(source, /function Invoke-NativeCommand/, `${label}: ヘルパー関数が定義されていること`);
      const startIdx = source.indexOf('function Invoke-NativeCommand');
      const endIdx = source.indexOf('# <<< SB-2.1.1 shared helper <<<', startIdx);
      assert.ok(startIdx !== -1 && endIdx !== -1, `${label}: ヘルパーのマーカーが見つかること`);
      const body = source.slice(startIdx, endIdx);
      assert.match(body, /\$prevEap = \$ErrorActionPreference/, `${label}: 呼び出し前に退避すること`);
      assert.match(body, /\$ErrorActionPreference = \$prevEap/, `${label}: finally で復元すること`);
      assert.match(body, /\$global:LASTEXITCODE = 0/, `${label}: 呼び出し前に LASTEXITCODE をリセットすること`);
      assert.match(
        body,
        /-not \$AllowFailure\s*\)\s*\{[\s\S]*?exit 1/,
        `${label}: -AllowFailure が無い場合は exit 1 すること`,
      );
    }
  });

  test('D4: install と uninstall のヘルパー本体（マーカー間）がバイト一致（コピーの劣化防止）', () => {
    function extractMarkerBlock(source, label) {
      const start = source.indexOf('>>> SB-2.1.1 shared helper');
      const end = source.indexOf('<<< SB-2.1.1 shared helper');
      assert.ok(start !== -1 && end !== -1, `${label}: マーカーが両方見つかること`);
      return source.slice(start, end);
    }
    const installBlock = extractMarkerBlock(installSource, 'install-sandbox-host.ps1');
    const uninstallBlock = extractMarkerBlock(uninstallSource, 'uninstall-sandbox-host.ps1');
    assert.equal(installBlock, uninstallBlock, 'install と uninstall のヘルパー本体が一字一句一致すること');
  });

  test('D5: 「存在しなくても成功」の削除系コマンドは -AllowFailure 付き', () => {
    const deleteLabelPatterns = ['sc.exe delete', 'schtasks /Delete', 'icacls /remove:g'];
    const combined = codeLinesOf(installSource + '\n' + uninstallSource);
    for (const pattern of deleteLabelPatterns) {
      const lines = combined.filter((line) => line.includes(pattern) && line.includes('Invoke-NativeCommand'));
      assert.ok(lines.length > 0, `"${pattern}" を呼ぶ行が見つかること`);
      for (const line of lines) {
        assert.match(line, /-AllowFailure/, `"${pattern}": -AllowFailure 付きであること: ${line.trim()}`);
      }
    }
  });

  test('D5: 秘密鍵・home・許可リストディレクトリへの icacls /inheritance:r は -AllowFailure 無し（中止すべき操作）', () => {
    const inheritanceLines = codeLinesOf(installSource).filter((line) => line.includes('/inheritance:r'));
    assert.ok(inheritanceLines.length > 0, '/inheritance:r を呼ぶ行が見つかること');
    for (const line of inheritanceLines) {
      assert.ok(!line.includes('-AllowFailure'), `/inheritance:r は -AllowFailure 無しであること: ${line.trim()}`);
    }
  });
});
