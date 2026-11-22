import { readdir, readFile, stat, mkdir, rm, copyFile } from 'fs/promises';
import { join, basename, extname } from 'path';
import type { FileAttachment } from '@devrelay/shared';

// 出力ファイルの履歴保存先ディレクトリ名
const OUTPUT_HISTORY_DIR_NAME = '.devrelay-output-history';

// Directory name for files to be sent to user
export const OUTPUT_DIR_NAME = '.devrelay-output';

// Max file size to transfer（25MB。base64化で約1.37倍に膨張してもサーバーWSの既定maxPayload
// 100MiBに対して十分な余裕を残す値。2026-11-22: 旧5MBは動画等の成果物が通らず無言で消える
// 根本原因の一つだったため緩和した）
const MAX_FILE_SIZE = 25 * 1024 * 1024;

// 1ターンで送る添付の合計サイズ上限（40MB）。WS 1フレームに全ファイルのbase64が載るため、
// 個々が上限以下でも合計が膨らむとサーバー側maxPayload（既定100MiB）超過でAgent接続ごと
// 切断される。それを避けるための安全弁（2026-11-22）
const MAX_TOTAL_SIZE = 40 * 1024 * 1024;

// 1ターンで送るファイル件数の上限（暴走防止）
const MAX_FILE_COUNT = 50;

// ターン専用フォルダ配下で許容するサブフォルダの深さ（暴走・symlinkループ対策の保険）
const MAX_DEPTH = 5;

// MIME types for common file extensions
const MIME_TYPES: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.js': 'text/javascript',
  '.ts': 'text/typescript',
  '.py': 'text/x-python',
  '.html': 'text/html',
  '.css': 'text/css',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.xml': 'application/xml',
  '.csv': 'text/csv',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  // 2026-11-22: 動画・音声・Office形式が未登録で octet-stream になっていたため追加
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export async function ensureOutputDir(projectPath: string): Promise<string> {
  const outputDir = join(projectPath, OUTPUT_DIR_NAME);
  await mkdir(outputDir, { recursive: true });
  return outputDir;
}

/**
 * 出力ディレクトリをクリアする前に、既存ファイルを履歴ディレクトリにコピーする
 * コピー先: .devrelay-output-history/YYYYMMDD_HHmmss_filename
 * @param projectPath - プロジェクトのルートパス
 */
export async function clearOutputDir(projectPath: string): Promise<void> {
  const outputDir = join(projectPath, OUTPUT_DIR_NAME);
  try {
    // クリア前に既存ファイルを履歴ディレクトリにコピー
    await archiveOutputFiles(projectPath);
    await rm(outputDir, { recursive: true, force: true });
    await mkdir(outputDir, { recursive: true });
  } catch (err) {
    // Directory might not exist, that's ok
  }
}

/**
 * .devrelay-output/ 内のファイルを .devrelay-output-history/ に日時プレフィックス付きでコピーする
 * @param projectPath - プロジェクトのルートパス
 */
async function archiveOutputFiles(projectPath: string): Promise<void> {
  const outputDir = join(projectPath, OUTPUT_DIR_NAME);
  try {
    const files = await readdir(outputDir);
    // ファイルが無ければ何もしない
    if (files.length === 0) return;

    // 履歴ディレクトリを作成
    const historyDir = join(projectPath, OUTPUT_HISTORY_DIR_NAME);
    await mkdir(historyDir, { recursive: true });

    // 日時プレフィックスを生成（YYYYMMDD_HHmmss 形式）
    const now = new Date();
    const prefix = now.getFullYear().toString() +
      String(now.getMonth() + 1).padStart(2, '0') +
      String(now.getDate()).padStart(2, '0') + '_' +
      String(now.getHours()).padStart(2, '0') +
      String(now.getMinutes()).padStart(2, '0') +
      String(now.getSeconds()).padStart(2, '0');

    for (const filename of files) {
      const srcPath = join(outputDir, filename);
      try {
        const stats = await stat(srcPath);
        // ファイルのみコピー（サブディレクトリはスキップ）
        if (!stats.isFile()) continue;

        const destFilename = `${prefix}_${filename}`;
        const destPath = join(historyDir, destFilename);
        await copyFile(srcPath, destPath);
        console.log(`📁 Archived output file: ${destFilename}`);
      } catch (err: any) {
        console.error(`Failed to archive file ${filename}:`, err.message);
      }
    }
  } catch (err: any) {
    // 出力ディレクトリが存在しない場合はスキップ
    if (err.code !== 'ENOENT') {
      console.error('Failed to archive output files:', err.message);
    }
  }
}

