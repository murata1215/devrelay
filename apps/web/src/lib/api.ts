const API_BASE = '/devrelay-api/api';

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

// マシンAPI
export interface Machine {
  id: string;
  name: string;
  status: 'online' | 'offline';
  lastSeenAt: string | null;
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
    online: boolean;
  };
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

  async create(name: string): Promise<MachineCreateResponse> {
    return request('POST', '/machines', { name });
  },

  async delete(id: string): Promise<void> {
    await request('DELETE', `/machines/${id}`);
  },
};

export const projects = {
  async list(): Promise<Project[]> {
    return request('GET', '/projects');
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
    return request('POST', '/services/restart/server');
  },

  async restartAgent(): Promise<{ success: boolean; message: string }> {
    return request('POST', '/services/restart/agent');
  },
};
