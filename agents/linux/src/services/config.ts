import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import yaml from 'yaml';
import type { AiTool, ProxyConfig } from '@devrelay/shared';
import { isAiToolPresent, resolveAiToolFallbackPath } from './ai-tool-probe.js';
import { pickReplacementDefaultAiTool, decideAiToolPathSelfHeal } from './ai-tool-presence.js';

export interface AgentConfig {
  machineName: string;
  machineId: string;
  serverUrl: string;
  token: string;
  projectsDirs: string[];  // 複数ディレクトリ対応
  aiTools: {
    default: AiTool;
    claude?: { command: string };
    gemini?: { command: string };
    codex?: { command: string };
    aider?: { command: string };
    devin?: {
      command: string;
      /** #277: Devin の実行時間上限（分）。未設定=15、0=無制限。課金暴走の抑止用 */
      maxRuntimeMinutes?: number;
      /** #277: ATIF ステップ数上限。未設定/0=無効（--export 対応版のみ機能） */
      maxSteps?: number;
    };
  };
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  proxy?: ProxyConfig;  // プロキシ設定（オプション）
  /**
   * プロジェクト自動検出の所有者フィルタ（#322）。既定 true。
   * true の場合、CLAUDE.md 等のマーカーファイルが Agent 実行ユーザーの所有でない
   * プロジェクトを検出・一覧送信の対象から除外する（`/opt` 等の複数ユーザー共有環境向け）。
   * false にすると従来どおり全ユーザーのプロジェクトを検出する。
   */
  projectOwnerFilter?: boolean;
  /**
   * プロジェクト一覧の実在チェック（幽霊エントリ除外）。既定 true。
   * true の場合、`projects.yaml` に登録されているがディスク上から削除された
   * （かつ親ディレクトリは存在する＝未マウントではないと判断できる）プロジェクトを
   * 一覧送信の対象から除外する。false にすると従来どおり yaml の内容をそのまま送信する。
   */
  projectExistenceFilter?: boolean;
  /**
   * サイクル SB-1a-1: Sandbox 実行（仮想アカウント + 外向き通信制限、Windows + claude のみ）の
   * マシン単位のローカル設定。
   *
   * サイクル SB-1a-2 でチャット経路（`ai-runner.ts` の単一判定点、`decideSandboxTarget()`）にも
   * 配線した。`projects` は「このマシンで Sandbox 実行の対象にするプロジェクトの絶対パス」を
   * 兼ねる（`devrelay sandbox status`/`selftest` の対象確認にも、チャットでの実際の起動判定にも
   * 同じキーを使う。SB-1a-1 時点で検討した `selftestProjects` への改名は行わない — selftest は
   * `--project` で明示指定するため改名の必要が無く、キー名を増やすと混乱するため）。
   * 空/未設定なら全ターンが対象外（既定）。SB-1b で `Project.sandbox`（DB・プロジェクト単位）を
   * 導入する際は、本フィールドと DB のどちらが優先かを別途 Plan で決める。
   */
  sandbox?: {
    /** このマシンで Sandbox 実行の対象にするプロジェクトの絶対パス一覧（未設定/空なら対象外） */
    projects?: string[];
    /** `host` または `host:port` 形式。未指定なら `DEFAULT_SANDBOX_ALLOWLIST` を使う */
    allowlist?: string[];
  };
}

export interface ProjectConfig {
  name: string;
  path: string;
  defaultAi: AiTool;
}

/**
 * OS 別の設定ディレクトリ
 * Windows: %APPDATA%\devrelay\  (例: C:\Users\name\AppData\Roaming\devrelay)
 * Linux/Mac: ~/.devrelay/
 */
const CONFIG_DIR = process.platform === 'win32'
  ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'devrelay')
  : path.join(os.homedir(), '.devrelay');

const CONFIG_FILE = path.join(CONFIG_DIR, 'config.yaml');
const PROJECTS_FILE = path.join(CONFIG_DIR, 'projects.yaml');

/**
 * OS 別のデフォルトプロジェクトスキャンディレクトリ
 * Windows: ホームディレクトリのみ（/opt は存在しない）
 * Linux: ホームディレクトリ + /opt
 */
function getDefaultProjectsDirs(): string[] {
  if (process.platform === 'win32') {
    return [os.homedir()];
  }
  return [os.homedir(), '/opt'];
}