export async function collectOutputFiles(projectPath: string): Promise<FileAttachment[]> {
  const outputDir = join(projectPath, OUTPUT_DIR_NAME);
  const attachments: FileAttachment[] = [];

  try {
    const files = await readdir(outputDir);

    for (const filename of files) {
      const filePath = join(outputDir, filename);

      try {
        const stats = await stat(filePath);

        // Skip directories and large files
        if (!stats.isFile()) continue;
        if (stats.size > MAX_FILE_SIZE) {
          console.log(`⚠️ File too large to transfer: ${filename} (${stats.size} bytes)`);
          continue;
        }

        const content = await readFile(filePath);
        const ext = extname(filename).toLowerCase();
        const mimeType = MIME_TYPES[ext] || 'application/octet-stream';

        attachments.push({
          filename,
          content: content.toString('base64'),
          mimeType,
          size: stats.size,
        });

        console.log(`📤 Collected output file: ${filename} (${stats.size} bytes)`);
      } catch (err: any) {
        console.error(`Failed to read file ${filename}:`, err.message);
      }
    }
  } catch (err: any) {
    // Directory doesn't exist or is empty, that's ok
    if (err.code !== 'ENOENT') {
      console.error(`Failed to read output directory:`, err.message);
    }
  }

  return attachments;
}

// Instruction to append to prompts
export const OUTPUT_DIR_INSTRUCTION = `

【ファイル出力】
ユーザー向けの成果物ファイル（HTML/PDF/画像/スクリプト等）は、特にパス指定がなければ \`${OUTPUT_DIR_NAME}/\` ディレクトリに保存してください。このディレクトリに置かれたファイルは自動的にユーザーに送信されます。
ただしユーザーが明示的に保存先を指定した場合（例：「ルートフォルダに」「~/foo に」「カレントディレクトリに」等）は、その指示を優先してください。`;

// ============================================================================
// ターン単位の出力フォルダ（複数スレッド同時実行時の成果物の混線防止）
//
// 背景: 以前は同じプロジェクトの全スレッドが `.devrelay-output/` 直下を共有しており、
//   - ターン開始時の clearOutputDir() が、実行中の別スレッドの作りかけ成果物まで消す
//   - ターン完了時の collectOutputFiles() が、別スレッドが置いたファイルまで送ってしまう
// という混線が起きていた。そこでターンごとに `.devrelay-output/turn_<ID>/` を用意して AI に案内し、
// 送信対象は「そのターン専用フォルダの中身」＋「ターン開始後に直下へ新規作成/更新されたファイル」
// （古いルールに従って直下に置く AI 向けの後方互換）に限定する。
// 直下を丸ごと消す処理はやめ、24 時間以上前のターン専用フォルダ・直下ファイルだけを履歴へ退避して片付ける。
// ============================================================================

/** ターン専用フォルダ名の接頭辞。片付け（prune）はこの接頭辞のフォルダだけを対象にする */
export const TURN_DIR_PREFIX = 'turn_';

/** これより古いターン専用フォルダ・直下ファイルを、次のターン開始時に履歴へ退避して片付ける */
const STALE_OUTPUT_MS = 24 * 60 * 60 * 1000;

/** 1 ターン分の出力フォルダ情報（beginOutputTurn が作り、collectTurnOutputFiles が使う） */
export interface OutputTurn {
  /** プロジェクトのルートパス */
  projectPath: string;
  /** ターン専用フォルダ名（例: `turn_abc123`） */
  turnDirName: string;
  /** AI に案内する相対パス（区切りは常に `/`。例: `.devrelay-output/turn_abc123`） */
  relDir: string;
  /** ターン開始時点の直下ファイル一覧（ファイル名 → `mtimeMs:size`）。差分検出に使う */
  rootSnapshot: Map<string, string>;
}

/**
 * ターンを識別するキーから、ファイル名として安全なターン専用フォルダ名を作る。
 * パス区切りやドット等は除去し（`..` によるフォルダ外への脱出を防ぐ）、長さも 40 文字に制限する。
 * @param turnKey ターン識別子（通常は server が採番する turnId）
 * @returns `turn_` で始まるフォルダ名
 */
