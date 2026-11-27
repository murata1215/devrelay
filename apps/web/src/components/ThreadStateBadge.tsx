import { useLanguage } from '../contexts/LanguageContext';
import { resolveThreadStateBadge, type ThreadListItem } from '../lib/thread-list-rules';

/**
 * スレッド状態バッジ（プラン作成済み/実行済み/回答済み）。
 * `resolveThreadStateBadge()`（`thread-list-rules.ts`）が返す色区分（tone）に応じて
 * `LevelBadge.tsx` と同じ表駆動パターンで配色する。固定色ではなくアルファ付き背景にして
 * ライト/ダーク両テーマで破綻しないようにする（このプロジェクトの `dark:` バリアントは
 * テーマ切替と連動しないため使わない）。
 *
 * `turnState` が無い（旧サーバー応答・キルスイッチ OFF）か `null`（AI 応答がまだ無い）場合は
 * 何も描画しない（既存の「既定/質問/取消済み」バッジと同列に並べて使う前提）。
 */
export interface ThreadStateBadgeProps {
  item: Pick<ThreadListItem, 'turnState'>;
}

const TONE_CLASS: Record<'executed' | 'planned' | 'answered', string> = {
  executed: 'bg-green-500/15 text-green-500 border-green-500/40',
  planned: 'bg-amber-500/15 text-amber-500 border-amber-500/40',
  answered: 'bg-blue-500/15 text-blue-500 border-blue-500/40',
};

export function ThreadStateBadge({ item }: ThreadStateBadgeProps) {
  const { t } = useLanguage();
  const badge = resolveThreadStateBadge(item);
  if (!badge) return null;
  return (
    <span
      className={`text-[10px] px-1 rounded border shrink-0 ${TONE_CLASS[badge.tone]}`}
      title={t(badge.hintKey)}
    >
      {t(badge.labelKey)}
    </span>
  );
}
