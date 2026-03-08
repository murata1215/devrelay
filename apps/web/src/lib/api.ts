// 開発環境ではViteのプロキシを使用（相対パス）、本番環境でも相対パスでOK（Caddyがリバースプロキシ）
const API_BASE = '/api';

// トークンをlocalStorageに保存
export function getToken(): string | null {
  return localStorage.getItem('token');
}

export function setToken(token: string): void {
  localStorage.setItem('token', token);
}

export function clearToken(): void {
  localStorage.removeItem('token');
}

// APIリクエストのヘルパー
async function request<T>(
  method: string,
  path: string,
  body?: object
): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

// 認証API
export interface User {
  id: string;
  email: string | null;
  name: string | null;
}

export interface AuthResponse {
  user: User;
  token: string;
}

export const auth = {
  async register(email: string, password: string, name?: string): Promise<AuthResponse> {
    return request('POST', '/auth/register', { email, password, name });
  },

  async login(email: string, password: string): Promise<AuthResponse> {
    return request('POST', '/auth/login', { email, password });
  },

  async logout(): Promise<void> {
    await request('POST', '/auth/logout', {});
    clearToken();
  },

  async me(): Promise<{ user: User }> {
    return request('GET', '/auth/me');
  },
};

// 管理コマンド型
export interface ManagementCommand {
  type: string;
  label: string;
  command: string;
}

export interface ManagementInfo {
  os: string;
  installType: string;
  commands: ManagementCommand[];
}

// マシンAPI
export interface Machine {
  id: string;
  name: string;
  displayName?: string | null;  // ホスト名エイリアスから自動計算された表示名
  status: 'online' | 'offline';
  lastSeenAt: string | null;
  managementInfo?: ManagementInfo | null;
  projectCount: number;
  projects: Project[];
}

export interface Project {
  id: string;
  name: string;
  path: string;
  lastUsedAt: string | null;
  machine?: {
    id: string;
    name: string;
    displayName?: string | null;
    online: boolean;
  };
  latestBuild?: {
    buildNumber: number;
    summary: string;
    createdAt: string;
  } | null;
}

/** ビルドログ一覧の各エントリ */
export interface BuildLogItem {
  buildNumber: number;
  summary: string;
  prompt?: string | null;
  createdAt: string;
  machineName: string;
}

export interface MachineCreateResponse {
  id: string;
  name: string;
  token: string;
  createdAt: string;
}

export const machines = {
  async list(): Promise<Machine[]> {
    return request('GET', '/machines');
  },

  /** エージェントを作成（名前はオプション、省略時はサーバーが仮名を自動生成） */
  async create(name?: string): Promise<MachineCreateResponse> {
    return request('POST', '/machines', name ? { name } : {});
  },

  async delete(id: string): Promise<void> {
    await request('DELETE', `/machines/${id}`);
  },

  /** 既存エージェントのトークンを取得 */
  async getToken(id: string): Promise<{ token: string }> {
    return request('GET', `/machines/${id}/token`);
  },

  /** ホスト名エイリアスを設定（同じホスト名の全マシンに一括適用） */
  async setHostnameAlias(hostname: string, alias: string): Promise<{ success: boolean; updatedCount: number }> {
    return request('PUT', '/machines/hostname-alias', { hostname, alias });
  },

  /** プロジェクト検索パスを取得（localProjectsDirs は Agent ローカル設定の参照値） */
  async getProjectsDirs(id: string): Promise<{ projectsDirs: string[] | null; localProjectsDirs: string[] | null }> {
    return request('GET', `/machines/${id}/projects-dirs`);
  },

  /** プロジェクト検索パスを更新し、Agent にリアルタイム配信 */
  async setProjectsDirs(id: string, projectsDirs: string[] | null): Promise<{ success: boolean }> {
    return request('PUT', `/machines/${id}/projects-dirs`, { projectsDirs });
  },
};