export function makeTurnDirName(turnKey: string): string {
  const safe = (turnKey || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  // 何も残らなかった場合は時刻ベースの名前で代用する（空のフォルダ名を作らない）
  return TURN_DIR_PREFIX + (safe || Date.now().toString(36));
}

/**
 * 1 ファイルを `.devrelay-output-history/` に日時プレフィックス付きでコピーする。
 * @param projectPath プロジェクトのルートパス
 * @param srcPath コピー元の絶対パス
 * @param destName 履歴側のファイル名（日時プレフィックスの後ろに付く部分）
 */
async function archiveOneFile(projectPath: string, srcPath: string, destName: string): Promise<void> {
  const historyDir = join(projectPath, OUTPUT_HISTORY_DIR_NAME);
  await mkdir(historyDir, { recursive: true });
  const now = new Date();
  const prefix = now.getFullYear().toString() +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0') + '_' +
    String(now.getHours()).padStart(2, '0') +
    String(now.getMinutes()).padStart(2, '0') +
    String(now.getSeconds()).padStart(2, '0');
  await copyFile(srcPath, join(historyDir, `${prefix}_${destName}`));
}

/**
 * 24 時間以上前のターン専用フォルダと直下ファイルを履歴に退避してから削除する。
 * 実行中の別スレッドのものを消さないよう、新しいものには一切触れない。
 * 失敗しても AI 実行は止めない（ログのみ）。
 * @param projectPath プロジェクトのルートパス
 * @param nowMs 現在時刻（ミリ秒）
 */
async function pruneStaleOutputs(projectPath: string, nowMs: number): Promise<void> {
  const outputDir = join(projectPath, OUTPUT_DIR_NAME);
  let entries: string[];
  try {
    entries = await readdir(outputDir);
  } catch {
    return;
  }
  for (const name of entries) {
    const entryPath = join(outputDir, name);
    try {
      const st = await stat(entryPath);
      if (nowMs - st.mtimeMs < STALE_OUTPUT_MS) continue;
      if (st.isFile()) {
        // 直下の古いファイル（以前のターンの成果物）
        await archiveOneFile(projectPath, entryPath, name);
        await rm(entryPath, { force: true });
      } else if (st.isDirectory() && name.startsWith(TURN_DIR_PREFIX)) {
        // 古いターン専用フォルダ: 中のファイルを退避してからフォルダごと削除
        // （ユーザーや AI が作った turn_ 以外のフォルダには触れない）
        for (const child of await readdir(entryPath)) {
          const childPath = join(entryPath, child);
          try {
            if ((await stat(childPath)).isFile()) await archiveOneFile(projectPath, childPath, `${name}_${child}`);
          } catch (err: any) {
            console.error(`Failed to archive ${name}/${child}:`, err.message);
          }
        }
        await rm(entryPath, { recursive: true, force: true });
      }
    } catch (err: any) {
      console.error(`Failed to prune output entry ${name}:`, err.message);
    }
  }
}

/**
 * 直下のファイル一覧（ファイル名 → `mtimeMs:size`）を取る。
 * @param outputDir `.devrelay-output` の絶対パス
 */
async function snapshotRootFiles(outputDir: string): Promise<Map<string, string>> {
  const snap = new Map<string, string>();
  try {
    for (const name of await readdir(outputDir)) {
      try {
        const st = await stat(join(outputDir, name));
        if (st.isFile()) snap.set(name, `${st.mtimeMs}:${st.size}`);
      } catch {
        // 読み取り中に消えたファイル等は無視
      }
    }
  } catch {
    // フォルダが無ければ空のスナップショット
  }
  return snap;
}

/**
 * ターン開始時の準備: ターン専用フォルダを作り、直下ファイルのスナップショットを取る。
 * 例外は投げない（準備に失敗しても AI 実行は続ける）。
 * @param projectPath プロジェクトのルートパス
 * @param turnKey ターン識別子（turnId。無ければ呼び出し側で時刻+sessionId 等を渡す）
 * @param options.prune 古い出力の片付けを行うか（一時セッションでは false にする）
 * @returns このターンの出力フォルダ情報
 */
export async function beginOutputTurn(
  projectPath: string,
  turnKey: string,
  options: { prune: boolean } = { prune: true },
): Promise<OutputTurn> {
  const turnDirName = makeTurnDirName(turnKey);
  const outputDir = join(projectPath, OUTPUT_DIR_NAME);
  try {
    await mkdir(outputDir, { recursive: true });
    if (options.prune) await pruneStaleOutputs(projectPath, Date.now());
  } catch (err: any) {
    console.error('Failed to prepare output directory:', err.message);
  }
  const rootSnapshot = await snapshotRootFiles(outputDir);
  try {
    await mkdir(join(outputDir, turnDirName), { recursive: true });
  } catch (err: any) {
    console.error('Failed to create turn output directory:', err.message);
  }
  return { projectPath, turnDirName, relDir: `${OUTPUT_DIR_NAME}/${turnDirName}`, rootSnapshot };
}

/**
 * 収集時にスキップされた 1 件の情報（上限超過・読み取り失敗等、ユーザーに伝えるため）。
 */
export interface SkippedOutput {
  /** 表示用の相対パス（ターン専用フォルダ基準。`/` 区切り） */
  path: string;
  /** この機体上の絶対パス（ユーザーが直接確認できるように） */
  absPath: string;
  /** バイトサイズ（取得できた場合のみ） */
  size?: number;
  /** スキップ理由 */
  reason: 'too-large' | 'total-limit' | 'count-limit' | 'depth-limit' | 'read-error';
}

/** collectTurnOutputFiles() の戻り値 */
export interface CollectedOutput {
  /** 送信する添付ファイル */
  attachments: FileAttachment[];
  /** 上限超過・読み取り失敗等でスキップされたファイル */
  skipped: SkippedOutput[];
}

/**
 * 1 ファイルを読み込んで添付形式にする。
 * 大きすぎる・読み取れない場合は理由付きの skip を返す（2026-11-22: 以前は null を返すだけで
 * ユーザーに一切伝わらなかった「無言の失敗」を解消するための変更）。
 * @param filePath 絶対パス
 * @param relPath 送信時のファイル名（相対パス。サブフォルダ経由なら `/` を含む）
 */
async function readAttachment(filePath: string, relPath: string): Promise<{ ok: FileAttachment } | { skip: SkippedOutput }> {
  try {
    const stats = await stat(filePath);
    if (!stats.isFile()) {
      // 呼び出し元は基本ファイルのみ渡すが、競合でディレクトリ化した等の保険
      return { skip: { path: relPath, absPath: filePath, reason: 'read-error' } };
    }
    if (stats.size > MAX_FILE_SIZE) {
      console.log(`File too large to transfer: ${relPath} (${stats.size} bytes)`);
      return { skip: { path: relPath, absPath: filePath, size: stats.size, reason: 'too-large' } };
    }
    const content = await readFile(filePath);
    const mimeType = MIME_TYPES[extname(relPath).toLowerCase()] || 'application/octet-stream';
    console.log(`Collected output file: ${relPath} (${stats.size} bytes)`);
    return { ok: { filename: relPath, content: content.toString('base64'), mimeType, size: stats.size } };
  } catch (err: any) {
    console.error(`Failed to read file ${relPath}:`, err.message);
    return { skip: { path: relPath, absPath: filePath, reason: 'read-error' } };
  }
}

/**
 * ターン専用フォルダを再帰的に走査し、ファイル一覧とスキップ情報を集める。
 * シンボリックリンクは辿らない（フォルダ外への脱出防止）。件数・合計サイズ・深さの
 * 上限に達したエントリは skipped に記録して以降は読み取らない。
 * @param dir 現在探索中のディレクトリ（絶対パス）
 * @param relBase dir の turnDir からの相対パス（`/` 区切り。ルートは空文字）
 * @param state 件数・合計サイズの集計状態（再帰全体で共有する可変オブジェクト）
 * @param depth 現在の深さ（turnDir 自身が 0）
 * @param attachments 収集済み添付（呼び出し側と共有、push で追加）
 * @param skipped スキップ一覧（呼び出し側と共有、push で追加）
 */
async function walkTurnFiles(
  dir: string,
  relBase: string,
  state: { count: number; totalSize: number },
  depth: number,
  attachments: FileAttachment[],
  skipped: SkippedOutput[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err: any) {
    if (err.code !== 'ENOENT') console.error(`Failed to read directory ${dir}:`, err.message);
    return;
  }
  // 名前順に処理する（上限に達したときどのファイルが送られたかが実行環境に依存しないようにする）
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;
    const absPath = join(dir, entry.name);

    // シンボリックリンクはフォルダ外への脱出・循環参照を防ぐため辿らない（ファイルでも無視）
    if (entry.isSymbolicLink()) continue;

    if (entry.isDirectory()) {
      if (depth + 1 > MAX_DEPTH) {
        skipped.push({ path: relPath, absPath, reason: 'depth-limit' });
        continue;
      }
      await walkTurnFiles(absPath, relPath, state, depth + 1, attachments, skipped);
      continue;
    }

    if (!entry.isFile()) continue; // ソケット・デバイスファイル等は無視

    if (state.count >= MAX_FILE_COUNT) {
      skipped.push({ path: relPath, absPath, reason: 'count-limit' });
      continue;
    }

    const result = await readAttachment(absPath, relPath);
    if ('skip' in result) {
      skipped.push(result.skip);
      continue;
    }
    if (state.totalSize + result.ok.size > MAX_TOTAL_SIZE) {
      skipped.push({ path: relPath, absPath, size: result.ok.size, reason: 'total-limit' });
      continue;
    }

    attachments.push(result.ok);
    state.count += 1;
    state.totalSize += result.ok.size;
  }
}

