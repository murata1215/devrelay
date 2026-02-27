import { useEffect, useState } from 'react';
import { conversations } from '../lib/api';
import type { ConversationItem, ConversationsResponse } from '../lib/api';

/** トークン数を K 単位で表示（例: 19963 → "20.0K"） */
function formatTokens(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toString();
}

/** ミリ秒を秒表示（例: 5234 → "5.2s"） */
function formatDuration(ms: number): string {
  if (ms <= 0) return '-';
  if (ms >= 60000) return (ms / 60000).toFixed(1) + 'm';
  return (ms / 1000).toFixed(1) + 's';
}

/** モデル名を短縮表示（例: "claude-opus-4-6" → "opus-4-6"） */
function shortModelName(model: string | null): string {
  if (!model) return '-';
  return model.replace(/^claude-/, '');
}

/** 文字列を指定文字数で切り詰め */
function truncate(text: string, maxLen: number): string {
  if (!text) return '';
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '...';
}

/** トークン合算（input + output + cacheRead + cacheCreation） */
function totalTokens(item: ConversationItem): number {
  return item.inputTokens + item.outputTokens + item.cacheReadTokens + item.cacheCreationTokens;
}

const PAGE_SIZE = 50;

export function ConversationsPage() {
  const [data, setData] = useState<ConversationsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [page, setPage] = useState(0);
  const [expandedRow, setExpandedRow] = useState<string | null>(null);

  const loadConversations = async () => {
    try {
      setLoading(true);
      const result = await conversations.list(page * PAGE_SIZE, PAGE_SIZE);
      setData(result);
      if (error) setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load conversations');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadConversations();
  }, [page]);

  const toggleRow = (messageId: string) => {
    setExpandedRow(expandedRow === messageId ? null : messageId);
  };

  if (loading && !data) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-white mb-6">Conversations</h1>
        <div className="text-gray-400">Loading...</div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-white mb-6">Conversations</h1>
        <div className="text-red-400">{error}</div>
      </div>
    );
  }

  const items = data?.conversations || [];
  const total = data?.total || 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold text-white mb-6">Conversations</h1>

      {items.length === 0 ? (
        <div className="bg-gray-800 rounded-lg p-8 text-center text-gray-400">
          No conversations yet. Usage data will appear here after sending prompts to AI.
        </div>
      ) : (
        <>
          {/* デスクトップ: テーブル表示 */}
          <div className="hidden md:block bg-gray-800 rounded-lg overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-700">
                  <th className="text-left text-gray-400 text-xs font-medium px-4 py-3 w-40">Date</th>
                  <th className="text-left text-gray-400 text-xs font-medium px-4 py-3 w-28">Project</th>
                  <th className="text-left text-gray-400 text-xs font-medium px-4 py-3">User</th>
                  <th className="text-left text-gray-400 text-xs font-medium px-4 py-3">AI Response</th>
                  <th className="text-left text-gray-400 text-xs font-medium px-4 py-3 w-28">Model</th>
                  <th className="text-right text-gray-400 text-xs font-medium px-4 py-3 w-20">Duration</th>
                  <th className="text-right text-gray-400 text-xs font-medium px-4 py-3 w-20">Tokens</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <>
                    <tr
                      key={item.messageId}
                      onClick={() => toggleRow(item.messageId)}
                      className={`border-b border-gray-700/50 cursor-pointer transition-colors ${
                        expandedRow === item.messageId ? 'bg-gray-700/40' : 'hover:bg-gray-700/20'
                      }`}
                    >
                      <td className="px-4 py-3 text-gray-300 text-sm whitespace-nowrap">
                        {new Date(item.createdAt).toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-white text-sm font-medium">
                        {item.projectName}
                      </td>
                      <td className="px-4 py-3 text-gray-300 text-sm max-w-0">
                        <div className="truncate">{truncate(item.userMessage, 80)}</div>
                      </td>
                      <td className="px-4 py-3 text-gray-400 text-sm max-w-0">
                        <div className="truncate">{truncate(item.aiMessage, 80)}</div>
                      </td>
                      <td className="px-4 py-3 text-gray-400 text-xs whitespace-nowrap">
                        {shortModelName(item.model)}
                      </td>
                      <td className="px-4 py-3 text-gray-400 text-sm text-right whitespace-nowrap">
                        {formatDuration(item.durationMs)}
                      </td>
                      <td className="px-4 py-3 text-gray-300 text-sm text-right whitespace-nowrap font-mono">
                        {formatTokens(totalTokens(item))}
                      </td>
                    </tr>
                    {/* 展開パネル */}
                    {expandedRow === item.messageId && (
                      <tr key={`${item.messageId}-detail`}>
                        <td colSpan={7} className="px-4 py-4 bg-gray-700/20">
                          <div className="space-y-4">
                            {/* ユーザーメッセージ全文 */}
                            <div>
                              <div className="text-gray-500 text-xs mb-1 font-medium">User Message</div>
                              <div className="text-white text-sm whitespace-pre-wrap bg-gray-900/60 rounded p-3 max-h-60 overflow-y-auto">
                                {item.userMessage || '(empty)'}
                              </div>
                            </div>
                            {/* AI メッセージ全文 */}
                            <div>
                              <div className="text-gray-500 text-xs mb-1 font-medium">AI Response</div>
                              <div className="text-gray-300 text-sm whitespace-pre-wrap bg-gray-900/60 rounded p-3 max-h-60 overflow-y-auto">
                                {item.aiMessage || '(empty)'}
                              </div>
                            </div>
                            {/* トークン内訳 + メタ情報 */}
                            <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-gray-400 border-t border-gray-700 pt-3">
                              <span>Input: <span className="text-gray-300">{item.inputTokens.toLocaleString()}</span></span>
                              <span>Output: <span className="text-gray-300">{item.outputTokens.toLocaleString()}</span></span>
                              <span>Cache Read: <span className="text-gray-300">{item.cacheReadTokens.toLocaleString()}</span></span>
                              <span>Cache Creation: <span className="text-gray-300">{item.cacheCreationTokens.toLocaleString()}</span></span>
                              <span>Duration: <span className="text-gray-300">{formatDuration(item.durationMs)}</span></span>
                              <span>Model: <span className="text-gray-300">{item.model ?? 'unknown'}</span></span>
                              <span>Agent: <span className="text-gray-300">{item.machineName}</span></span>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </div>

          {/* モバイル: カード表示 */}
          <div className="md:hidden space-y-3">
            {items.map((item) => (
              <div
                key={item.messageId}
                onClick={() => toggleRow(item.messageId)}
                className="bg-gray-800 rounded-lg p-4 cursor-pointer hover:bg-gray-700/60 transition-colors"
              >
                <div className="flex justify-between items-start mb-2">
                  <span className="text-white text-sm font-medium">{item.projectName}</span>
                  <span className="text-gray-400 text-xs">{new Date(item.createdAt).toLocaleString()}</span>
                </div>
                <div className="text-gray-300 text-sm mb-1 truncate">{truncate(item.userMessage, 60)}</div>
                <div className="text-gray-500 text-xs mb-2 truncate">{truncate(item.aiMessage, 60)}</div>
                <div className="flex gap-3 text-xs text-gray-400">
                  <span>{shortModelName(item.model)}</span>
                  <span>{formatDuration(item.durationMs)}</span>
                  <span className="font-mono">{formatTokens(totalTokens(item))}</span>
                </div>

                {/* モバイル展開 */}
                {expandedRow === item.messageId && (
                  <div className="mt-4 space-y-3 border-t border-gray-700 pt-3">
                    <div>
                      <div className="text-gray-500 text-xs mb-1">User Message</div>
                      <div className="text-white text-sm whitespace-pre-wrap bg-gray-900/60 rounded p-2 max-h-40 overflow-y-auto">
                        {item.userMessage || '(empty)'}
                      </div>
                    </div>
                    <div>
                      <div className="text-gray-500 text-xs mb-1">AI Response</div>
                      <div className="text-gray-300 text-sm whitespace-pre-wrap bg-gray-900/60 rounded p-2 max-h-40 overflow-y-auto">
                        {item.aiMessage || '(empty)'}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-400">
                      <span>In: {item.inputTokens.toLocaleString()}</span>
                      <span>Out: {item.outputTokens.toLocaleString()}</span>
                      <span>Cache: {item.cacheReadTokens.toLocaleString()}</span>
                      <span>Agent: {item.machineName}</span>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* ページネーション */}
          {total > PAGE_SIZE && (
            <div className="flex items-center justify-between mt-4">
              <div className="text-gray-400 text-sm">
                {data!.offset + 1} - {Math.min(data!.offset + data!.limit, total)} of {total}
              </div>
              <div className="flex space-x-2">
                <button
                  onClick={() => setPage(p => p - 1)}
                  disabled={page === 0}
                  className="px-3 py-1 bg-gray-700 text-gray-300 rounded text-sm disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-600"
                >
                  Previous
                </button>
                <button
                  onClick={() => setPage(p => p + 1)}
                  disabled={page + 1 >= totalPages}
                  className="px-3 py-1 bg-gray-700 text-gray-300 rounded text-sm disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-600"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
