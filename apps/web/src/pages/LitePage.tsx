import { useCallback, useEffect, useState } from 'react';
import { projects as projectsApi, type Project, type ThreadSummary } from '../lib/api';
import { useLanguage } from '../contexts/LanguageContext';
import { LiteHeader } from '../components/lite/LiteHeader';
import { LiteComposer } from '../components/lite/LiteComposer';
import { ThreadList } from '../components/ThreadList';
import { buildProjectSelectorOptions, resolveThreadProjectView } from '../components/lite/lite-shell-rules';

/**
 * Lite シェル L2: 3 ペインの骨組み。
 *
 * **本サイクル（L2）の制約（重要）**:
 * - `useWebSocket` を import しない・WebSocket を一切生成・接続しない
 *   （`tests/lite-source-guards.test.mjs` が本ファイルと `components/lite/*.tsx` を静的走査して固定する）。
 *   参照プラン `~/.claude/plans/quizzical-zooming-flute.md` :104-122 — `ProtectedContent` 内で
 *   `ChatPage` を常時マウントする既存設計と WS が同一 `chatId` で殴り合い、無限再接続ループになる
 *   （CLAUDE.md の pm2 二重起動事故と同型）。`/lite` は `ProtectedContent` の外の兄弟ルートに置くことで
 *   `ChatPage` を同時マウントしない設計だが、念のため `LitePage` 自身も WS を張らないことをここで確定する。
 * - `ThreadList` は `readOnly` で使う。行クリック・「＋新規」・改名はサーバー操作
 *   （`switchThread`/`create`/`rename` の POST/PATCH）を一切発行しない（B1）。
 *   L3 で `readOnly` を外し `onLocalSelect` を実際の `switchChatToThread` 相当に差し替える。
 * - `Layout` / `useOrganization()` は使わない（F5）。
 */
export function LitePage() {
  const { t } = useLanguage();
  const [projectsById, setProjectsById] = useState<ReadonlyMap<string, Project>>(new Map());
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsLoadFailed, setProjectsLoadFailed] = useState(false);
  /** L2 が保持する state は「選択中プロジェクト / 選択中スレッド」のみ（参照プラン :196-199）。
   * projectName 等は毎レンダー `projectsById` から導出する。 */
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    projectsApi.list()
      .then((list) => {
        if (!active) return;
        setProjectsById(new Map(list.map((p) => [p.id, p])));
        setProjectsLoading(false);
      })
      .catch(() => {
        if (!active) return;
        setProjectsLoadFailed(true);
        setProjectsLoading(false);
      });
    return () => { active = false; };
  }, []);

  const projectOptions = buildProjectSelectorOptions(Array.from(projectsById.values()));

  /** L2 では ThreadList からの行クリックはローカル state の更新のみ（サーバー switch を発行しない） */
  const handleLocalSelect = useCallback((item: ThreadSummary) => {
    setSelectedSessionId(item.sessionId);
    setSelectedProjectId(item.projectId);
  }, []);

  const handleProjectChange = useCallback((projectId: string) => {
    setSelectedProjectId(projectId || null);
  }, []);

  const resolveProjectLabel = useCallback((projectId: string, fallbackName: string) => {
    return resolveThreadProjectView({ projectId, projects: projectsById, fallbackProjectName: fallbackName }).projectLabel;
  }, [projectsById]);

  return (
    <div className="h-screen flex flex-col bg-[var(--bg-primary)]">
      <LiteHeader />
      <div className="flex-1 flex min-h-0">
        <ThreadList
          currentSessionId={selectedSessionId}
          readOnly
          onLocalSelect={handleLocalSelect}
          resolveProjectLabel={resolveProjectLabel}
          createProjectId={selectedProjectId ?? undefined}
          /* L3 で switchChatToThread 相当に差し替える。L2 では readOnly のため呼ばれない */
          onSelect={() => {}}
        />
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex-1 flex items-center justify-center px-4">
            <div className="text-sm text-[var(--text-faint)] text-center">{t('lite.emptyState')}</div>
          </div>
          <LiteComposer
            options={projectOptions}
            selectedProjectId={selectedProjectId}
            onProjectChange={handleProjectChange}
            projectsLoading={projectsLoading}
            projectsLoadFailed={projectsLoadFailed}
          />
        </div>
      </div>
    </div>
  );
}