/**
 * このターンでユーザーに送るファイルを集める。
 * 1. ターン専用フォルダ配下（サブフォルダも含め再帰的に集める。2026-11-22: 以前は直下の
 *    ファイルしか見ておらず、サブフォルダに整理して置いた成果物が無言で消えていた）
 * 2. `.devrelay-output/` 直下のうち、ターン開始時のスナップショットに無い（新規）か、更新されたファイル
 *    （こちらは従来どおり非再帰。直下のサブフォルダは他スレッドのターン専用フォルダ・ユーザーの
 *    作業用フォルダである可能性があり、再帰すると混線が再発するため対象外のまま維持する）
 * 同名がある場合は 1 を優先する。
 * @param turn beginOutputTurn の戻り値
 */
export async function collectTurnOutputFiles(turn: OutputTurn): Promise<CollectedOutput> {
  const outputDir = join(turn.projectPath, OUTPUT_DIR_NAME);
  const turnDir = join(outputDir, turn.turnDirName);
  const attachments: FileAttachment[] = [];
  const skipped: SkippedOutput[] = [];
  const state = { count: 0, totalSize: 0 };

  // 1. ターン専用フォルダ（再帰）
  await walkTurnFiles(turnDir, '', state, 0, attachments, skipped);
  const seen = new Set(attachments.map((a) => a.filename));

  // 2. 直下の新規・更新ファイル（後方互換・非再帰）
  const current = await snapshotRootFiles(outputDir);
  for (const [name, sig] of current) {
    if (seen.has(name)) continue;
    // ターン開始前から変わっていないファイルは前のターン（または別スレッド）の物なので送らない
    if (turn.rootSnapshot.get(name) === sig) continue;
    if (state.count >= MAX_FILE_COUNT) {
      skipped.push({ path: name, absPath: join(outputDir, name), reason: 'count-limit' });
      continue;
    }
    const result = await readAttachment(join(outputDir, name), name);
    if ('skip' in result) {
      skipped.push(result.skip);
      continue;
    }
    if (state.totalSize + result.ok.size > MAX_TOTAL_SIZE) {
      skipped.push({ path: name, absPath: join(outputDir, name), size: result.ok.size, reason: 'total-limit' });
      continue;
    }
    attachments.push(result.ok);
    state.count += 1;
    state.totalSize += result.ok.size;
  }
  return { attachments, skipped };
}

