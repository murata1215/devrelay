import { useState, useRef, useEffect, useCallback, type KeyboardEvent, type ClipboardEvent } from 'react';
import { useWebSocket, type ChatMessage, type ProgressInfo, type ToolApprovalPrompt, type ToolApprovalResolved, type ToolApprovalAuto } from '../hooks/useWebSocket';
import { machines as machinesApi, sessions as sessionsApi, projects as projectsApi, settings as settingsApi, agentDocuments, getToken, type Machine, type AgentDocMeta, type ChatServer } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { playNotificationSound } from '../utils/notification-sound';

/** 1タブあたりの最大メッセージ保持数（超過分は古い方から除去） */
const MAX_MESSAGES = 50;

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
  /** タブごとの入力テキスト（タブ切り替え時に保持） */
  inputText: string;
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

/** バイト数を人間が読める形式に変換 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** テキストとしてプレビュー可能なファイルか判定 */
const TEXT_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs',
  'java', 'kt', 'swift', 'c', 'cpp', 'h', 'hpp', 'cs', 'md', 'mdx',
  'yml', 'yaml', 'json', 'toml', 'ini', 'cfg', 'conf', 'sh', 'bash',
  'zsh', 'sql', 'graphql', 'vue', 'svelte', 'prisma', 'env', 'log',
  'diff', 'patch', 'txt', 'csv', 'xml', 'html', 'css', 'scss', 'less',
]);

function isTextPreviewable(mimeType: string, filename: string): boolean {
  if (mimeType.startsWith('text/')) return true;
  if (['application/json', 'application/xml', 'application/yaml',
       'application/x-yaml', 'application/javascript', 'application/typescript',
       'application/x-sh'].includes(mimeType)) return true;
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return TEXT_EXTENSIONS.has(ext);
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

/** テキストファイルプレビューカード（最大18行 + 展開） */
function TextPreviewCard({ file, fileUrl }: {
  file: { id?: string; filename: string; content?: string; mimeType: string; size?: number };
  fileUrl: string;
}) {
  const MAX_PREVIEW_LINES = 18;
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    // リアルタイムメッセージ: base64 デコード
    if (file.content) {
      try {
        const decoded = new TextDecoder().decode(
          Uint8Array.from(atob(file.content), c => c.charCodeAt(0))
        );
        setPreviewText(decoded);
      } catch {
        setError(true);
      }
      return;
    }
    // 履歴メッセージ: API から遅延取得
    if (file.id) {
      setLoading(true);
      fetch(`/api/files/${file.id}?token=${getToken()}`)
        .then(res => {
          if (!res.ok) throw new Error('fetch failed');
          return res.text();
        })
        .then(text => { setPreviewText(text); setLoading(false); })
        .catch(() => { setError(true); setLoading(false); });
    }
  }, [file.content, file.id]);

  const lines = previewText?.split('\n') ?? [];
  const truncated = lines.length > MAX_PREVIEW_LINES;
  const displayText = (expanded ? lines : lines.slice(0, MAX_PREVIEW_LINES)).join('\n');

  const sizeStr = file.size
    ? formatBytes(file.size)
    : file.content ? formatFileSize(file.content) : '';

  return (
    <div className="max-w-md rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] overflow-hidden">
      {/* プレビュー本体 */}
      <div className="relative">
        {loading && (
          <div className="p-4 text-xs text-[var(--text-muted)]">読み込み中...</div>
        )}
        {error && (
          <div className="p-4 text-xs text-red-400">プレビューを読み込めませんでした</div>
        )}
        {previewText !== null && (
          <pre className="p-3 text-xs leading-relaxed text-[var(--text-primary)] bg-[var(--bg-base)] overflow-x-auto max-h-80 overflow-y-auto font-mono">
            <code>{displayText}</code>
          </pre>
        )}
        {/* 切り詰めグラデーション + 展開ボタン */}
        {truncated && !expanded && previewText !== null && (
          <div
            className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-[var(--bg-base)] to-transparent cursor-pointer flex items-end justify-center pb-1"
            onClick={() => setExpanded(true)}
          >
            <span className="text-xs text-[var(--text-link)]">
              さらに {lines.length - MAX_PREVIEW_LINES} 行を表示
            </span>
          </div>
        )}
      </div>
      {/* フッター: ファイル名 + サイズ + ダウンロード */}
      <div className="flex items-center gap-2 px-3 py-2 border-t border-[var(--border-color)]">
        <svg className="w-4 h-4 text-[var(--text-muted)] shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
        </svg>
        <span className="text-sm text-[var(--text-link)] truncate flex-1">{file.filename}</span>
        {sizeStr && <span className="text-xs text-[var(--text-faint)] shrink-0">{sizeStr}</span>}
        <a
          href={fileUrl}
          download={file.filename}
          className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors shrink-0"
          title="ダウンロード"
          onClick={(e) => e.stopPropagation()}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
          </svg>
        </a>
      </div>
    </div>
  );
}

/** バイナリファイルダウンロードカード */
function BinaryFileCard({ file, fileUrl }: {
  file: { id?: string; filename: string; content?: string; mimeType: string; size?: number };
  fileUrl: string;
}) {
  const sizeStr = file.size
    ? formatBytes(file.size)
    : file.content ? formatFileSize(file.content) : '';

  return (
    <a
      href={fileUrl}
      download={file.filename}
      className="flex items-center gap-3 max-w-md rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2 hover:bg-[var(--bg-hover)] transition-colors no-underline"
    >
      <svg className="w-8 h-8 text-[var(--text-muted)] shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
      </svg>
      <div className="min-w-0 flex-1">
        <div className="text-sm text-[var(--text-link)] truncate">{file.filename}</div>
        {sizeStr && <div className="text-xs text-[var(--text-faint)]">{sizeStr}</div>}
      </div>
      <svg className="w-5 h-5 text-[var(--text-muted)] shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
      </svg>
    </a>
  );
}

/** ファイル種別に応じてプレビューカードを振り分け */
function FilePreviewCard({ file, onImageClick }: {
  file: { id?: string; filename: string; content?: string; mimeType: string; size?: number };
  onImageClick?: (src: string) => void;
}) {
  const isImage = file.mimeType.startsWith('image/');
  const isText = !isImage && isTextPreviewable(file.mimeType, file.filename);

  const fileUrl = file.content
    ? URL.createObjectURL(
        new Blob([Uint8Array.from(atob(file.content), c => c.charCodeAt(0))], { type: file.mimeType })
      )
    : file.id ? `/api/files/${file.id}?token=${getToken()}` : '';

  if (!fileUrl) return null;

  /* 画像: 既存のサムネ + ライトボックス */
  if (isImage) {
    return (
      <div>
        <img
          src={fileUrl}
          alt={file.filename}
          className="max-w-xs max-h-60 rounded-lg border border-[var(--border-color)] cursor-pointer hover:opacity-90 transition-opacity"
          onClick={() => onImageClick?.(fileUrl)}
        />
        <span className="block text-xs text-[var(--text-faint)] mt-0.5">{file.filename}</span>
      </div>
    );
  }

  /* テキスト系: プレビューカード */
  if (isText) {
    return <TextPreviewCard file={file} fileUrl={fileUrl} />;
  }

  /* バイナリ/不明: ダウンロードカード */
  return <BinaryFileCard file={file} fileUrl={fileUrl} />;
}