export const projects = {
  async list(): Promise<Project[]> {
    return request('GET', '/projects');
  },

  /** プロジェクトのビルドログ一覧を取得（降順、最大50件） */
  async getBuildLogs(projectId: string): Promise<{ builds: BuildLogItem[] }> {
    return request('GET', `/projects/${projectId}/builds`);
  },

  /** プロジェクト横断メッセージ履歴を取得（全セッション横断、カーソルベースページネーション） */
  async getMessages(projectId: string, opts?: { before?: string; limit?: number }): Promise<{ messages: SessionMessage[]; hasMore: boolean }> {
    const params = new URLSearchParams();
    if (opts?.before) params.set('before', opts.before);
    if (opts?.limit) params.set('limit', String(opts.limit));
    const q = params.toString() ? `?${params.toString()}` : '';
    return request('GET', `/projects/${projectId}/messages${q}`);
  },
};

// 設定API
export const settings = {
  async get(): Promise<Record<string, string>> {
    return request('GET', '/settings');
  },

  async update(key: string, value: string): Promise<void> {
    await request('PUT', `/settings/${key}`, { value });
  },

  async delete(key: string): Promise<void> {
    await request('DELETE', `/settings/${key}`);
  },

  /** サーバーからチャット表示設定を取得（chat_display キー） */
  async getChatDisplay(): Promise<string | null> {
    const all = await this.get();
    return all['chat_display'] ?? null;
  },

  /** チャット表示設定をサーバーに保存 */
  async saveChatDisplay(json: string): Promise<void> {
    await this.update('chat_display', json);
  },

  /** サーバーからピン止めタブ一覧を取得 */
  async getPinnedTabs(): Promise<string[]> {
    const all = await this.get();
    const raw = all['pinned_tabs'];
    if (!raw) return [];
    try { return JSON.parse(raw); } catch { return []; }
  },

  /** ピン止めタブ一覧をサーバーに保存 */
  async savePinnedTabs(projectIds: string[]): Promise<void> {
    await this.update('pinned_tabs', JSON.stringify(projectIds));
  },

  /** サーバーからタブ表示順序を取得 */
  async getTabOrder(): Promise<string[]> {
    const all = await this.get();
    const raw = all['tab_order'];
    if (!raw) return [];
    try { return JSON.parse(raw); } catch { return []; }
  },

  /** タブ表示順序をサーバーに保存 */
  async saveTabOrder(projectIds: string[]): Promise<void> {
    await this.update('tab_order', JSON.stringify(projectIds));
  },

  /** サーバーからタブカスタム名を取得 */
  async getTabNames(): Promise<Record<string, string>> {
    const all = await this.get();
    const raw = all['tab_names'];
    if (!raw) return {};
    try { return JSON.parse(raw); } catch { return {}; }
  },

  /** タブカスタム名をサーバーに保存 */
  async saveTabNames(names: Record<string, string>): Promise<void> {
    await this.update('tab_names', JSON.stringify(names));
  },
};

// Allowed Tools API（プランモード許可ツール）
export interface AllowedToolsOsData {
  tools: string[] | null;  // null = デフォルト使用
  defaults: string[];
}

export interface AllowedToolsResponse {
  linux: AllowedToolsOsData;
  windows: AllowedToolsOsData;
}

export const allowedTools = {
  /** 両 OS の allowedTools 設定を取得（カスタム値 + デフォルト値） */
  async get(): Promise<AllowedToolsResponse> {
    return request('GET', '/settings/allowed-tools');
  },

  /** 特定 OS の allowedTools を保存（null = デフォルトにリセット） */
  async update(os: 'linux' | 'windows', tools: string[] | null): Promise<{ success: boolean }> {
    return request('PUT', '/settings/allowed-tools', { os, tools });
  },
};

// Agreement テンプレート API
export interface AgreementTemplateResponse {
  template: string;
  isCustom: boolean;
  defaultTemplate: string;
}

export const agreementTemplate = {
  /** 現在のテンプレートを取得（カスタムまたはデフォルト） */
  async get(): Promise<AgreementTemplateResponse> {
    return request('GET', '/agreement-template');
  },

  /** カスタムテンプレートを保存 */
  async update(template: string): Promise<void> {
    await request('PUT', '/agreement-template', { template });
  },

  /** デフォルトにリセット */
  async reset(): Promise<{ success: boolean; template: string }> {
    return request('DELETE', '/agreement-template');
  },
};

// ダッシュボードAPI
export interface DashboardStats {
  machines: { total: number; online: number };
  projects: number;
  sessions: number;
  recentSessions: {
    id: string;
    projectName: string;
    machineName: string;
    machineDisplayName?: string | null;
    aiTool: string;
    status: string;
    startedAt: string;
    endedAt: string | null;
  }[];
}