/**
 * collectTurnOutputFiles() が返した skipped を、AI 応答本文に追記する注意文に変換する。
 * スキップが無ければ空文字を返す（呼び出し側はそのまま末尾に連結すればよい）。
 * 2026-11-22: 以前は console.log のみでユーザーに一切伝わらなかった「無言の失敗」を解消する。
 * @param skipped collectTurnOutputFiles の戻り値の skipped
 */
export function buildSkippedOutputNotice(skipped: SkippedOutput[]): string {
  if (skipped.length === 0) return '';
  const reasonLabel: Record<SkippedOutput['reason'], string> = {
    'too-large': '1ファイルの上限超過',
    'total-limit': '合計サイズの上限超過',
    'count-limit': '件数の上限超過',
    'depth-limit': 'フォルダ階層が深すぎる',
    'read-error': '読み取り失敗',
  };
  const lines = skipped.map((s) => {
    const sizeStr = s.size != null ? `（${(s.size / (1024 * 1024)).toFixed(1)}MB）` : '';
    return `- ${s.path}${sizeStr} … ${reasonLabel[s.reason]}（この機体に残っています: ${s.absPath}）`;
  });
  const maxFileMb = Math.round(MAX_FILE_SIZE / (1024 * 1024));
  const maxTotalMb = Math.round(MAX_TOTAL_SIZE / (1024 * 1024));
  return `\n\n⚠️ 以下のファイルは DevRelay で送信できませんでした（上限: 1ファイル${maxFileMb}MB・合計${maxTotalMb}MB・${MAX_FILE_COUNT}件・階層${MAX_DEPTH}段）:\n${lines.join('\n')}`;
}

/**
 * ターン専用フォルダを案内する「ファイル出力」指示文を作る（OUTPUT_DIR_INSTRUCTION の置き換え）。
 * @param turn beginOutputTurn の戻り値
 */
