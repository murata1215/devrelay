// #352: 依存コマンドの機能プローブ（H2-a/H2-b 対策）と成果物の鮮度ゲート（2ファイルAND）の単体テスト。
// 外部 import ゼロの純粋関数（agents/linux/src/services/update-script.ts）を
// コンパイル済み dist から直接 import する（claude-locator.test.mjs と同じ流儀）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isVersionLikeOutput,
  buildExecutableResolver,
  buildDependencyProbeBlock,
  buildArtifactFreshnessGate,
} from '../dist/services/update-script.js';

// ---- isVersionLikeOutput ----

test('isVersionLikeOutput: 版番号らしい文字列は true', () => {
  assert.equal(isVersionLikeOutput('10.28.0'), true);
});

test('isVersionLikeOutput: 空文字は false', () => {
  assert.equal(isVersionLikeOutput(''), false);
});

test('isVersionLikeOutput: 空白のみは false', () => {
  assert.equal(isVersionLikeOutput('   \n  '), false);
});

test('isVersionLikeOutput: null は false', () => {
  assert.equal(isVersionLikeOutput(null), false);
});

test('isVersionLikeOutput: undefined は false', () => {
  assert.equal(isVersionLikeOutput(undefined), false);
});

test('isVersionLikeOutput: 数字始まりでない文字列は false', () => {
  assert.equal(isVersionLikeOutput('command not found'), false);
});

test('isVersionLikeOutput: 複数行で1行目が版番号なら true', () => {
  assert.equal(isVersionLikeOutput('2.43.0.windows.1\nsome extra line'), true);
});

test('isVersionLikeOutput: 先頭行が版番号でなければ以降が版番号でも false', () => {
  assert.equal(isVersionLikeOutput('warning: something\n10.28.0'), false);
});

// #356 B2: 実際の `git --version` / `node --version` の生出力（数字始まりでない）を
// そのまま与えても true になることを担保する（アンカー付き `^\d+\.\d+` だった旧実装では
// これらは全て false になっていた＝実運用で一度も意図通り動いていなかった）。

test('isVersionLikeOutput: 実際の git --version 出力（数字始まりでない）は true', () => {
  assert.equal(isVersionLikeOutput('git version 2.52.0.windows.1'), true);
});

test('isVersionLikeOutput: 実際の node --version 出力（v プレフィックス）は true', () => {
  assert.equal(isVersionLikeOutput('v24.12.0'), true);
});

test('isVersionLikeOutput: 実際の pnpm -v 出力は true', () => {
  assert.equal(isVersionLikeOutput('10.15.0'), true);
});

// ---- buildExecutableResolver ----

test('buildExecutableResolver: preferredPaths が先頭から順に現れる（探索順が保たれる）', () => {
  const script = buildExecutableResolver('pnpm', [
    'C:\\Users\\x\\AppData\\Roaming\\devrelay\\node\\pnpm.cmd',
  ]);
  const idxIf = script.indexOf('if (Test-Path "C:\\Users\\x\\AppData\\Roaming\\devrelay\\node\\pnpm.cmd")');
  const idxCmd = script.indexOf('Get-Command pnpm.cmd');
  const idxExe = script.indexOf('Get-Command pnpm.exe');
  assert.ok(idxIf >= 0 && idxCmd > idxIf && idxExe > idxCmd);
});

test('buildExecutableResolver: .ps1 を選ぶ経路を一切含まない', () => {
  const script = buildExecutableResolver('pnpm', ['C:\\devrelay\\node\\pnpm.cmd']);
  assert.ok(!script.includes('.ps1'));
});

test('buildExecutableResolver: preferredPaths が空でも .cmd/.exe 探索は生成される', () => {
  const script = buildExecutableResolver('git', []);
  assert.ok(script.includes('Get-Command git.cmd'));
  assert.ok(script.includes('Get-Command git.exe'));
  assert.ok(!script.includes('.ps1'));
});

test('buildExecutableResolver: 変数名は <name>Resolved', () => {
  const script = buildExecutableResolver('node', []);
  assert.ok(script.includes('$nodeResolved'));
});

