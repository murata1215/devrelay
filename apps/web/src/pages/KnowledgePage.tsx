import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useLanguage } from '../contexts/LanguageContext';
import { useAuth } from '../contexts/AuthContext';
import { useOrganization } from '../contexts/OrganizationContext';
import {
  knowledge as knowledgeApi,
  clearance as clearanceApi,
  projects as projectsApi,
  type KnowledgeSearchResponse,
  type ClassificationValue,
  type ThreadClassification,
} from '../lib/api';
import {
  parseKnowledgeUrlState,
  serializeKnowledgeUrlState,
  patchKnowledgeUrlState,
  buildKnowledgeSearchQuery,
  isSearchable,
  describeCoverage,
  describeViewer,
  isKnowledgeDisabledError,
  isVectorKeyMissingError,
  KNOWLEDGE_LIMIT_DEFAULT,
  type KnowledgeUrlState,
} from '../lib/knowledge-search-rules';
import { canEditClassification } from '../lib/clearance-rules';
import {
  IDLE_ANSWER_STATE,
  DISABLED_ANSWER_STATE,
  startingAnswerState,
  reduceAnswerStream,
  parseAnswerToggleValue,
  serializeAnswerToggleValue,
  isKnowledgeAnswerDisabledError,
  buildAnswerRequestFilters,
  type AnswerState,
} from '../lib/knowledge-answer-rules';
import { KnowledgeFilterBar } from '../components/knowledge/KnowledgeFilterBar';
import { KnowledgeResultCard } from '../components/knowledge/KnowledgeResultCard';
import { KnowledgeThreadViewer } from '../components/knowledge/KnowledgeThreadViewer';
import { KnowledgeAnswerPanel } from '../components/knowledge/KnowledgeAnswerPanel';
import { useWebSocket } from '../hooks/useWebSocket';
import { getTabId } from '../lib/tab-id';

/**
 * 高辻ナレッジ サイクル4: 「AI 回答」トグルの localStorage キー（閲覧者ごとに記憶、既定 ON）。
 * I/O は純ロジック（`lib/knowledge-answer-rules.ts`）ではなくここで行う（tsconfig.test.json の
 * `lib:["ES2022"]` には DOM が無いため、`localStorage` はそちら側で参照できない）。
 */
const ANSWER_TOGGLE_STORAGE_KEY = 'devrelay-knowledge-answer-enabled';

function readAnswerToggleFromStorage(): boolean {
  try {
    return parseAnswerToggleValue(localStorage.getItem(ANSWER_TOGGLE_STORAGE_KEY));
  } catch {
    return true;
  }
}

function writeAnswerToggleToStorage(value: boolean): void {
  try {
    localStorage.setItem(ANSWER_TOGGLE_STORAGE_KEY, serializeAnswerToggleValue(value));
  } catch {
    // localStorage 不可時は無視（utils/doc-panel-settings.ts と同じ流儀）
  }
}

/**
 * 高辻ナレッジ サイクル3（WebUI）: `/knowledge` ページ（指示書 §3）。
 *
 * URL が唯一の真実（D6）。`setSearchParams` を呼ぶのはこのコンポーネントの `apply()` だけ
 * （guard テストで出現数を固定する）。検索 fetch のキーは `thread`/`anchor` を含まない
 * プリミティブ文字列にしているため、スレッドを開閉しても検索は再実行されない
 * （fetch コールバックから URL を書かないことと合わせて、LitePage で文書化済みの
 * 「setSearchParams → effect → setSearchParams …」ループを構造的に避ける）。
 */
