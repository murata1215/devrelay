/**
 * `u`（Agent 自己更新）の Windows 版 update.ps1 が使う「依存コマンドの機能プローブ」と
 * 「成果物の鮮度ゲート」の PowerShell スクリプト片を組み立てる純関数群（#352）。
 *
 * 背景（詳細はプラン §34.9〜§34.10 参照）:
 * #351 の `Get-Command pnpm -ErrorAction SilentlyContinue` は「解決できるか」しか見ていない。
 * PowerShell の解決優先順位（Alias > Function > Cmdlet > ExternalScript > Application）により
 * 裸の `pnpm` は常に `pnpm.ps1`（ExternalScript）を指し、`Get-Command` は必ず成功する。
 * ところがこの `pnpm.ps1` は特定端末で「起動はするが標準出力が空、$LASTEXITCODE も更新しない」
 * 状態になっており、#351 の「存在チェック」も「$LASTEXITCODE リセット」もこれを検出できなかった
 * （直前のコマンドの exit code＝0 がそのまま残り、無音のまま "成功" と誤認される）。
 *
 * この修正は判定軸を「解決できるか」から「実際に動くか」に変える:
 *   1. `.ps1` を避けて `.cmd`/`.exe` を明示的に解決する（buildExecutableResolver）
 *   2. タイムアウト付きで実際に実行し、標準出力が「版番号らしいか」で判定する
 *      （isVersionLikeOutput / buildDependencyProbeBlock）
 * exit code はこの中では 3 条件のうちの 1 つでしかない（PowerShell の exit code は
 * 信用できないことが実測で分かっているため、主軸には使わない）。
 *
 * 成果物の鮮度ゲート（buildArtifactFreshnessGate）は #351 Fix 3 の「唯一この種のデッドロックを
 * 止められる防御」を、shared/agent の 2 ファイル AND に強化したもの。
 *
 * 外部 import ゼロに保ち、コンパイル済み dist を直接 `node --test` から import して
 * 単体検証できるようにする（agent-update-decision.ts / auto-update-reconcile.ts と同じ流儀）。
 */

/**
 * 標準出力が「版番号らしい」か判定する。
 * 非空であり、かつ（複数行なら）1 行目が `^\d+\.\d+` に一致することを要求する。
 * `pnpm -v` / `node --version` / `git --version` のいずれも、正常時は数字始まりの
 * バージョン文字列を返す（`git --version` は `git version 2.43.0` のように前置詞が付くため
 * 呼び出し側で数字部分だけを渡す想定だが、この関数自体は「1 行目が数字始まりか」だけを見る
 * 保守的な判定にとどめる。誤検出よりも「疑わしきは失敗扱い」を優先する）。
 */
export function isVersionLikeOutput(stdout: string | null | undefined): boolean {
  if (!stdout) {
    return false;
  }
  const trimmed = stdout.trim();
  if (!trimmed) {
    return false;
  }
  const firstLine = trimmed.split(/\r?\n/)[0];
  return /^\d+\.\d+/.test(firstLine);
}

/**
 * PowerShell の変数名として安全な識別子か（英数字とアンダースコアのみ）。
 * 呼び出し元はすべて固定文字列（'git'/'node'/'pnpm'）を渡す想定だが、
 * 生成される PowerShell コードに任意文字列がそのまま混入しないよう防御的に検証する。
 */
function assertSafeIdentifier(name: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`update-script: unsafe identifier: ${name}`);
  }
}

/**
 * `.ps1` を避けて `.cmd`/`.exe` を優先的に解決する PowerShell 式（複数行ステートメント）を組み立てる。
 * 生成される PowerShell 変数は `$<name>Resolved`（見つからなければ `$null`）。
 *
 * 探索順（この順序を変えないこと）:
 *   1. `preferredPaths` を先頭から順に `Test-Path` で確認（例: ポータブル Node 配下の既知パス）
 *   2. `Get-Command <name>.cmd`
 *   3. `Get-Command <name>.exe`
 *
 * **`.ps1` を選ぶ経路は存在しない**（`git`/`node`/`pnpm` いずれも ExternalScript 経由を回避する）。
 */
