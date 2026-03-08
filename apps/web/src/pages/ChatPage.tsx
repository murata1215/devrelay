import { useState, useRef, useEffect, useCallback, type KeyboardEvent, type ClipboardEvent } from 'react';
import { useWebSocket, type ChatMessage, type ProgressInfo } from '../hooks/useWebSocket';
import { machines as machinesApi, sessions as sessionsApi, projects as projectsApi, settings as settingsApi, getToken, type Machine } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';

/** 添付ファイル型 */
interface FileAttachment {
  filename: string;
  content: string;
  mimeType: string;
  size: number;
}

/** タブデータ */
interface Tab {
  projectId: string;
  projectName: string;
  machineDisplayName: string;
  /** ユーザーが設定したカスタムタブ名 */
  customName?: string;
  messages: ChatMessage[];
  progress: ProgressInfo | null;
  sessionId: string | null;
  historyLoaded: boolean;
  hasMoreHistory: boolean;
  loadingHistory: boolean;
  pinned: boolean;
  /** Claude の処理が完了した状態 */
  completed: boolean;
}

/** File → base64 FileAttachment 変換 */
async function fileToAttachment(file: File): Promise<FileAttachment> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return {
    filename: file.name,
    content: btoa(binary),
    mimeType: file.type || 'application/octet-stream',
    size: file.size,
  };
}