export function KnowledgePage() {
  const { t } = useLanguage();
  const { user } = useAuth();
  const { organization } = useOrganization();

  const [searchParams, setSearchParams] = useSearchParams();
  const urlState = useMemo(() => parseKnowledgeUrlState((k) => searchParams.get(k)), [searchParams]);

  const apply = useCallback(
    (patch: Partial<KnowledgeUrlState>) => {
      setSearchParams(
        (prev) => {
          const prevState = parseKnowledgeUrlState((k) => prev.get(k));
          const nextState = patchKnowledgeUrlState(prevState, patch);
          return new URLSearchParams(serializeKnowledgeUrlState(nextState));
        },
        { replace: true }
      );
    },
    [setSearchParams]
  );

  const [qDraft, setQDraft] = useState(urlState.q);
  const lastAppliedQRef = useRef(urlState.q);
  useEffect(() => {
    if (urlState.q !== lastAppliedQRef.current) {
      setQDraft(urlState.q);
      lastAppliedQRef.current = urlState.q;
    }
  }, [urlState.q]);

  const [limit, setLimit] = useState(KNOWLEDGE_LIMIT_DEFAULT);
  const [data, setData] = useState<KnowledgeSearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [disabled, setDisabled] = useState(false);

  const [projectsList, setProjectsList] = useState<Array<{ id: string; name: string }>>([]);
  const [compartments, setCompartments] = useState<string[]>([]);
  const [ownClearance, setOwnClearance] = useState<{ readLevel: number; compartments: string[] } | null>(null);
  const [anchorTimestamp, setAnchorTimestamp] = useState<string | null>(null);

  // 高辻ナレッジ サイクル4: 「AI 回答」トグル（既定 ON、localStorage で閲覧者ごとに記憶）。
  // killswitch（DEVRELAY_KNOWLEDGE_ANSWER=0）に当たったら以後のセッションでトグル自体を隠す
  // （既存の検索 killswitch 発見と同じ「実際に叩いて初めて分かる」流儀。他ページ/useWebSocket は無変更）。
  const [answerEnabled, setAnswerEnabled] = useState(readAnswerToggleFromStorage);
  const [answerFeatureDisabled, setAnswerFeatureDisabled] = useState(false);
  const [answerState, setAnswerState] = useState<AnswerState>(IDLE_ANSWER_STATE);
  const answerIdRef = useRef<string | null>(null);

  // カードへのスクロール＋ハイライト（[n] クリック用）。KnowledgeResultCard.tsx 自体は変更しない
  // （ref はこのページ側の wrapper div に付ける）。
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [highlightedCardKey, setHighlightedCardKey] = useState<string | null>(null);
  const lastCitationRankRef = useRef<number | null>(null);

  // 高辻ナレッジ サイクル4 D4: 回答配信専用の WS 接続。ChatPage/LitePage と同じ `web:${userId}:${tabId}`
  // 規約だが、`:knowledge` を付けた専用 tabId を使うことで chatId の名前空間を分離する。
  // これをせず classic の `getTabId()` をそのまま使うと、同じブラウザタブで ChatPage ⇄ /knowledge を
  // 往復した際に chatId が一致し、`platforms/web.ts` の接続時フラッシュ処理が
  // 「WS 切断中に完了していたチャットの応答」を無条件に消費してしまう（実機で実害のある副作用。
  // 検証済み: `getUserContext` は未知の chatId に対して何の参加登録も行わないため、この専用
  // chatId で接続しても ChatPage 側のセッション・進捗には一切影響しない）。
  const knowledgeTabId = useMemo(() => `${getTabId()}:knowledge`, []);

  useWebSocket(
    {
      onKnowledgeAnswerDelta: (payload) => {
        if (payload.answerId !== answerIdRef.current) return;
        setAnswerState((s) => reduceAnswerStream(s, { type: 'delta', answerId: payload.answerId, text: payload.text }));
      },
      onKnowledgeAnswerDone: (payload) => {
        if (payload.answerId !== answerIdRef.current) return;
        setAnswerState((s) => reduceAnswerStream(s, { type: 'done', answerId: payload.answerId, data: payload }));
      },
      onKnowledgeAnswerError: (payload) => {
        if (payload.answerId !== answerIdRef.current) return;
        setAnswerState((s) => reduceAnswerStream(s, { type: 'error', answerId: payload.answerId, message: payload.message }));
      },
    },
    { tabId: knowledgeTabId }
  );

  // プロジェクト一覧・案件名候補・自分の権限（組織なしでも 200）は検索と無関係に 1 回だけ取得する。
  useEffect(() => {
    let dead = false;
    projectsApi
      .list()
      .then((list) => {
        if (!dead) setProjectsList(list.map((p) => ({ id: p.id, name: p.displayName ?? p.name })));
      })
      .catch(() => {});
    clearanceApi
      .compartments()
      .then((res) => {
        if (!dead) setCompartments(res.compartments);
      })
      .catch(() => {});
    if (user) {
      clearanceApi
        .getMember(user.id)
        .then((res) => {
          if (!dead) setOwnClearance({ readLevel: res.readLevel, compartments: res.compartments });
        })
        .catch(() => {});
    }
    return () => {
      dead = true;
    };
  }, [user]);

  // 検索クエリは thread/anchor を含まないプリミティブなキーで effect を駆動する
  // （スレッドを開いても検索条件の参照は変わらない＝再検索ループに陥らない、という保証をここで固定する）。
  // `urlState` 全体ではなく検索軸のプリミティブ値だけに依存させる意図的な設計のため exhaustive-deps を外す。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const searchQueryKey = useMemo(() => JSON.stringify(buildKnowledgeSearchQuery(urlState, limit)), [
    urlState.q,
    urlState.mode,
    urlState.scope,
    urlState.kind,
    urlState.projectId,
    urlState.compartment,
    urlState.maxLevel,
    urlState.since,
    urlState.until,
    limit,
  ]);

  useEffect(() => {
    if (!isSearchable(urlState)) {
      setData(null);
      setErr(null);
      setDisabled(false);
      return;
    }
    let dead = false;
    setLoading(true);
    knowledgeApi
      .search(JSON.parse(searchQueryKey))
      .then((res) => {
        if (dead) return;
        setData(res);
        setErr(null);
        setDisabled(false);
      })
      .catch((e) => {
        if (dead) return;
        const message = e instanceof Error ? e.message : String(e);
        if (isKnowledgeDisabledError(message)) {
          setDisabled(true);
          setData(null);
          setErr(null);
        } else {
          setErr(message);
          setData(null);
          setDisabled(false);
        }
      })
      .finally(() => {
        if (!dead) setLoading(false);
      });
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQueryKey]);

  // 高辻ナレッジ サイクル4 D1: 検索と「同じクエリ・同じフィルタ」で回答生成を同時に走らせる
  // （`searchQueryKey` を共有。`thread`/`anchor` には依存しないので、検索と同様スレッド開閉では
  // 再トリガーされない）。新しい検索が始まるたびに前の回答は破棄する（`answerIdRef` を更新し、
  // 古い `answerId` 宛の delta/done/error は `reduceAnswerStream` 側で無視される）。
  useEffect(() => {
    if (!answerEnabled || answerFeatureDisabled) {
      answerIdRef.current = null;
      setAnswerState(answerFeatureDisabled ? DISABLED_ANSWER_STATE : IDLE_ANSWER_STATE);
      return;
    }
    if (!isSearchable(urlState)) {
      answerIdRef.current = null;
      setAnswerState(IDLE_ANSWER_STATE);
      return;
    }

    let dead = false;
    const answerId = crypto.randomUUID();
    answerIdRef.current = answerId;
    setAnswerState(startingAnswerState(answerId));

    const filters = buildAnswerRequestFilters(JSON.parse(searchQueryKey));
    knowledgeApi
      .answer({
        answerId,
        question: urlState.q.trim(),
        stream: true,
        tabId: knowledgeTabId,
        ...filters,
      })
      .then((res) => {
        if (dead || answerIdRef.current !== answerId) return;
        if (res.delivery === 'http') {
          setAnswerState((s) => reduceAnswerStream(s, { type: 'done', answerId, data: res }));
        }
        // delivery === 'ws' の場合は useWebSocket の onKnowledgeAnswerDelta/Done/Error が後続を処理する。
      })
      .catch((e) => {
        if (dead || answerIdRef.current !== answerId) return;
        const message = e instanceof Error ? e.message : String(e);
        if (isKnowledgeAnswerDisabledError(message)) {
          setAnswerFeatureDisabled(true);
          setAnswerState(DISABLED_ANSWER_STATE);
          return;
        }
        setAnswerState((s) => reduceAnswerStream(s, { type: 'error', answerId, message }));
      });

    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQueryKey, answerEnabled, answerFeatureDisabled, knowledgeTabId]);

  const handleSubmit = () => {
    const trimmed = qDraft.trim();
    lastAppliedQRef.current = trimmed;
    apply({ q: trimmed });
  };

  const handleReset = () => {
    lastAppliedQRef.current = '';
    setQDraft('');
    apply({
      q: '',
      mode: 'hybrid',
      scope: 'all',
      kind: 'all',
      projectId: null,
      compartment: null,
      maxLevel: null,
      since: null,
      until: null,
    });
  };

  const handleOpen = (sessionId: string, aiMessageId: string, occurredAt: string) => {
    setAnchorTimestamp(occurredAt);
    apply({ thread: sessionId, anchor: aiMessageId });
  };

  const handleClose = () => {
    setAnchorTimestamp(null);
    apply({ thread: null, anchor: null });
  };

  const handleClassificationSaved = (sessionId: string, after: ClassificationValue | ThreadClassification) => {
    const effectiveLevel = 'effectiveLevel' in after ? after.effectiveLevel : after.level ?? 0;
    const effectiveCompartment = 'effectiveCompartment' in after ? after.effectiveCompartment : after.compartment;
    setData((prev) =>
      prev
        ? {
            ...prev,
            results: prev.results.map((r) =>
              r.sessionId === sessionId ? { ...r, level: effectiveLevel, compartment: effectiveCompartment } : r
            ),
          }
        : prev
    );
  };

  // 高辻ナレッジ サイクル4: 回答本文の [n] クリック。1 回目はそのカードへスクロール＋ハイライト、
  // 同じ [n] を続けてクリックするとスレッドビューアを開く（指示書 §3）。
  const handleCitationClick = useCallback(
    (rank: number) => {
      const result = data?.results.find((r) => r.rank === rank);
      if (!result) return;
      const key = `${result.sessionId}:${result.aiMessageId}`;

      if (lastCitationRankRef.current === rank) {
        lastCitationRankRef.current = null;
        handleOpen(result.sessionId, result.aiMessageId, result.occurredAt);
        return;
      }

      lastCitationRankRef.current = rank;
      const el = cardRefs.current[key];
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setHighlightedCardKey(key);
      setTimeout(() => {
        setHighlightedCardKey((cur) => (cur === key ? null : cur));
      }, 2000);
    },
    [data]
  );

  if (disabled) {
    return (
      <div className="p-6">
        <h1 className="mb-4 text-2xl font-bold text-[var(--text-primary)]">{t('knowledge.title')}</h1>
        <div className="rounded-lg bg-[var(--bg-secondary)] p-8 text-center">
          <p className="text-[var(--text-primary)] font-medium">{t('knowledge.disabledTitle')}</p>
          <p className="mt-1 text-sm text-[var(--text-muted)]">{t('knowledge.disabledBody')}</p>
        </div>
      </div>
    );
  }

  const role = organization?.role ?? null;
  const viewerDisplay = data
    ? describeViewer(data.viewer)
    : describeViewer(
        ownClearance ? { readLevel: ownClearance.readLevel, compartments: ownClearance.compartments, organization: organization !== null } : null
      );
  const coverage = data ? describeCoverage(data.coverage, data.mode) : null;

  return (
    <div className="p-6">
      <h1 className="mb-2 text-2xl font-bold text-[var(--text-primary)]">{t('knowledge.title')}</h1>

      <div className="mb-4 text-xs text-[var(--text-muted)]">
        {viewerDisplay.orgLess ? (
          <span>{t('knowledge.viewerOrgLess')}</span>
        ) : (
          <span>
            {t('knowledge.viewerReadLevelLabel')} ≤ {viewerDisplay.readLevel} ／ {t('knowledge.viewerCompartmentsLabel')}:{' '}
            {viewerDisplay.hasWildcard
              ? t('knowledge.viewerCompartmentsAll')
              : viewerDisplay.compartments.length > 0
                ? viewerDisplay.compartments.join(', ')
                : t('knowledge.viewerCompartmentsNone')}
          </span>
        )}
      </div>

      <KnowledgeFilterBar
        state={urlState}
        qDraft={qDraft}
        projects={projectsList}
        compartments={compartments}
        limit={limit}
        disabled={loading}
        onQDraftChange={setQDraft}
        onSubmit={handleSubmit}
        onPatch={apply}
        onLimitChange={setLimit}
        onReset={handleReset}
      />

      {!answerFeatureDisabled && (
        <label className="mt-2 flex items-center gap-2 text-xs text-[var(--text-muted)]">
          <input
            type="checkbox"
            checked={answerEnabled}
            onChange={(e) => {
              const next = e.target.checked;
              setAnswerEnabled(next);
              writeAnswerToggleToStorage(next);
            }}
          />
          {t('knowledge.answer.toggle')}
        </label>
      )}

      {coverage && coverage.kind !== 'both' && (
        <p className="mt-2 text-xs text-[var(--text-muted)]">
          {t(`knowledge.coverage.${coverage.kind}` as const)}
          {coverage.skippedReason === 'no_openai_api_key' && ` ${t('knowledge.coverage.skippedNoKey')}`}
        </p>
      )}

      {err && !isVectorKeyMissingError(err) && <p className="mt-3 text-sm text-[var(--text-danger)]">{err}</p>}
      {err && isVectorKeyMissingError(err) && <p className="mt-3 text-sm text-[var(--text-danger)]">{t('knowledge.error.vectorNoKey')}</p>}

      <div className="mt-4 grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className={urlState.thread ? 'hidden md:block' : ''}>
          <KnowledgeAnswerPanel state={answerState} onCitationClick={handleCitationClick} />

          {loading && <p className="text-sm text-[var(--text-muted)]">{t('knowledge.loading')}</p>}
          {!loading && data && data.results.length === 0 && (
            <div className="rounded-lg bg-[var(--bg-secondary)] p-8 text-center">
              <p className="text-[var(--text-primary)]">{t('knowledge.empty')}</p>
              <p className="mt-1 text-xs text-[var(--text-muted)]">{t('knowledge.emptyHint')}</p>
            </div>
          )}
          {!loading && data && data.results.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs text-[var(--text-faint)]">{t('knowledge.resultCount').replace('{n}', String(data.total))}</p>
              {data.results.map((r) => {
                const cardKey = `${r.sessionId}:${r.aiMessageId}`;
                return (
                  <div
                    key={cardKey}
                    ref={(el) => {
                      cardRefs.current[cardKey] = el;
                    }}
                    className={highlightedCardKey === cardKey ? 'rounded-lg ring-2 ring-[var(--accent-blue)]' : ''}
                  >
                    <KnowledgeResultCard
                      result={r}
                      query={urlState.q}
                      isOpen={urlState.thread === r.sessionId}
                      canEditClassification={canEditClassification(role, user?.id ?? '', r.ownerUserId)}
                      onOpen={handleOpen}
                      onClassificationSaved={handleClassificationSaved}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {urlState.thread && (
          <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)]">
            <KnowledgeThreadViewer
              key={urlState.thread}
              sessionId={urlState.thread}
              anchorMessageId={urlState.anchor}
              anchorTimestamp={anchorTimestamp}
              query={urlState.q}
              onClose={handleClose}
              onClassificationSaved={handleClassificationSaved}
            />
          </div>
        )}
      </div>
    </div>
  );
}