export function buildExecutableResolver(name: string, preferredPaths: string[]): string {
  assertSafeIdentifier(name);
  const varName = `${name}Resolved`;
  const lines: string[] = [`$${varName} = $null`];

  preferredPaths.forEach((p, i) => {
    const keyword = i === 0 ? 'if' : 'elseif';
    lines.push(`${keyword} (Test-Path "${p}") { $${varName} = "${p}" }`);
  });

  const cmdKeyword = preferredPaths.length === 0 ? 'if' : 'elseif';
  lines.push(
    `${cmdKeyword} (Get-Command ${name}.cmd -ErrorAction SilentlyContinue) { $${varName} = (Get-Command ${name}.cmd).Source }`,
  );
  lines.push(
    `elseif (Get-Command ${name}.exe -ErrorAction SilentlyContinue) { $${varName} = (Get-Command ${name}.exe).Source }`,
  );

  return lines.join('\n');
}

export interface DependencyProbeCommand {
  /** コマンド名（'git' / 'node' / 'pnpm'）。PowerShell 変数名にもそのまま使うため英数字のみ */
  name: string;
  /** バージョンを取得する引数（例: '-v' / '--version'） */
  versionArg: string;
  /** `.ps1`/`Get-Command` より優先して確認する既知の絶対パス（例: ポータブル Node 配下） */
  preferredPaths: string[];
}

export interface DependencyProbeOptions {
  /** プローブ 1 件あたりのタイムアウト（ミリ秒）。既定は呼び出し側で DEVRELAY_UPDATE_PROBE_TIMEOUT_MS を解決する */
  timeoutMs: number;
  commands: DependencyProbeCommand[];
}

/**
 * 依存コマンドの機能プローブ（実行 + タイムアウト + 版番号検査）のブロックを生成する。
 *
 * PowerShell 5.1 の制約（`Start-Process` に `-Timeout` が無い、`ProcessStartInfo` は `.ps1` を
 * 直接起動できない）により `System.Diagnostics.Process` + `WaitForExit(ms)` + タイムアウト時
 * `Kill()` で実装する（詳細はプラン §36.4）。
 *
 * 判定は 3 条件の AND（exit code に依存しない。詳細はプラン §36.1）:
 *   1. タイムアウト内に終了した（ハングを検出）
 *   2. 標準出力が版番号らしい（無音での即時終了を検出）
 *   3. exit code が 0
 *
 * いずれかのコマンドで判定が false になった場合、**その時点で `return`** し、
 * 以降（`git fetch`/`git reset` を含む）を一切実行しない（旧 Agent は kill しない）。
 */
