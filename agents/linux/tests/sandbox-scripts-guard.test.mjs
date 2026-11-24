// サイクル SB-1a-1.1 / SB-2.1 / SB-2.1.2: scripts/install-sandbox-host.ps1 /
// uninstall-sandbox-host.ps1 / apply-sandbox-allowlist.ps1 に対する静的ガード（node:fs のみ、
// スクリプトを実行しない。apps/server の install-agent-repo-auth-guard.test.mjs と同じ手口）。
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
//
// サイクル SB-2.1.2 で追加（hp630g9 実機: apply-sandbox-allowlist.ps1 が
// `$destinations = @($validDestinations)` で毎回 System.ArgumentException を投げ、
// IPv4 の遮断ルールが 1 本も作られない状態になっていた不具合の根治。真因は
// Windows PowerShell 5.1 が List[object] 変数に対する `@()` 演算子を特別扱いし、
// 型が合わない式を組み立てて例外を投げること。空集合・1件・複数件のいずれでも発生する）:
// - E1: List[object] 変数に対して `@($変数)` または `$変数 |` が復活する（List[string] は対象外。
//   このバグは List<object> 固有で、install/uninstall の Invoke-NativeCommand 内 `Output = @($lines)`
//   （List[string]）は実機で動作実証済みのため触らない）
// - E2: install が反映スクリプト呼び出しより前に fail-closed の IPv4 全遮断ルールを作らなくなる、
//   または範囲・ルール名・-Group が一致しなくなる（反映が失敗した場合に IPv4 が無防備になる）
// - E3: apply が fail-closed ルールを削除する位置が新世代の作成完了より前に戻る、または
//   rollback（失敗時）のブロック内に紛れ込む（緩む瞬間を作ってしまう）
// - E4: state.json の error にローカライズされた例外本文（Exception.Message）がそのまま
//   書き戻される（ASCII の型名＋行番号のみであるべき）
//
// サイクル SB-2.1.3 で追加（hp630g9 実機: 2つの独立した不具合の根治。
// (1) ConvertFrom-Ipv4Value の桁あふれにより IPv4 範囲文字列が常に誤っており、
// 許可先が空のときに終了アドレス < 開始アドレスの文字列を生成して
// New-NetFirewallRule が CimException 0x80070057 で拒否した。
// (2) そのエラーが `&` 直接実行では非終了エラーとして握りつぶされ、
// スクリプトが「作成できた」とみなして旧世代と全遮断ルールを削除し、
// IPv4 が全開になった）:
// - F1: New-NetFirewallRule / Remove-NetFirewallRule / Get-NetFirewallRule の
//   呼び出しに -ErrorAction Stop が無くなる（呼び出し方や $ErrorActionPreference
//   に依存する挙動が復活する）
// - F2: ConvertFrom-Ipv4Value が桁連鎖する除算（"$v = [uint64]($v / 256)" 型）に
//   戻る（丸めが上位桁に混入する既存バグの再発）
// - F3: 範囲文字列の往復自己検査（Test-Ipv4RangeStringsSelfCheck）が無くなる、
//   または最初の New-NetFirewallRule 呼び出しより後に移動する
// - F4: 新世代に必要なルール名の実在確認が、旧世代・fail-closed ルールの削除より
//   後に移動する、または削除前に確認しなくなる
// - F5: コード行に Write-Error が復活する（$ErrorActionPreference = "Stop" の下では
//   Write-Error 自体が終端エラーになり、元の例外を隠す）
// - F6: 例外を再利用する catch（ロールバック＋ Format-ErrorCode 報告の両方を行う
//   もの）が、先頭で $err = $_ に退避せず $_ を直接使う（ロールバック中の
//   入れ子 catch が $_ を上書きして元のエラーを消してしまう）

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

  test('A4: ファイアウォールのルールは3本（fail-closed IPv4・静的な IPv6 Block・loopback Allow のみ）', () => {
    // 行頭から始まる実呼び出しのみを対象にする（コメント内の "New-NetFirewallRule" という
    // 言及（例: "rejected by New-NetFirewallRule with ..."）を実呼び出しと誤認しないため）。
    const ruleBlocks = [...source.matchAll(/^New-NetFirewallRule[\s\S]*?\| Out-Null/gm)];
    assert.equal(
      ruleBlocks.length,
      3,
      'install-sandbox-host.ps1 が直接作る New-NetFirewallRule の呼び出しは3本であること' +
        '（IPv4 の許可リスト反映 Block ルールは apply-sandbox-allowlist.ps1 が digest 付きで管理する。' +
        '3本目はサイクル SB-2.1.2 の fail-closed ルール）',
    );
    for (const block of ruleBlocks) {
      assert.match(block[0], /-LocalUser/, `-LocalUser を使うこと: ${block[0].slice(0, 80)}...`);
      assert.match(block[0], /-Group \$FirewallGroup/, `-Group を使うこと: ${block[0].slice(0, 80)}...`);
      assert.match(block[0], /-Name ("DevRelay-Sandbox|\$FailClosedRuleName)/, `-Name を使うこと: ${block[0].slice(0, 80)}...`);
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

describe('サイクル SB-2.1.2: List[object] に @() を使わない（hp630g9 実機バグ「Argument types do not match」の再発防止）', () => {
  const SANDBOX_PS1_RELPATHS = [
    'scripts/install-sandbox-host.ps1',
    'scripts/uninstall-sandbox-host.ps1',
    'scripts/apply-sandbox-allowlist.ps1',
  ];

  for (const relPath of SANDBOX_PS1_RELPATHS) {
    test(`E1: ${relPath} の List[object] 変数は @() も "変数 | ..." も使わず、.ToArray() か foreach でのみスコープ外に出す`, () => {
      const source = readScript(relPath);
      // List[string] は対象外（install/uninstall の $lines は実機で @($lines) が動作実証済み。
      // バグは List<object> 固有であり List<string> には無い）。
      const declRe = /\$(\w+)\s*=\s*New-Object System\.Collections\.Generic\.List\[object\]/g;
      const varNames = new Set();
      let m;
      while ((m = declRe.exec(source)) !== null) {
        varNames.add(m[1]);
      }
      const codeLines = codeLinesOf(source);
      for (const varName of varNames) {
        const arrayWrapRe = new RegExp(`@\\(\\s*\\$${varName}\\b`);
        const pipeRe = new RegExp(`\\$${varName}\\b\\s*\\|`);
        for (const line of codeLines) {
          assert.ok(!arrayWrapRe.test(line), `${relPath}: "@($${varName})" が無いこと（List[object] への @() は ArgumentException を投げる）: ${line.trim()}`);
          assert.ok(!pipeRe.test(line), `${relPath}: "$${varName} |" が無いこと（.ToArray() してからパイプする方針で統一）: ${line.trim()}`);
        }
      }
    });
  }

  test('E1: apply-sandbox-allowlist.ps1 の List[object] 宣言が1個以上見つかる（検査対象が空で素通りしていないこと）', () => {
    const source = readScript('scripts/apply-sandbox-allowlist.ps1');
    const declCount = (source.match(/New-Object System\.Collections\.Generic\.List\[object\]/g) || []).length;
    assert.ok(declCount >= 5, `List[object] 宣言が5個以上見つかること（holeList/merged x2/complement x2/violations/validDestinations）: ${declCount}`);
  });

  test('E2: install が fail-closed の IPv4 全遮断ルールを apply 呼び出しより前に作る', () => {
    const source = readScript('scripts/install-sandbox-host.ps1');
    const failClosedIdx = source.indexOf('New-NetFirewallRule -Name $FailClosedRuleName');
    const applyInvokeIdx = source.indexOf('-ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$ApplyScriptDestPath`"")');
    assert.ok(failClosedIdx !== -1, 'fail-closed ルール作成が見つかること');
    assert.ok(applyInvokeIdx !== -1, 'apply-sandbox-allowlist.ps1 の呼び出しが見つかること');
    assert.ok(failClosedIdx < applyInvokeIdx, 'fail-closed ルール作成が apply 呼び出しより前であること');

    const block = source.slice(failClosedIdx, failClosedIdx + 400);
    assert.match(block, /-RemoteAddress "0\.0\.0\.0-126\.255\.255\.255","128\.0\.0\.0-255\.255\.255\.255"/, '範囲が旧静的 IPv4 ルールと同一であること');
    assert.match(block, /-Group \$FirewallGroup/);
    assert.match(block, /DisplayName "DevRelay Sandbox - /, 'uninstall の削除条件（DisplayName ワイルドカード）に当たること');
  });

  test('E2: install と apply のルール名リテラルが一致する', () => {
    const installSource = readScript('scripts/install-sandbox-host.ps1');
    const applySource = readScript('scripts/apply-sandbox-allowlist.ps1');
    assert.match(installSource, /\$FailClosedRuleName = "DevRelay-SandboxFailClosed-ipv4"/);
    assert.match(applySource, /\$FailClosedRuleName = "DevRelay-SandboxFailClosed-ipv4"/);
  });

  test('E3: apply の fail-closed ルール削除が、新世代の最後の New-NetFirewallRule より後にある', () => {
    const source = readScript('scripts/apply-sandbox-allowlist.ps1');
    const lastRuleCreateIdx = source.lastIndexOf('New-NetFirewallRule');
    const failClosedRemoveIdx = source.indexOf('Remove-NetFirewallRule -Name $FailClosedRuleName');
    assert.ok(lastRuleCreateIdx !== -1 && failClosedRemoveIdx !== -1, '両方が見つかること');
    assert.ok(failClosedRemoveIdx > lastRuleCreateIdx, 'fail-closed ルールの削除は最後のルール作成より後であること');
  });

  test('E3: apply の fail-closed ルール削除は rollback（失敗時）のブロック内に無い', () => {
    const source = readScript('scripts/apply-sandbox-allowlist.ps1');
    const rollbackIdx = source.indexOf('} catch {\n        # Roll back only what THIS run created');
    assert.ok(rollbackIdx !== -1, 'ロールバック処理のコメントが見つかること');
    const rollbackBody = source.slice(rollbackIdx, source.indexOf('exit 1', rollbackIdx) + 'exit 1'.length);
    assert.ok(!rollbackBody.includes('Remove-NetFirewallRule -Name $FailClosedRuleName'), 'rollback ブロックは fail-closed ルールを消さないこと（旧世代同様、残すべき）');
  });

  test('E4: state.json の error にローカライズされた例外本文（Exception.Message）が書き戻されない', () => {
    const source = readScript('scripts/apply-sandbox-allowlist.ps1');
    const errorAssignments = [...source.matchAll(/error\s*=\s*"[^"\n]*"/g)];
    assert.ok(errorAssignments.length > 0, 'error = "..." の割り当てが見つかること');
    for (const call of errorAssignments) {
      assert.ok(!call[0].includes('Exception.Message'), `state.json の error に Exception.Message を直接書かないこと: ${call[0]}`);
    }
  });

  test('E4: Format-ErrorCode は型名(.NET FullName)と行番号のみを使う', () => {
    const source = readScript('scripts/apply-sandbox-allowlist.ps1');
    assert.match(source, /function Format-ErrorCode/);
    const idx = source.indexOf('function Format-ErrorCode');
    const body = source.slice(idx, source.indexOf('return "$ascii at line $line"', idx) + 40);
    assert.match(body, /\.GetType\(\)\.FullName/);
    assert.match(body, /InvocationInfo\.ScriptLineNumber/);
  });

  test('F5: コード行に Write-Error が無く、catch 内の画面表示（Write-Host）が行番号を含む', () => {
    const source = readScript('scripts/apply-sandbox-allowlist.ps1');
    const codeWithWriteError = codeLinesOf(source).filter((line) => line.includes('Write-Error'));
    assert.deepEqual(
      codeWithWriteError,
      [],
      'コード行（コメント以外）に Write-Error が無いこと（$ErrorActionPreference = "Stop" の下では' +
        'Write-Error 自体が終端エラーになり元の例外を隠すため、サイクル SB-2.1.3 で全廃した）',
    );
    const writeHostErrorCalls = [...source.matchAll(/Write-Host "\[ERROR\][^\n]*"/g)];
    assert.ok(writeHostErrorCalls.length > 0, 'Write-Host "[ERROR] ..." の呼び出しが見つかること');
    const withLineNumber = writeHostErrorCalls.filter((c) => c[0].includes('ScriptLineNumber'));
    assert.ok(withLineNumber.length > 0, '少なくとも1つの [ERROR] Write-Host が行番号 (ScriptLineNumber) を含むこと');
  });
});

describe('サイクル SB-2.1.3: apply-sandbox-allowlist.ps1 がルール作成失敗時に全遮断ルールを消す不具合の根治（hp630g9 実機）', () => {
  const source = readScript('scripts/apply-sandbox-allowlist.ps1');

  test('F1: New-NetFirewallRule の呼び出しは全て -ErrorAction Stop 付き', () => {
    const ruleBlocks = [...source.matchAll(/New-NetFirewallRule[\s\S]*?\| Out-Null/g)];
    assert.ok(ruleBlocks.length >= 2, 'New-NetFirewallRule の呼び出しが見つかること');
    for (const block of ruleBlocks) {
      assert.match(block[0], /-ErrorAction Stop/, `-ErrorAction Stop を使うこと: ${block[0].slice(0, 80)}...`);
    }
  });

  test('F1: Remove-NetFirewallRule の呼び出しは全て -ErrorAction Stop 付き（-ErrorAction SilentlyContinue は無い）', () => {
    const codeWithSilentRemove = codeLinesOf(source).filter(
      (line) => line.includes('Remove-NetFirewallRule') && line.includes('-ErrorAction SilentlyContinue'),
    );
    assert.deepEqual(codeWithSilentRemove, [], 'Remove-NetFirewallRule が -ErrorAction SilentlyContinue で呼ばれていないこと');
    const removeLines = codeLinesOf(source).filter((line) => line.includes('Remove-NetFirewallRule'));
    assert.ok(removeLines.length > 0, 'Remove-NetFirewallRule の呼び出しが見つかること');
    for (const line of removeLines) {
      assert.match(line, /-ErrorAction Stop/, `-ErrorAction Stop を使うこと: ${line.trim()}`);
    }
  });

  test('F1: Get-NetFirewallRule の直接呼び出しは全て -ErrorAction Stop 付き（SilentlyContinue は無い。存在確認・取得は専用ヘルパー経由）', () => {
    // コメント行（Get-NetFirewallRule への言及）を実呼び出しと誤認しないよう、
    // codeLinesOf でコメント行を除いてから判定する（A3/A5/B6 等と同じ既存の手口）。
    const calls = codeLinesOf(source).filter((line) => line.includes('Get-NetFirewallRule'));
    assert.ok(calls.length > 0, 'Get-NetFirewallRule の呼び出しが見つかること');
    for (const call of calls) {
      assert.ok(!call.includes('SilentlyContinue'), `-ErrorAction SilentlyContinue を使わないこと: ${call.trim()}`);
      assert.match(call, /-ErrorAction Stop/, `-ErrorAction Stop を使うこと: ${call.trim()}`);
    }
  });

  test('F1: 存在確認・グループ取得は Test-FirewallRuleExists / Get-FirewallRulesInGroup ヘルパー経由のみ（直接呼び出しはヘルパー定義内の2箇所だけ）', () => {
    const directCalls = codeLinesOf(source).filter((line) => line.includes('Get-NetFirewallRule'));
    assert.equal(directCalls.length, 2, `Get-NetFirewallRule の直接呼び出しは2箇所（ヘルパー定義内）のみであること: 実際 ${directCalls.length} 箇所`);
    assert.match(source, /function Test-FirewallRuleExists/);
    assert.match(source, /function Get-FirewallRulesInGroup/);
  });

  test('F2: ConvertFrom-Ipv4Value は桁を独立計算する（連鎖する "[uint64]($v / 256)" 型の除算に戻っていない）', () => {
    const idx = source.indexOf('function ConvertFrom-Ipv4Value');
    assert.ok(idx !== -1, 'ConvertFrom-Ipv4Value が見つかること');
    const body = source.slice(idx, source.indexOf('\n}', idx));
    // コメント中の旧バグの説明文字列（ドキュメント目的の引用）をコード行と誤認しないよう、
    // codeLinesOf でコメント行を除いてから判定する。
    const codeBody = codeLinesOf(body).join('\n');
    assert.ok(!/\$v\s*=\s*\[uint64\]\(\$v\s*\/\s*256\)/.test(codeBody), '桁連鎖する除算パターンが無いこと（丸めの混入バグの再発防止）');
    assert.match(codeBody, /\[math\]::Floor/, '[math]::Floor による独立計算を使うこと');
  });

  test('F3: 範囲文字列の往復自己検査（Test-Ipv4RangeStringsSelfCheck）が存在し、最初の New-NetFirewallRule 呼び出しより前で呼ばれる', () => {
    assert.match(source, /function Test-Ipv4RangeStringsSelfCheck/);
    const checkCallIdx = source.indexOf('Test-Ipv4RangeStringsSelfCheck -RangeStrings');
    const firstRuleCreateIdx = source.indexOf('New-NetFirewallRule -Name $ipv4RuleName');
    assert.ok(checkCallIdx !== -1 && firstRuleCreateIdx !== -1, '両方が見つかること');
    assert.ok(checkCallIdx < firstRuleCreateIdx, '自己検査の呼び出しが最初の New-NetFirewallRule より前であること');
  });

  test('F4: 新世代に必要なルール名の実在確認が、旧世代削除・fail-closed ルール削除より前にある', () => {
    const verifyIdx = source.indexOf('$missingRuleNames');
    const staleDeleteIdx = source.indexOf('$staleRules = @(Get-FirewallRulesInGroup');
    const failClosedDeleteIdx = source.indexOf('Remove-NetFirewallRule -Name $FailClosedRuleName -ErrorAction Stop');
    assert.ok(verifyIdx !== -1 && staleDeleteIdx !== -1 && failClosedDeleteIdx !== -1, '3箇所とも見つかること');
    assert.ok(verifyIdx < staleDeleteIdx, '実在確認が旧世代削除より前であること');
    assert.ok(verifyIdx < failClosedDeleteIdx, '実在確認が fail-closed ルール削除より前であること');
  });

  test('F4: 実在確認で1本でも欠けていれば、このランで作った分だけ削除して firewall の他の変更は行わない', () => {
    const idx = source.indexOf('if ($missingRuleNames.Count -gt 0) {');
    assert.ok(idx !== -1, '実在確認の分岐が見つかること');
    const body = source.slice(idx, source.indexOf('exit 1', idx) + 'exit 1'.length);
    assert.match(body, /Remove-NetFirewallRule -Name \$name/, 'createdThisRun のみを削除すること');
    assert.ok(!body.includes('$staleRules'), '旧世代の削除を行わないこと');
    assert.ok(!body.includes('$FailClosedRuleName'), 'fail-closed ルールの削除を行わないこと');
  });

  test('F6: ロールバック + Format-ErrorCode 報告を両方行う catch は、先頭で $err = $_ に退避する', () => {
    // 候補を "} catch {" の全出現から探すが、ロールバック内の使い捨て
    // "try { Remove-NetFirewallRule ... } catch { }" のような trivial な catch を
    // 誤検出しないよう、ウィンドウ内に Remove-NetFirewallRule / Format-ErrorCode /
    // Write-SandboxAllowState の3つ全てがあることを要求する（rule_creation_failed を
    // 報告する本物の catch はこの3つを全て含む唯一の候補になる）。
    const catchStarts = [...source.matchAll(/\}\s*catch\s*\{/g)].map((m) => m.index);
    const catchesWithRollbackAndFormat = catchStarts.filter((start) => {
      const body = source.slice(start, start + 1400);
      return (
        body.includes('Remove-NetFirewallRule') &&
        body.includes('Format-ErrorCode') &&
        body.includes('Write-SandboxAllowState')
      );
    });
    assert.ok(catchesWithRollbackAndFormat.length > 0, 'ロールバック+Format-ErrorCode を行う catch が見つかること');
    for (const start of catchesWithRollbackAndFormat) {
      const body = source.slice(start, start + 400);
      assert.match(body, /\$err\s*=\s*\$_/, `catch の先頭付近で $err = $_ に退避すること: ${body.slice(0, 120)}`);
    }
  });

  test('F6: 最後の catch（unexpected error）も先頭で $err = $_ に退避し、Format-ErrorCode と画面表示の両方がそれを使う', () => {
    // "} catch {" の最後の出現（lastIndexOf）は、ロールバック内の trivial な
    // "catch { }" に当たってしまうため使わない。"unexpected_error: ..." という
    // 固有のマーカー文字列から逆方向に検索して、それを含む catch の開始位置を特定する。
    const markerIdx = source.indexOf('unexpected_error: $(Format-ErrorCode $err)');
    assert.ok(markerIdx !== -1, 'unexpected_error マーカーが見つかること');
    const idx = source.lastIndexOf('} catch {', markerIdx);
    assert.ok(idx !== -1);
    const body = source.slice(idx, idx + 1700);
    assert.match(body, /\$err\s*=\s*\$_/);
    assert.match(body, /Format-ErrorCode \$err/);
    assert.match(body, /\$err\.InvocationInfo\.ScriptLineNumber/);
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
