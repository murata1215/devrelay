import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import yaml from 'yaml';
import { execSync } from 'child_process';
import type { AiTool, ProxyConfig } from '@devrelay/shared';

export interface AgentConfig {
  machineName: string;
  machineId: string;
  serverUrl: string;
  token: string;
  projectsDirs: string[];  // Multiple directory support
  aiTools: {
    default: AiTool;
    claude?: { command: string };
    gemini?: { command: string };
    codex?: { command: string };
    aider?: { command: string };
    devin?: { command: string };
  };
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  proxy?: ProxyConfig;  // Proxy configuration (optional)
  preventSleep?: boolean;  // Prevent Windows sleep while connected (optional)
}

export interface ProjectConfig {
  name: string;
  path: string;
  defaultAi: AiTool;
}

// Windows: %APPDATA%\devrelay\
// Linux/Mac: ~/.devrelay/
const CONFIG_DIR = process.platform === 'win32'
  ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'devrelay')
  : path.join(os.homedir(), '.devrelay');

const CONFIG_FILE = path.join(CONFIG_DIR, 'config.yaml');
const PROJECTS_FILE = path.join(CONFIG_DIR, 'projects.yaml');

// Default projects directories for Windows
function getDefaultProjectsDirs(): string[] {
  const dirs: string[] = [os.homedir()];

  // Add Documents folder if it exists
  const documentsPath = path.join(os.homedir(), 'Documents');
  if (process.platform === 'win32') {
    dirs.push(documentsPath);
  }

  return dirs;
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

    // Backward compatibility: support both projectsDir (singular) and projectsDirs (plural)
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
      proxy: config.proxy,  // Load proxy configuration
      preventSleep: config.preventSleep ?? false,  // Load sleep prevention setting
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
      preventSleep: false,
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
 * - 既存の設定（カスタムコマンドパス等）は上書きしない
 * - 検出なしのツールでも既存設定があれば削除しない（オフライン環境対応）
 * - 変更があった場合のみ config.yaml に保存
 *
 * @returns 新しいツールが検出されたかどうか
 */
export async function detectAndUpdateAiTools(config: AgentConfig): Promise<boolean> {
  const findCmd = 'where';
  let updated = false;

  for (const { name, command } of KNOWN_AI_TOOLS) {
    if (config.aiTools[name]) continue;

    try {
      execSync(`${findCmd} ${command}`, { stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 });
      config.aiTools[name] = { command };
      console.log(`Detected ${name} CLI -> added to config`);
      updated = true;
    } catch {
      // コマンドなし → 何もしない
    }
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

export function getBinDir() {
  return path.join(CONFIG_DIR, 'bin');
}