export function buildDependencyProbeBlock(logFile: string, opts: DependencyProbeOptions): string {
  const blocks = opts.commands.map((cmd) => {
    assertSafeIdentifier(cmd.name);
    const resolvedVar = `${cmd.name}Resolved`;
    const okVar = `${cmd.name}ProbeOk`;
    const outVar = `${cmd.name}ProbeOut`;
    const errVar = `${cmd.name}ProbeErr`;
    const exitVar = `${cmd.name}ProbeExit`;
    const elapsedVar = `${cmd.name}ProbeElapsedMs`;
    const startVar = `${cmd.name}ProbeStart`;
    const finishedVar = `${cmd.name}ProbeFinished`;
    const psiVar = `${cmd.name}Psi`;
    const procVar = `${cmd.name}Proc`;

    return [
      buildExecutableResolver(cmd.name, cmd.preferredPaths),
      `if (-not $${resolvedVar}) {`,
      `  "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] ${cmd.name} resolved: NOT FOUND" | Out-File -Append "${logFile}"`,
      `  "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] !! ${cmd.name} probe failed (not resolved), aborting update (agent kept alive)" | Out-File -Append "${logFile}"`,
      `  return`,
      `}`,
      `"[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] ${cmd.name} resolved: $${resolvedVar}" | Out-File -Append "${logFile}"`,
      `$${psiVar} = New-Object System.Diagnostics.ProcessStartInfo`,
      `$${psiVar}.FileName = $${resolvedVar}`,
      `$${psiVar}.Arguments = '${cmd.versionArg}'`,
      `$${psiVar}.UseShellExecute = $false`,
      `$${psiVar}.RedirectStandardOutput = $true`,
      `$${psiVar}.RedirectStandardError = $true`,
      `$${psiVar}.CreateNoWindow = $true`,
      `$${procVar} = New-Object System.Diagnostics.Process`,
      `$${procVar}.StartInfo = $${psiVar}`,
      `$${startVar} = Get-Date`,
      `$${okVar} = $false`,
      `$${outVar} = ''`,
      `$${errVar} = ''`,
      `$${exitVar} = -1`,
      `try {`,
      `  $${procVar}.Start() | Out-Null`,
      `  $${finishedVar} = $${procVar}.WaitForExit(${opts.timeoutMs})`,
      `  if (-not $${finishedVar}) {`,
      `    try { $${procVar}.Kill() } catch {}`,
      `    $${errVar} = 'timeout'`,
      `  } else {`,
      `    $${outVar} = $${procVar}.StandardOutput.ReadToEnd()`,
      `    $${errVar} = $${procVar}.StandardError.ReadToEnd()`,
      `    $${exitVar} = $${procVar}.ExitCode`,
      `    $${okVar} = ($${exitVar} -eq 0) -and ('$${outVar}'.Trim() -match '^\\d+\\.\\d+') -and ($${outVar}.Trim().Length -gt 0)`,
      `  }`,
      `} catch {`,
      `  $${errVar} = $_.Exception.Message`,
      `}`,
      `$${elapsedVar} = ((Get-Date) - $${startVar}).TotalMilliseconds`,
      `"[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] ${cmd.name} probe: exit=$${exitVar} elapsed=$([math]::Round($${elapsedVar}))ms out=[$($${outVar}.Trim())] err=[$($${errVar}.Trim())]" | Out-File -Append "${logFile}"`,
      `if (-not $${okVar}) {`,
      `  "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] !! ${cmd.name} probe failed, aborting update (agent kept alive)" | Out-File -Append "${logFile}"`,
      `  return`,
      `}`,
    ].join('\n');
  });

  return blocks.join('\n');
}

/**
 * 成果物の鮮度ゲート（複数ファイルの AND）のブロックを生成する。
 *
 * `$buildStart`（呼び出し側で `Get-Date` を代入済みの変数）を基準に、`distPaths` の
 * すべてが「存在し、かつ `$buildStart` 以降に書き換えられている」ことを要求する。
 * 判定結果は PowerShell 変数 `$artifactsFresh`（真偽値）に格納する
 * （build の exit code との AND は呼び出し側 connection.ts が行う）。
 *
 * 失敗時は `!! artifact missing` / `!! artifact stale` のどちらかを、
 * 実測 `LastWriteTime` と `$buildStart` を添えてログへ残す（#351 Fix 3 の「何秒ズレていたか
 * 後から読めない」問題への対応）。
 */
export function buildArtifactFreshnessGate(distPaths: string[], logFile: string): string {
  const lines: string[] = [
    `$artifactPaths = @(${distPaths.map((p) => `"${p}"`).join(', ')})`,
    `$artifactsFresh = $true`,
    `foreach ($artifactPath in $artifactPaths) {`,
    `  if (-not (Test-Path $artifactPath)) {`,
    `    $artifactsFresh = $false`,
    `    "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] !! artifact missing: $artifactPath" | Out-File -Append "${logFile}"`,
    `  } elseif ((Get-Item $artifactPath).LastWriteTime -lt $buildStart) {`,
    `    $artifactsFresh = $false`,
    `    "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] !! artifact stale: $artifactPath (mtime=$((Get-Item $artifactPath).LastWriteTime) buildStart=$buildStart)" | Out-File -Append "${logFile}"`,
    `  } else {`,
    `    "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] artifact OK: $artifactPath (mtime=$((Get-Item $artifactPath).LastWriteTime))" | Out-File -Append "${logFile}"`,
    `  }`,
    `}`,
  ];
  return lines.join('\n');
}
