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

const CONFIG_DIR = path.join(os.homedir(), '.devrelay');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.yaml');
const PROJECTS_FILE = path.join(CONFIG_DIR, 'projects.yaml');

export async function ensureConfigDir() {
  try {
    await fs.mkdir(CONFIG_DIR, { recursive: true });
    await fs.mkdir(path.join(CONFIG_DIR, 'logs'), { recursive: true });
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
      projectsDirs = [os.homedir()];
    }

    return {
      machineName: config.machineName || `${os.hostname()}/${os.userInfo().username}`,
      machineId: config.machineId || '',
      serverUrl: config.serverUrl || 'wss://ribbon-re.jp/devrelay-api/ws/agent',
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
      serverUrl: 'wss://ribbon-re.jp/devrelay-api/ws/agent',
      token: '',
      projectsDirs: [os.homedir()],
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