export function buildOutputDirInstruction(turn: OutputTurn): string {
  const maxFileMb = Math.round(MAX_FILE_SIZE / (1024 * 1024));
  const maxTotalMb = Math.round(MAX_TOTAL_SIZE / (1024 * 1024));
  return `

【ファイル出力】
ユーザー向けの成果物ファイル（HTML/PDF/画像/スクリプト等）は、特にパス指定がなければ \`${turn.relDir}/\` ディレクトリに保存してください。このディレクトリに置かれたファイルは自動的にユーザーに送信されます。
（このやり取り専用のフォルダです。同じプロジェクトの別の会話の成果物と混ざらないよう、\`${OUTPUT_DIR_NAME}/\` 直下ではなくこのフォルダに置いてください）
サブフォルダを作って整理しても構いません（階層ごと送られます）。ただし 1 ファイル ${maxFileMb}MB・合計 ${maxTotalMb}MB・${MAX_FILE_COUNT} 件が上限です。動画等が超える場合は解像度やビットレートを落として収めてください。
ただしユーザーが明示的に保存先を指定した場合（例：「ルートフォルダに」「~/foo に」「カレントディレクトリに」等）は、その指示を優先してください。`;
}


// Instruction for plan mode (when user hasn't sent 'exec' yet)
export const PLAN_MODE_INSTRUCTION = `

【プランモード】
現在はプランモードです。コードの書き換えや新規ファイルの作成は行わず、以下のみを行ってください：
- 調査・分析
- 実装プランの立案
- 質問や確認
- ログ確認（pm2 logs, journalctl, git status 等の読み取り専用コマンドは実行可能）
- スキルは Skill ツールではなく Bash で直接実行（例: \`bash ~/.claude/skills/devrelay-ask-member/scripts/ask.sh --list\`）

プランが完成したら、最後に必ず以下のように伝えてください：
「このプランでよければ \`e\` または \`exec\` を送信してください。実装を開始します。」

ユーザーが \`exec\` を送信するまで、コードの変更は行わないでください。

【重要】\`ExitPlanMode\` ツールは使用しないでください。DevRelay のプランモード解除はユーザーが \`e\` / \`exec\` を送信することで行います。`;

// Instruction for exec mode (after user sends 'exec')
export const EXEC_MODE_INSTRUCTION = `

【実行モード】
ユーザーが実装開始を承認しました。プランに従ってコードの変更を実行してください。

プランに従って実装を開始してください。

【重要】シェルコマンド（ビルド・テスト・インストール等）はバックグラウンドではなく**フォアグラウンドで実行**し、完了を待ってから結果を報告してください。バックグラウンド実行するとセッション終了時にプロセスが停止します。`;

// DevRelay Agreement v6: ルールを rules/devrelay.md に分離
// CLAUDE.md には軽量マーカーのみ配置し、Agreement 本体は rules/devrelay.md に置く
export const DEVRELAY_AGREEMENT_VERSION = 'v6';
export const DEVRELAY_AGREEMENT_MARKER = `<!-- DevRelay Agreement ${DEVRELAY_AGREEMENT_VERSION} -->`;
export const DEVRELAY_AGREEMENT_END_MARKER = '<!-- /DevRelay Agreement -->';

// 旧バージョンのマーカー（アップグレード検出用）
export const DEVRELAY_AGREEMENT_OLD_MARKERS = [
  '<!-- DevRelay Agreement v1 -->',
  '<!-- DevRelay Agreement v2 -->',
  '<!-- DevRelay Agreement v3 -->',
  '<!-- DevRelay Agreement v4 -->',
  '<!-- DevRelay Agreement v5 -->',
];

