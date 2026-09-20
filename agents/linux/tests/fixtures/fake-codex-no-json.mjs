#!/usr/bin/env node
// raw-codex-runner.test.mjs 用: `--json` を持たない旧バージョンの codex CLI を模した偽 CLI。
// `probeRawCodexSupport()` が json=false を返すことを検証するためだけに使う（本体は spawn されない想定）。

const args = process.argv.slice(2);
if (args.includes('--help')) {
  // 注意: 「structured output flag」等、"--json" という部分文字列を一切含めないこと
  // （probeRawCodexSupport() の正規表現 /--json\b/ が誤検出してしまうため）。
  process.stdout.write('Usage: codex exec [OPTIONS] [PROMPT]\n  (this ancient version has no structured output flag)\n');
  process.exit(0);
}
process.stderr.write('this fixture should never be spawned beyond --help\n');
process.exit(1);
