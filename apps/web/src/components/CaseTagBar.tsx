import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { usage as usageApi } from '../lib/api';
import { BacklogIssueBadge, BacklogPickButton } from './BacklogIssuePicker';

/**
 * Usage 案件必須サイクル（2026-11-19）: チャット入力欄の上に出す「🏷 案件」欄。
 * スレッド（Session）の案件（`Session.usageCase`、コスト集計専用）をその場で表示・変更する。
 * ChatPage と Lite の両方で使う。
 */

export interface ThreadCaseState {
  /** 案件の状態を読み終えたか（sessionId 未確定・取得中は false） */
  loaded: boolean;
  caseName: string | null;
  options: string[];
  /** DEVRELAY_USAGE_CASE_REQUIRED=1 のとき true（案件が空なら AI プロンプトを送らせない） */
  required: boolean;
  editable: boolean;
  /** Usage 機能が無効（API 404）など、案件欄を出さないとき true */
  unavailable: boolean;
}

const INITIAL: ThreadCaseState = { loaded: false, caseName: null, options: [], required: false, editable: false, unavailable: false };

/**
 * sessionId が変わるたびに案件を取り直す。save は保存して状態を更新する。
 *
 * `allowPending: true`（Lite の「最初の送信でスレッドを作る」経路）のときは、スレッドがまだ無くても
 * 入力でき、値は手元に持つだけ（`pendingCase`）。呼び出し側がスレッド作成直後に保存する。
 * `allowPending: false`（ChatPage）のときはスレッドが決まるまで読み込み中扱い（送信も止める）。
 */
export function useThreadCase(sessionId: string | null | undefined, opts: { allowPending?: boolean } = {}) {
  const [state, setState] = useState<ThreadCaseState>(INITIAL);
  const reqRef = useRef(0);
  const allowPending = !!opts.allowPending;

  useEffect(() => {
    const req = ++reqRef.current;
    if (!sessionId) {
      if (!allowPending) {
        setState((s) => ({ ...INITIAL, required: s.required, options: s.options }));
        return;
      }
      setState((s) => ({ ...s, loaded: false, caseName: null }));
      usageApi
        .getCaseSettings()
        .then((r) => {
          if (req !== reqRef.current) return;
          setState({ loaded: true, caseName: null, options: r.options, required: r.required, editable: true, unavailable: false });
        })
        .catch(() => {
          if (req !== reqRef.current) return;
          setState({ ...INITIAL, loaded: true, unavailable: true });
        });
      return;
    }
    setState((s) => ({ ...s, loaded: false }));
    usageApi
      .getCase(sessionId)
      .then((r) => {
        if (req !== reqRef.current) return;
        setState({ loaded: true, caseName: r.caseName, options: r.options, required: r.required, editable: r.editable, unavailable: false });
      })
      .catch(() => {
        if (req !== reqRef.current) return;
        // 取得できない（Usage 無効・権限なし・旧サーバー）ときは欄を出さず、送信も止めない
        setState({ ...INITIAL, loaded: true, unavailable: true });
      });
  }, [sessionId, allowPending]);

  // Backlog 連携: AI が課題に着手すると（スキルの move start）サーバー側で案件が課題キーに変わるため、
  // 画面に戻ったときと 20 秒ごと（表示中のみ）に静かに取り直す（読み込み中表示にはしない）
  useEffect(() => {
    if (!sessionId) return;
    const refresh = () => {
      const req = reqRef.current;
      usageApi
        .getCase(sessionId)
        .then((r) => {
          if (req !== reqRef.current) return;
          setState((s) => (s.loaded && !s.unavailable && s.caseName !== r.caseName ? { ...s, caseName: r.caseName } : s));
        })
        .catch(() => {});
    };
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, 20_000);
    return () => {
      window.removeEventListener('focus', onFocus);
      clearInterval(t);
    };
  }, [sessionId]);

  const save = useCallback(
    async (next: string | null) => {
      if (!sessionId) {
        // スレッド未作成: 手元に持つだけ（作成直後に呼び出し側が保存する）
        if (allowPending) setState((s) => ({ ...s, caseName: next }));
        return;
      }
      const r = await usageApi.setCase(sessionId, next);
      setState((s) => ({
        ...s,
        caseName: r.caseName,
        options: r.caseName && !s.options.includes(r.caseName) ? [...s.options, r.caseName].sort((a, b) => a.localeCompare(b, 'ja')) : s.options,
      }));
    },
    [sessionId, allowPending],
  );

  return { state, save };
}

export function CaseTagBar({
  state,
  onSave,
  highlight,
  inputRef,
  disabled,
}: {
  state: ThreadCaseState;
  onSave: (next: string | null) => Promise<void>;
  /** 送信を止めたとき赤枠で強調する */
  highlight: boolean;
  inputRef?: RefObject<HTMLInputElement | null>;
  disabled?: boolean;
}) {
  const [text, setText] = useState(state.caseName ?? '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setText(state.caseName ?? '');
    setErr('');
  }, [state.caseName, state.loaded]);

  if (state.unavailable) return null;

  const commit = async () => {
    const next = text.replace(/[\s　]+/g, ' ').trim() || null;
    if (next === (state.caseName ?? null)) return;
    setSaving(true);
    setErr('');
    try {
      await onSave(next);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '保存に失敗しました');
      setText(state.caseName ?? '');
    } finally {
      setSaving(false);
    }
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      (e.target as HTMLInputElement).blur();
    }
    if (e.key === 'Escape') {
      setText(state.caseName ?? '');
      (e.target as HTMLInputElement).blur();
    }
  };

  const empty = !state.caseName;
  const placeholder = !state.loaded ? '読み込み中…' : state.required ? '案件名を入力（必須）' : '案件名（任意・コスト集計用）';
  const listId = 'chat-case-options';

  return (
    <div className="flex flex-wrap items-center gap-2 mb-2 text-sm min-w-0">
      <span className="text-[var(--text-muted)] whitespace-nowrap" title="このスレッドの案件（Usage 画面のコスト集計に使います）">
        🏷 案件
      </span>
      <datalist id={listId}>
        {state.options.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
      <input
        ref={inputRef}
        value={text}
        list={listId}
        maxLength={40}
        placeholder={placeholder}
        disabled={disabled || saving || !state.loaded || !state.editable}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={onKey}
        title={state.editable ? 'Enter またはフォーカスを外すと保存（空欄で案件なしに戻す）' : '案件を変更できるのはスレッドの持ち主と管理者だけです'}
        className={`w-56 px-2 py-1 rounded border bg-[var(--input-bg)] text-[var(--text-primary)] placeholder-[var(--text-faint)] focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-60 ${
          highlight || (state.required && state.loaded && empty) ? 'border-red-500' : 'border-[var(--border-color)]'
        }`}
      />
      {state.editable && state.loaded && (
        <BacklogPickButton
          disabled={disabled || saving}
          onPick={(key) => {
            setText(key);
            void (async () => {
              if (key === (state.caseName ?? null)) return;
              setSaving(true);
              setErr('');
              try {
                await onSave(key);
              } catch (e) {
                setErr(e instanceof Error ? e.message : '保存に失敗しました');
                setText(state.caseName ?? '');
              } finally {
                setSaving(false);
              }
            })();
          }}
        />
      )}
      <BacklogIssueBadge caseName={state.caseName} />
      {saved && <span className="text-xs text-green-600">保存しました</span>}
      {err && <span className="text-xs text-[var(--text-danger)]">{err}</span>}
      {highlight && !err && <span className="text-xs text-[var(--text-danger)]">案件を入力してから送信してください</span>}
    </div>
  );
}
