import type { KeyboardEvent } from 'react';
import { useLanguage } from '../../contexts/LanguageContext';
import type { ProjectSelectorOption, ComposerPlaceholderReason } from './lite-shell-rules';
import type { TranslationKey } from '../../i18n/messages';

/**
 * Lite シェル L4: 入力欄 + プロジェクトセレクタ。
 *
 * L2/L3 では送信機能が無く常に disabled だったが、L4 で送信可能にする。このコンポーネント自身は
 * 状態を持たない（`body`/送信可否/プレースホルダ理由はすべて `LitePage` から渡される）。
 * Enter = 送信 / Shift+Enter = 改行は classic（`ChatPage.tsx` の `handleKeyDown`）と同一挙動
 * （IME 変換中判定は classic 側にも無いため、ここでも追加しない）。
 *
 * B6: テキストエリアは送信中も disabled にしない。送信ボタンのみ `sendDisabled` で disabled にする。
 */
export interface LiteComposerProps {
  options: readonly ProjectSelectorOption[];
  selectedProjectId: string | null;
  onProjectChange: (projectId: string) => void;
  projectsLoading: boolean;
  projectsLoadFailed: boolean;
  /** 入力中の本文（LitePage が state を保持する） */
  body: string;
  onBodyChange: (value: string) => void;
  /** 送信操作（Enter・送信ボタンの両方から呼ばれる）。ブロック中かどうかの判定は呼び出し側が持つ。 */
  onSend: () => void;
  /** A2: 入力欄が使えない理由（`resolveComposerPlaceholderReason()` の結果） */
  placeholderReason: ComposerPlaceholderReason;
  /** 送信ボタンの disabled（B1 の条件を満たさない、または送信中） */
  sendDisabled: boolean;
  /** 送信中かどうか（送信ボタンのラベル切替のみに使う。B6: テキストエリアは無関係） */
  sending: boolean;
  /** A3: 非 null なら「送信すると <projectLabel> に新しいスレッドを作ります」を表示する */
  newThreadNoticeProjectLabel: string | null;
}

const PLACEHOLDER_KEY_BY_REASON: Record<ComposerPlaceholderReason, TranslationKey> = {
  connecting: 'lite.composerPlaceholderConnecting',
  'machine-offline': 'lite.composerPlaceholderMachineOffline',
  'no-project': 'lite.composerPlaceholderNoProject',
  ready: 'lite.composerPlaceholder',
};

export function LiteComposer({
  options,
  selectedProjectId,
  onProjectChange,
  projectsLoading,
  projectsLoadFailed,
  body,
  onBodyChange,
  onSend,
  placeholderReason,
  sendDisabled,
  sending,
  newThreadNoticeProjectLabel,
}: LiteComposerProps) {
  const { t } = useLanguage();

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  };

  return (
    <div className="shrink-0 border-t border-[var(--border-color)] bg-[var(--bg-secondary)] p-2 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <label className="text-xs text-[var(--text-muted)] shrink-0">{t('lite.projectLabel')}</label>
        <select
          value={selectedProjectId ?? ''}
          onChange={(e) => onProjectChange(e.target.value)}
          disabled={projectsLoading || projectsLoadFailed}
          className="flex-1 text-xs bg-[var(--bg-primary)] border border-[var(--border-color)] rounded px-2 py-1 text-[var(--text-primary)] disabled:opacity-50"
        >
          <option value="" disabled>{t('lite.projectPlaceholder')}</option>
          {options.map((opt) => (
            <option key={opt.projectId} value={opt.projectId}>
              {opt.label}{opt.machineLabel ? ` — ${opt.machineLabel}` : ''}{opt.online ? '' : ` (${t('lite.offline')})`}
            </option>
          ))}
        </select>
      </div>
      {projectsLoadFailed && (
        <div className="text-[10px] text-[var(--text-faint)]">{t('lite.projectLoadFailed')}</div>
      )}
      {newThreadNoticeProjectLabel && (
        <div className="text-[10px] text-[var(--text-faint)]">
          {t('lite.newThreadNoticePrefix')}{newThreadNoticeProjectLabel}{t('lite.newThreadNoticeSuffix')}
        </div>
      )}
      <div className="flex items-center gap-2">
        <textarea
          value={body}
          onChange={(e) => onBodyChange(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={2}
          placeholder={t(PLACEHOLDER_KEY_BY_REASON[placeholderReason])}
          className="flex-1 text-sm bg-[var(--bg-primary)] border border-[var(--border-color)] rounded px-2 py-1 text-[var(--text-primary)] resize-none disabled:opacity-50"
        />
        <button
          onClick={onSend}
          disabled={sendDisabled}
          className="text-sm px-3 py-1 rounded bg-[var(--bg-hover)] text-[var(--text-muted)] disabled:opacity-50 shrink-0"
        >
          {sending ? '…' : t('chat.send')}
        </button>
      </div>
    </div>
  );
}
