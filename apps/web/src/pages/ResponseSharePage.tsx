import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { apiUrl } from '../lib/base';
import { MarkdownBody } from '../components/MarkdownBody';

/**
 * 応答の書式サイクル（2026-11-23）: AI 応答の公開共有リンク（ログイン不要・`/s/:token`）。
 * `UsageSignagePage` と同じ位置（`App.tsx` の `ProtectedContent` の外）に置く read-only ページ。
 * 表示するのは本文テキストのみ（添付ファイル・ユーザーの入力・他メッセージは出さない）。
 */

interface SharedResponse {
  content: string;
  createdAt: string;
  expiresAt: string | null;
  projectName: string;
}

export function ResponseSharePage() {
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<SharedResponse | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    let cancelled = false;
    fetch(apiUrl(`/public/response/${encodeURIComponent(token)}`), { cache: 'no-store' })
      .then((res) => {
        if (!res.ok) throw new Error('not-found');
        return res.json();
      })
      .then((body: SharedResponse) => {
        if (!cancelled) setData(body);
      })
      .catch(() => {
        if (!cancelled) setNotFound(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <div className="min-h-screen bg-[var(--bg-base)] flex justify-center px-4 py-10">
      <div className="w-full max-w-2xl">
        {loading && (
          <div className="text-[var(--text-muted)] text-sm">読み込み中…</div>
        )}
        {!loading && notFound && (
          <div className="bg-[var(--bg-secondary)] rounded-lg p-6 text-center">
            <p className="text-[var(--text-primary)] font-medium mb-1">このリンクは見つかりません</p>
            <p className="text-[var(--text-muted)] text-sm">期限切れ、または無効なリンクです。</p>
          </div>
        )}
        {!loading && data && (
          <div className="bg-[var(--bg-secondary)] rounded-lg p-6">
            <div className="flex items-center justify-between mb-4 text-xs text-[var(--text-faint)]">
              <span>{data.projectName}</span>
              <span>{new Date(data.createdAt).toLocaleString('ja-JP')}</span>
            </div>
            <div className="text-sm text-[var(--text-primary)] leading-relaxed">
              <MarkdownBody text={data.content} />
            </div>
            {data.expiresAt && (
              <p className="mt-6 text-xs text-[var(--text-faint)] border-t border-[var(--border-color)] pt-3">
                このリンクは {new Date(data.expiresAt).toLocaleDateString('ja-JP')} まで有効です。
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
