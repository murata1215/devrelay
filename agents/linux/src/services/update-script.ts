/**
 * `u`（Agent 自己更新）の Windows 版 update.ps1 が使う「依存コマンドの機能プローブ」と
 * 「成果物の鮮度ゲート」の PowerShell スクリプト片を組み立てる純関数群（#352、#356 で判定を修正）。
 *
 * 背景（#352、詳細はプラン §34.9〜§34.10 参照）:
 * #351 の `Get-Command pnpm -ErrorAction SilentlyContinue` は「解決できるか」しか見ていない。
 * PowerShell の解決優先順位（Alias > Function > Cmdlet > ExternalScript > Application）により
 * 裸の `pnpm` は常に `pnpm.ps1`（ExternalScript）を指し、`Get-Command` は必ず成功する。
 * ところがこの `pnpm.ps1` は特定端末で「起動はするが標準出力が空、$LASTEXITCODE も更新しない」
 * 状態になっており、#351 の「存在チェック」も「$LASTEXITCODE リセット」もこれを検出できなかった
 * （直前のコマンドの exit code＝0 がそのまま残り、無音のまま "成功" と誤認される）。
 *
 * この修正（#352）は判定軸を「解決できるか」から「実際に動くか」に変えた:
 *   1. `.ps1` を避けて `.cmd`/`.exe` を明示的に解決する（buildExecutableResolver）
 *   2. タイムアウト付きで実際に実行し、標準出力が「版番号らしいか」で判定する
 *      （isVersionLikeOutput / buildDependencyProbeBlock）
 *
 * #356: しかし #352 で生成される PowerShell の判定式自体にバグがあり、git/node/pnpm が
 * すべて正常でも必ず失敗と判定されていた（実測: `git probe: exit=0 ... out=[git version
 * 2.52.0.windows.1]` の直後に `!! git probe failed` と記録される）。原因は2つ:
 *   B1. 版番号一致チェックの左辺が PowerShell のシングルクォート文字列 `'$outVar'` になっており、
 *       これはリテラルで変数展開されない（文字列 "$outVar" 自体に対して正規表現を評価していた）。
 *   B2. 正規表現が `^\d+\.\d+`（先頭アンカー）だったため、`git version 2.52.0...` や
 *       `v24.12.0` のように数字で始まらない実際の出力に一致しなかった。
 * さらに `UseShellExecute = $false` は CreateProcess を直接呼ぶため `.cmd`/`.bat`
 * （pnpm の解決結果は `pnpm.cmd`）を起動できない問題（B3）も判明した。
 *
 * #356 の設計判断: 「間違えたときのコスト」を下げる。成果物の鮮度ゲート
 * （buildArtifactFreshnessGate、shared/agent の dist mtime が非 incremental ビルドで
 * 必ず更新される）が既に「ビルドが実際に走ったか」を独立に担保しているため、
 * このプローブの判定を誤って緩くしても restart の安全性は落ちない。
 * したがってハード中止（`return`）は「実行ファイルが見つからない」「タイムアウト」の
 * 2 つの決定的な条件のみに残し、exit code 不一致・版番号不一致は警告してログに残した上で
 * 処理を継続する（exit code は $proc.ExitCode であり信用できる。不信の対象は
 * PowerShell が管理する $LASTEXITCODE であって $proc.ExitCode ではない）。
 *
 * 成果物の鮮度ゲート（buildArtifactFreshnessGate）は #351 Fix 3 の「唯一この種のデッドロックを
 * 止められる防御」を、shared/agent の 2 ファイル AND に強化したもの。
 *
 * 外部 import ゼロに保ち、コンパイル済み dist を直接 `node --test` から import して
 * 単体検証できるようにする（agent-update-decision.ts / auto-update-reconcile.ts と同じ流儀）。
 */

/**
 * 標準出力が「版番号らしい」か判定する。
 * 非空であり、かつ 1 行目のどこかに `[0-9]+\.[0-9]+`（例: `2.52.0`）が現れることを要求する。
 *
 * #356: 当初は `^\d+\.\d+`（1 行目が数字で始まる）というアンカー付き判定だったが、
 * `git --version` の実際の出力は `git version 2.52.0.windows.1`、`node --version` は
 * `v24.12.0` のように数字始まりではないため、実運用でこの関数が意図した判定基準を
 * 満たせなかった（実際に生成される PowerShell 側は独立した別バグ〔左辺のクォート漏れ〕で
 * 無関係に常に失敗していたため、この関数のテストが green のままバグが見逃されていた）。
 * `pnpm -v` は数字始まりの出力を返すため、非アンカー化しても引き続き true になる。
 *
 * 注意: この関数は生成される PowerShell の判定式（buildDependencyProbeBlock 内の
 * `-match` 式）と同一の実装ではない（JS の正規表現と .NET の正規表現は意味論が異なる
 * ため、共有定数化はしていない）。生成される PowerShell 自体の検証は
 * buildDependencyProbeBlock() の出力文字列に対するテストで行う。
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
  return /[0-9]+\.[0-9]+/.test(firstLine);
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
 * `Kill()` で実装する。`.cmd`/`.bat`（`UseShellExecute=$false` では CreateProcess が直接
 * 実行できない、#356 B3）は `%ComSpec% /c` 経由で起動する。
 *
 * exit code は `$proc.ExitCode`（OS 由来）であり信用できる。#352 が不信を表明していたのは
 * PowerShell が管理する `$LASTEXITCODE`（コマンドが見つからない場合に更新されないことがある）
 * であって、この `$proc.ExitCode` とは別物（#356 でこの JSDoc の誤記を訂正）。
 *
 * ハード中止（`return`、以降 `git fetch`/`git reset` を含め一切実行しない・旧 Agent は
 * kill しない）は次の 2 条件のみ（#356 で decisive な条件だけに絞った）:
 *   1. 実行ファイルが見つからない（`.cmd`/`.exe` のいずれも解決できない）
 *   2. タイムアウト（プロセスがハングしている）
 *
 * 次の 2 条件は **警告してログに残した上で処理を継続する**（#356、以前はここもハード中止
 * だったが、成果物の鮮度ゲート buildArtifactFreshnessGate が「ビルドが実際に走ったか」を
 * 独立に担保しているため、ここを厳しくしても restart の安全性は上がらず、逆に判定式の
 * バグ一つで更新が永久ロックする構造的リスクだけが残ることが実際に起きた〔#356 の本題〕
 * ため反転した）:
 *   3. exit code が 0 でない
 *   4. 標準出力が版番号らしくない
 */