// v6: rules/devrelay.md に書き込む Agreement 全文テンプレート
export const DEVRELAY_RULES_TEMPLATE = `<!-- DevRelay Agreement v6 -->

# DevRelay 共通ルール

## ファイル出力

ユーザーに渡すファイルを作成する場合は、必ず \`.devrelay-output/\` ディレクトリに保存してください。
このディレクトリに置かれたファイルは自動的にユーザーに送信されます。

## プランモード

現在はプランモードです。コードの書き換えや新規ファイルの作成は行わず、以下のみを行ってください：
- 調査・分析
- 実装プランの立案
- 質問や確認

プランが完成したら、最後に必ず以下のように伝えてください：
「このプランでよければ \\\`e\\\` または \\\`exec\\\` を送信してください。実装を開始します。」

ユーザーが \\\`exec\\\` を送信するまで、コードの変更は行わないでください。

\\\`ExitPlanMode\\\` ツールは使用しないでください。DevRelay のプランモード解除はユーザーが \\\`e\\\` / \\\`exec\\\` を送信することで行います。

## プランの説明

プランを立案したら、必ずテキストで概要を説明してください。
ファイルに書き込むだけでなく、ユーザーが Discord/Telegram で内容を確認できるようにしてください。

## ユーザーへの質問

exec モードでは AskUserQuestion ツールを使用できます。
質問は DevRelay 経由で WebUI/Discord/Telegram に表示され、ユーザーが選択肢を選んで回答します。
plan モードでは AskUserQuestion は使用せず、テキストで質問してください。

## コーディングスタイル

ソースコードを書く際は、詳細な日本語コメントを必ず残してください。

1. **関数・メソッド**: 必ず JSDoc 形式で目的・引数・戻り値を説明
2. **クラス**: クラスの責務と使用方法を説明
3. **複雑なロジック**: 処理の流れを段階的に説明
4. **条件分岐**: なぜその条件が必要かを説明
5. **重要な変数**: 変数の用途を説明
6. **TODO・FIXME**: 将来の改善点を明記

コメントがないコードは不完全です。他の開発者が読んで理解できるレベルのコメントを心がけてください。

---

## Issue 管理（doc/issues.md）

プロジェクトの課題・タスクは \\\`doc/issues.md\\\` で管理してください。
DevRelay WebUI の Issues タブからリアルタイムで確認できます。

### フォーマット

\\\`\\\`\\\`markdown
# Issues

## カテゴリ名（例: バグ修正、機能追加、改善）

- [ ] 未着手のタスク
- [~] 進行中のタスク
- [x] 完了したタスク
\\\`\\\`\\\`

### ルール

- ステータスは \\\`[ ]\\\`（未着手）、\\\`[~]\\\`（進行中）、\\\`[x]\\\`（完了）の3種類
- 完了したタスクは定期的に削除して肥大化を防ぐ
- \\\`w\\\` コマンド実行時に、今回の作業に関連する Issue のステータスを更新する

---

## クロスプロジェクト連携

DevRelay はプロジェクト間で質問や実行依頼を送ることができます。
devrelay-ask-member スキルを使用するか、ユーザーが Discord/Telegram で以下のコマンドを使用します。

| コマンド | 説明 | 例 |
|---------|------|-----|
| \\\`ask <project>: <質問>\\\` | 他プロジェクトに質問（プランモード） | \\\`ask pixblog: API仕様を教えて\\\` |
| \\\`teamexec <project>: <指示>\\\` | 他プロジェクトに実行依頼（exec モード） | \\\`teamexec pixblog: README更新して\\\` |
| \\\`te <project>: <指示>\\\` | teamexec の短縮形 | \\\`te pixdraft: バグ修正して\\\` |

- \\\`ask\\\` はプランモードで回答のみ。コード変更は行いません
- \\\`teamexec\\\` / \\\`te\\\` は exec モードで実装まで実行します
- 質問/依頼先のエージェントがオンラインである必要があります

---

## CLAUDE.md 更新ルール

CLAUDE.md は **毎回のプロンプトでコンテキストに全文載る**。
肥大化を防ぐため、以下のルールを厳守すること。

### CLAUDE.md に書いてよいもの（2,000 トークン以内を維持）

- プロジェクト概要（1〜2行）
- ルールファイルへの参照（\\\`rules/devrelay.md\\\`、\\\`rules/project.md\\\`）
- 技術スタック（テーブル 5〜8行）
- ビルド & デプロイ手順（5〜10行）
- 環境変数一覧（テーブル）
- DB テーブル概要（テーブル名 + 1行説明）
- 詳細ドキュメントへの参照リンク

### CLAUDE.md に絶対書いてはいけないもの

| 書いてはいけないもの | 代わりに書く場所 |
|---------------------|--------------------|
| 完了済みタスクのチェックリスト（✅） | \\\`doc/changelog.md\\\` |
| 日付付きの実装記録（「2026-XX-XX 実装」） | \\\`doc/changelog.md\\\` |
| Phase 完了の詳細 | \\\`doc/changelog.md\\\` |
| 仕様変更の経緯（Before/After） | \\\`doc/changelog.md\\\` |
| 新規ファイル一覧 | \\\`doc/changelog.md\\\` |
| API エンドポイント全一覧 | \\\`doc/\\\` またはコードから読む |
| 設計判断の追加・変更 | \\\`rules/project.md\\\` |

### \\\`w\\\` コマンド（wrap up）実行時の手順

1. **doc/changelog.md** に今回の変更内容を追記（日付 + 概要 + 詳細）
2. **rules/project.md** に設計判断・ルールの追加/変更があれば追記
3. **doc/issues.md** に今回の作業に関連する Issue があればステータスを更新
4. **CLAUDE.md** は技術スタック・DB テーブル・環境変数に変更があった場合**のみ**更新
5. **MEMORY.md** があれば更新（下記ルール参照）
6. README.md を必要に応じて更新
7. コミット & プッシュ

### 判断に迷ったら

「このセクションは、次回のプロンプトで Claude が作業するために毎回必要か？」

- **YES** → CLAUDE.md に残す（ただし簡潔に）
- **NO** → \\\`doc/changelog.md\\\` または \\\`rules/project.md\\\` に移動

---

## MEMORY.md 更新ルール

MEMORY.md（Claude Code の auto memory）は **毎回のプロンプトでシステムプロンプトに全文載る**。
CLAUDE.md と同じ肥大化問題を抱えるため、以下のルールを守ること。

### MEMORY.md の上限

- **80行以内を維持**（200行で切り詰められるが、余裕を持って80行）
- 設計判断の詳細は \\\`rules/project.md\\\` に書き、MEMORY.md には書かない

### MEMORY.md に書いてよいもの

- Project Overview（プロジェクト概要: 5行）
- Critical Rules（絶対守るルール: 5行）
- Build & Deploy（ビルド手順: 4行）
- Architecture Patterns（アーキテクチャの癖: 5行）
- Recent Changes（直近の変更サマリー: 10行）
- Document Structure（ドキュメント構成の参照先: 6行）
- Key File Locations（主要ファイルパス: 12行）
- トラブルシューティング知見（ハマりやすいポイントのみ、各1行）

### MEMORY.md に書いてはいけないもの

| 書いてはいけないもの | 代わりに参照する場所 |
|---------------------|--------------------|
| 個別機能の実装詳細 | \\\`rules/project.md\\\` |
| API エンドポイント・DB フィールド一覧 | \\\`rules/project.md\\\` またはコード |
| 完了済みタスクの経緯 | \\\`doc/changelog.md\\\` |
| 1回限りの作業手順 | 不要（削除） |

### \\\`w\\\` コマンド時の MEMORY.md 更新

- **Recent Changes** セクションを最新の変更で更新
- \\\`rules/project.md\\\` に移行済みの詳細があれば削除
- 80行を超えていたら圧縮

<!-- /DevRelay Agreement v6 -->
`;

