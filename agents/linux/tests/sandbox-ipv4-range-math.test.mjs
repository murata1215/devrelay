// サイクル SB-2.1.3: scripts/apply-sandbox-allowlist.ps1 の IPv4 / ポート範囲算術を
// 実際に動かして検証する（sandbox-scripts-guard.test.mjs は静的な文字列照合のみで、
// 計算結果そのものは一度も実行確認していなかった）。
//
// 背景（hp630g9 実機バグ）: ConvertFrom-Ipv4Value が
// "$v = [uint64]($v / 256)" を3回連鎖させており、PowerShell の "/" が割り切れない
// ときに返す Double から [uint64] へのキャストが（切り捨てではなく）最近接偶数丸め
// になるため、繰り上がりが上位の桁へ混入していた。許可先が空集合のとき、本来
// "0.0.0.0-126.255.255.255" / "128.0.0.0-255.255.255.255" になるはずの補集合が
// "0.0.0.0-127.0.0.255" / "128.0.0.0-0.0.0.255"（2本目は終了 < 開始）になり、
// New-NetFirewallRule が CimException 0x80070057 で拒否していた。
//
// このファイルは2段構成:
// 1) 常に実行: .ps1 から IPv4/ポート算術系の関数定義を波括弧対応で抽出できること、
//    ConvertFrom-Ipv4Value の本体が期待する形（[math]::Floor による桁独立計算）に
//    なっていることを確認する（sandbox-scripts-guard.test.mjs の静的ガードと一部重複するが、
//    「抽出して実際に動かす」の土台が壊れていないことをここでも保証する）。
// 2) pwsh がある場合のみ実行: 抽出した関数をドライバスクリプトに繋いで
//    `pwsh -NoProfile -NonInteractive -File` で実際に実行し、出力文字列を照合する。
//    pwsh が見つからない環境（既定の Linux 開発機・CI）では t.skip() で何もしない。
//
// PowerShell 7 (pwsh) と Windows PowerShell 5.1 の差について: このバグの原因だった
// 除算・Double→[uint64] キャストの丸め挙動は .NET の Convert.ToUInt64(double) の
// 仕様（最近接偶数丸め）であり、.NET Framework (5.1) と .NET (7+ / pwsh) の両方で
// 同一。したがってこの検証は pwsh で行っても 5.1 の実機挙動の再現として有効。
// （SB-2.1.2 で修正した「List[object] 変数への @() が ArgumentException を投げる」
// バグは Windows PowerShell 5.1 の実装固有のバインダーの挙動で、pwsh (7+) では
// 再現しないため、本ファイルの検証対象には含めない。）

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const SCRIPT_REL_PATH = 'scripts/apply-sandbox-allowlist.ps1';

function readScript() {
  return readFileSync(path.join(repoRoot, SCRIPT_REL_PATH), 'utf8');
}

/** "function <Name> { ... }" を波括弧の対応を数えて1個分だけ切り出す（コメント中の
 *  波括弧は無視できないため、文字列・コメントを特別扱いしない素朴な対応数えだが、
 *  このスクリプトの関数本体には不均衡な波括弧を含む文字列リテラルが無いことを
 *  既存の ASCII ガード・他のテストが別途保証している）。見つからなければ null。 */
function extractFunction(source, name) {
  const marker = `function ${name}`;
  const startIdx = source.indexOf(marker);
  if (startIdx === -1) return null;
  const braceIdx = source.indexOf('{', startIdx);
  if (braceIdx === -1) return null;
  let depth = 0;
  let i = braceIdx;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
  }
  if (depth !== 0) return null;
  return source.slice(startIdx, i);
}

const FUNCTION_NAMES = [
  'Test-StrictIpv4String',
  'ConvertTo-Ipv4Value',
  'ConvertFrom-Ipv4Value',
  'Get-Ipv4Complement',
  'Test-Ipv4ComplementSelfCheck',
  'Format-Ipv4RangeStrings',
  'Test-Ipv4RangeStringsSelfCheck',
  'Get-PortComplementRanges',
];

describe('IPv4/ポート範囲算術: 関数抽出の土台（常に実行）', () => {
  const source = readScript();

  for (const name of FUNCTION_NAMES) {
    test(`${name} が波括弧対応で1個だけ抽出できる`, () => {
      const body = extractFunction(source, name);
      assert.ok(body, `${name} の本体が抽出できること`);
      assert.ok(body.startsWith(`function ${name}`));
      assert.ok(body.trimEnd().endsWith('}'));
    });
  }

  test('ConvertFrom-Ipv4Value は [math]::Floor による桁独立計算を使う（丸め混入バグの再発防止）', () => {
    const body = extractFunction(source, 'ConvertFrom-Ipv4Value');
    assert.ok(body);
    const codeLines = body.split('\n').filter((line) => !line.trim().startsWith('#'));
    const codeBody = codeLines.join('\n');
    assert.ok(
      !/\$v\s*=\s*\[uint64\]\(\$v\s*\/\s*256\)/.test(codeBody),
      '桁連鎖する除算パターンが無いこと',
    );
    assert.match(codeBody, /\[math\]::Floor/);
  });
});