// ---- buildDependencyProbeBlock ----

test('buildDependencyProbeBlock: タイムアウト値が埋め込まれる', () => {
  const script = buildDependencyProbeBlock('C:\\log\\update.log', {
    timeoutMs: 60000,
    commands: [{ name: 'pnpm', versionArg: '-v', preferredPaths: [] }],
  });
  assert.ok(script.includes('WaitForExit(60000)'));
});

test('buildDependencyProbeBlock: 指定した全コマンドがブロックに出現する', () => {
  const script = buildDependencyProbeBlock('C:\\log\\update.log', {
    timeoutMs: 60000,
    commands: [
      { name: 'git', versionArg: '--version', preferredPaths: [] },
      { name: 'node', versionArg: '--version', preferredPaths: [] },
      { name: 'pnpm', versionArg: '-v', preferredPaths: ['C:\\devrelay\\node\\pnpm.cmd'] },
    ],
  });
  assert.ok(script.includes('$gitResolved'));
  assert.ok(script.includes('$nodeResolved'));
  assert.ok(script.includes('$pnpmResolved'));
  assert.ok(script.includes('pnpm probe: exit='));
  assert.ok(script.includes('git probe: exit='));
  assert.ok(script.includes('node probe: exit='));
});

test('buildDependencyProbeBlock: ログファイルパスが全ブロックに埋め込まれる', () => {
  const script = buildDependencyProbeBlock('C:\\Users\\x\\logs\\update.log', {
    timeoutMs: 1000,
    commands: [{ name: 'git', versionArg: '--version', preferredPaths: [] }],
  });
  const occurrences = script.split('C:\\Users\\x\\logs\\update.log').length - 1;
  assert.ok(occurrences >= 2);
});

test('buildDependencyProbeBlock: ハード中止（return）は not-found とタイムアウトの2箇所のみ', () => {
  const script = buildDependencyProbeBlock('C:\\log\\update.log', {
    timeoutMs: 60000,
    commands: [{ name: 'pnpm', versionArg: '-v', preferredPaths: [] }],
  });
  const returns = script.split('return').length - 1;
  // #356: 1) 未解決時の return、2) タイムアウト時の return の計2箇所。
  // exit code 不一致・版番号不一致はハード中止しない（return しない）ため数は増えない。
  assert.equal(returns, 2);
});

// #356 B1 アンチリグレッション（最重要）: 生成物のどこにも
// 「シングルクォートで囲まれた変数」（例: '$gitProbeOut'）が現れないこと。
// PowerShell のシングルクォートはリテラルで変数展開しないため、これが再発すると
// 版番号一致判定が常に false になる（今回の一次原因そのもの）。
test('buildDependencyProbeBlock: シングルクォートで囲まれた変数が1つも無い（B1再発防止）', () => {
  const script = buildDependencyProbeBlock('C:\\log\\update.log', {
    timeoutMs: 60000,
    commands: [
      { name: 'git', versionArg: '--version', preferredPaths: [] },
      { name: 'node', versionArg: '--version', preferredPaths: [] },
      { name: 'pnpm', versionArg: '-v', preferredPaths: ['C:\\devrelay\\node\\pnpm.cmd'] },
    ],
  });
  assert.ok(!/'\$[A-Za-z_]\w*'/.test(script));
});

test('buildDependencyProbeBlock: -match の左辺は $<name>ProbeOut.Trim()（クォート無し）', () => {
  const script = buildDependencyProbeBlock('C:\\log\\update.log', {
    timeoutMs: 60000,
    commands: [{ name: 'pnpm', versionArg: '-v', preferredPaths: [] }],
  });
  assert.ok(/\$pnpmProbeOut\.Trim\(\) -match '\[0-9\]\+\\\.\[0-9\]\+'/.test(script));
});

test('buildDependencyProbeBlock: 正規表現は非アンカー・ASCII明示の [0-9]+\\.[0-9]+ を使う（B2修正）', () => {
  const script = buildDependencyProbeBlock('C:\\log\\update.log', {
    timeoutMs: 60000,
    commands: [{ name: 'git', versionArg: '--version', preferredPaths: [] }],
  });
  assert.ok(script.includes("-match '[0-9]+\\.[0-9]+'"));
  assert.ok(!script.includes("-match '^\\d+\\.\\d+'"));
});

