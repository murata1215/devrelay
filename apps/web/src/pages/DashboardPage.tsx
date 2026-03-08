import { useEffect, useState } from 'react';
import { dashboard } from '../lib/api';
import type { DashboardStats } from '../lib/api';

export function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const loadStats = async () => {
      try {
        const data = await dashboard.stats();
        setStats(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load stats');
      } finally {
        setLoading(false);
      }
    };

    loadStats();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-[var(--text-muted)]">Loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-[var(--bg-danger)] border border-[var(--border-danger)] text-[var(--text-danger)] px-4 py-3 rounded">
        {error}
      </div>
    );
  }

  if (!stats) return null;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-[var(--text-primary)]">Dashboard</h1>

      {/* Stats cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        <div className="bg-[var(--bg-secondary)] rounded-lg p-4 sm:p-6">
          <div className="text-[var(--text-muted)] text-xs sm:text-sm">Agents</div>
          <div className="text-xl sm:text-2xl font-bold text-[var(--text-primary)]">
            {stats.machines.online}/{stats.machines.total}
          </div>
          <div className="text-[var(--text-success)] text-xs sm:text-sm">online</div>
        </div>

        <div className="bg-[var(--bg-secondary)] rounded-lg p-4 sm:p-6">
          <div className="text-[var(--text-muted)] text-xs sm:text-sm">Projects</div>
          <div className="text-xl sm:text-2xl font-bold text-[var(--text-primary)]">{stats.projects}</div>
        </div>

        <div className="bg-[var(--bg-secondary)] rounded-lg p-4 sm:p-6 col-span-2 sm:col-span-1">
          <div className="text-[var(--text-muted)] text-xs sm:text-sm">Sessions</div>
          <div className="text-xl sm:text-2xl font-bold text-[var(--text-primary)]">{stats.sessions}</div>
        </div>
      </div>

      {/* Recent sessions */}
      <div className="bg-[var(--bg-secondary)] rounded-lg p-4 sm:p-6">
        <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-4">Recent Sessions</h2>
        {stats.recentSessions.length === 0 ? (
          <p className="text-[var(--text-muted)]">No recent sessions</p>
        ) : (
          <div className="space-y-3">
            {stats.recentSessions.map((session) => (
              <div
                key={session.id}
                className="flex flex-col sm:flex-row sm:items-center sm:justify-between py-2 border-b border-[var(--border-color)] last:border-0 gap-1"
              >
                <div>
                  <div className="text-[var(--text-primary)] font-medium text-sm sm:text-base">{session.projectName}</div>
                  <div className="text-[var(--text-muted)] text-xs sm:text-sm">
                    {session.machineDisplayName ?? session.machineName} - {session.aiTool}
                  </div>
                </div>
                <div className="sm:text-right flex sm:flex-col items-center sm:items-end gap-2 sm:gap-0">
                  <div
                    className={`text-xs sm:text-sm ${
                      session.status === 'active' ? 'text-[var(--text-success)]' : 'text-[var(--text-muted)]'
                    }`}
                  >
                    {session.status}
                  </div>
                  <div className="text-[var(--text-faint)] text-xs">
                    {new Date(session.startedAt).toLocaleString()}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