export async function ensureConfigDir() {
  try {
    await fs.mkdir(CONFIG_DIR, { recursive: true });
    await fs.mkdir(path.join(CONFIG_DIR, 'logs'), { recursive: true });
    await fs.mkdir(path.join(CONFIG_DIR, 'bin'), { recursive: true });
  } catch (err) {
    // Ignore if exists
  }
}

export async function loadConfig(): Promise<AgentConfig> {
  await ensureConfigDir();

  try {
    const content = await fs.readFile(CONFIG_FILE, 'utf-8');
    const config = yaml.parse(content) as any;

    // 後方互換: projectsDir (単数) と projectsDirs (複数) の両方をサポート
    let projectsDirs: string[] = [];
    if (config.projectsDirs && Array.isArray(config.projectsDirs)) {
      projectsDirs = config.projectsDirs;
    } else if (config.projectsDir) {
      projectsDirs = [config.projectsDir];
    } else {
      projectsDirs = getDefaultProjectsDirs();
    }

    return {
      machineName: config.machineName || `${os.hostname()}/${os.userInfo().username}`,
      machineId: config.machineId || '',
      serverUrl: config.serverUrl || 'wss://devrelay.io/ws/agent',
      token: config.token || '',
      projectsDirs,
      aiTools: config.aiTools || {
        default: 'claude',
        claude: { command: 'claude' },
        gemini: { command: 'gemini' },
      },
      logLevel: config.logLevel || 'info',
      proxy: config.proxy,  // プロキシ設定を読み込み
      projectOwnerFilter: config.projectOwnerFilter,  // 未設定なら undefined（呼び出し側で !== false 判定 → 既定 true）
      projectExistenceFilter: config.projectExistenceFilter,  // 未設定なら undefined（呼び出し側で !== false 判定 → 既定 true）
      sandbox: config.sandbox,  // サイクル SB-1a-1: Sandbox 実行のローカル設定（未配線）
    };
  } catch (err) {
    // Return default config
    return {
      machineName: `${os.hostname()}/${os.userInfo().username}`,
      machineId: '',
      serverUrl: 'wss://devrelay.io/ws/agent',
      token: '',
      projectsDirs: getDefaultProjectsDirs(),
      aiTools: {
        default: 'claude',
        claude: { command: 'claude' },
      },
      logLevel: 'info',
      proxy: undefined,
      projectOwnerFilter: undefined,
      projectExistenceFilter: undefined,
    };
  }
}

/** 自動検出対象の AI ツール一覧（コマンド名とキー名の対応） */
const KNOWN_AI_TOOLS: { name: AiTool; command: string }[] = [
  { name: 'claude', command: 'claude' },
  { name: 'gemini', command: 'gemini' },
  { name: 'codex', command: 'codex' },
  { name: 'aider', command: 'aider' },
  { name: 'devin', command: 'devin' },
];

/**
 * PATH 上の AI ツールを自動検出し、config.aiTools に存在しないものを追加する。
 *
 * - 既存の設定（カスタムコマンドパス等）は上書きしない。ただし 2026-10-27
 *   `chatgpt-user` 障害の根治として、素のコマンド名のまま PATH で解決できなくなった
 *   既存エントリだけは、フォールバック候補に実在すれば絶対パスへ自己修復する
 *   （`decideAiToolPathSelfHeal()` 参照。ユーザーが明示した絶対パスは対象外）
 * - 検出なしのツールでも既存設定があれば削除しない（オフライン環境対応）
 * - 変更があった場合のみ config.yaml に保存
 *
 * @returns 新しいツールが検出されたかどうか
 */