test('buildDependencyProbeBlock: exit code 不一致・版番号不一致は警告のみで return しない', () => {
  const script = buildDependencyProbeBlock('C:\\log\\update.log', {
    timeoutMs: 60000,
    commands: [{ name: 'pnpm', versionArg: '-v', preferredPaths: [] }],
  });
  const marker = '-ne 0) -or (-not';
  const idx = script.indexOf(marker);
  assert.ok(idx >= 0, 'exit code / versionLike の警告条件式が見つからない');
  const closeIdx = script.indexOf('}', idx);
  const warnBlock = script.slice(idx, closeIdx);
  assert.ok(!warnBlock.includes('return'));
  assert.ok(script.includes('probe warning (continuing)'));
});

test('buildDependencyProbeBlock: タイムアウトのみが return する（timedOut 変数を条件に使う）', () => {
  const script = buildDependencyProbeBlock('C:\\log\\update.log', {
    timeoutMs: 60000,
    commands: [{ name: 'pnpm', versionArg: '-v', preferredPaths: [] }],
  });
  assert.ok(/if \(\$pnpmProbeTimedOut\) \{[\s\S]*?return/.test(script));
});

test('buildDependencyProbeBlock: preferredPaths に .cmd を含む場合、$env:ComSpec と /c 経由で起動する（B3修正）', () => {
  const script = buildDependencyProbeBlock('C:\\log\\update.log', {
    timeoutMs: 60000,
    commands: [{ name: 'pnpm', versionArg: '-v', preferredPaths: ['C:\\devrelay\\node\\pnpm.cmd'] }],
  });
  assert.ok(script.includes('$env:ComSpec'));
  assert.ok(/\/c ["\']/.test(script));
});

test('buildDependencyProbeBlock: .exe のみのコマンドは $env:ComSpec を経由しない', () => {
  const script = buildDependencyProbeBlock('C:\\log\\update.log', {
    timeoutMs: 60000,
    commands: [{ name: 'git', versionArg: '--version', preferredPaths: [] }],
  });
  // git は .cmd/.bat の preferredPaths を持たないため、実行時分岐自体は生成されるが
  // 少なくとも ComSpec 分岐のガード式（拡張子マッチ）が含まれることを確認する。
  assert.ok(script.includes("-match '\\.(cmd|bat)"));
});

// ---- buildArtifactFreshnessGate ----

test('buildArtifactFreshnessGate: 複数パスが $artifactPaths に全て含まれる（AND判定の対象）', () => {
  const script = buildArtifactFreshnessGate(
    ['C:\\agent\\packages\\shared\\dist\\index.js', 'C:\\agent\\agents\\linux\\dist\\index.js'],
    'C:\\log\\update.log',
  );
  assert.ok(script.includes('C:\\agent\\packages\\shared\\dist\\index.js'));
  assert.ok(script.includes('C:\\agent\\agents\\linux\\dist\\index.js'));
});

test('buildArtifactFreshnessGate: $buildStart との比較を含む', () => {
  const script = buildArtifactFreshnessGate(['C:\\agent\\dist\\index.js'], 'C:\\log\\update.log');
  assert.ok(script.includes('$buildStart'));
  assert.ok(script.includes('-lt $buildStart'));
});

test('buildArtifactFreshnessGate: 判定結果を $artifactsFresh に格納する', () => {
  const script = buildArtifactFreshnessGate(['C:\\agent\\dist\\index.js'], 'C:\\log\\update.log');
  assert.ok(script.includes('$artifactsFresh = $true'));
  assert.ok(script.includes('$artifactsFresh = $false'));
});

test('buildArtifactFreshnessGate: 単一パスでも動作する（配列長1）', () => {
  const script = buildArtifactFreshnessGate(['C:\\agent\\dist\\index.js'], 'C:\\log\\update.log');
  assert.ok(script.includes('@("C:\\agent\\dist\\index.js")'));
});
