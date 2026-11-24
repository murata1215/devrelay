// サイクル SB-2.1.4: scripts/apply-sandbox-allowlist.ps1 全体を
// scripts/tests/test-apply-sandbox-allowlist.ps1 経由で実際に動かす（pwsh がある場合のみ）。
//
// sandbox-scripts-guard.test.mjs は静的な文字列照合、sandbox-ipv4-range-math.test.mjs は
// IPv4/ポート算術の関数だけを抽出して動かす。本ファイルはどちらでもカバーされない
// 「許可リストの反映フロー全体（ルール作成・世代切り替え・失敗時ロールバック・拒否理由）」を
// 実際に1プロセスとして実行し、PASS/FAIL件数で判定する。
//
// 重要な限界（test-apply-sandbox-allowlist.ps1 のヘッダーコメントにも明記済み）: このサイクルで
// 直した不具合（Group-Object -Property / Select-Object -ExpandProperty がハッシュテーブルの
// キーをプロパティとして解決しない）は Windows PowerShell 5.1 固有で、PowerShell 7 (pwsh) の
// Hashtable アダプタでは再現しない。つまりこのテストが緑でも「5.1 の実機バグが直っている」こと
// の証明にはならない -- 証明するのは「許可リスト反映フロー全体のロジックが pwsh でも 5.1 でも
// 同じに動くこと」（ルール作成・世代切り替え・失敗時ロールバック・拒否理由の分岐は PowerShell
// バージョンに依存しないロジックであるため、これは実在の保証になる）。5.1 固有の修正そのものは
// 実機（hp630g9）で test-apply-sandbox-allowlist.ps1 を実行して確認する必要がある。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const TEST_SCRIPT_REL_PATH = 'scripts/tests/test-apply-sandbox-allowlist.ps1';

/** pwsh の実行ファイルを探す。PATH 上の "pwsh"、無ければ環境変数
 *  SANDBOX_TEST_PWSH_PATH（sandbox-ipv4-range-math.test.mjs と同じフック）を試す。
 *  どちらも無ければ null。 */
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

describe(
  'apply-sandbox-allowlist.ps1: 全体フローの実行確認（pwsh がある場合のみ。5.1 固有バグの証明にはならない点はファイル先頭コメント参照）',
  { skip: !pwshPath && 'pwsh が見つからないためスキップ（5.1 実機での確認が必須）' },
  () => {
    test('test-apply-sandbox-allowlist.ps1 が全ケース PASS で終了する', () => {
      const scriptPath = path.join(repoRoot, TEST_SCRIPT_REL_PATH);
      const result = spawnSync(pwshPath, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
        encoding: 'utf8',
        timeout: 120_000,
      });

      const output = `${result.stdout || ''}\n${result.stderr || ''}`;
      assert.equal(
        result.status,
        0,
        `test-apply-sandbox-allowlist.ps1 は終了コード0であること（実際: ${result.status}）\n--- output ---\n${output}`,
      );

      const summaryMatch = /Results:\s*(\d+)\s*passed,\s*(\d+)\s*failed,\s*(\d+)\s*skipped/.exec(output);
      assert.ok(summaryMatch, `結果サマリ行が見つかること\n--- output ---\n${output}`);
      const [, passed, failed] = summaryMatch;
      assert.equal(Number(failed), 0, `失敗したケースが0件であること（実際: ${failed}件）\n--- output ---\n${output}`);
      assert.ok(Number(passed) >= 15, `PASS したケースが十分な数（目安15件以上）であること（実際: ${passed}件）。0件近い場合はケースが1つも走っていない可能性がある\n--- output ---\n${output}`);
    });
  },
);
