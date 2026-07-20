import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import type { ReactNode } from 'react';
import { org as orgApi, getToken } from '../lib/api';
import type { OrgInfo } from '../lib/api';

/**
 * 所属組織（エンタープライズモード）の状態を提供するコンテキスト。
 * ログイン後に GET /api/org/me を1回取得し、Layout のロゴ表示や
 * Settings の Enterprise セクションで参照する。
 */
interface OrganizationContextType {
  organization: OrgInfo | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

const OrganizationContext = createContext<OrganizationContextType | undefined>(undefined);

export function OrganizationProvider({ children }: { children: ReactNode }) {
  const [organization, setOrganization] = useState<OrgInfo | null>(null);
  const [loading, setLoading] = useState(true);

  // 組織情報を取得する（トークンがなければスキップ）
  const refresh = useCallback(async () => {
    if (!getToken()) {
      setOrganization(null);
      setLoading(false);
      return;
    }
    try {
      const { organization } = await orgApi.me();
      setOrganization(organization);
    } catch {
      setOrganization(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <OrganizationContext.Provider value={{ organization, loading, refresh }}>
      {children}
    </OrganizationContext.Provider>
  );
}

export function useOrganization() {
  const context = useContext(OrganizationContext);
  if (context === undefined) {
    throw new Error('useOrganization must be used within an OrganizationProvider');
  }
  return context;
}
