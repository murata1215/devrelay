import { useState, useEffect, useCallback } from 'react';

/** プロジェクト別の未処理会話数 */
interface ProjectCount {
  projectName: string;
  count: number;
}

/** レポート一覧アイテム */
interface ReportItem {
  id: string;
  projectName: string;
  title: string;
  status: 'generating' | 'completed' | 'failed';
  error: string | null;
  createdAt: string;
  entryCount: number;
}

/** API リクエスト用ヘルパー */
function getAuthHeaders(): HeadersInit {
  const token = localStorage.getItem('token');
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

export function DevReportsPage() {
  const [projects, setProjects] = useState<ProjectCount[]>([]);
  const [reports, setReports] = useState<ReportItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  /** データ取得 */
  const fetchData = useCallback(async () => {
    try {
      const headers = getAuthHeaders();
      const [projRes, repRes] = await Promise.all([
        fetch('/api/dev-reports/projects', { headers }),
        fetch('/api/dev-reports', { headers }),
      ]);

      if (projRes.ok) {
        const projData = await projRes.json();
        setProjects(projData.projects);
      }
      if (repRes.ok) {
        const repData = await repRes.json();
        setReports(repData.reports);
      }
    } catch (err) {
      setError('データの取得に失敗しました');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  /** 生成中のレポートをポーリング（5秒間隔） */
  useEffect(() => {
    const generatingReports = reports.filter((r) => r.status === 'generating');
    if (generatingReports.length === 0) return;

    const interval = setInterval(() => {
      fetchData();
    }, 5000);

    return () => clearInterval(interval);
  }, [reports, fetchData]);

  /** レポート生成を開始 */
  const handleCreate = async (projectName: string) => {
    setGenerating((prev) => new Set([...prev, projectName]));
    setError(null);

    try {
      const res = await fetch('/api/dev-reports', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ projectName }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || 'レポート生成の開始に失敗しました');
        return;
      }

      // データを再取得してリストに反映
      await fetchData();
    } catch {
      setError('レポート生成の開始に失敗しました');
    } finally {
      setGenerating((prev) => {
        const next = new Set(prev);
        next.delete(projectName);
        return next;
      });
    }
  };

  /** レポートを削除 */
  const handleDelete = async (reportId: string) => {
    if (!confirm('このレポートを削除しますか？')) return;

    try {
      const res = await fetch(`/api/dev-reports/${reportId}`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
      });

      if (res.ok) {
        await fetchData();
      }
    } catch {
      setError('削除に失敗しました');
    }
  };

  /** ZIP ダウンロード */
  const handleDownload = async (reportId: string) => {
    const token = localStorage.getItem('token');
    window.open(`/api/dev-reports/${reportId}/download?token=${token}`, '_blank');
  };

  /** 日時フォーマット */
  const formatDate = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString('ja-JP', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-400">Loading...</div>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-white mb-6">Dev Reports</h1>

      {error && (
        <div className="bg-red-900/50 border border-red-700 rounded-lg p-4 mb-6">
          <p className="text-red-300 text-sm">{error}</p>
        </div>
      )}

      {/* プロジェクトカード */}
      <div className="mb-8">
        <h2 className="text-lg font-semibold text-gray-300 mb-4">Projects</h2>
        {projects.length === 0 ? (
          <p className="text-gray-500 text-sm">No conversations found.</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {projects.map((proj) => (
              <div
                key={proj.projectName}
                className="bg-gray-800 border border-gray-700 rounded-lg p-4"
              >
                <h3 className="text-white font-medium mb-2 truncate" title={proj.projectName}>
                  {proj.projectName}
                </h3>
                <p className="text-gray-400 text-sm mb-3">
                  Unprocessed: <span className="text-yellow-400 font-medium">{proj.count}</span> conversations
                </p>
                <button
                  onClick={() => handleCreate(proj.projectName)}
                  disabled={proj.count === 0 || generating.has(proj.projectName)}
                  className={`w-full px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                    proj.count === 0
                      ? 'bg-gray-700 text-gray-500 cursor-not-allowed'
                      : generating.has(proj.projectName)
                        ? 'bg-blue-800 text-blue-300 cursor-wait'
                        : 'bg-blue-600 hover:bg-blue-500 text-white'
                  }`}
                >
                  {generating.has(proj.projectName) ? 'Starting...' : 'Create Report'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* レポート一覧 */}
      <div>
        <h2 className="text-lg font-semibold text-gray-300 mb-4">Reports</h2>
        {reports.length === 0 ? (
          <p className="text-gray-500 text-sm">No reports yet. Create one from the project cards above.</p>
        ) : (
          <div className="space-y-3">
            {reports.map((report) => (
              <div
                key={report.id}
                className="bg-gray-800 border border-gray-700 rounded-lg p-4"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <h3 className="text-white font-medium truncate" title={report.title}>
                      {report.title}
                    </h3>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1 text-sm text-gray-400">
                      <span className="text-gray-500">{report.projectName}</span>
                      <span>{formatDate(report.createdAt)}</span>
                      <span>{report.entryCount} conversations</span>
                      {report.status === 'generating' && (
                        <span className="text-yellow-400 flex items-center gap-1">
                          <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                          </svg>
                          Generating...
                        </span>
                      )}
                      {report.status === 'completed' && (
                        <span className="text-green-400">Completed</span>
                      )}
                      {report.status === 'failed' && (
                        <span className="text-red-400" title={report.error || ''}>
                          Failed
                        </span>
                      )}
                    </div>
                    {report.status === 'failed' && report.error && (
                      <p className="text-red-400 text-xs mt-1 truncate" title={report.error}>
                        {report.error}
                      </p>
                    )}
                  </div>

                  <div className="flex items-center gap-2 flex-shrink-0">
                    {report.status === 'completed' && (
                      <button
                        onClick={() => handleDownload(report.id)}
                        className="px-3 py-1.5 bg-green-700 hover:bg-green-600 text-white text-sm rounded-md transition-colors"
                      >
                        Download ZIP
                      </button>
                    )}
                    <button
                      onClick={() => handleDelete(report.id)}
                      className="px-3 py-1.5 bg-gray-700 hover:bg-red-700 text-gray-300 hover:text-white text-sm rounded-md transition-colors"
                    >
                      Delete
                    </button>
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
