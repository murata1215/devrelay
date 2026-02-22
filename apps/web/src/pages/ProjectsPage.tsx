import { useEffect, useState } from 'react';
import { projects, history } from '../lib/api';
import type { Project } from '../lib/api';

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
      <div className="bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4 max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold text-white">History Export</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="text-gray-400 text-sm mb-4">{project.name}</div>

        {loading ? (
          <div className="text-center py-8 text-gray-400">Loading...</div>
        ) : error ? (
          <div className="bg-red-500/20 border border-red-500 text-red-400 px-4 py-3 rounded">
            {error}
          </div>
        ) : dates.length === 0 ? (
          <div className="text-center py-8 text-gray-400">No history available</div>
        ) : (
          <div className="space-y-2">
            {dates.map((date) => (
              <button
                key={date}
                onClick={() => handleDownload(date)}
                className="w-full flex items-center justify-between px-4 py-3 bg-gray-700 hover:bg-gray-600 rounded-lg transition-colors"
              >
                <span className="text-white">{date}</span>
                <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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

export function ProjectsPage() {
  const [data, setData] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const result = await projects.list();
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

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-white">Projects</h1>

      {data.length === 0 ? (
        <div className="bg-gray-800 rounded-lg p-6 text-center">
          <p className="text-gray-400">No projects found.</p>
          <p className="text-gray-500 text-sm mt-2">
            Projects are automatically detected when they contain a <code className="bg-gray-700 px-2 py-1 rounded">CLAUDE.md</code> file.
          </p>
        </div>
      ) : (
        <>
          {/* Desktop table view */}
          <div className="hidden md:block bg-gray-800 rounded-lg overflow-hidden">
            <table className="min-w-full divide-y divide-gray-700">
              <thead className="bg-gray-700/50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">
                    Project
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">
                    Machine
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">
                    Path
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">
                    Last Used
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-700">
                {data.map((project) => (
                  <tr key={project.id}>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <button
                        onClick={() => setSelectedProject(project)}
                        className="text-blue-400 hover:text-blue-300 font-medium hover:underline"
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
                          <span className="text-gray-300">{project.machine.displayName ?? project.machine.name}</span>
                        </div>
                      )}
                    </td>
                    <td className="px-6 py-4">
                      <code className="text-gray-400 text-sm">{project.path}</code>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-gray-400 text-sm">
                      {project.lastUsedAt
                        ? new Date(project.lastUsedAt).toLocaleString()
                        : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile card view */}
          <div className="md:hidden space-y-4">
            {data.map((project) => (
              <div key={project.id} className="bg-gray-800 rounded-lg p-4">
                <div className="flex items-center justify-between mb-2">
                  <button
                    onClick={() => setSelectedProject(project)}
                    className="text-blue-400 hover:text-blue-300 font-medium hover:underline"
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
                      <span className="text-gray-300 text-sm">{project.machine.displayName ?? project.machine.name}</span>
                    </div>
                  )}
                </div>
                <code className="text-gray-400 text-xs break-all">{project.path}</code>
                {project.lastUsedAt && (
                  <div className="text-gray-500 text-xs mt-2">
                    Last used: {new Date(project.lastUsedAt).toLocaleString()}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {selectedProject && (
        <HistoryModal
          project={selectedProject}
          onClose={() => setSelectedProject(null)}
        />
      )}
    </div>
  );
}