function formatFileSize(base64: string): string {
  const bytes = Math.ceil(base64.length * 3 / 4);
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

let messageIdCounter = 0;
function nextMessageId(): string {
  return `msg_${Date.now()}_${++messageIdCounter}`;
}

/** マークダウン風テキスト簡易レンダリング */
function renderContent(content: string) {
  const parts = content.split(/(```[\s\S]*?```)/g);
  return parts.map((part, i) => {
    if (part.startsWith('```') && part.endsWith('```')) {
      const code = part.slice(3, -3).replace(/^\w*\n/, '');
      return (
        <pre key={i} className="bg-[var(--bg-base)] rounded p-3 my-2 overflow-x-auto text-sm">
          <code>{code}</code>
        </pre>
      );
    }
    const inlineParts = part.split(/(`[^`]+`)/g);
    return (
      <span key={i}>
        {inlineParts.map((ip, j) => {
          if (ip.startsWith('`') && ip.endsWith('`')) {
            return <code key={j} className="bg-[var(--bg-tertiary)] px-1 rounded text-sm">{ip.slice(1, -1)}</code>;
          }
          const boldParts = ip.split(/(\*\*[^*]+\*\*)/g);
          return boldParts.map((bp, k) => {
            if (bp.startsWith('**') && bp.endsWith('**')) {
              return <strong key={`${j}-${k}`}>{bp.slice(2, -2)}</strong>;
            }
            return bp;
          });
        })}
      </span>
    );
  });
}

// ---------------------------------------------------------------------------
// ピン止めタブの永続化（localStorage 管理）
// ---------------------------------------------------------------------------

const PINNED_TABS_KEY = 'devrelay-pinned-tabs';

/** ピン止め中のタブ projectId 一覧を取得 */
function getPinnedTabIds(): Set<string> {
  try {
    const raw = localStorage.getItem(PINNED_TABS_KEY);
    if (raw) return new Set(JSON.parse(raw));
  } catch { /* ignore */ }
  return new Set();
}

/** ピン止め状態を localStorage に保存 */
function savePinnedTabIds(tabs: Tab[]) {
  const pinned = tabs.filter(t => t.pinned).map(t => t.projectId);
  localStorage.setItem(PINNED_TABS_KEY, JSON.stringify(pinned));
}

// ---------------------------------------------------------------------------
// タブカスタム名の永続化（localStorage 管理）
// ---------------------------------------------------------------------------

const TAB_NAMES_KEY = 'devrelay-tab-names';

/** カスタムタブ名のマッピングを取得（projectId → customName） */
function getTabNames(): Record<string, string> {
  try {
    const raw = localStorage.getItem(TAB_NAMES_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return {};
}

/** カスタムタブ名を localStorage に保存 */
function saveTabNames(tabs: Tab[]) {
  const names: Record<string, string> = {};
  for (const t of tabs) {
    if (t.customName) names[t.projectId] = t.customName;
  }
  localStorage.setItem(TAB_NAMES_KEY, JSON.stringify(names));
}

// ---------------------------------------------------------------------------
// チャット表示設定（localStorage 管理）
// ---------------------------------------------------------------------------

/** チャット表示設定型 */
interface ChatDisplaySettings {
  userName: string;
  userColor: string;
  userAvatar?: string;
  aiName: string;
  aiColor: string;
  aiAvatar?: string;
}

const CHAT_DISPLAY_KEY = 'devrelay-chat-display';
const DEFAULT_USER_COLOR = '#5865f2';
const DEFAULT_AI_COLOR = '#57f287';

/** localStorage からチャット表示設定を取得 */
function getChatDisplaySettings(fallbackUserName: string): ChatDisplaySettings {
  try {
    const raw = localStorage.getItem(CHAT_DISPLAY_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        userName: parsed.userName || fallbackUserName,
        userColor: parsed.userColor || DEFAULT_USER_COLOR,
        userAvatar: parsed.userAvatar || undefined,
        aiName: parsed.aiName || 'DevRelay',
        aiColor: parsed.aiColor || DEFAULT_AI_COLOR,
        aiAvatar: parsed.aiAvatar || undefined,
      };
    }
  } catch { /* ignore */ }
  return {
    userName: fallbackUserName,
    userColor: DEFAULT_USER_COLOR,
    aiName: 'DevRelay',
    aiColor: DEFAULT_AI_COLOR,
  };
}

// ---------------------------------------------------------------------------
// サブコンポーネント
// ---------------------------------------------------------------------------

/** アバター（画像があれば画像、なければ色付き頭文字1文字） */
function Avatar({ name, color, image }: { name: string; color: string; image?: string }) {
  if (image) {
    return (
      <img
        src={image}
        alt={name}
        className="w-8 h-8 rounded-full object-cover shrink-0 mt-0.5"
      />
    );
  }
  const initial = name.charAt(0).toUpperCase();
  return (
    <div
      className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold text-white shrink-0 mt-0.5"
      style={{ backgroundColor: color }}
    >
      {initial}
    </div>
  );
}

/** Discord 風メッセージ行 */
function MessageRow({
  message,
  userName,
  userColor,
  userAvatar,
  aiName,
  aiColor,
  aiAvatar,
  onImageClick,
}: {
  message: ChatMessage;
  userName: string;
  userColor: string;
  userAvatar?: string;
  aiName: string;
  aiColor: string;
  aiAvatar?: string;
  onImageClick?: (src: string) => void;
}) {
  const isUser = message.role === 'user';
  const displayName = isUser ? userName : aiName;
  const displayColor = isUser ? userColor : aiColor;
  const displayAvatar = isUser ? userAvatar : aiAvatar;

  return (
    <div className="flex gap-3 px-2 py-1 hover:bg-[var(--bg-hover)] rounded group">
      <Avatar name={displayName} color={displayColor} image={displayAvatar} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="font-semibold text-sm" style={{ color: displayColor }}>
            {displayName}
          </span>
          <span className="text-xs text-[var(--text-faint)]">
            {message.timestamp.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
        <div className="text-sm text-[var(--text-primary)] leading-relaxed whitespace-pre-wrap break-words">
          {renderContent(message.content)}
        </div>
        {message.files && message.files.length > 0 && (
          <div className="mt-2 space-y-2">
            {message.files.map((f, i) => {
              const isImage = f.mimeType.startsWith('image/');
              // content がある場合は blob URL、id のみの場合は /api/files/:id を使用
              const fileUrl = f.content
                ? URL.createObjectURL(
                    new Blob([Uint8Array.from(atob(f.content), c => c.charCodeAt(0))], { type: f.mimeType })
                  )
                : f.id ? `/api/files/${f.id}?token=${getToken()}` : '';
              if (!fileUrl) return null;
              if (isImage) {
                return (
                  <div key={i}>
                    <img
                      src={fileUrl}
                      alt={f.filename}
                      className="max-w-xs max-h-60 rounded-lg border border-[var(--border-color)] cursor-pointer hover:opacity-90 transition-opacity"
                      onClick={() => onImageClick?.(fileUrl)}
                    />
                    <span className="block text-xs text-[var(--text-faint)] mt-0.5">{f.filename}</span>
                  </div>
                );
              }
              return (
                <a key={i} href={fileUrl} download={f.filename} className="block text-[var(--text-link)] hover:opacity-80 underline text-xs">
                  {f.filename}
                </a>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/** Discord 風進捗インジケーター */
function ProgressIndicator({ output, elapsed, aiName, aiColor, aiAvatar }: { output: string; elapsed: number; aiName: string; aiColor: string; aiAvatar?: string }) {
  /** ローカル経過タイマー（WS 切断中もカウント継続） */
  const [localElapsed, setLocalElapsed] = useState(elapsed);
  const startTimeRef = useRef(Date.now() - elapsed * 1000);

  // サーバーから新しい elapsed を受信したら基準時刻を同期
  useEffect(() => {
    startTimeRef.current = Date.now() - elapsed * 1000;
  }, [elapsed]);

  // 1秒間隔でローカルカウントアップ
  useEffect(() => {
    const timer = setInterval(() => {
      setLocalElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="flex gap-3 px-2 py-1 hover:bg-[var(--bg-hover)] rounded">
      <Avatar name={aiName} color={aiColor} image={aiAvatar} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="font-semibold text-sm" style={{ color: aiColor }}>
            {aiName}
          </span>
          <span className="text-xs text-[var(--text-faint)]">
            {new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
        <div className="flex items-center gap-2 text-sm text-[var(--text-link)]">
          <span className="animate-pulse">●</span>
          <span>処理中... ({localElapsed}秒経過)</span>
        </div>
        {output && (
          <pre className="text-xs text-[var(--text-secondary)] bg-[var(--bg-base)] rounded p-2 mt-1 overflow-x-auto max-h-48 overflow-y-auto">
            {output}
          </pre>
        )}
      </div>
    </div>
  );
}

/** 画像ライトボックス（クリックで全画面表示） */
function ImageLightbox({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const handleKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80"
      onClick={onClose}
    >
      <button
        onClick={onClose}
        className="absolute top-4 right-4 text-white/70 hover:text-white text-2xl leading-none p-2"
        title="閉じる"
      >
        <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
        </svg>
      </button>
      <img
        src={src}
        alt="拡大画像"
        className="max-w-[90vw] max-h-[90vh] object-contain rounded"
        onClick={e => e.stopPropagation()}
      />
    </div>
  );
}

/** 添付ファイルプレビュー。画像は大きめサムネ＋クリック拡大、ファイルはファイル名+サイズ表示 */
function AttachmentPreview({ files, onRemove, onImageClick }: { files: FileAttachment[]; onRemove: (i: number) => void; onImageClick?: (src: string) => void }) {
  if (files.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 px-4 py-2 bg-[var(--bg-secondary)] border-t border-[var(--border-color)]">
      {files.map((file, i) => {
        const isImage = file.mimeType.startsWith('image/');
        if (isImage) {
          const dataUrl = `data:${file.mimeType};base64,${file.content}`;
          return (
            <div key={i} className="relative group">
              <img
                src={dataUrl}
                alt={file.filename}
                className="max-h-40 max-w-xs object-contain rounded-lg border border-[var(--border-color)] cursor-pointer hover:opacity-90 transition-opacity"
                onClick={() => onImageClick?.(dataUrl)}
              />
              <button
                onClick={() => onRemove(i)}
                className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-red-500 text-white rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                title="削除"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" strokeWidth="2.5" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          );
        }
        return (
          <div key={i} className="relative flex items-center gap-2 bg-[var(--bg-tertiary)] rounded-lg px-3 py-1.5 text-sm text-[var(--text-secondary)]">
            <svg className="w-4 h-4 text-[var(--text-muted)]" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
            </svg>
            <span className="max-w-[120px] truncate">{file.filename}</span>
            <span className="text-xs text-[var(--text-faint)]">{formatFileSize(file.content)}</span>
            <button onClick={() => onRemove(i)} className="ml-1 text-[var(--text-faint)] hover:text-red-400" title="削除">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// タブバー
// ---------------------------------------------------------------------------

function TabBar({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onTogglePin,
  onReorder,
  onDoubleClickTab,
  onRenameTab,
}: {
  tabs: Tab[];
  activeTabId: string | null;
  onSelectTab: (projectId: string) => void;
  onCloseTab: (projectId: string) => void;
  onTogglePin: (projectId: string) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  onDoubleClickTab: () => void;
  onRenameTab: (projectId: string, newName: string) => void;
}) {
  /** ドラッグ中のタブ index */
  const dragIndexRef = useRef<number | null>(null);
  /** ドロップ先のタブ index */
  const dragOverIndexRef = useRef<number | null>(null);
  /** 編集中のタブ projectId */
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const editInputRef = useRef<HTMLInputElement | null>(null);

  /** 編集確定 */
  const commitEdit = useCallback((projectId: string) => {
    const value = editInputRef.current?.value.trim() ?? '';
    onRenameTab(projectId, value);
    setEditingTabId(null);
  }, [onRenameTab]);

  if (tabs.length === 0) return null;

  /** ピン止めタブを先頭に、通常タブを後ろに表示 */
  const pinnedTabs = tabs.filter(t => t.pinned);
  const unpinnedTabs = tabs.filter(t => !t.pinned);
  const orderedTabs = [...pinnedTabs, ...unpinnedTabs];

  return (
    <div className="flex items-center bg-[var(--bg-secondary)] border-b border-[var(--border-color)] overflow-x-auto scrollbar-thin">
      {orderedTabs.map((tab) => {
        const globalIndex = tabs.indexOf(tab);
        const isActive = tab.projectId === activeTabId;
        const isEditing = editingTabId === tab.projectId;
        const displayName = tab.customName || tab.projectName;
        return (
          <div
            key={tab.projectId}
            draggable={!isEditing}
            onDragStart={() => { dragIndexRef.current = globalIndex; }}
            onDragOver={(e) => { e.preventDefault(); dragOverIndexRef.current = globalIndex; }}
            onDrop={() => {
              if (dragIndexRef.current !== null && dragOverIndexRef.current !== null && dragIndexRef.current !== dragOverIndexRef.current) {
                onReorder(dragIndexRef.current, dragOverIndexRef.current);
              }
              dragIndexRef.current = null;
              dragOverIndexRef.current = null;
            }}
            onDragEnd={() => { dragIndexRef.current = null; dragOverIndexRef.current = null; }}
            className={`
              group flex items-center gap-1.5 px-3 py-1.5 text-sm cursor-pointer border-b-2 shrink-0 select-none
              ${isActive
                ? 'border-blue-500 text-[var(--text-primary)] bg-[var(--bg-hover)]'
                : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
              }
            `}
            onClick={() => onSelectTab(tab.projectId)}
            onDoubleClick={onDoubleClickTab}
          >
            {/* ピン止めアイコン（ピン済み時は常時表示、未ピン時はホバーで表示） */}
            <button
              onClick={(e) => { e.stopPropagation(); onTogglePin(tab.projectId); }}
              className={`shrink-0 transition-opacity ${
                tab.pinned
                  ? 'text-[var(--text-link)] opacity-100'
                  : 'text-[var(--text-faint)] opacity-0 group-hover:opacity-60 hover:!opacity-100'
              }`}
              title={tab.pinned ? 'ピン止め解除' : 'ピン止め'}
            >
              <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor">
                <path d="M4.456.734a1.75 1.75 0 0 1 2.826.504l.613 1.327a3.1 3.1 0 0 0 2.084 1.707l2.454.584c1.332.317 1.8 1.972.78 2.748L11.06 9.3a3.1 3.1 0 0 0-1.088 2.39l.06 1.9c.04 1.32-1.283 2.24-2.4 1.67L5.4 14.14a3.1 3.1 0 0 0-2.7-.09L1.28 14.75c-1.097.53-2.348-.43-2.27-1.74l.12-1.96a3.1 3.1 0 0 0-.97-2.44L-3.38 7.14c-.98-.87-.42-2.5.93-2.71l2.5-.4a3.1 3.1 0 0 0 2.16-1.56z" transform="translate(3, 1) scale(0.8)" />
              </svg>
            </button>
            {/* 状態アイコン: 実行中 → スピナー、完了 → チェック、通常 → # */}
            {tab.progress ? (
              <span className="w-3 h-3 border-2 border-[var(--accent-blue)] border-t-transparent rounded-full animate-spin inline-block shrink-0" />
            ) : tab.completed ? (
              <span className="text-green-500 text-xs shrink-0">✓</span>
            ) : (
              <span className="text-[var(--text-faint)]">#</span>
            )}
            {/* タブ名: ダブルクリックでインライン編集 */}
            {isEditing ? (
              <input
                ref={editInputRef}
                defaultValue={displayName}
                className="bg-[var(--bg-base)] text-[var(--text-primary)] border border-[var(--border-color)] rounded px-1 text-sm w-24 outline-none focus:border-blue-500"
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') commitEdit(tab.projectId);
                  if (e.key === 'Escape') setEditingTabId(null);
                }}
                onBlur={() => commitEdit(tab.projectId)}
                autoFocus
              />
            ) : (
              <span
                className={isActive ? 'font-semibold' : ''}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  setEditingTabId(tab.projectId);
                }}
                title="ダブルクリックで名前を変更"
              >
                {displayName}
              </span>
            )}
            {/* 閉じるボタン: ピン止め時は非表示 */}
            {!tab.pinned && (
              <button
                onClick={(e) => { e.stopPropagation(); onCloseTab(tab.projectId); }}
                className="ml-1 text-[var(--text-faint)] hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                title="タブを閉じる"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// サイドバー
// ---------------------------------------------------------------------------

function Sidebar({
  machineList,
  openTabIds,
  activeTabId,
  onSelectProject,
  collapsed,
  onToggle,
}: {
  machineList: Machine[];
  openTabIds: Set<string>;
  activeTabId: string | null;
  onSelectProject: (projectId: string) => void;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const [expandedMachines, setExpandedMachines] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (machineList.length > 0 && expandedMachines.size === 0) {
      const onlineIds = machineList.filter(m => m.status === 'online').map(m => m.id);
      setExpandedMachines(new Set(onlineIds.length > 0 ? onlineIds : [machineList[0].id]));
    }
  }, [machineList, expandedMachines.size]);

  const toggleMachine = (id: string) => {
    setExpandedMachines(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const sorted = [...machineList].sort((a, b) => {
    if (a.status === 'online' && b.status !== 'online') return -1;
    if (a.status !== 'online' && b.status === 'online') return 1;
    return (a.displayName ?? a.name).localeCompare(b.displayName ?? b.name);
  });

  return (
    <>
      {!collapsed && (
        <div className="fixed inset-0 bg-black/50 z-20 md:hidden" onClick={onToggle} />
      )}

      <aside
        className={`
          ${collapsed ? '-translate-x-full' : 'translate-x-0'}
          fixed md:relative md:translate-x-0
          z-30 md:z-auto
          w-56 h-full
          bg-[var(--bg-secondary)] border-r border-[var(--border-color)]
          flex flex-col
          transition-transform duration-200 ease-in-out
          shrink-0
        `}
      >
        <div className="flex items-center justify-between px-3 py-3 border-b border-[var(--border-color)]">
          <button
            onClick={() => {
              if (expandedMachines.size > 0) {
                setExpandedMachines(new Set());
              } else {
                setExpandedMachines(new Set(sorted.map(m => m.id)));
              }
            }}
            className="text-sm font-semibold text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
          >Agents</button>
          <button onClick={onToggle} className="md:hidden text-[var(--text-muted)] hover:text-[var(--text-primary)]">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto py-1">
          {sorted.length === 0 && (
            <div className="px-3 py-4 text-xs text-[var(--text-faint)] text-center">
              エージェントがありません
            </div>
          )}
          {sorted.map(machine => {
            const displayName = machine.displayName ?? machine.name;
            const isOnline = machine.status === 'online';
            const isExpanded = expandedMachines.has(machine.id);

            return (
              <div key={machine.id}>
                <button
                  onClick={() => toggleMachine(machine.id)}
                  className="w-full flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
                >
                  <svg
                    className={`w-3 h-3 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                    fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
                  </svg>
                  <span className={`w-2 h-2 rounded-full ${isOnline ? 'bg-green-500' : 'bg-[var(--bg-selected)]'}`} />
                  <span className="truncate">{displayName}</span>
                </button>

                {isExpanded && (
                  <div className="ml-2">
                    {machine.projects.length === 0 ? (
                      <div className="px-3 py-1 text-xs text-[var(--text-faint)] italic">プロジェクトなし</div>
                    ) : (
                      machine.projects.map(project => {
                        const hasTab = openTabIds.has(project.id);
                        const isActive = project.id === activeTabId;
                        return (
                          <button
                            key={project.id}
                            onClick={() => {
                              onSelectProject(project.id);
                              if (window.innerWidth < 768) onToggle();
                            }}
                            disabled={!isOnline}
                            className={`
                              w-full text-left flex items-center gap-1.5 px-3 py-1 rounded-md mx-1 text-sm
                              ${isActive
                                ? 'bg-[var(--bg-selected)] text-[var(--text-primary)] font-semibold'
                                : hasTab
                                  ? 'text-[var(--text-primary)] font-semibold hover:bg-[var(--bg-hover)]'
                                  : isOnline
                                    ? 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                                    : 'text-[var(--text-faint)] cursor-not-allowed'
                              }
                            `}
                            title={project.path}
                          >
                            <span className={hasTab ? 'text-yellow-400' : 'text-[var(--text-faint)]'}>
                              {hasTab ? '★' : '#'}
                            </span>
                            <span className="truncate">{project.name}</span>
                          </button>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </aside>
    </>
  );
}

// ---------------------------------------------------------------------------
// セッション情報パネル（右サイド）
// ---------------------------------------------------------------------------

/** セッション情報パネル（右サイドバー） */
function SessionInfoPanel(_props: { sessionId: string | null; refreshTrigger: number }) {
  return (
    <aside className="w-52 shrink-0 hidden lg:block border-l border-[var(--border-color)] bg-[var(--bg-secondary)] p-3">
    </aside>
  );
}

// ---------------------------------------------------------------------------
// メインコンポーネント
// ---------------------------------------------------------------------------

export function ChatPage() {
  const { user } = useAuth();
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [pendingFiles, setPendingFiles] = useState<FileAttachment[]>([]);
  const [machineList, setMachineList] = useState<Machine[]>([]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  /** ライトボックス表示用の画像 URL */
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);
  /** セッション情報パネル再取得トリガー */
  const [sessionRefreshCount, setSessionRefreshCount] = useState(0);
  /** チャットエリア最大化（サイドバー・右パネル・ナビバー非表示） */
  const [maximized, setMaximized] = useState(false);

  // 最大化時に body にクラスを付与してナビバーを CSS で隠す
  useEffect(() => {
    if (maximized) {
      document.body.classList.add('chat-maximized');
    } else {
      document.body.classList.remove('chat-maximized');
    }
    return () => document.body.classList.remove('chat-maximized');
  }, [maximized]);

  /** チャット表示設定（localStorage 管理、storage イベントで他タブと同期） */
  const fallbackName = user?.name || user?.email || 'User';
  const [chatDisplay, setChatDisplay] = useState<ChatDisplaySettings>(() => getChatDisplaySettings(fallbackName));

  useEffect(() => {
    setChatDisplay(getChatDisplaySettings(fallbackName));
    // サーバーからチャット表示設定を取得して localStorage を更新
    settingsApi.getChatDisplay().then(json => {
      if (json) {
        try {
          const server = JSON.parse(json);
          const merged: ChatDisplaySettings = {
            userName: server.userName || fallbackName,
            userColor: server.userColor || DEFAULT_USER_COLOR,
            userAvatar: server.userAvatar || undefined,
            aiName: server.aiName || 'DevRelay',
            aiColor: server.aiColor || DEFAULT_AI_COLOR,
            aiAvatar: server.aiAvatar || undefined,
          };
          setChatDisplay(merged);
          localStorage.setItem(CHAT_DISPLAY_KEY, JSON.stringify(merged));
        } catch { /* ignore */ }
      }
    }).catch(() => { /* ignore */ });
    const handleStorage = (e: StorageEvent) => {
      if (e.key === CHAT_DISPLAY_KEY) setChatDisplay(getChatDisplaySettings(fallbackName));
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, [fallbackName]);
  /** タブ切り替え由来の //connect レスポンスを抑制するフラグ */
  const suppressConnectRef = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** tabs/activeTabId の最新値を参照する ref */
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  /** 初回タブ復元済みフラグ */
  const restoredRef = useRef(false);

  /** セッションIDからタブにメッセージ履歴を読み込む */
  const loadHistory = useCallback(async (projectId: string, _sessionId?: string) => {
    // 履歴読み込み中はスクロールを抑制
    shouldAutoScrollRef.current = false;
    // 読み込み中フラグを立てる
    setTabs(prev => prev.map(t =>
      t.projectId === projectId ? { ...t, loadingHistory: true } : t
    ));

    try {
      // プロジェクト横断で全セッションのメッセージを取得
      const { messages, hasMore } = await projectsApi.getMessages(projectId, { limit: 30 });
      const chatMessages: ChatMessage[] = messages.map(m => ({
        id: m.id,
        role: m.role === 'ai' ? 'system' as const : m.role,
        content: m.content,
        timestamp: new Date(m.createdAt),
        files: m.files && m.files.length > 0 ? m.files : undefined,
      }));

      setTabs(prev => prev.map(t => {
        if (t.projectId !== projectId) return t;
        // 既存のリアルタイムメッセージと重複しないよう、既存メッセージIDをセットに
        const existingIds = new Set(t.messages.map(m => m.id));
        const newMsgs = chatMessages.filter(m => !existingIds.has(m.id));
        return {
          ...t,
          messages: [...newMsgs, ...t.messages],
          historyLoaded: true,
          hasMoreHistory: hasMore,
          loadingHistory: false,
        };
      }));

      // 履歴読み込み完了後、アクティブタブなら最下部にスクロール
      if (activeTabIdRef.current === projectId) {
        requestAnimationFrame(() => {
          messagesEndRef.current?.scrollIntoView({ behavior: 'instant' as ScrollBehavior });
          shouldAutoScrollRef.current = true;
        });
      }
    } catch {
      setTabs(prev => prev.map(t =>
        t.projectId === projectId ? { ...t, historyLoaded: true, loadingHistory: false } : t
      ));

      // エラー時もスクロール復元
      if (activeTabIdRef.current === projectId) {
        shouldAutoScrollRef.current = true;
      }
    }
  }, []);

  /**
   * メッセージをタブに追加（projectId で対象タブを特定、省略時はアクティブタブ）
   */
  const addMessageToTab = useCallback((msg: Omit<ChatMessage, 'id' | 'timestamp'>, projectId?: string) => {
    // projectId が指定され、該当タブがある場合はそのタブに追加
    const targetId = projectId
      ? (tabsRef.current.some(t => t.projectId === projectId) ? projectId : activeTabIdRef.current)
      : activeTabIdRef.current;
    if (!targetId) return;

    // //connect 応答を抑制（タブ切り替え由来）— 再接続メッセージも含む
    if (suppressConnectRef.current) {
      suppressConnectRef.current = false;
      if (msg.role === 'system' && (msg.content.includes('に接続') || msg.content.includes('に再接続'))) {
        return;
      }
    }

    // 新メッセージ受信時は smooth スクロールを有効に（アクティブタブの場合のみ）
    if (targetId === activeTabIdRef.current) {
      shouldAutoScrollRef.current = true;
    }
    const newMsg: ChatMessage = { ...msg, id: nextMessageId(), timestamp: new Date() };
    setTabs(prev => prev.map(t =>
      t.projectId === targetId ? { ...t, messages: [...t.messages, newMsg] } : t
    ));
  }, []);

  /**
   * 進捗を更新（projectId で対象タブを特定、省略時はアクティブタブ）
   */
  const updateProgressOnTab = useCallback((info: ProgressInfo, projectId?: string) => {
    const targetId = projectId
      ? (tabsRef.current.some(t => t.projectId === projectId) ? projectId : activeTabIdRef.current)
      : activeTabIdRef.current;
    if (!targetId) return;
    setTabs(prev => prev.map(t =>
      t.projectId === targetId ? { ...t, progress: info } : t
    ));
  }, []);

  /**
   * 進捗をクリア（projectId で対象タブを特定、省略時はアクティブタブ）
   * //connect 応答では進捗をクリアしない（suppressConnectRef でガード）
   */
  const clearProgressOnTab = useCallback((projectId?: string) => {
    // //connect レスポンス由来の場合は進捗をクリアしない
    if (suppressConnectRef.current) return;
    const targetId = projectId
      ? (tabsRef.current.some(t => t.projectId === projectId) ? projectId : activeTabIdRef.current)
      : activeTabIdRef.current;
    if (!targetId) return;
    setTabs(prev => prev.map(t =>
      t.projectId === targetId ? { ...t, progress: null, completed: t.progress !== null } : t
    ));
    // AI 応答完了 → セッション情報パネルを再取得
    setSessionRefreshCount(c => c + 1);
  }, []);

  /** セッション情報受信: sessionId をタブに保存し、履歴未読み込みなら読み込み開始 */
  const handleSessionInfo = useCallback((projectId: string, sessionId: string) => {
    setTabs(prev => {
      const tab = prev.find(t => t.projectId === projectId);
      if (!tab) return prev;
      // sessionId を更新
      const updated = prev.map(t =>
        t.projectId === projectId ? { ...t, sessionId } : t
      );
      // 履歴未読み込みなら読み込み開始
      if (!tab.historyLoaded && !tab.loadingHistory) {
        loadHistory(projectId, sessionId);
      }
      return updated;
    });
  }, [loadHistory]);

  const { connected, sendCommand } = useWebSocket({
    onMessage: addMessageToTab,
    onProgress: updateProgressOnTab,
    onProgressClear: clearProgressOnTab,
    onSessionInfo: handleSessionInfo,
  });

  // マシン一覧取得 + ポーリング（10秒）
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const list = await machinesApi.list();
        if (active) setMachineList(list);
      } catch {
        // ポーリングエラーは無視
      }
    };
    load();
    const interval = setInterval(load, 10000);
    return () => { active = false; clearInterval(interval); };
  }, []);

  // マウント時にアクティブセッションを取得してタブを復元
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;

    (async () => {
      try {
        const { sessions: activeSessions } = await sessionsApi.getActive();

        // 先にピン止め状態を取得（machineOnline フィルタの前に必要）
        let pinnedIds: Set<string>;
        try {
          const serverPinned = await settingsApi.getPinnedTabs();
          pinnedIds = serverPinned.length > 0 ? new Set(serverPinned) : getPinnedTabIds();
          if (serverPinned.length > 0) {
            localStorage.setItem('devrelay-pinned-tabs', JSON.stringify(serverPinned));
          }
        } catch {
          pinnedIds = getPinnedTabIds();
        }

        // ピン止めタブのみ復元（非ピン止めタブはセッション中に動的追加される）
        // バツで閉じたタブがリロードで復活するのを防止
        const restorable = activeSessions.filter(
          s => s.messageCount > 0 && pinnedIds.has(s.projectId)
        );
        if (restorable.length === 0) return;

        const savedNames = getTabNames();
        const newTabs: Tab[] = restorable.map(s => ({
          projectId: s.projectId,
          projectName: s.projectName,
          machineDisplayName: s.machineDisplayName,
          customName: savedNames[s.projectId],
          messages: [],
          progress: null,
          sessionId: s.sessionId,
          historyLoaded: false,
          hasMoreHistory: true,
          loadingHistory: false,
          pinned: pinnedIds.has(s.projectId),
          completed: false,
        }));

        setTabs(newTabs);
        setActiveTabId(newTabs[0].projectId);
        activeTabIdRef.current = newTabs[0].projectId;

        // 最初のタブの履歴を読み込み + サーバーコンテキスト同期
        sendCommand(`//connect ${newTabs[0].projectId}`);
        suppressConnectRef.current = true;
        loadHistory(newTabs[0].projectId, newTabs[0].sessionId!);
      } catch {
        // 復元失敗は無視
      }
    })();
  }, [sendCommand, loadHistory]);

  // アクティブタブ取得
  const activeTab = tabs.find(t => t.projectId === activeTabId) ?? null;

  // メッセージ追加時に自動スクロール（上スクロール読み込み中・タブ切替時は抑制）
  const shouldAutoScrollRef = useRef(true);
  useEffect(() => {
    if (shouldAutoScrollRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [activeTab?.messages, activeTab?.progress]);

  // タブ切替時は instant で最下部に移動（アニメーションなし）+ 入力フォーカス
  useEffect(() => {
    shouldAutoScrollRef.current = false;
    messagesEndRef.current?.scrollIntoView({ behavior: 'instant' as ScrollBehavior });
    inputRef.current?.focus();
  }, [activeTabId]);

  /** 古いメッセージを追加読み込み（ページネーション） */
  const loadOlderMessages = useCallback(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    const tabId = activeTabIdRef.current;
    if (!tabId) return;
    const tab = tabsRef.current.find(t => t.projectId === tabId);
    if (!tab || !tab.hasMoreHistory || tab.loadingHistory) return;

    const oldestMsg = tab.messages[0];
    if (!oldestMsg) return;

    const prevScrollHeight = container.scrollHeight;
    shouldAutoScrollRef.current = false;

    setTabs(prev => prev.map(t =>
      t.projectId === tabId ? { ...t, loadingHistory: true } : t
    ));

    // プロジェクト横断で全セッションのメッセージを取得
    projectsApi.getMessages(tabId, { before: oldestMsg.id, limit: 30 }).then(({ messages, hasMore }) => {
      const chatMessages: ChatMessage[] = messages.map(m => ({
        id: m.id,
        role: m.role === 'ai' ? 'system' as const : m.role,
        content: m.content,
        timestamp: new Date(m.createdAt),
        files: m.files && m.files.length > 0 ? m.files : undefined,
      }));

      setTabs(prev => prev.map(t => {
        if (t.projectId !== tabId) return t;
        const existingIds = new Set(t.messages.map(m => m.id));
        const newMsgs = chatMessages.filter(m => !existingIds.has(m.id));
        return {
          ...t,
          messages: [...newMsgs, ...t.messages],
          hasMoreHistory: hasMore,
          loadingHistory: false,
        };
      }));

      // スクロール位置を保持（新しいメッセージ分だけスクロール）
      requestAnimationFrame(() => {
        if (container) {
          container.scrollTop = container.scrollHeight - prevScrollHeight;
        }
      });
    }).catch(() => {
      setTabs(prev => prev.map(t =>
        t.projectId === tabId ? { ...t, loadingHistory: false } : t
      ));
    });
  }, []);

  /** 無限スクロール: 上にスクロールしたら古いメッセージを追加読み込み */
  const handleScroll = useCallback(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    // ユーザーが下端から離れたら自動スクロールを無効化（Agent 実行中の snap-back 防止）
    const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 50;
    if (!atBottom) {
      shouldAutoScrollRef.current = false;
    }

    const tabId = activeTabIdRef.current;
    if (!tabId) return;

    const tab = tabsRef.current.find(t => t.projectId === tabId);
    if (!tab || !tab.sessionId) return;

    // 履歴未読み込みかつ読み込み中でない → loadHistory で初期読み込み
    if (!tab.historyLoaded && !tab.loadingHistory) {
      loadHistory(tab.projectId, tab.sessionId);
      return;
    }

    // スクロール位置が上端近くにいる場合 → ページネーション
    if (container.scrollTop < 100) {
      loadOlderMessages();
    }
  }, []);

  // コンテナが非スクロール（メッセージ少）かつ追加履歴ありなら自動で追加読み込み
  useEffect(() => {
    if (!activeTab?.historyLoaded || !activeTab?.hasMoreHistory || activeTab?.loadingHistory) return;
    // DOM 更新後にコンテナサイズをチェック
    requestAnimationFrame(() => {
      const container = messagesContainerRef.current;
      if (!container) return;
      if (container.scrollHeight <= container.clientHeight) {
        loadOlderMessages();
      }
    });
  }, [activeTab?.historyLoaded, activeTab?.hasMoreHistory, activeTab?.loadingHistory, loadOlderMessages]);

  /** プロジェクト選択（サイドバー or タブクリック） */
  const handleSelectProject = useCallback((projectId: string) => {
    if (activeTabIdRef.current === projectId) return;

    const existingTab = tabsRef.current.find(t => t.projectId === projectId);
    if (!existingTab) {
      let projectName = projectId;
      let machineDisplayName = '';
      for (const m of machineList) {
        const p = m.projects.find(p => p.id === projectId);
        if (p) {
          projectName = p.name;
          machineDisplayName = m.displayName ?? m.name;
          break;
        }
      }

      const newTab: Tab = {
        projectId,
        projectName,
        machineDisplayName,
        customName: getTabNames()[projectId],
        messages: [],
        progress: null,
        sessionId: null,
        historyLoaded: false,
        hasMoreHistory: false,
        loadingHistory: false,
        pinned: false,
        completed: false,
      };
      setTabs(prev => [...prev, newTab]);
    }

    setActiveTabId(projectId);

    // サーバーにコンテキスト切り替えを通知
    suppressConnectRef.current = true;
    sendCommand(`//connect ${projectId}`);

    // 既存タブでセッションIDがあり、履歴未読み込みなら読み込み開始
    if (existingTab?.sessionId && !existingTab.historyLoaded && !existingTab.loadingHistory) {
      loadHistory(projectId, existingTab.sessionId);
    }
  }, [machineList, sendCommand, loadHistory]);

  /** タブを閉じる（ピン止めタブは閉じない） */
  const handleCloseTab = useCallback((projectId: string) => {
    setTabs(prev => {
      const tab = prev.find(t => t.projectId === projectId);
      if (tab?.pinned) return prev;
      const newTabs = prev.filter(t => t.projectId !== projectId);
      if (activeTabIdRef.current === projectId) {
        const closedIdx = prev.findIndex(t => t.projectId === projectId);
        const nextTab = newTabs[Math.min(closedIdx, newTabs.length - 1)] ?? null;
        const nextId = nextTab?.projectId ?? null;
        setActiveTabId(nextId);
        if (nextId) {
          suppressConnectRef.current = true;
          sendCommand(`//connect ${nextId}`);
        }
      }
      return newTabs;
    });
  }, [sendCommand]);

  /** タブのピン止めを切り替え（サーバーにも永続化） */
  const handleTogglePin = useCallback((projectId: string) => {
    setTabs(prev => {
      const updated = prev.map(t =>
        t.projectId === projectId ? { ...t, pinned: !t.pinned } : t
      );
      savePinnedTabIds(updated);
      // サーバーにも保存（fire-and-forget）
      const pinnedIds = updated.filter(t => t.pinned).map(t => t.projectId);
      settingsApi.savePinnedTabs(pinnedIds).catch(() => {});
      return updated;
    });
  }, []);

  /** タブ名の変更（空文字の場合はリセット） */
  const handleRenameTab = useCallback((projectId: string, newName: string) => {
    setTabs(prev => {
      const updated = prev.map(t =>
        t.projectId === projectId
          ? { ...t, customName: newName || undefined }
          : t
      );
      saveTabNames(updated);
      return updated;
    });
  }, []);

  /** タブの並べ替え（ドラッグ&ドロップ） */
  const handleReorderTabs = useCallback((fromIndex: number, toIndex: number) => {
    setTabs(prev => {
      const updated = [...prev];
      const [moved] = updated.splice(fromIndex, 1);
      updated.splice(toIndex, 0, moved);
      return updated;
    });
  }, []);

  /** ファイルを pendingFiles に追加 */
  const addFiles = async (fileList: File[]) => {
    const attachments = await Promise.all(fileList.map(fileToAttachment));
    setPendingFiles(prev => [...prev, ...attachments]);
  };

  const handleSend = () => {
    const text = input.trim();
    const hasFiles = pendingFiles.length > 0;
    if ((!text && !hasFiles) || !connected) return;
    const sendText = text || pendingFiles.map(f => f.filename).join(', ');

    if (activeTabId) {
      // 送信時は自動スクロールを再有効化（手動スクロール中でも最下部に戻す）
      shouldAutoScrollRef.current = true;
      const userMsg: ChatMessage = {
        id: nextMessageId(),
        role: 'user',
        content: sendText,
        timestamp: new Date(),
        files: hasFiles ? pendingFiles : undefined,
      };
      setTabs(prev => prev.map(t =>
        t.projectId === activeTabId ? { ...t, messages: [...t.messages, userMsg], completed: false } : t
      ));
    }

    sendCommand(sendText, hasFiles ? pendingFiles : undefined);
    setInput('');
    setPendingFiles([]);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handlePaste = async (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].kind === 'file') {
        const file = items[i].getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      await addFiles(files);
      return;
    }

    // 長文テキストのペースト → ファイル添付に変換（1000文字以上）
    const text = e.clipboardData?.getData('text/plain');
    if (text && text.length >= 1000) {
      e.preventDefault();
      const blob = new Blob([text], { type: 'text/plain' });
      const file = new File([blob], 'pasted-text.txt', { type: 'text/plain' });
      await addFiles([file]);
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) await addFiles(files);
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) await addFiles(files);
    e.target.value = '';
  };

  const openTabIds = new Set(tabs.map(t => t.projectId));

  return (
    <div className={`flex ${maximized ? 'h-screen' : 'h-[calc(100vh-4rem)]'}`}>
      {/* サイドバー（最大化時は非表示） */}
      {!maximized && (
        <Sidebar
          machineList={machineList}
          openTabIds={openTabIds}
          activeTabId={activeTabId}
          onSelectProject={handleSelectProject}
          collapsed={sidebarCollapsed}
          onToggle={() => setSidebarCollapsed(prev => !prev)}
        />
      )}

      {/* チャットエリア */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* ヘッダー */}
        <div className="flex items-center justify-between px-4 py-2 bg-[var(--bg-secondary)] border-b border-[var(--border-color)]">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setSidebarCollapsed(prev => !prev)}
              className="md:hidden text-[var(--text-muted)] hover:text-[var(--text-primary)] p-1"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
              </svg>
            </button>
            <span className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`} />
            <span className="text-sm text-[var(--text-muted)]">
              {activeTab ? `# ${activeTab.customName || activeTab.projectName}` : connected ? '接続中' : '切断中...'}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-[var(--text-faint)] hidden sm:inline">h: ヘルプ</span>
            {activeTab && activeTab.messages.length > 0 && (
              <button
                onClick={() => setTabs(prev => prev.map(t =>
                  t.projectId === activeTabId ? { ...t, messages: [], progress: null } : t
                ))}
                className="text-xs text-[var(--text-faint)] hover:text-[var(--text-secondary)] px-2 py-1 rounded hover:bg-[var(--bg-tertiary)]"
              >
                クリア
              </button>
            )}
          </div>
        </div>

        {/* タブバー */}
        <TabBar
          tabs={tabs}
          activeTabId={activeTabId}
          onSelectTab={handleSelectProject}
          onCloseTab={handleCloseTab}
          onTogglePin={handleTogglePin}
          onReorder={handleReorderTabs}
          onDoubleClickTab={() => setMaximized(prev => !prev)}
          onRenameTab={handleRenameTab}
        />

        {/* メッセージエリア */}
        <div
          ref={messagesContainerRef}
          className="flex-1 overflow-y-auto px-4 py-4"
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleDrop}
          onScroll={handleScroll}
        >
          {/* 履歴読み込み中インジケーター */}
          {activeTab?.loadingHistory && (
            <div className="flex justify-center py-2 mb-2">
              <span className="text-xs text-[var(--text-faint)] animate-pulse">履歴を読み込み中...</span>
            </div>
          )}
          {!activeTab && (
            <div className="flex items-center justify-center h-full">
              <div className="text-center text-[var(--text-faint)]">
                <p className="text-lg mb-2 text-[var(--text-muted)]">DevRelay Chat</p>
                <p className="text-sm">
                  {machineList.length > 0
                    ? '左のサイドバーからプロジェクトを選んで開始'
                    : '`m` でエージェント一覧を表示して開始できます'}
                </p>
                <p className="text-xs mt-1">
                  Shift+Enter で改行、Enter で送信、Ctrl+V で画像貼り付け
                </p>
              </div>
            </div>
          )}
          {activeTab && activeTab.messages.length === 0 && !activeTab.progress && !activeTab.loadingHistory && (
            <div className="flex items-center justify-center h-full">
              <div className="text-center text-[var(--text-faint)]">
                <p className="text-sm">
                  <span className="text-[var(--text-muted)] font-semibold"># {activeTab.customName || activeTab.projectName}</span> に接続中
                </p>
                <p className="text-xs mt-1">
                  メッセージを入力して送信してください
                </p>
              </div>
            </div>
          )}
          {activeTab?.messages.map((msg) => (
            <MessageRow
              key={msg.id}
              message={msg}
              userName={chatDisplay.userName}
              userColor={chatDisplay.userColor}
              userAvatar={chatDisplay.userAvatar}
              aiName={chatDisplay.aiName}
              aiColor={chatDisplay.aiColor}
              aiAvatar={chatDisplay.aiAvatar}
              onImageClick={setLightboxImage}
            />
          ))}
          {activeTab?.progress && (
            <ProgressIndicator
              output={activeTab.progress.output}
              elapsed={activeTab.progress.elapsed}
              aiName={chatDisplay.aiName}
              aiColor={chatDisplay.aiColor}
              aiAvatar={chatDisplay.aiAvatar}
            />
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* 添付プレビュー */}
        <AttachmentPreview
          files={pendingFiles}
          onRemove={(i) => setPendingFiles(prev => prev.filter((_, idx) => idx !== i))}
          onImageClick={setLightboxImage}
        />

        {/* 入力エリア */}
        <div className="px-4 py-3 bg-[var(--bg-secondary)] border-t border-[var(--border-color)]">
          <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileSelect} />
          <div className="flex gap-2 items-end">
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={!connected || !activeTab}
              className="p-2 text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-50 transition-colors"
              title="ファイルを添付"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="m18.375 12.739-7.693 7.693a4.5 4.5 0 0 1-6.364-6.364l10.94-10.94A3 3 0 1 1 19.5 7.372L8.552 18.32m.009-.01-.01.01m5.699-9.941-7.81 7.81a1.5 1.5 0 0 0 2.112 2.13" />
              </svg>
            </button>
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={!activeTab ? 'プロジェクトを選択してください' : connected ? 'コマンドまたはメッセージを入力...' : '接続中...'}
              disabled={!connected || !activeTab}
              rows={1}
              className="flex-1 bg-[var(--input-bg)] text-[var(--text-primary)] rounded-lg px-4 py-2 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 placeholder-[var(--text-faint)]"
              style={{ minHeight: '40px', maxHeight: '120px' }}
              onInput={(e) => {
                const target = e.target as HTMLTextAreaElement;
                target.style.height = '40px';
                target.style.height = `${Math.min(target.scrollHeight, 120)}px`;
              }}
            />
            <button
              onClick={handleSend}
              disabled={!connected || !activeTab || (!input.trim() && pendingFiles.length === 0)}
              className="px-4 py-2 bg-[var(--accent-blue)] text-white rounded-lg hover:bg-[var(--accent-blue-hover)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              送信
            </button>
          </div>
        </div>
      </div>

      {/* セッション情報パネル（右サイド、大画面のみ、最大化時は非表示） */}
      {!maximized && (
        <SessionInfoPanel
          sessionId={activeTab?.sessionId ?? null}
          refreshTrigger={sessionRefreshCount}
        />
      )}

      {/* 画像ライトボックス */}
      {lightboxImage && (
        <ImageLightbox src={lightboxImage} onClose={() => setLightboxImage(null)} />
      )}
    </div>
  );
}