/** ツール承認カード（exec モード時にインライン表示） */
function ToolApprovalCard({
  approval,
  onRespond,
}: {
  approval: {
    requestId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    title?: string;
    description?: string;
    status: 'pending' | 'allow' | 'deny';
  };
  onRespond: (requestId: string, behavior: 'allow' | 'deny', approveAll?: boolean, alwaysAllow?: boolean) => void;
}) {
  /** ツール入力を人が読める形式で表示 */
  const formatInput = () => {
    if (approval.toolName === 'Bash' && approval.toolInput.command) {
      return String(approval.toolInput.command);
    }
    if ((approval.toolName === 'Read' || approval.toolName === 'Write' || approval.toolName === 'Edit') && approval.toolInput.file_path) {
      return String(approval.toolInput.file_path);
    }
    if (approval.toolName === 'Glob' && approval.toolInput.pattern) {
      return String(approval.toolInput.pattern);
    }
    if (approval.toolName === 'Grep' && approval.toolInput.pattern) {
      return `${approval.toolInput.pattern}${approval.toolInput.path ? ` in ${approval.toolInput.path}` : ''}`;
    }
    // その他: JSON 表示（短縮）
    const json = JSON.stringify(approval.toolInput);
    return json.length > 120 ? json.substring(0, 120) + '...' : json;
  };

  const statusColors = {
    pending: 'border-amber-500/30 bg-amber-900/10 dark:bg-amber-500/5',
    allow: 'border-green-500/30 bg-green-900/10 dark:bg-green-500/5',
    deny: 'border-red-500/30 bg-red-900/10 dark:bg-red-500/5',
  };

  const statusIcons = {
    pending: '🔧',
    allow: '✅',
    deny: '❌',
  };

  return (
    <div className={`rounded-lg border p-3 my-2 transition-colors ${statusColors[approval.status]}`}>
      <div className="flex items-center gap-2 mb-1">
        <span>{statusIcons[approval.status]}</span>
        <span className="font-semibold text-sm text-[var(--text-primary)]">{approval.toolName}</span>
        {approval.status !== 'pending' && (
          <span className="text-xs text-[var(--text-muted)]">
            {approval.status === 'allow' ? '許可済み' : '拒否済み'}
          </span>
        )}
      </div>
      <div className="text-xs font-mono text-[var(--text-secondary)] bg-black/5 dark:bg-white/10 rounded px-2 py-1 mb-2 break-all whitespace-pre-wrap">
        {formatInput()}
      </div>
      {approval.status === 'pending' && (
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => onRespond(approval.requestId, 'allow')}
            className="px-3 py-1 text-xs font-medium rounded bg-green-600/90 text-white hover:bg-green-600 transition-colors"
          >
            ✅ 許可
          </button>
          <button
            onClick={() => onRespond(approval.requestId, 'deny')}
            className="px-3 py-1 text-xs font-medium rounded bg-red-600/90 text-white hover:bg-red-600 transition-colors"
          >
            ❌ 拒否
          </button>
          <button
            onClick={() => onRespond(approval.requestId, 'allow', true)}
            className="px-3 py-1 text-xs font-medium rounded bg-slate-600 text-white hover:bg-slate-500 transition-colors"
          >
            🔓 以降すべて許可
          </button>
          <button
            onClick={() => onRespond(approval.requestId, 'allow', false, true)}
            className="px-3 py-1 text-xs font-medium rounded bg-violet-600/90 text-white hover:bg-violet-600 transition-colors"
          >
            📌 常に許可
          </button>
        </div>
      )}
    </div>
  );
}