export function buildDependencyProbeBlock(logFile: string, opts: DependencyProbeOptions): string {
  const blocks = opts.commands.map((cmd) => {
    assertSafeIdentifier(cmd.name);
    const resolvedVar = `${cmd.name}Resolved`;
    const outVar = `${cmd.name}ProbeOut`;
    const errVar = `${cmd.name}ProbeErr`;
    const exitVar = `${cmd.name}ProbeExit`;
    const elapsedVar = `${cmd.name}ProbeElapsedMs`;
    const startVar = `${cmd.name}ProbeStart`;
    const finishedVar = `${cmd.name}ProbeFinished`;
    const timedOutVar = `${cmd.name}ProbeTimedOut`;
    const versionLikeVar = `${cmd.name}ProbeVersionLike`;
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
      // #356 B3: UseShellExecute=$false は CreateProcess を直接呼ぶため .cmd/.bat を
      // 起動できない（ERROR_BAD_EXE_FORMAT）。pnpm の preferredPath は pnpm.cmd のため
      // 拡張子で分岐し、.cmd/.bat のときだけ %ComSpec% /c 経由で起動する。
      `if ($${resolvedVar} -match '\\.(cmd|bat)$') {`,
      `  $${psiVar}.FileName = $env:ComSpec`,
      `  $${psiVar}.Arguments = '/c "' + $${resolvedVar} + '" ${cmd.versionArg}'`,
      `} else {`,
      `  $${psiVar}.FileName = $${resolvedVar}`,
      `  $${psiVar}.Arguments = '${cmd.versionArg}'`,
      `}`,
      `$${psiVar}.UseShellExecute = $false`,
      `$${psiVar}.RedirectStandardOutput = $true`,
      `$${psiVar}.RedirectStandardError = $true`,
      `$${psiVar}.CreateNoWindow = $true`,
      `$${procVar} = New-Object System.Diagnostics.Process`,
      `$${procVar}.StartInfo = $${psiVar}`,
      `$${startVar} = Get-Date`,
      `$${outVar} = ''`,
      `$${errVar} = ''`,
      `$${exitVar} = -1`,
      `$${timedOutVar} = $false`,
      `try {`,
      `  $${procVar}.Start() | Out-Null`,
      `  $${finishedVar} = $${procVar}.WaitForExit(${opts.timeoutMs})`,
      `  if (-not $${finishedVar}) {`,
      `    try { $${procVar}.Kill() } catch {}`,
      `    $${timedOutVar} = $true`,
      `    $${errVar} = 'timeout'`,
      `  } else {`,
      `    $${outVar} = $${procVar}.StandardOutput.ReadToEnd()`,
      `    $${errVar} = $${procVar}.StandardError.ReadToEnd()`,
      `    $${exitVar} = $${procVar}.ExitCode`,
      `  }`,
      `} catch {`,
      `  $${errVar} = $_.Exception.Message`,
      `}`,
      `$${elapsedVar} = ((Get-Date) - $${startVar}).TotalMilliseconds`,
      // #356 B1/B2: 左辺をクォートせず（バグ再発防止）、非アンカー・ASCII 明示の
      // [0-9]+\.[0-9]+ で判定する（.NET の \d は Unicode Nd にマッチし JS の \d と
      // 意味が割れるため使わない）。
      `$${versionLikeVar} = ($${outVar}.Trim() -match '[0-9]+\\.[0-9]+')`,
      `"[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] ${cmd.name} probe: exit=$${exitVar} elapsed=$([math]::Round($${elapsedVar}))ms out=[$($${outVar}.Trim())] err=[$($${errVar}.Trim())] versionLike=$${versionLikeVar}" | Out-File -Append "${logFile}"`,
      // #356: ハード中止はタイムアウトのみ（実行ファイル未解決は上のブロックで既に中止済み）。
      `if ($${timedOutVar}) {`,
      `  "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] !! ${cmd.name} probe timed out, aborting update (agent kept alive)" | Out-File -Append "${logFile}"`,
      `  return`,
      `}`,
      // #356: exit code 不一致・版番号不一致はハード中止せず警告のみ（成果物鮮度ゲートが
      // 「ビルドが実際に走ったか」を別途担保するため）。
      `if (($${exitVar} -ne 0) -or (-not $${versionLikeVar})) {`,
      `  "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] !! ${cmd.name} probe warning (continuing): exit=$${exitVar} versionLike=$${versionLikeVar}" | Out-File -Append "${logFile}"`,
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
