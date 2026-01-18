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
        <div className="text-gray-400">Loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-500/20 border border-red-500 text-red-400 px-4 py-3 rounded">
        {error}
      </div>
    );
  }

  if (!stats) return null;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-white">Dashboard</h1>

      {/* Stats cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-gray-800 rounded-lg p-6">
          <div className="text-gray-400 text-sm">Machines</div>
          <div className="text-2xl font-bold text-white">
            {stats.machines.online}/{stats.machines.total}
          </div>
          <div className="text-green-400 text-sm">online</div>
        </div>

        <div className="bg-gray-800 rounded-lg p-6">
          <div className="text-gray-400 text-sm">Projects</div>
          <div className="text-2xl font-bold text-white">{stats.projects}</div>
        </div>

        <div className="bg-gray-800 rounded-lg p-6">
          <div className="text-gray-400 text-sm">Sessions</div>
          <div className="text-2xl font-bold text-white">{stats.sessions}</div>
        </div>
      </div>

      {/* Recent sessions */}
      <div className="bg-gray-800 rounded-lg p-6">
        <h2 className="text-lg font-semibold text-white mb-4">Recent Sessions</h2>
        {stats.recentSessions.length === 0 ? (
          <p className="text-gray-400">No recent sessions</p>
        ) : (
          <div className="space-y-3">
            {stats.recentSessions.map((session) => (
              <div
                key={session.id}
                className="flex items-center justify-between py-2 border-b border-gray-700 last:border-0"
              >
                <div>
                  <div className="text-white font-medium">{session.projectName}</div>
                  <div className="text-gray-400 text-sm">
                    {session.machineName} - {session.aiTool}
                  </div>
                </div>
                <div className="text-right">
                  <div
                    className={`text-sm ${
                      session.status === 'active' ? 'text-green-400' : 'text-gray-400'
                    }`}
                  >
                    {session.status}
                  </div>
                  <div className="text-gray-500 text-xs">
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
