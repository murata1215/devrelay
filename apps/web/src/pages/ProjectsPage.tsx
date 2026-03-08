import { useEffect, useState } from 'react';
import { projects, history } from '../lib/api';
import type { Project, BuildLogItem } from '../lib/api';

/** 日付を M/D 形式にフォーマット */
function formatShortDate(dateStr: string): string {
  const d = new Date(dateStr);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** サマリーを指定文字数で切り詰め */
function truncateSummary(summary: string, maxLen: number): string {
  if (summary.length <= maxLen) return summary;
  return summary.slice(0, maxLen) + '...';
}

/** 会話履歴エクスポートモーダル */
interface HistoryModalProps {
  project: Project;
  onClose: () => void;
}

function HistoryModal({ project, onClose }: HistoryModalProps) {
  const [dates, setDates] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const load = async () => {
      try {
        const result = await history.getDates(project.id);
        setDates(result.dates);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load history dates');
      } finally {
        setLoading(false);
      }
    };

    load();
  }, [project.id]);

  const handleDownload = (date: string) => {
    const url = history.getDownloadUrl(project.id, date);
    window.open(url, '_blank');
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-[var(--bg-secondary)] rounded-lg p-6 max-w-md w-full mx-4 max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold text-[var(--text-primary)]">History Export</h2>
          <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="text-[var(--text-muted)] text-sm mb-4">{project.name}</div>

        {loading ? (
          <div className="text-center py-8 text-[var(--text-muted)]">Loading...</div>
        ) : error ? (
          <div className="bg-[var(--bg-danger)] border border-[var(--border-danger)] text-[var(--text-danger)] px-4 py-3 rounded">
            {error}
          </div>
        ) : dates.length === 0 ? (
          <div className="text-center py-8 text-[var(--text-muted)]">No history available</div>
        ) : (
          <div className="space-y-2">
            {dates.map((date) => (
              <button
                key={date}
                onClick={() => handleDownload(date)}
                className="w-full flex items-center justify-between px-4 py-3 bg-[var(--bg-tertiary)] hover:bg-[var(--bg-hover)] rounded-lg transition-colors"
              >
                <span className="text-[var(--text-primary)]">{date}</span>
                <svg className="w-5 h-5 text-[var(--text-muted)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** ビルド履歴モーダル - プロジェクトのビルドログ一覧を表示 */
interface BuildHistoryModalProps {
  project: Project;
  onClose: () => void;
}

function BuildHistoryModal({ project, onClose }: BuildHistoryModalProps) {
  const [builds, setBuilds] = useState<BuildLogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  /** 展開中のビルド番号（クリックで全文表示） */
  const [expandedBuild, setExpandedBuild] = useState<number | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const result = await projects.getBuildLogs(project.id);
        setBuilds(result.builds);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load build history');
      } finally {
        setLoading(false);
      }
    };

    load();
  }, [project.id]);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-[var(--bg-secondary)] rounded-lg p-6 max-w-2xl w-full mx-4 max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold text-[var(--text-primary)]">Build History</h2>
          <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="text-[var(--text-muted)] text-sm mb-4">{project.name}</div>

        {loading ? (
          <div className="text-center py-8 text-[var(--text-muted)]">Loading...</div>
        ) : error ? (
          <div className="bg-[var(--bg-danger)] border border-[var(--border-danger)] text-[var(--text-danger)] px-4 py-3 rounded">
            {error}
          </div>
        ) : builds.length === 0 ? (
          <div className="text-center py-8 text-[var(--text-muted)]">No builds yet</div>
        ) : (
          <div className="space-y-2">
            {builds.map((build) => {
              const isExpanded = expandedBuild === build.buildNumber;
              return (
                <button
                  key={build.buildNumber}
                  onClick={() => setExpandedBuild(isExpanded ? null : build.buildNumber)}
                  className="w-full text-left px-4 py-3 bg-[var(--bg-tertiary)] hover:bg-[var(--bg-hover)] rounded-lg transition-colors"
                >
                  {/* ヘッダー行: ビルド番号、日付、マシン名 */}
                  <div className="flex items-center gap-3 text-sm">
                    <span className="text-[var(--text-link)] font-mono font-medium">#{build.buildNumber}</span>
                    <span className="text-[var(--text-muted)]">{new Date(build.createdAt).toLocaleString()}</span>
                    <span className="text-[var(--text-faint)]">{build.machineName}</span>
                  </div>
                  {/* サマリー: 展開時は全文、折りたたみ時は先頭80文字 */}
                  <div className={`mt-1 text-[var(--text-secondary)] text-sm ${isExpanded ? 'whitespace-pre-wrap' : 'truncate'}`}>
                    {isExpanded ? build.summary : truncateSummary(build.summary, 80)}
                  </div>
                  {/* プロンプト: 展開時のみ表示 */}
                  {isExpanded && build.prompt && (
                    <div className="mt-2 text-xs text-[var(--text-faint)] border-t border-[var(--border-color)] pt-2">
                      <span className="text-[var(--text-faint)] font-medium">Prompt:</span> {build.prompt}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export function ProjectsPage() {
  const [data, setData] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  /** 会話履歴エクスポート用の選択プロジェクト */
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  /** ビルド履歴モーダル用の選択プロジェクト */
  const [buildProject, setBuildProject] = useState<Project | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const result = await projects.list();
        // latestBuild.createdAt の降順でソート（ビルドなしは末尾に配置）
        result.sort((a, b) => {
          if (!a.latestBuild && !b.latestBuild) return 0;
          if (!a.latestBuild) return 1;
          if (!b.latestBuild) return -1;
          return new Date(b.latestBuild.createdAt).getTime() - new Date(a.latestBuild.createdAt).getTime();
        });
        setData(result);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load projects');
      } finally {
        setLoading(false);
      }
    };

    load();
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

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-[var(--text-primary)]">Projects</h1>

      {data.length === 0 ? (
        <div className="bg-[var(--bg-secondary)] rounded-lg p-6 text-center">
          <p className="text-[var(--text-muted)]">No projects found.</p>
          <p className="text-[var(--text-faint)] text-sm mt-2">
            Projects are automatically detected when they contain a <code className="bg-[var(--bg-tertiary)] px-2 py-1 rounded">CLAUDE.md</code> file.
          </p>
        </div>
      ) : (
        <>
          {/* デスクトップ テーブルビュー */}
          <div className="hidden md:block bg-[var(--bg-secondary)] rounded-lg overflow-hidden">
            <table className="min-w-full divide-y divide-[var(--border-color)]">
              <thead className="bg-[var(--bg-tertiary)]/50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider">
                    Project
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider">
                    Machine
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider">
                    Path
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider">
                    Latest Build
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border-color)]">
                {data.map((project) => (
                  <tr key={project.id}>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <button
                        onClick={() => setSelectedProject(project)}
                        className="text-[var(--text-link)] hover:opacity-80 font-medium hover:underline"
                        title="Click to export history"
                      >
                        {project.name}
                      </button>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      {project.machine && (
                        <div className="flex items-center space-x-2">
                          <span
                            className={`w-2 h-2 rounded-full ${
                              project.machine.online ? 'bg-green-400' : 'bg-gray-400'
                            }`}
                          />
                          <span className="text-[var(--text-secondary)]">{project.machine.displayName ?? project.machine.name}</span>
                        </div>
                      )}
                    </td>
                    <td className="px-6 py-4">
                      <code className="text-[var(--text-muted)] text-sm">{project.path}</code>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm">
                      {project.latestBuild ? (
                        <button
                          onClick={() => setBuildProject(project)}
                          className="text-[var(--text-link)] hover:opacity-80 hover:underline text-left"
                          title="Click to view build history"
                        >
                          <span>{formatShortDate(project.latestBuild.createdAt)}</span>
                          <span className="text-[var(--text-muted)] ml-2">
                            {truncateSummary(project.latestBuild.summary, 40)}
                          </span>
                        </button>
                      ) : (
                        <span className="text-[var(--text-faint)]">-</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* モバイル カードビュー */}
          <div className="md:hidden space-y-4">
            {data.map((project) => (
              <div key={project.id} className="bg-[var(--bg-secondary)] rounded-lg p-4">
                <div className="flex items-center justify-between mb-2">
                  <button
                    onClick={() => setSelectedProject(project)}
                    className="text-[var(--text-link)] hover:opacity-80 font-medium hover:underline"
                    title="Click to export history"
                  >
                    {project.name}
                  </button>
                  {project.machine && (
                    <div className="flex items-center space-x-2">
                      <span
                        className={`w-2 h-2 rounded-full ${
                          project.machine.online ? 'bg-green-400' : 'bg-gray-400'
                        }`}
                      />
                      <span className="text-[var(--text-secondary)] text-sm">{project.machine.displayName ?? project.machine.name}</span>
                    </div>
                  )}
                </div>
                <code className="text-[var(--text-muted)] text-xs break-all">{project.path}</code>
                {/* モバイル: 最新ビルド情報 */}
                {project.latestBuild ? (
                  <button
                    onClick={() => setBuildProject(project)}
                    className="block mt-2 text-left text-sm text-[var(--text-link)] hover:opacity-80 hover:underline"
                    title="Click to view build history"
                  >
                    <span className="text-[var(--text-faint)]">Build:</span>{' '}
                    <span>{formatShortDate(project.latestBuild.createdAt)}</span>{' '}
                    <span className="text-[var(--text-muted)]">{truncateSummary(project.latestBuild.summary, 30)}</span>
                  </button>
                ) : (
                  <div className="text-[var(--text-faint)] text-xs mt-2">No builds</div>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {/* 会話履歴エクスポートモーダル */}
      {selectedProject && (
        <HistoryModal
          project={selectedProject}
          onClose={() => setSelectedProject(null)}
        />
      )}

      {/* ビルド履歴モーダル */}
      {buildProject && (
        <BuildHistoryModal
          project={buildProject}
          onClose={() => setBuildProject(null)}
        />
      )}
    </div>
  );
}