export async function detectAndUpdateAiTools(config: AgentConfig): Promise<boolean> {
  let updated = false;

  for (const { name, command } of KNOWN_AI_TOOLS) {
    const existing = config.aiTools[name];
    if (existing) {
      // 2026-10-27 `chatgpt-user` 障害の根治: 既存エントリの自己修復（他フィールドは保持）
      const healed = decideAiToolPathSelfHeal(existing.command, resolveAiToolFallbackPath(name, existing.command));
      if (healed) {
        config.aiTools[name] = { ...existing, command: healed };
        console.log(`🔧 Self-healed ${name} CLI path: '${existing.command}' → '${healed}' (not on PATH, found via fallback)`);
        updated = true;
      }
      continue;
    }

    // PATH（where / command -v、#350 の windowsHide 済み）→ 既知パス（~/.local/bin 等）の順で探す。
    // 従来は which のみで、PATH に無い ~/.local/bin/devin 等を拾えなかった。
    // 2026-10-27: フォールバック候補でのみ見つかった場合はその絶対パスを保存する
    // （PATH で引ける場合は従来どおり素の名前のまま。ツール更新でパスが変わっても壊れないように）。
    if (isAiToolPresent(name, command)) {
      const fallbackPath = resolveAiToolFallbackPath(name, command);
      config.aiTools[name] = { command: fallbackPath ?? command };
      console.log(`🔍 Detected ${name} CLI → added to config${fallbackPath ? ` (absolute path: ${fallbackPath})` : ''}`);
      updated = true;
    }
  }

  // aiTools.default が実在しないツール（インストーラが AI CLI を検出できず書いた `claude` 等）を指していて、
  // 他に実在するツールがあれば差し替える。新規自動登録プロジェクトの defaultAi もこれに揃う。
  const configured = KNOWN_AI_TOOLS.map((t) => t.name).filter((n) => config.aiTools[n]);
  const present = configured.filter((n) => isAiToolPresent(n, config.aiTools[n]?.command));
  const replacement = pickReplacementDefaultAiTool(config.aiTools.default, present);
  if (replacement) {
    console.log(`🔍 aiTools.default '${config.aiTools.default}' is not installed → switched to '${replacement}'`);
    config.aiTools.default = replacement as AiTool;
    updated = true;
  }

  if (updated) {
    await saveConfig(config);
  }
  return updated;
}

export async function saveConfig(config: AgentConfig) {
  await ensureConfigDir();
  const content = yaml.stringify(config);
  await fs.writeFile(CONFIG_FILE, content, 'utf-8');
}

export async function loadProjectsConfig(): Promise<ProjectConfig[]> {
  try {
    const content = await fs.readFile(PROJECTS_FILE, 'utf-8');
    const data = yaml.parse(content);
    return data.projects || [];
  } catch (err) {
    return [];
  }
}

export async function saveProjectsConfig(projects: ProjectConfig[]) {
  await ensureConfigDir();
  const content = yaml.stringify({ projects });
  await fs.writeFile(PROJECTS_FILE, content, 'utf-8');
}

export function getConfigDir() {
  return CONFIG_DIR;
}

export function getLogDir() {
  return path.join(CONFIG_DIR, 'logs');
}

/**
 * devrelay-claude ラッパー/シンボリックリンク格納ディレクトリを返す
 * @returns bin ディレクトリのパス
 */
export function getBinDir() {
  return path.join(CONFIG_DIR, 'bin');
}

/**
 * サイクル SB-1a-1: Sandbox トークン（`claude setup-token` で発行した専用トークン）の保存先。
 * 書き込み後は `icacls /inheritance:r /grant <本人>:(R,W)` で開発者本人のみに制限する
 * （`devrelay sandbox set-token` が行う）。
 */
export function getSandboxTokenPath() {
  return path.join(CONFIG_DIR, 'sandbox-token');
}

/**
 * サイクル SB-1a-1: Sandbox Host（管理者用インストールスクリプトが作成）の共有ディレクトリ。
 * 秘密鍵は仮想アカウントのみが読める DACL、公開鍵は誰でも読める（Agent はここから公開鍵だけ読む）。
 * win32 専用パス固定（Sandbox は Windows 専用機能のため、他 OS での呼び出しは呼び出し側の誤り）。
 */
export function getSandboxProgramDataDir() {
  return 'C:\\ProgramData\\devrelay\\sandbox';
}

/** Sandbox Host の公開鍵ファイルパス（署名検証に使う。誰でも読める） */
export function getSandboxPublicKeyPath() {
  return `${getSandboxProgramDataDir()}\\host-key.pub`;
}

/** 仮想アカウント専用の固定ホームディレクトリ（HOME/APPDATA/TEMP 等を固定する先） */
export function getSandboxHomeDir() {
  return `${getSandboxProgramDataDir()}\\home`;
}
