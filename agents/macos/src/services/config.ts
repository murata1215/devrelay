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
   * プロジェクト一覧の実在チェック（幽霊エントリ除外）。既定 true。
   * true の場合、`projects.yaml` に登録されているがディスク上から削除された
   * （かつ親ディレクトリは存在する＝未マウントではないと判断できる）プロジェクトを
   * 一覧送信の対象から除外する。false にすると従来どおり yaml の内容をそのまま送信する。
   */
  projectExistenceFilter?: boolean;
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
 * デフォルトプロジェクトスキャンディレクトリ（macOS 版）
 * macOS ではホームディレクトリのみ（/opt は一般的でない）
 */
function getDefaultProjectsDirs(): string[] {
  return [os.homedir()];
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
      projectExistenceFilter: config.projectExistenceFilter,  // 未設定なら undefined（呼び出し側で !== false 判定 → 既定 true）
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

    // PATH（command -v）→ 既知パス（~/.local/bin, /opt/homebrew/bin 等）の順で探す
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