/** AskUserQuestion 質問カード */
function QuestionCard({
  approval,
  onRespond,
}: {
  approval: {
    requestId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    status: 'pending' | 'allow' | 'deny';
  };
  onRespond: (requestId: string, behavior: 'allow' | 'deny', approveAll?: boolean, alwaysAllow?: boolean, answers?: Record<string, string>) => void;
}) {
  const questions = (approval.toolInput as any).questions as Array<{
    question: string;
    header?: string;
    multiSelect?: boolean;
    options: Array<{ label: string; description?: string }>;
  }> || [];

  const [selectedAnswers, setSelectedAnswers] = useState<Record<string, string>>({});
  /** 「その他」モードの質問（テキスト入力表示中） */
  const [otherMode, setOtherMode] = useState<Record<string, boolean>>({});
  /** 「その他」のテキスト入力値 */
  const [otherText, setOtherText] = useState<Record<string, string>>({});

  /** 選択肢をクリック（「その他」モードを解除） */
  const handleSelect = (question: string, label: string) => {
    setSelectedAnswers(prev => ({ ...prev, [question]: label }));
    setOtherMode(prev => ({ ...prev, [question]: false }));
  };

  /** 「その他」ボタンをクリック → テキスト入力モードに切替 */
  const handleOtherClick = (question: string) => {
    setOtherMode(prev => ({ ...prev, [question]: true }));
    setSelectedAnswers(prev => { const n = { ...prev }; delete n[question]; return n; });
  };

  /** 「その他」テキスト確定 */
  const handleOtherConfirm = (question: string) => {
    const text = (otherText[question] || '').trim();
    if (text) {
      setSelectedAnswers(prev => ({ ...prev, [question]: text }));
    }
  };

  /** 回答を送信 */
  const handleSubmit = () => {
    onRespond(approval.requestId, 'allow', false, false, selectedAnswers);
  };

  /** 全質問に回答済みかチェック */
  const allAnswered = questions.every(q => {
    const answer = selectedAnswers[q.question];
    return answer && answer.trim().length > 0;
  });

  const statusColors = {
    pending: 'border-sky-300 bg-sky-50',
    allow: 'border-emerald-300 bg-emerald-50',
    deny: 'border-slate-300 bg-slate-100',
  };

  return (
    <div className={`rounded-lg border-2 p-4 my-2 transition-colors ${statusColors[approval.status]}`}>
      {questions.map((q, qi) => (
        <div key={qi} className="mb-3">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-lg">❓</span>
            <span className="font-semibold text-sm text-slate-800">{q.question}</span>
          </div>
          {approval.status === 'pending' ? (
            <div>
              <div className="flex flex-wrap gap-2">
                {q.options.map((opt, oi) => (
                  <button
                    key={oi}
                    onClick={() => handleSelect(q.question, opt.label)}
                    className={`px-4 py-2 text-sm font-medium rounded-lg transition-all ${
                      selectedAnswers[q.question] === opt.label && !otherMode[q.question]
                        ? 'bg-sky-500 text-white shadow-md ring-2 ring-sky-300'
                        : 'bg-white text-slate-800 border border-slate-300 hover:bg-sky-50 hover:border-sky-400'
                    }`}
                    title={opt.description}
                  >
                    {opt.label}
                  </button>
                ))}
                <button
                  onClick={() => handleOtherClick(q.question)}
                  className={`px-4 py-2 text-sm font-medium rounded-lg transition-all ${
                    otherMode[q.question]
                      ? 'bg-amber-500 text-white shadow-md ring-2 ring-amber-300'
                      : 'bg-white text-slate-500 border border-dashed border-slate-300 hover:bg-amber-50 hover:border-amber-400 hover:text-slate-700'
                  }`}
                >
                  その他...
                </button>
              </div>
              {otherMode[q.question] && (
                <div className="flex gap-2 mt-2">
                  <input
                    type="text"
                    value={otherText[q.question] || ''}
                    onChange={(e) => setOtherText(prev => ({ ...prev, [q.question]: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleOtherConfirm(q.question); }}
                    placeholder="回答を入力..."
                    className="flex-1 px-3 py-1.5 text-sm rounded-lg border border-slate-300 bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-sky-300 focus:border-sky-400"
                    autoFocus
                  />
                  <button
                    onClick={() => handleOtherConfirm(q.question)}
                    disabled={!(otherText[q.question] || '').trim()}
                    className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-all ${
                      (otherText[q.question] || '').trim()
                        ? 'bg-sky-500 text-white hover:bg-sky-400'
                        : 'bg-slate-200 text-slate-400 cursor-not-allowed'
                    }`}
                  >
                    OK
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="text-sm text-slate-600">
              回答: <span className="font-medium text-slate-800">{selectedAnswers[q.question] || '(スキップ)'}</span>
            </div>
          )}
          {q.options.some(o => o.description) && approval.status === 'pending' && selectedAnswers[q.question] && (
            <div className="text-xs text-slate-500 mt-2 ml-1 italic">
              💡 {q.options.find(o => o.label === selectedAnswers[q.question])?.description}
            </div>
          )}
        </div>
      ))}
      {approval.status === 'pending' && (
        <div className="flex gap-2 mt-3 pt-2 border-t border-slate-200">
          <button
            onClick={handleSubmit}
            disabled={!allAnswered}
            className={`px-4 py-1.5 text-xs font-medium rounded-lg transition-all ${
              allAnswered
                ? 'bg-sky-500 text-white hover:bg-sky-400 shadow-sm'
                : 'bg-slate-200 text-slate-400 cursor-not-allowed'
            }`}
          >
            📩 回答を送信
          </button>
          <button
            onClick={() => onRespond(approval.requestId, 'deny')}
            className="px-4 py-1.5 text-xs font-medium rounded-lg bg-slate-200 text-slate-600 hover:bg-slate-300 transition-colors"
          >
            スキップ
          </button>
        </div>
      )}
      {approval.status !== 'pending' && (
        <div className="text-xs text-slate-500">
          {approval.status === 'allow' ? '✅ 回答済み' : '⏭️ スキップ'}
        </div>
      )}
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
            {message.files.map((f, i) => (
              <FilePreviewCard key={i} file={f} onImageClick={onImageClick} />
            ))}
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
            onDragStart={(e) => {
              dragIndexRef.current = globalIndex;
              e.dataTransfer.setData('text/x-devrelay-project', tab.projectId);
            }}
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
  mode,
  onChangeMode,
  servers,
  activeServerId,
  onSelectServer,
  onCreateServer,
  onRenameServer,
  onDeleteServer,
  onRemoveProject,
  onAddProjectToServer,
  tabCustomNames,
  onReorderServerProjects,
}: {
  machineList: Machine[];
  openTabIds: Set<string>;
  activeTabId: string | null;
  onSelectProject: (projectId: string) => void;
  collapsed: boolean;
  onToggle: () => void;
  mode: 'agents' | 'servers';
  onChangeMode: (mode: 'agents' | 'servers') => void;
  servers: ChatServer[];
  activeServerId: string | null;
  onSelectServer: (id: string | null) => void;
  onCreateServer: (name: string) => void;
  onRenameServer: (id: string, name: string) => void;
  onDeleteServer: (id: string) => void;
  onRemoveProject: (projectId: string) => void;
  onAddProjectToServer: (serverId: string, projectId: string) => void;
  /** タブのカスタム名マップ（projectId → customName） */
  tabCustomNames: Record<string, string>;
  onReorderServerProjects: (serverId: string, fromIndex: number, toIndex: number) => void;
}) {
  const [expandedMachines, setExpandedMachines] = useState<Set<string>>(new Set());
  /** サーバー内プロジェクトの展開状態 */
  const [expandedServers, setExpandedServers] = useState<Set<string>>(new Set());
  /** サーバー名のインライン編集中 ID */
  const [editingServerId, setEditingServerId] = useState<string | null>(null);
  /** 新規サーバー作成入力中 */
  const [creatingServer, setCreatingServer] = useState(false);
  /** サーバー内プロジェクト並べ替え用 ref */
  const projDragIdxRef = useRef<{ serverId: string; index: number } | null>(null);
  const projDragOverIdxRef = useRef<number | null>(null);
  /** ドラッグオーバー中のサーバー ID（ハイライト用） */
  const [dragOverServerId, setDragOverServerId] = useState<string | null>(null);
  const editServerInputRef = useRef<HTMLInputElement>(null);
  const newServerInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (machineList.length > 0 && expandedMachines.size === 0) {
      const onlineIds = machineList.filter(m => m.status === 'online').map(m => m.id);
      setExpandedMachines(new Set(onlineIds.length > 0 ? onlineIds : [machineList[0].id]));
    }
  }, [machineList, expandedMachines.size]);

  /** サーバー作成入力にフォーカス */
  useEffect(() => {
    if (creatingServer) newServerInputRef.current?.focus();
  }, [creatingServer]);

  /** サーバー名編集入力にフォーカス */
  useEffect(() => {
    if (editingServerId) editServerInputRef.current?.focus();
  }, [editingServerId]);

  const toggleMachine = (id: string) => {
    setExpandedMachines(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleServer = (id: string) => {
    setExpandedServers(prev => {
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

  /** projectId → プロジェクト名の逆引きマップ */
  const projectNameMap = new Map<string, string>();
  for (const m of machineList) {
    for (const p of m.projects) {
      projectNameMap.set(p.id, p.name);
    }
  }

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
        {/* ヘッダー: Agents / Servers 切り替え */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border-color)]">
          <div className="flex gap-1">
            <button
              onClick={() => onChangeMode('servers')}
              className={`text-xs px-2 py-1 rounded ${
                mode === 'servers'
                  ? 'bg-[var(--bg-selected)] text-[var(--text-primary)] font-semibold'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
              }`}
            >Servers</button>
            <button
              onClick={() => onChangeMode('agents')}
              className={`text-xs px-2 py-1 rounded ${
                mode === 'agents'
                  ? 'bg-[var(--bg-selected)] text-[var(--text-primary)] font-semibold'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
              }`}
            >Agents</button>
          </div>
          <button onClick={onToggle} className="md:hidden text-[var(--text-muted)] hover:text-[var(--text-primary)]">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto py-1">
          {/* ===== Agents モード ===== */}
          {mode === 'agents' && (
            <>
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
            </>
          )}

          {/* ===== Servers モード ===== */}
          {mode === 'servers' && (
            <>
              {/* 「すべて」ボタン */}
              <button
                onClick={() => onSelectServer(null)}
                className={`
                  w-full text-left flex items-center gap-1.5 px-3 py-1.5 text-sm
                  ${!activeServerId
                    ? 'bg-[var(--bg-selected)] text-[var(--text-primary)] font-semibold'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                  }
                `}
              >
                <span className="text-[var(--text-faint)]">#</span>
                <span>すべて</span>
              </button>

              {/* サーバー一覧 */}
              {servers.map(server => {
                const isActive = server.id === activeServerId;
                const isExpanded = expandedServers.has(server.id);
                const isEditing = editingServerId === server.id;

                return (
                  <div key={server.id}>
                    <div
                      className={`group flex items-center transition-colors ${
                        dragOverServerId === server.id ? 'bg-[var(--accent-blue)] bg-opacity-15 rounded' : ''
                      }`}
                      onDragOver={(e) => {
                        if (e.dataTransfer.types.includes('text/x-devrelay-project')) {
                          e.preventDefault();
                          setDragOverServerId(server.id);
                        }
                      }}
                      onDragLeave={() => setDragOverServerId(null)}
                      onDrop={(e) => {
                        const pid = e.dataTransfer.getData('text/x-devrelay-project');
                        if (pid) {
                          e.preventDefault();
                          onAddProjectToServer(server.id, pid);
                        }
                        setDragOverServerId(null);
                      }}
                    >
                      <button
                        onClick={() => {
                          onSelectServer(server.id);
                          if (!isExpanded) toggleServer(server.id);
                        }}
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          setEditingServerId(server.id);
                        }}
                        className={`
                          flex-1 text-left flex items-center gap-1.5 px-3 py-1.5 text-sm
                          ${isActive
                            ? 'text-[var(--text-primary)] font-semibold'
                            : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                          }
                        `}
                      >
                        <svg
                          className={`w-3 h-3 transition-transform shrink-0 ${isExpanded ? 'rotate-90' : ''}`}
                          fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor"
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
                        </svg>
                        {isEditing ? (
                          <input
                            ref={editServerInputRef}
                            defaultValue={server.name}
                            className="bg-[var(--input-bg)] text-[var(--text-primary)] text-sm px-1 rounded w-full outline-none"
                            onBlur={(e) => {
                              const v = e.target.value.trim();
                              if (v && v !== server.name) onRenameServer(server.id, v);
                              setEditingServerId(null);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                              if (e.key === 'Escape') setEditingServerId(null);
                            }}
                            onClick={(e) => e.stopPropagation()}
                          />
                        ) : (
                          <span className="truncate">{server.name}</span>
                        )}
                      </button>
                      {/* 削除ボタン */}
                      <button
                        onClick={(e) => { e.stopPropagation(); onDeleteServer(server.id); }}
                        className="opacity-0 group-hover:opacity-100 text-[var(--text-faint)] hover:text-red-400 px-1 mr-1 text-xs"
                        title="サーバーを削除"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>

                    {/* サーバー内プロジェクト一覧 */}
                    {isExpanded && (
                      <div className="ml-2">
                        {server.projectIds.length === 0 ? (
                          <div className="px-3 py-1 text-xs text-[var(--text-faint)] italic">
                            Agents からプロジェクトを追加
                          </div>
                        ) : (
                          server.projectIds.map((pid, pidIdx) => {
                            const name = tabCustomNames[pid] || projectNameMap.get(pid) || pid;
                            const isTabActive = pid === activeTabId;
                            const hasTab = openTabIds.has(pid);
                            return (
                              <div
                                key={pid}
                                className="group/proj flex items-center"
                                draggable
                                onDragStart={(e) => {
                                  projDragIdxRef.current = { serverId: server.id, index: pidIdx };
                                  e.dataTransfer.setData('text/x-devrelay-project', pid);
                                }}
                                onDragOver={(e) => {
                                  e.preventDefault();
                                  projDragOverIdxRef.current = pidIdx;
                                }}
                                onDrop={() => {
                                  if (projDragIdxRef.current && projDragIdxRef.current.serverId === server.id && projDragOverIdxRef.current !== null && projDragIdxRef.current.index !== projDragOverIdxRef.current) {
                                    onReorderServerProjects(server.id, projDragIdxRef.current.index, projDragOverIdxRef.current);
                                  }
                                  projDragIdxRef.current = null;
                                  projDragOverIdxRef.current = null;
                                }}
                                onDragEnd={() => { projDragIdxRef.current = null; projDragOverIdxRef.current = null; }}
                              >
                                <button
                                  onClick={() => {
                                    onSelectProject(pid);
                                    if (window.innerWidth < 768) onToggle();
                                  }}
                                  className={`
                                    flex-1 text-left flex items-center gap-1.5 px-3 py-1 rounded-md mx-1 text-sm
                                    ${isTabActive
                                      ? 'bg-[var(--bg-selected)] text-[var(--text-primary)] font-semibold'
                                      : hasTab
                                        ? 'text-[var(--text-primary)] font-semibold hover:bg-[var(--bg-hover)]'
                                        : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                                    }
                                  `}
                                >
                                  <span className={hasTab ? 'text-yellow-400' : 'text-[var(--text-faint)]'}>
                                    {hasTab ? '★' : '#'}
                                  </span>
                                  <span className="truncate">{name}</span>
                                </button>
                                {/* サーバーからプロジェクトを除去 */}
                                <button
                                  onClick={(e) => { e.stopPropagation(); onRemoveProject(pid); }}
                                  className="opacity-0 group-hover/proj:opacity-100 text-[var(--text-faint)] hover:text-red-400 px-1 mr-1 text-xs"
                                  title="サーバーから除去"
                                >
                                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                                  </svg>
                                </button>
                              </div>
                            );
                          })
                        )}
                      </div>
                    )}
                  </div>
                );
              })}

              {/* + サーバー追加ボタン */}
              {creatingServer ? (
                <div className="px-3 py-1.5">
                  <input
                    ref={newServerInputRef}
                    placeholder="サーバー名..."
                    className="w-full bg-[var(--input-bg)] text-[var(--text-primary)] text-sm px-2 py-1 rounded outline-none focus:ring-1 focus:ring-blue-500"
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v) onCreateServer(v);
                      setCreatingServer(false);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      if (e.key === 'Escape') setCreatingServer(false);
                    }}
                  />
                </div>
              ) : (
                <button
                  onClick={() => setCreatingServer(true)}
                  className="w-full text-left flex items-center gap-1.5 px-3 py-1.5 text-sm text-[var(--text-faint)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                  </svg>
                  <span>サーバー追加</span>
                </button>
              )}
            </>
          )}
        </div>
      </aside>
    </>
  );
}

// ---------------------------------------------------------------------------
// ドキュメントパネル（右サイド）
// ---------------------------------------------------------------------------

/** ファイルサイズをフォーマット（1024B → 1.0KB） */
function formatDocSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** マークダウン簡易レンダリング（Issues 表示用） */
function renderMarkdown(content: string) {
  const lines = content.split('\n');
  const elements: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // コードブロック
    if (line.startsWith('```')) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      elements.push(
        <pre key={elements.length} className="bg-[var(--bg-base)] rounded p-2 my-1 overflow-x-auto text-xs">
          <code>{codeLines.join('\n')}</code>
        </pre>
      );
      continue;
    }

    // 見出し
    const headingMatch = line.match(/^(#{1,3})\s+(.+)/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2];
      const cls = level === 1 ? 'text-sm font-bold mt-3 mb-1' : level === 2 ? 'text-xs font-bold mt-2 mb-1' : 'text-xs font-semibold mt-1.5 mb-0.5';
      elements.push(<div key={elements.length} className={`${cls} text-[var(--text-primary)]`}>{renderInline(text)}</div>);
      i++;
      continue;
    }

    // チェックボックス行
    const checkMatch = line.match(/^[-*]\s+\[([ x~])\]\s*(.*)/);
    if (checkMatch) {
      const status = checkMatch[1];
      const text = checkMatch[2];
      const icon = status === 'x' ? '✅' : status === '~' ? '🔄' : '⬜';
      const textCls = status === 'x' ? 'line-through text-[var(--text-muted)]' : 'text-[var(--text-secondary)]';
      elements.push(
        <div key={elements.length} className="flex gap-1 py-0.5 text-xs">
          <span className="shrink-0">{icon}</span>
          <span className={textCls}>{renderInline(text)}</span>
        </div>
      );
      i++;
      continue;
    }

    // 通常のリスト項目
    const listMatch = line.match(/^[-*]\s+(.*)/);
    if (listMatch) {
      elements.push(
        <div key={elements.length} className="flex gap-1 py-0.5 text-xs text-[var(--text-secondary)]">
          <span className="shrink-0">•</span>
          <span>{renderInline(listMatch[1])}</span>
        </div>
      );
      i++;
      continue;
    }

    // 区切り線
    if (/^---+$/.test(line.trim())) {
      elements.push(<hr key={elements.length} className="border-[var(--border-color)] my-2" />);
      i++;
      continue;
    }

    // 空行
    if (line.trim() === '') {
      elements.push(<div key={elements.length} className="h-1" />);
      i++;
      continue;
    }

    // 通常テキスト
    elements.push(<div key={elements.length} className="text-xs text-[var(--text-secondary)] py-0.5">{renderInline(line)}</div>);
    i++;
  }

  return elements;
}

/** インラインマークダウン（太字、インラインコード、リンク） */
function renderInline(text: string): React.ReactNode {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g);
  return parts.map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={i} className="bg-[var(--bg-tertiary)] px-1 rounded text-xs">{part.slice(1, -1)}</code>;
    }
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    const linkMatch = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (linkMatch) {
      return <a key={i} href={linkMatch[2]} target="_blank" rel="noopener noreferrer" className="text-[var(--accent-blue)] hover:underline">{linkMatch[1]}</a>;
    }
    return part;
  });
}

type DocPanelTab = 'approvals' | 'docs' | 'issues';

/** ツール承認履歴の1エントリ */
interface ApprovalHistoryEntry {
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  status: 'pending' | 'allow' | 'deny' | 'auto';
  timestamp: Date;
}

/** エージェントドキュメントパネル（右サイドバー） */
function DocPanel({ machineId, projectId, approvalHistory }: { machineId: string | null; machineDisplayName: string; projectId: string | null; approvalHistory: ApprovalHistoryEntry[] }) {
  const [documents, setDocuments] = useState<AgentDocMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // タブ状態
  const [activePanel, setActivePanel] = useState<DocPanelTab>('approvals');
  /** 承認履歴の展開中エントリ ID（クリックで全文表示） */
  const [expandedApprovalId, setExpandedApprovalId] = useState<string | null>(null);

  // Issues 状態
  const [issuesContent, setIssuesContent] = useState<string | null>(null);
  const [issuesLoading, setIssuesLoading] = useState(false);
  const [issuesError, setIssuesError] = useState<string | null>(null);

  // リサイズ状態
  const [panelWidth, setPanelWidth] = useState(() => {
    const saved = localStorage.getItem('devrelay-panel-width');
    return saved ? parseInt(saved, 10) : 208;
  });
  const [resizing, setResizing] = useState(false);
  const panelWidthRef = useRef(panelWidth);
  panelWidthRef.current = panelWidth;

  /** ドキュメント一覧を取得 */
  const fetchDocuments = useCallback(async () => {
    if (!machineId) { setDocuments([]); return; }
    setLoading(true);
    try {
      const res = await agentDocuments.list(machineId);
      setDocuments(res.documents);
    } catch (err) {
      console.error('Failed to fetch documents:', err);
    } finally {
      setLoading(false);
    }
  }, [machineId]);

  useEffect(() => { fetchDocuments(); }, [fetchDocuments]);

  /** Issues を Agent 経由で取得 */
  const fetchIssues = useCallback(async () => {
    if (!projectId) { setIssuesContent(null); return; }
    setIssuesLoading(true);
    setIssuesError(null);
    try {
      const res = await projectsApi.readFile(projectId, 'doc/issues.md');
      setIssuesContent(res.content);
    } catch (err: any) {
      // 503 = Agent offline, それ以外はエラー表示
      setIssuesError(err.message || 'Failed to load issues');
      setIssuesContent(null);
    } finally {
      setIssuesLoading(false);
    }
  }, [projectId]);

  // Issues タブ選択時または projectId 変更時に取得
  useEffect(() => {
    if (activePanel === 'issues') {
      fetchIssues();
    }
  }, [activePanel, fetchIssues]);

  /** ファイルをアップロード */
  const handleUpload = useCallback(async (files: FileList | File[]) => {
    if (!machineId || files.length === 0) return;
    setUploading(true);
    try {
      const filePayloads = await Promise.all(
        Array.from(files).map(async (file) => {
          const buffer = await file.arrayBuffer();
          const bytes = new Uint8Array(buffer);
          let binary = '';
          for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
          return {
            filename: file.name,
            content: btoa(binary),
            mimeType: file.type || 'application/octet-stream',
            size: file.size,
          };
        })
      );
      await agentDocuments.upload(machineId, filePayloads);
      await fetchDocuments();
    } catch (err) {
      console.error('Failed to upload documents:', err);
    } finally {
      setUploading(false);
    }
  }, [machineId, fetchDocuments]);

  /** ドキュメントを削除 */
  const handleDelete = useCallback(async (docId: string) => {
    if (!machineId) return;
    try {
      await agentDocuments.remove(machineId, docId);
      setDocuments(prev => prev.filter(d => d.id !== docId));
    } catch (err) {
      console.error('Failed to delete document:', err);
    }
  }, [machineId]);

  // ドラッグ&ドロップハンドラ
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (dragCounterRef.current === 1) setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) setDragOver(false);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setDragOver(false);
    if (e.dataTransfer.files.length > 0) {
      handleUpload(e.dataTransfer.files);
    }
  }, [handleUpload]);

  /** リサイズハンドル */
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setResizing(true);
    const startX = e.clientX;
    const startWidth = panelWidthRef.current;

    const handleMouseMove = (e: MouseEvent) => {
      // 右端パネルなので左にドラッグ = 幅拡大
      const delta = startX - e.clientX;
      const newWidth = Math.max(160, Math.min(600, startWidth + delta));
      setPanelWidth(newWidth);
    };

    const handleMouseUp = () => {
      setResizing(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      localStorage.setItem('devrelay-panel-width', String(panelWidthRef.current));
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, []);

  return (
    <>
      {/* リサイズ中のオーバーレイ（テキスト選択防止） */}
      {resizing && <div className="fixed inset-0 z-50 cursor-col-resize" />}

      <aside
        style={{ width: panelWidth }}
        className="shrink-0 hidden lg:flex flex-col border-l border-[var(--border-color)] bg-[var(--bg-secondary)] relative"
        onDragEnter={activePanel === 'docs' ? handleDragEnter : undefined}
        onDragLeave={activePanel === 'docs' ? handleDragLeave : undefined}
        onDragOver={activePanel === 'docs' ? handleDragOver : undefined}
        onDrop={activePanel === 'docs' ? handleDrop : undefined}
      >
        {/* リサイズハンドル */}
        <div
          className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-[var(--accent-blue)] hover:opacity-50 z-10"
          onMouseDown={handleResizeStart}
        />

        {/* タブヘッダー */}
        <div className="flex items-center border-b border-[var(--border-color)]">
          <button
            onClick={() => setActivePanel('approvals')}
            className={`flex-1 text-xs py-2 text-center transition-colors ${
              activePanel === 'approvals'
                ? 'text-[var(--text-primary)] border-b-2 border-[var(--accent-blue)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
            }`}
          >
            Approvals
          </button>
          <button
            onClick={() => setActivePanel('docs')}
            className={`flex-1 text-xs py-2 text-center transition-colors ${
              activePanel === 'docs'
                ? 'text-[var(--text-primary)] border-b-2 border-[var(--accent-blue)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
            }`}
          >
            Docs
          </button>
          <button
            onClick={() => setActivePanel('issues')}
            className={`flex-1 text-xs py-2 text-center transition-colors ${
              activePanel === 'issues'
                ? 'text-[var(--text-primary)] border-b-2 border-[var(--accent-blue)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
            }`}
          >
            Issues
          </button>
          {activePanel === 'docs' && (
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={!machineId || uploading}
              className="text-xs px-1.5 py-0.5 mr-1 rounded bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--border-color)] disabled:opacity-50 transition-colors"
              title="ファイルを追加"
            >
              +
            </button>
          )}
          {activePanel === 'issues' && (
            <button
              onClick={fetchIssues}
              disabled={!projectId || issuesLoading}
              className="text-xs px-1.5 py-0.5 mr-1 rounded bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--border-color)] disabled:opacity-50 transition-colors"
              title="更新"
            >
              ↻
            </button>
          )}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => { if (e.target.files) { handleUpload(e.target.files); e.target.value = ''; } }}
          />
        </div>

        {/* Approvals タブ */}
        {activePanel === 'approvals' ? (
          <div className="flex-1 overflow-y-auto p-2">
            {approvalHistory.length === 0 ? (
              <p className="text-xs text-[var(--text-muted)] text-center mt-4">No approval history yet</p>
            ) : (
              <div className="space-y-1">
                {[...approvalHistory].reverse().map(entry => {
                  const statusIcon = entry.status === 'auto' ? '🔓' : entry.status === 'allow' ? '✅' : entry.status === 'deny' ? '❌' : '⏳';
                  const statusColor = entry.status === 'auto' ? 'text-purple-500' : entry.status === 'allow' ? 'text-green-500' : entry.status === 'deny' ? 'text-red-500' : 'text-yellow-500';
                  const timeStr = entry.timestamp.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                  const isExpanded = expandedApprovalId === entry.requestId;
                  // ツール入力の詳細テキスト（全文保持）
                  let detail = '';
                  if (entry.toolName === 'Bash' && entry.toolInput.command) {
                    detail = String(entry.toolInput.command);
                  } else if (entry.toolInput.file_path) {
                    detail = String(entry.toolInput.file_path);
                  } else if (entry.toolInput.pattern) {
                    detail = String(entry.toolInput.pattern);
                  }
                  return (
                    <div
                      key={entry.requestId}
                      className="flex items-start gap-1.5 px-1 py-0.5 rounded hover:bg-[var(--bg-tertiary)] transition-colors cursor-pointer"
                      onClick={() => setExpandedApprovalId(isExpanded ? null : entry.requestId)}
                    >
                      <span className={`text-xs ${statusColor} flex-shrink-0 mt-0.5`}>{statusIcon}</span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1">
                          <span className="text-xs font-medium text-[var(--text-primary)]">{entry.toolName}</span>
                          <span className="text-[10px] text-[var(--text-muted)]">{timeStr}</span>
                        </div>
                        {detail && (
                          <p className={`text-[10px] text-[var(--text-muted)] font-mono ${isExpanded ? 'whitespace-pre-wrap break-all' : 'truncate'}`}>{detail}</p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ) : activePanel === 'issues' ? (
          <div className="flex-1 overflow-y-auto p-2">
            {!projectId ? (
              <p className="text-xs text-[var(--text-muted)] text-center mt-4">タブを選択してください</p>
            ) : issuesLoading ? (
              <p className="text-xs text-[var(--text-muted)] text-center mt-4">読み込み中...</p>
            ) : issuesError ? (
              <p className="text-xs text-red-400 text-center mt-4">{issuesError}</p>
            ) : issuesContent === null ? (
              <p className="text-xs text-[var(--text-muted)] text-center mt-4">doc/issues.md が見つかりません</p>
            ) : (
              <div className="leading-relaxed">{renderMarkdown(issuesContent)}</div>
            )}
          </div>
        ) : (
          /* Docs タブ */
          <div className="flex-1 overflow-y-auto p-2">
            {!machineId ? (
              <p className="text-xs text-[var(--text-muted)] text-center mt-4">タブを選択してください</p>
            ) : loading ? (
              <p className="text-xs text-[var(--text-muted)] text-center mt-4">読み込み中...</p>
            ) : documents.length === 0 ? (
              <div className={`flex items-center justify-center h-full text-xs text-center transition-colors rounded ${
                dragOver ? 'text-[var(--text-primary)] bg-[var(--accent-blue)] bg-opacity-10 border border-dashed border-[var(--accent-blue)]' : 'text-[var(--text-muted)]'
              }`}>
                {uploading ? 'アップロード中...' : 'ドロップで\nファイル追加'}
              </div>
            ) : (
              <>
                {dragOver && (
                  <div className="text-xs text-center py-2 mb-2 rounded bg-[var(--accent-blue)] bg-opacity-10 border border-dashed border-[var(--accent-blue)] text-[var(--text-primary)]">
                    ドロップでアップロード
                  </div>
                )}
                {uploading && (
                  <div className="text-xs text-center py-1 mb-2 text-[var(--text-muted)]">アップロード中...</div>
                )}
                {documents.map(doc => (
                  <div
                    key={doc.id}
                    className="group flex items-center gap-1 px-1.5 py-1 rounded hover:bg-[var(--bg-tertiary)] transition-colors"
                  >
                    <a
                      href={agentDocuments.getDownloadUrl(machineId, doc.id)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex-1 min-w-0 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] truncate"
                      title={`${doc.filename} (${formatDocSize(doc.size)})`}
                    >
                      {doc.filename}
                    </a>
                    <button
                      onClick={() => handleDelete(doc.id)}
                      className="opacity-0 group-hover:opacity-100 text-[var(--text-muted)] hover:text-red-400 text-xs transition-opacity shrink-0"
                      title="削除"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </aside>
    </>
  );
}

// ---------------------------------------------------------------------------
// メインコンポーネント
// ---------------------------------------------------------------------------

export function ChatPage() {
  const { user } = useAuth();
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [pendingFiles, setPendingFiles] = useState<FileAttachment[]>([]);
  const [machineList, setMachineList] = useState<Machine[]>([]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  /** サーバー（タブグループ）定義 */
  const [servers, setServers] = useState<ChatServer[]>([]);
  /** アクティブサーバー ID（null = 「すべて」表示） */
  const [activeServerId, setActiveServerId] = useState<string | null>(null);
  /** サイドバーモード切り替え */
  const [sidebarMode, setSidebarMode] = useState<'agents' | 'servers'>('servers');
  /** ライトボックス表示用の画像 URL */
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);
  /** セッション情報パネル再取得トリガー（将来の拡張用） */
  const [, setSessionRefreshCount] = useState(0);
  /** チャットエリア最大化（サイドバー・右パネル・ナビバー非表示） */
  const [maximized, setMaximized] = useState(false);
  /** ツール承認リクエスト: requestId → 承認情報 */
  const [toolApprovals, setToolApprovals] = useState<Map<string, {
    requestId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    title?: string;
    description?: string;
    projectId?: string;
    status: 'pending' | 'allow' | 'deny';
    isQuestion?: boolean;
  }>>(new Map());
  /** ツール承認履歴（右パネルの Approvals タブに表示） */
  const [approvalHistory, setApprovalHistory] = useState<ApprovalHistoryEntry[]>([]);
  /** 承認履歴の DB ロード済みフラグ（二重ロード防止） */
  const approvalHistoryLoadedRef = useRef<Set<string>>(new Set());

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

  /** アクティブタブ変更時にツール承認履歴を DB からロード */
  useEffect(() => {
    if (!activeTabId) return;
    // 既にロード済みならスキップ
    if (approvalHistoryLoadedRef.current.has(activeTabId)) return;
    approvalHistoryLoadedRef.current.add(activeTabId);

    projectsApi.getApprovals(activeTabId, { limit: 100 }).then(res => {
      if (res.approvals.length > 0) {
        const loaded: ApprovalHistoryEntry[] = res.approvals.map(a => ({
          requestId: a.requestId || `db_${a.id}`,
          toolName: a.toolName,
          toolInput: a.toolInput,
          status: a.status as ApprovalHistoryEntry['status'],
          timestamp: new Date(a.createdAt),
        }));
        setApprovalHistory(prev => {
          // DB から取得した履歴と既存のリアルタイム履歴をマージ（重複排除）
          const existingIds = new Set(prev.map(e => e.requestId));
          const newEntries = loaded.filter(e => !existingIds.has(e.requestId));
          if (newEntries.length === 0) return prev;
          // DB 履歴（古い順）を先頭に、リアルタイム履歴を後ろに
          return [...newEntries, ...prev];
        });
      }
    }).catch(err => console.error('Failed to load approval history:', err));
  }, [activeTabId]);

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
      const { messages, hasMore } = await projectsApi.getMessages(projectId, { limit: 10 });
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

      // 履歴読み込み完了後、アクティブタブなら自動スクロールを有効化
      // rAF 内だと React の useEffect より後に実行されるため、同期的にセットする
      if (activeTabIdRef.current === projectId) {
        historyJustLoadedRef.current = true;
        shouldAutoScrollRef.current = true;
        // DOM 更新後に直接スクロール（複数タイミングで試行して確実にスクロール）
        const scrollToBottom = () => {
          autoScrollingUntilRef.current = Date.now() + 500;
          const container = messagesContainerRef.current;
          if (container) container.scrollTop = container.scrollHeight;
        };
        requestAnimationFrame(scrollToBottom);
        setTimeout(scrollToBottom, 100);
      }
    } catch {
      setTabs(prev => prev.map(t =>
        t.projectId === projectId ? { ...t, historyLoaded: true, loadingHistory: false } : t
      ));

      // エラー時もスクロール復元
      if (activeTabIdRef.current === projectId) {
        historyJustLoadedRef.current = true;
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
    setTabs(prev => prev.map(t => {
      if (t.projectId !== targetId) return t;
      const updated = [...t.messages, newMsg];
      // 上限を超えた古いメッセージを除去（スクロールバックで再読み込み可能）
      if (updated.length > MAX_MESSAGES) {
        return { ...t, messages: updated.slice(updated.length - MAX_MESSAGES), hasMoreHistory: true };
      }
      return { ...t, messages: updated };
    }));
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
    setTabs(prev => prev.map(t => {
      if (t.projectId !== targetId) return t;
      // progress が null でない = AI が動いていた → 通知音を再生
      if (t.progress !== null) playNotificationSound();
      return { ...t, progress: null, completed: t.progress !== null };
    }));
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

  /** ツール承認リクエスト受信時のハンドラ */
  const handleToolApproval = useCallback((prompt: ToolApprovalPrompt) => {
    setToolApprovals(prev => {
      const next = new Map(prev);
      next.set(prompt.requestId, { ...prompt, status: 'pending' });
      return next;
    });
    // 承認履歴に追加（pending 状態で）
    setApprovalHistory(prev => [...prev, {
      requestId: prompt.requestId,
      toolName: prompt.toolName,
      toolInput: prompt.toolInput,
      status: 'pending',
      timestamp: new Date(),
    }]);
  }, []);

  /** ツール承認解決（自分 or 他ブラウザからの応答）受信時のハンドラ */
  /** ツール承認解決（自分 or 他ブラウザからの応答）→ 2秒後に自動非表示 */
  const handleToolApprovalResolved = useCallback((resolved: ToolApprovalResolved) => {
    setToolApprovals(prev => {
      const next = new Map(prev);
      const existing = next.get(resolved.requestId);
      if (existing) {
        next.set(resolved.requestId, { ...existing, status: resolved.behavior });
      }
      return next;
    });
    // 承認履歴のステータスを更新
    setApprovalHistory(prev => prev.map(entry =>
      entry.requestId === resolved.requestId ? { ...entry, status: resolved.behavior } : entry
    ));
    // 2秒後にカードを削除（許可済み/拒否済みの表示が邪魔にならないように）
    setTimeout(() => {
      setToolApprovals(prev => {
        const next = new Map(prev);
        next.delete(resolved.requestId);
        return next;
      });
    }, 2000);
  }, []);

  /** 自動承認通知受信時のハンドラ（approveAllMode 時、履歴にのみ追加） */
  const handleToolApprovalAuto = useCallback((info: ToolApprovalAuto) => {
    setApprovalHistory(prev => [...prev, {
      requestId: `auto_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      toolName: info.toolName,
      toolInput: info.toolInput,
      status: 'auto',
      timestamp: new Date(),
    }]);
  }, []);

  const { connected, sendCommand, sendToolApprovalResponse } = useWebSocket({
    onMessage: addMessageToTab,
    onProgress: updateProgressOnTab,
    onProgressClear: clearProgressOnTab,
    onSessionInfo: handleSessionInfo,
    onToolApproval: handleToolApproval,
    onToolApprovalResolved: handleToolApprovalResolved,
    onToolApprovalAuto: handleToolApprovalAuto,
  });

  /** ユーザーがツール承認ボタンをクリックした時のハンドラ */
  const handleToolApprovalRespond = useCallback((requestId: string, behavior: 'allow' | 'deny', approveAll?: boolean, alwaysAllow?: boolean, answers?: Record<string, string>) => {
    sendToolApprovalResponse(requestId, behavior, approveAll, alwaysAllow, answers);
    // 即座にローカルの状態を更新（Server からの resolved を待たずに UI 反映）
    setToolApprovals(prev => {
      const next = new Map(prev);
      const existing = next.get(requestId);
      if (existing) {
        next.set(requestId, { ...existing, status: behavior });
      }
      // 「以降すべて許可」→ 保留中のカードも全て許可済みに
      if (approveAll) {
        for (const [id, a] of next) {
          if (a.status === 'pending') {
            next.set(id, { ...a, status: 'allow' });
          }
        }
      }
      return next;
    });
    // 承認履歴のステータスを即座に更新
    setApprovalHistory(prev => prev.map(entry =>
      entry.requestId === requestId ? { ...entry, status: behavior } : entry
    ));
    // 2秒後にカードを削除
    setTimeout(() => {
      setToolApprovals(prev => {
        const next = new Map(prev);
        next.delete(requestId);
        return next;
      });
    }, 2000);
  }, [sendToolApprovalResponse]);

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

        // サーバーからタブ状態を一括取得
        let pinnedIds: Set<string>;
        let tabOrder: string[] = [];
        let savedNames: Record<string, string> = {};
        try {
          const [serverPinned, serverOrder, serverNames, savedServers, savedActiveServer] = await Promise.all([
            settingsApi.getPinnedTabs(),
            settingsApi.getTabOrder(),
            settingsApi.getTabNames(),
            settingsApi.getServers(),
            settingsApi.getActiveServer(),
          ]);
          pinnedIds = serverPinned.length > 0 ? new Set(serverPinned) : getPinnedTabIds();
          tabOrder = serverOrder;
          savedNames = Object.keys(serverNames).length > 0 ? serverNames : getTabNames();
          // localStorage を同期
          if (serverPinned.length > 0) {
            localStorage.setItem('devrelay-pinned-tabs', JSON.stringify(serverPinned));
          }
          // サーバー定義を復元
          if (savedServers.length > 0) {
            setServers(savedServers);
            if (savedActiveServer) setActiveServerId(savedActiveServer);
          }
        } catch {
          pinnedIds = getPinnedTabIds();
          savedNames = getTabNames();
        }

        // セッション検索用マップ
        const sessionMap = new Map(activeSessions.map(s => [s.projectId, s]));

        // TAB_ORDER がある場合: 保存された順序でタブを復元
        // TAB_ORDER がない場合: 従来通りピン止めタブのみ復元
        let restorable: typeof activeSessions;
        if (tabOrder.length > 0) {
          // TAB_ORDER の順序でアクティブセッションがあるものを復元
          restorable = tabOrder
            .map(id => sessionMap.get(id))
            .filter((s): s is NonNullable<typeof s> => s != null && s.messageCount > 0);
          // TAB_ORDER にないがピン止めされているセッションも末尾に追加
          for (const s of activeSessions) {
            if (!tabOrder.includes(s.projectId) && pinnedIds.has(s.projectId) && s.messageCount > 0) {
              restorable.push(s);
            }
          }
        } else {
          // 従来互換: ピン止めタブのみ
          restorable = activeSessions.filter(
            s => s.messageCount > 0 && pinnedIds.has(s.projectId)
          );
        }
        if (restorable.length === 0) return;

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
          inputText: '',
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

  /** タブごとの入力テキスト（グローバル state ではなくタブデータから派生） */
  const input = activeTab?.inputText ?? '';
  const setInput = useCallback((text: string) => {
    setTabs(prev => prev.map(t =>
      t.projectId === activeTabId ? { ...t, inputText: text } : t
    ));
  }, [activeTabId]);

  // アクティブタブの machineId を machineList から導出（DocPanel 用）
  const activeMachineId = (() => {
    if (!activeTab) return null;
    for (const m of machineList) {
      if (m.projects.some(p => p.id === activeTab.projectId)) return m.id;
    }
    return null;
  })();

  // メッセージ追加時に自動スクロール（上スクロール読み込み中・タブ切替時は抑制）
  const shouldAutoScrollRef = useRef(true);
  /** プログラムによるスムーズスクロール中のガードタイムスタンプ */
  const autoScrollingUntilRef = useRef(0);
  /** 履歴ロード直後フラグ（instant スクロール用） */
  const historyJustLoadedRef = useRef(false);
  useEffect(() => {
    if (shouldAutoScrollRef.current) {
      const useInstant = historyJustLoadedRef.current;
      historyJustLoadedRef.current = false;
      // instant/smooth 両方にガードを設定（handleScroll の干渉を防ぐ）
      autoScrollingUntilRef.current = Date.now() + 500;
      if (useInstant) {
        // 履歴ロード直後: scrollTop 直接操作（scrollIntoView はモバイルで不安定）
        const container = messagesContainerRef.current;
        if (container) container.scrollTop = container.scrollHeight;
      } else {
        // 通常の新メッセージ到着時は smooth スクロール
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      }
    }
  }, [activeTab?.messages, activeTab?.progress]);

  // タブ切替時は instant で最下部に移動（アニメーションなし）
  useEffect(() => {
    shouldAutoScrollRef.current = false;
    // handleScroll の干渉を防ぐガード
    autoScrollingUntilRef.current = Date.now() + 500;
    const container = messagesContainerRef.current;
    if (container) container.scrollTop = container.scrollHeight;
    // タッチデバイスでは focus しない（キーボードが開くのを防ぐ）
    if (!('ontouchstart' in window)) {
      inputRef.current?.focus();
    }
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
    projectsApi.getMessages(tabId, { before: oldestMsg.id, limit: 20 }).then(({ messages, hasMore }) => {
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
        const merged = [...newMsgs, ...t.messages];
        // 上限を超えた新しい方（末尾）を除去（ユーザーは上部を見ている）
        const trimmed = merged.length > MAX_MESSAGES ? merged.slice(0, MAX_MESSAGES) : merged;
        return {
          ...t,
          messages: trimmed,
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
    // プログラムによるスムーズスクロールアニメーション中は shouldAutoScrollRef を変更しない
    if (Date.now() < autoScrollingUntilRef.current) return;
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
        inputText: '',
      };
      setTabs(prev => {
        const updated = [...prev, newTab];
        // サーバーにタブ順序を保存（fire-and-forget）
        settingsApi.saveTabOrder(updated.map(t => t.projectId)).catch(() => {});
        return updated;
      });

      // アクティブサーバーがある場合はプロジェクトを自動登録
      if (activeServerId) {
        setServers(prev => {
          const next = prev.map(s =>
            s.id === activeServerId && !s.projectIds.includes(projectId)
              ? { ...s, projectIds: [...s.projectIds, projectId] }
              : s
          );
          settingsApi.saveServers(next).catch(() => {});
          return next;
        });
      }
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
      // サーバーにタブ順序を保存（fire-and-forget）
      settingsApi.saveTabOrder(newTabs.map(t => t.projectId)).catch(() => {});
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
      settingsApi.saveTabOrder(updated.map(t => t.projectId)).catch(() => {});
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
      // サーバーにもカスタム名を保存（fire-and-forget）
      const names: Record<string, string> = {};
      for (const t of updated) {
        if (t.customName) names[t.projectId] = t.customName;
      }
      settingsApi.saveTabNames(names).catch(() => {});
      return updated;
    });
  }, []);

  /** タブの並べ替え（ドラッグ&ドロップ） */
  const handleReorderTabs = useCallback((fromIndex: number, toIndex: number) => {
    setTabs(prev => {
      const updated = [...prev];
      const [moved] = updated.splice(fromIndex, 1);
      updated.splice(toIndex, 0, moved);
      // サーバーにタブ順序を保存（fire-and-forget）
      settingsApi.saveTabOrder(updated.map(t => t.projectId)).catch(() => {});
      return updated;
    });
  }, []);

  // -----------------------------------------------------------------------
  // サーバー（タブグループ）管理
  // -----------------------------------------------------------------------

  /** サーバー定義を保存（state + バックエンド） */
  const persistServers = useCallback((next: ChatServer[]) => {
    setServers(next);
    settingsApi.saveServers(next).catch(() => {});
  }, []);

  /** アクティブサーバーを切り替え */
  const handleSelectServer = useCallback((id: string | null) => {
    setActiveServerId(id);
    settingsApi.saveActiveServer(id).catch(() => {});
  }, []);

  /** サーバーを新規作成 */
  const handleCreateServer = useCallback((name: string) => {
    const newServer: ChatServer = {
      id: crypto.randomUUID(),
      name,
      projectIds: [],
    };
    const next = [...servers, newServer];
    persistServers(next);
    handleSelectServer(newServer.id);
    setSidebarMode('servers');
  }, [servers, persistServers, handleSelectServer]);

  /** サーバー名を変更 */
  const handleRenameServer = useCallback((id: string, name: string) => {
    persistServers(servers.map(s => s.id === id ? { ...s, name } : s));
  }, [servers, persistServers]);

  /** サーバーを削除（タブ自体は残る） */
  const handleDeleteServer = useCallback((id: string) => {
    persistServers(servers.filter(s => s.id !== id));
    if (activeServerId === id) handleSelectServer(null);
  }, [servers, activeServerId, persistServers, handleSelectServer]);

  /** プロジェクトをアクティブサーバーから除去 */
  const handleRemoveProjectFromServer = useCallback((projectId: string) => {
    if (!activeServerId) return;
    persistServers(servers.map(s =>
      s.id === activeServerId
        ? { ...s, projectIds: s.projectIds.filter(pid => pid !== projectId) }
        : s
    ));
  }, [activeServerId, servers, persistServers]);

  /** 指定サーバーにプロジェクトを追加（D&D 用） */
  const handleAddProjectToServer = useCallback((serverId: string, projectId: string) => {
    persistServers(servers.map(s =>
      s.id === serverId && !s.projectIds.includes(projectId)
        ? { ...s, projectIds: [...s.projectIds, projectId] }
        : s
    ));
  }, [servers, persistServers]);

  /** サーバー内プロジェクトの並べ替え */
  const handleReorderServerProjects = useCallback((serverId: string, fromIndex: number, toIndex: number) => {
    persistServers(servers.map(s => {
      if (s.id !== serverId) return s;
      const ids = [...s.projectIds];
      const [moved] = ids.splice(fromIndex, 1);
      ids.splice(toIndex, 0, moved);
      return { ...s, projectIds: ids };
    }));
  }, [servers, persistServers]);

  /** アクティブサーバー */
  const activeServer = servers.find(s => s.id === activeServerId) ?? null;

  /** タブバーに表示するタブ（サーバーでフィルタ） */
  const visibleTabs = activeServerId && activeServer
    ? tabs.filter(t => activeServer.projectIds.includes(t.projectId))
    : tabs;

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

    playNotificationSound();
    sendCommand(sendText, hasFiles ? pendingFiles : undefined, activeTabId || undefined);
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

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) await addFiles(files);
    e.target.value = '';
  };

  /** ドラッグオーバー中フラグ（視覚フィードバック用） */
  const [dragOver, setDragOver] = useState(false);
  const dragCounterRef = useRef(0);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current++;
    if (e.dataTransfer.types.includes('Files')) setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) setDragOver(false);
  }, []);

  const handleDragDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current = 0;
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) await addFiles(files);
  }, [addFiles]);

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
          mode={sidebarMode}
          onChangeMode={setSidebarMode}
          servers={servers}
          activeServerId={activeServerId}
          onSelectServer={handleSelectServer}
          onCreateServer={handleCreateServer}
          onRenameServer={handleRenameServer}
          onDeleteServer={handleDeleteServer}
          onRemoveProject={handleRemoveProjectFromServer}
          onAddProjectToServer={handleAddProjectToServer}
          tabCustomNames={Object.fromEntries(tabs.filter(t => t.customName).map(t => [t.projectId, t.customName!]))}
          onReorderServerProjects={handleReorderServerProjects}
        />
      )}

      {/* チャットエリア（ドロップゾーン） */}
      <div
        className="flex-1 flex flex-col min-w-0 relative"
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleDragDrop}
      >
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
          tabs={visibleTabs}
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
          {/* ツール承認カード / 質問カード（アクティブタブの projectId に一致するもののみ表示） */}
          {Array.from(toolApprovals.values())
            .filter(a => !a.projectId || a.projectId === activeTabId)
            .map(approval => (
              approval.isQuestion ? (
                <QuestionCard
                  key={approval.requestId}
                  approval={approval}
                  onRespond={handleToolApprovalRespond}
                />
              ) : (
                <ToolApprovalCard
                  key={approval.requestId}
                  approval={approval}
                  onRespond={handleToolApprovalRespond}
                />
              )
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

        {/* ドラッグ中オーバーレイ */}
        {dragOver && (
          <div className="absolute inset-0 z-10 bg-[var(--accent-blue)]/10 border-2 border-dashed border-[var(--accent-blue)] rounded-lg flex items-center justify-center pointer-events-none">
            <div className="bg-[var(--bg-secondary)] rounded-lg px-6 py-4 shadow-lg border border-[var(--border-color)]">
              <p className="text-sm text-[var(--text-primary)] font-semibold">ファイルをドロップして添付</p>
            </div>
          </div>
        )}
      </div>

      {/* ドキュメントパネル（右サイド、大画面のみ、最大化時は非表示） */}
      {!maximized && (
        <DocPanel
          machineId={activeMachineId}
          machineDisplayName={activeTab?.machineDisplayName ?? ''}
          projectId={activeTab?.projectId ?? null}
          approvalHistory={approvalHistory}
        />
      )}

      {/* 画像ライトボックス */}
      {lightboxImage && (
        <ImageLightbox src={lightboxImage} onClose={() => setLightboxImage(null)} />
      )}
    </div>
  );
}