// v6: CLAUDE.md 先頭に置く軽量マーカー（Agreement 本体は rules/devrelay.md に分離）
export const DEVRELAY_CLAUDEMD_MARKER = `${DEVRELAY_AGREEMENT_MARKER}
See \`rules/devrelay.md\` for DevRelay rules.
${DEVRELAY_AGREEMENT_END_MARKER}`;

// v6 用 Agreement 適用プロンプト
// rules/devrelay.md を作成し、CLAUDE.md の旧 Agreement ブロックを軽量マーカーに置き換える
export const AGREEMENT_APPLY_PROMPT = `【タスク】DevRelay Agreement v6 を適用する

これは DevRelay システムからの自動タスクです。質問せずに以下を実行してください：

## Step 1: rules/devrelay.md を作成・更新

1. \`rules/\` ディレクトリを作成（存在しない場合）
2. \`rules/devrelay.md\` に以下の内容を書き込む（既存の場合は上書き）：

${DEVRELAY_RULES_TEMPLATE}

## Step 2: CLAUDE.md を更新

1. CLAUDE.md を読む（存在しない場合は新規作成）
2. 旧 Agreement ブロック（\`<!-- DevRelay Agreement v...\` から \`<!-- /DevRelay Agreement -->\` まで、その直後の \`---\` 行も含む）を**全て削除**
3. ファイルの先頭に以下のマーカーを追加：

${DEVRELAY_CLAUDEMD_MARKER}

---

## Step 3: 補助ファイルの作成（未存在時のみ）

1. \`doc/\` ディレクトリを作成（存在しない場合）
2. \`doc/changelog.md\` が存在しなければ、以下の内容で作成：
\`\`\`
# Changelog
\`\`\`
3. \`doc/issues.md\` が存在しなければ、以下の内容で作成：
\`\`\`
# Issues
\`\`\`
4. \`rules/project.md\` が存在しなければ、以下の内容で作成：
\`\`\`
# プロジェクト固有ルール
\`\`\`

## Step 4: 結果を報告

以下の形式で結果を報告してください：
- \`rules/devrelay.md\` を作成/更新した
- CLAUDE.md を更新した
- 補助ファイルを作成した場合はその旨

質問は不要です。上記のタスクをそのまま実行してください。`;