/** pwsh の実行ファイルを探す。PATH 上の "pwsh"、無ければ環境変数
 *  SANDBOX_TEST_PWSH_PATH（このテストファイル専用、CI/手元で任意のバイナリパスを
 *  指すためのフック）を試す。どちらも無ければ null。 */
function findPwsh() {
  const candidates = [process.env.SANDBOX_TEST_PWSH_PATH, 'pwsh'].filter(Boolean);
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], {
      encoding: 'utf8',
    });
    if (result.error) continue; // ENOENT 等: このコマンドは使えない
    if (result.status === 0) return candidate;
  }
  return null;
}

const pwshPath = findPwsh();

describe('IPv4/ポート範囲算術: pwsh での実行確認', { skip: !pwshPath && 'pwsh が見つからないためスキップ' }, () => {
  const source = readScript();
  let tmpDir;

  function runDriver(driverBody) {
    const funcSource = FUNCTION_NAMES.map((name) => extractFunction(source, name)).join('\n\n');
    const fullScript = `${funcSource}\n\n${driverBody}`;
    const scriptPath = path.join(tmpDir, 'driver.ps1');
    writeFileSync(scriptPath, fullScript, 'utf8');
    const result = spawnSync(pwshPath, ['-NoProfile', '-NonInteractive', '-File', scriptPath], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `pwsh がエラー終了しないこと: stderr=${result.stderr}`);
    return result.stdout;
  }

  test('セットアップ: 一時ディレクトリを作る', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'sandbox-ipv4-range-'));
  });

  test('許可先が空のとき、補集合は install-sandbox-host.ps1 の fail-closed ルールと同じ2本になる', () => {
    const out = runDriver(`
      $ipv4 = Get-Ipv4Complement -AllowedValues @()
      if (-not (Test-Ipv4ComplementSelfCheck -Merged $ipv4['Merged'] -Complement $ipv4['Complement'])) { throw "self-check failed" }
      $strings = @(Format-Ipv4RangeStrings -Ranges $ipv4['Complement'])
      if (-not (Test-Ipv4RangeStringsSelfCheck -RangeStrings $strings -Ranges $ipv4['Complement'])) { throw "round-trip self-check failed" }
      $strings | ForEach-Object { Write-Output $_ }
    `);
    const lines = out.trim().split(/\r?\n/);
    assert.deepEqual(lines, ['0.0.0.0-126.255.255.255', '128.0.0.0-255.255.255.255']);

    // install-sandbox-host.ps1 の静的 fail-closed ルールのリテラルと一致すること
    // （apply が最初に反映に成功したとき、fail-closed ルールと同じ範囲を実現する
    // べきなので、この一致がずれていれば一方だけが変更された既存バグの再発）。
    const installSource = readFileSync(path.join(repoRoot, 'scripts/install-sandbox-host.ps1'), 'utf8');
    assert.match(
      installSource,
      /-RemoteAddress "0\.0\.0\.0-126\.255\.255\.255","128\.0\.0\.0-255\.255\.255\.255"/,
    );
  });

  test('許可先が1件（203.0.113.5:5432）のとき、IPv4補集合3本・TCPポート補集合2本になる', () => {
    const out = runDriver(`
      $ipv4 = Get-Ipv4Complement -AllowedValues @((ConvertTo-Ipv4Value "203.0.113.5"))
      if (-not (Test-Ipv4ComplementSelfCheck -Merged $ipv4['Merged'] -Complement $ipv4['Complement'])) { throw "self-check failed" }
      $strings = @(Format-Ipv4RangeStrings -Ranges $ipv4['Complement'])
      if (-not (Test-Ipv4RangeStringsSelfCheck -RangeStrings $strings -Ranges $ipv4['Complement'])) { throw "round-trip self-check failed" }
      Write-Output "IPV4:"
      $strings | ForEach-Object { Write-Output $_ }
      Write-Output "PORTS:"
      $ports = @(Get-PortComplementRanges -AllowedPorts @(5432))
      $ports | ForEach-Object { Write-Output $_ }
    `);
    const lines = out.trim().split(/\r?\n/);
    const ipv4Idx = lines.indexOf('IPV4:');
    const portsIdx = lines.indexOf('PORTS:');
    assert.ok(ipv4Idx !== -1 && portsIdx !== -1);
    const ipv4Lines = lines.slice(ipv4Idx + 1, portsIdx);
    const portLines = lines.slice(portsIdx + 1);
    assert.deepEqual(ipv4Lines, [
      '0.0.0.0-126.255.255.255',
      '128.0.0.0-203.0.113.4',
      '203.0.113.6-255.255.255.255',
    ]);
    assert.deepEqual(portLines, ['1-5431', '5433-65535']);
  });

  test('許可先が複数件（隣接しないIP2件）のとき、IPv4補集合4本になる', () => {
    const out = runDriver(`
      $ipv4 = Get-Ipv4Complement -AllowedValues @((ConvertTo-Ipv4Value "203.0.113.5"), (ConvertTo-Ipv4Value "198.51.100.9"))
      if (-not (Test-Ipv4ComplementSelfCheck -Merged $ipv4['Merged'] -Complement $ipv4['Complement'])) { throw "self-check failed" }
      $strings = @(Format-Ipv4RangeStrings -Ranges $ipv4['Complement'])
      if (-not (Test-Ipv4RangeStringsSelfCheck -RangeStrings $strings -Ranges $ipv4['Complement'])) { throw "round-trip self-check failed" }
      $strings | ForEach-Object { Write-Output $_ }
    `);
    const lines = out.trim().split(/\r?\n/);
    assert.deepEqual(lines, [
      '0.0.0.0-126.255.255.255',
      '128.0.0.0-198.51.100.8',
      '198.51.100.10-203.0.113.4',
      '203.0.113.6-255.255.255.255',
    ]);
  });

  test('隣接する2つのIP（203.0.113.5, 203.0.113.6）は1つの穴にマージされ、補集合は3本になる', () => {
    const out = runDriver(`
      $ipv4 = Get-Ipv4Complement -AllowedValues @((ConvertTo-Ipv4Value "203.0.113.5"), (ConvertTo-Ipv4Value "203.0.113.6"))
      if (-not (Test-Ipv4ComplementSelfCheck -Merged $ipv4['Merged'] -Complement $ipv4['Complement'])) { throw "self-check failed" }
      $strings = @(Format-Ipv4RangeStrings -Ranges $ipv4['Complement'])
      if (-not (Test-Ipv4RangeStringsSelfCheck -RangeStrings $strings -Ranges $ipv4['Complement'])) { throw "round-trip self-check failed" }
      $strings | ForEach-Object { Write-Output $_ }
    `);
    const lines = out.trim().split(/\r?\n/);
    assert.deepEqual(lines, [
      '0.0.0.0-126.255.255.255',
      '128.0.0.0-203.0.113.4',
      '203.0.113.7-255.255.255.255',
    ]);
  });

  test('旧実装（SB-2.1 時点のコミット 752cb16）は空集合のとき終了<開始の範囲文字列を生成していたことの記録的再現', () => {
    // このテストは「新実装が正しい」ことの確認ではなく、根治対象のバグが実在した
    // ことを記録するための再現。旧実装の ConvertFrom-Ipv4Value（桁連鎖する除算）を
    // インラインでここに書き、現行の Get-Ipv4Complement/Format-Ipv4RangeStrings と
    // 組み合わせたときに不正な文字列が出ることを示す。
    const out = runDriver(`
      function ConvertFrom-Ipv4ValueOld {
          param([uint64]$Value)
          $v = $Value
          $o4 = $v % 256; $v = [uint64]($v / 256)
          $o3 = $v % 256; $v = [uint64]($v / 256)
          $o2 = $v % 256; $v = [uint64]($v / 256)
          $o1 = $v % 256
          return "$o1.$o2.$o3.$o4"
      }
      function Format-Ipv4RangeStringsOld {
          param($Ranges)
          $result = @()
          foreach ($r in $Ranges) {
              if ($r['Start'] -eq $r['End']) {
                  $result += (ConvertFrom-Ipv4ValueOld $r['Start'])
              } else {
                  $result += "$(ConvertFrom-Ipv4ValueOld $r['Start'])-$(ConvertFrom-Ipv4ValueOld $r['End'])"
              }
          }
          return $result
      }
      $ipv4 = Get-Ipv4Complement -AllowedValues @()
      $strings = @(Format-Ipv4RangeStringsOld -Ranges $ipv4['Complement'])
      $strings | ForEach-Object { Write-Output $_ }
    `);
    const lines = out.trim().split(/\r?\n/);
    assert.deepEqual(lines, ['0.0.0.0-127.0.0.255', '128.0.0.0-0.0.0.255']);
    // 2本目は "終了アドレスが開始アドレスより小さい"（hp630g9 実機の
    // CimException 0x80070057 の原因そのもの）。
    const [startStr, endStr] = lines[1].split('-');
    const toValue = (ip) => ip.split('.').reduce((acc, part) => acc * 256 + Number(part), 0);
    assert.ok(toValue(endStr) < toValue(startStr), '旧実装は終了 < 開始の不正な範囲を生成していたこと');
  });

  test('片付け: 一時ディレクトリを削除する', () => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });
});
