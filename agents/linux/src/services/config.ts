import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import yaml from 'yaml';
import type { AiTool, ProxyConfig } from '@devrelay/shared';

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
  };
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  proxy?: ProxyConfig;  // プロキシ設定（オプション）
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
    };
  }
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
