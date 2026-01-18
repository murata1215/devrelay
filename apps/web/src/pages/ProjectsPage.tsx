import { useEffect, useState } from 'react';
import { projects } from '../lib/api';
import type { Project } from '../lib/api';

export function ProjectsPage() {
  const [data, setData] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

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
        <div className="bg-gray-800 rounded-lg overflow-hidden">
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
                    <div className="text-white font-medium">{project.name}</div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    {project.machine && (
                      <div className="flex items-center space-x-2">
                        <span
                          className={`w-2 h-2 rounded-full ${
                            project.machine.online ? 'bg-green-400' : 'bg-gray-400'
                          }`}
                        />
                        <span className="text-gray-300">{project.machine.name}</span>
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
      )}
    </div>
  );
}