export const dashboard = {
  async stats(): Promise<DashboardStats> {
    return request('GET', '/dashboard/stats');
  },
};

// プラットフォーム連携API
export interface LinkedPlatform {
  platform: string;
  platformUserId: string;
  platformName: string | null;
  linkedAt: string;
}

export interface LinkResult {
  success: boolean;
  platform: string;
  platformName?: string;
}

export const platforms = {
  async list(): Promise<LinkedPlatform[]> {
    return request('GET', '/platforms');
  },

  async link(code: string): Promise<LinkResult> {
    return request('POST', '/platforms/link', { code });
  },

  async unlink(platform: string): Promise<void> {
    await request('DELETE', `/platforms/${platform}`);
  },
};

// サービス管理API
export interface ServiceStatus {
  server: 'active' | 'inactive';
  agent: 'active' | 'inactive';
}

export const services = {
  async status(): Promise<ServiceStatus> {
    return request('GET', '/services/status');
  },

  async restartServer(): Promise<{ success: boolean; message: string }> {
    return request('POST', '/services/restart/server', {});
  },

  async restartAgent(): Promise<{ success: boolean; message: string }> {
    return request('POST', '/services/restart/agent', {});
  },
};

// 会話一覧API（Conversations ページ用）
/** メッセージに紐づくファイルのメタデータ（content は含まない） */
export interface MessageFileMeta {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  direction: 'input' | 'output';
}

export interface ConversationItem {
  messageId: string;
  sessionId: string;
  projectName: string;
  machineName: string;
  userMessage: string;
  aiMessage: string;
  model: string | null;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  createdAt: string;
  inputFiles: MessageFileMeta[];
  outputFiles: MessageFileMeta[];
}

export interface ConversationsResponse {
  conversations: ConversationItem[];
  total: number;
  offset: number;
  limit: number;
}

export const conversations = {
  async list(offset = 0, limit = 50): Promise<ConversationsResponse> {
    return request('GET', `/conversations?offset=${offset}&limit=${limit}`);
  },
};

// セッション履歴API（Chat タブ復元・メッセージ履歴用）
export interface ActiveSession {
  sessionId: string;
  projectId: string;
  projectName: string;
  machineId: string;
  machineDisplayName: string;
  machineOnline: boolean;
  messageCount: number;
  startedAt: string;
}

export interface SessionMessage {
  id: string;
  role: 'user' | 'ai' | 'system';
  content: string;
  createdAt: string;
  files: MessageFileMeta[];
}

export const sessions = {
  /** アクティブセッション一覧を取得（タブ復元用） */
  async getActive(limit?: number): Promise<{ sessions: ActiveSession[] }> {
    const q = limit ? `?limit=${limit}` : '';
    return request('GET', `/sessions/active${q}`);
  },

  /** セッションのメッセージ履歴を取得（カーソルベースページネーション） */
  async getMessages(sessionId: string, opts?: { before?: string; limit?: number }): Promise<{ messages: SessionMessage[]; hasMore: boolean }> {
    const params = new URLSearchParams();
    if (opts?.before) params.set('before', opts.before);
    if (opts?.limit) params.set('limit', String(opts.limit));
    const q = params.toString() ? `?${params.toString()}` : '';
    return request('GET', `/sessions/${sessionId}/messages${q}`);
  },

  /** Claude セッション推定情報を取得（5時間ギャップベース） */
  async getClaudeSession(sessionId: string): Promise<ClaudeSessionInfo> {
    return request('GET', `/sessions/${sessionId}/claude-session`);
  },
};

/** Claude セッション推定情報 */
export interface ClaudeSessionInfo {
  sessionStart: string | null;
  messageCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  elapsedMinutes: number;
  remainingMinutes: number;
}

// 履歴エクスポートAPI
export const history = {
  async getDates(projectId: string): Promise<{ dates: string[] }> {
    return request('GET', `/projects/${projectId}/history/dates`);
  },

  getDownloadUrl(projectId: string, date: string): string {
    const token = getToken();
    return `${API_BASE}/projects/${projectId}/history/${date}/download?token=${token}`;
  },
};
