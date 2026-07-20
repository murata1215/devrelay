import { useEffect, useState } from 'react';
import { settings, platforms, services, agreementTemplate, allowedTools, org as orgApi, type LinkedPlatform, type ServiceStatus, type AgreementTemplateResponse, type AllowedToolsResponse, type OrgMember, type OrgActivity } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { useOrganization } from '../contexts/OrganizationContext';
import { isNotificationSoundEnabled, setNotificationSoundEnabled, playNotificationSound } from '../utils/notification-sound';
import { getDocPanelSettings, setDocPanelSettings, type DocPanelSettings } from '../utils/doc-panel-settings';

/** API キーフィールドの定義 */
interface ApiKeyFieldDef {
  key: string;
  label: string;
  placeholder: string;
  description: string;
  linkUrl: string;
  linkText: string;
}

/** AI プロバイダー選択の定義 */
interface ProviderSelectDef {
  key: string;
  label: string;
  description: string;
}

/** 3社分の API キー定義 */
const API_KEY_FIELDS: ApiKeyFieldDef[] = [
  {
    key: 'openai_api_key',
    label: 'OpenAI API Key',
    placeholder: 'sk-...',
    description: 'GPT-4o-mini for build summary and chat AI.',
    linkUrl: 'https://platform.openai.com/api-keys',
    linkText: 'OpenAI Platform',
  },
  {
    key: 'anthropic_api_key',
    label: 'Anthropic API Key',
    placeholder: 'sk-ant-...',
    description: 'Claude Haiku for build summary and chat AI.',
    linkUrl: 'https://console.anthropic.com/settings/keys',
    linkText: 'Anthropic Console',
  },
  {
    key: 'gemini_api_key',
    label: 'Gemini API Key',
    placeholder: 'AIza...',
    description: 'Gemini 2.0 Flash for build summary and chat AI.',
    linkUrl: 'https://aistudio.google.com/apikey',
    linkText: 'Google AI Studio',
  },
];

/** プロバイダー選択ドロップダウンの選択肢 */
const PROVIDER_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: 'openai', label: 'OpenAI (gpt-4o-mini)' },
  { value: 'anthropic', label: 'Anthropic (Claude Haiku)' },
  { value: 'gemini', label: 'Gemini (2.0 Flash)' },
];

/** プロバイダー選択フィールドの定義 */
const PROVIDER_SELECTS: ProviderSelectDef[] = [
  {
    key: 'build_summary_provider',
    label: 'Build Summary',
    description: 'exec 完了時のビルドログ要約に使用',
  },
  {
    key: 'chat_ai_provider',
    label: 'Chat AI',
    description: '自然言語コマンドパースに使用',
  },
  {
    key: 'dev_report_provider',
    label: 'Dev Report',
    description: '開発レポートのセクション分割・要約に使用',
  },
  {
    key: 'terminal_ai_provider',
    label: 'Terminal AI',
    description: '端末モードの画面解析・応答要約に使用',
  },
  {
    key: 'voice_assist_provider',
    label: '会話モード (Voice Assist)',
    description: '音声指示の組み立て会話に使用',
  },
];

/** Claude モデル選択肢（server の AVAILABLE_MODELS と同期。フル ID は CLI バージョン非依存で動作） */
const CLAUDE_MODEL_OPTIONS = [
  { value: '', label: '(default) — CLI 標準' },
  { value: 'claude-fable-5', label: 'Claude Fable 5（最高性能）' },
  { value: 'claude-opus-4-8', label: 'Claude Opus 4.8（高性能・最新）' },
  { value: 'opus', label: 'Claude Opus 4（CLI版）' },
  { value: 'sonnet', label: 'Claude Sonnet 4（バランス型）' },
  { value: 'haiku', label: 'Claude Haiku 3.5（高速・低コスト）' },
];

/** Claude モデル設定フィールド（plan/exec 別）。`l` コマンドと同じ UserSettings キーを共有 */
const CLAUDE_MODEL_FIELDS = [
  { key: 'claude_model_plan', label: 'Plan モード', description: 'プランモードで使用するモデル' },
  { key: 'claude_model_exec', label: 'Exec モード', description: '実行モードで使用するモデル' },
];

/** チャット表示設定（localStorage 管理） */
const CHAT_DISPLAY_KEY = 'devrelay-chat-display';
const DEFAULT_USER_COLOR = '#5865f2';
const DEFAULT_AI_COLOR = '#57f287';

interface ChatDisplaySettings {
  userName: string;
  userColor: string;
  userAvatar?: string;
  aiName: string;
  aiColor: string;
  aiAvatar?: string;
}

/**
 * エンタープライズモード（組織）セクション。
 * - 未所属: 「組織を作成」/「組織に参加」タブ
 * - admin: 組織ID表示・パスワード変更・ロゴ管理・メンバー管理・アクティビティ監視
 * - member: 組織名表示 + 脱退
 */
function EnterpriseSection({ userEmail }: { userEmail: string | null }) {
  const { organization, refresh } = useOrganization();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');

  // 未所属時のタブ・入力
  const [tab, setTab] = useState<'create' | 'join'>('create');
  const [createName, setCreateName] = useState('');
  const [createPw, setCreatePw] = useState('');
  const [createPw2, setCreatePw2] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [joinPw, setJoinPw] = useState('');
  // 作成直後に発行された組織IDを大きく表示するための一時状態
  const [issuedCode, setIssuedCode] = useState('');

  // admin: パスワード変更
  const [newPw, setNewPw] = useState('');
  // admin: メンバー / アクティビティ
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [activity, setActivity] = useState<OrgActivity[]>([]);
  // ロゴプレビュー用のキャッシュバスター
  const [logoBust, setLogoBust] = useState(Date.now());

  const isAdmin = organization?.role === 'admin';

  // admin のときメンバー・アクティビティを読み込む
  useEffect(() => {
    if (!isAdmin) return;
    orgApi.listMembers().then((r) => setMembers(r.members)).catch(() => { /* ignore */ });
    orgApi.activity().then((r) => setActivity(r.activity)).catch(() => { /* ignore */ });
  }, [isAdmin, organization?.orgCode]);

  const flash = (message: string, isError = false) => {
    if (isError) { setErr(message); setOk(''); } else { setOk(message); setErr(''); }
    setTimeout(() => { setErr(''); setOk(''); }, 4000);
  };

  /** 組織を作成する */
  const handleCreate = async () => {
    if (!createName.trim()) return flash('会社名を入力してください', true);
    if (createPw.length < 4) return flash('参加パスワードは4文字以上で設定してください', true);
    if (createPw !== createPw2) return flash('参加パスワードが一致しません', true);
    setBusy(true);
    try {
      const { organization: created } = await orgApi.create(createName.trim(), createPw);
      setIssuedCode(created.orgCode || '');
      setCreateName(''); setCreatePw(''); setCreatePw2('');
      await refresh();
      flash('組織を作成しました');
    } catch (e) {
      flash(e instanceof Error ? e.message : '作成に失敗しました', true);
    } finally { setBusy(false); }
  };

  /** 組織に参加する */
  const handleJoin = async () => {
    if (!joinCode.trim() || !joinPw) return flash('組織IDと参加パスワードを入力してください', true);
    setBusy(true);
    try {
      await orgApi.join(joinCode.trim(), joinPw);
      setJoinCode(''); setJoinPw('');
      await refresh();
      flash('組織に参加しました');
    } catch (e) {
      flash(e instanceof Error ? e.message : '参加に失敗しました', true);
    } finally { setBusy(false); }
  };

  /** 組織から脱退する */
  const handleLeave = async () => {
    if (!confirm('この組織から脱退しますか？')) return;
    setBusy(true);
    try {
      await orgApi.leave();
      await refresh();
      flash('組織から脱退しました');
    } catch (e) {
      flash(e instanceof Error ? e.message : '脱退に失敗しました', true);
    } finally { setBusy(false); }
  };

  /** 参加パスワードを変更する */
  const handleChangePw = async () => {
    if (newPw.length < 4) return flash('参加パスワードは4文字以上で設定してください', true);
    setBusy(true);
    try {
      await orgApi.changePassword(newPw);
      setNewPw('');
      flash('参加パスワードを変更しました');
    } catch (e) {
      flash(e instanceof Error ? e.message : '変更に失敗しました', true);
    } finally { setBusy(false); }
  };

  /** ロゴ画像をアップロードする（FileReader で base64 data URL 化） */
  const handleLogoUpload = (file: File) => {
    if (file.size > 512 * 1024) return flash('ロゴ画像は512KB以下にしてください', true);
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = reader.result as string;
      setBusy(true);
      try {
        await orgApi.uploadLogo(dataUrl);
        await refresh();
        setLogoBust(Date.now());
        flash('ロゴを登録しました');
      } catch (e) {
        flash(e instanceof Error ? e.message : 'ロゴ登録に失敗しました', true);
      } finally { setBusy(false); }
    };
    reader.readAsDataURL(file);
  };

  /** ロゴを削除する */
  const handleLogoRemove = async () => {
    setBusy(true);
    try {
      await orgApi.removeLogo();
      await refresh();
      setLogoBust(Date.now());
      flash('ロゴを削除しました');
    } catch (e) {
      flash(e instanceof Error ? e.message : 'ロゴ削除に失敗しました', true);
    } finally { setBusy(false); }
  };

  /** メンバーを削除する */
  const handleRemoveMember = async (m: OrgMember) => {
    if (!confirm(`${m.email || m.name || m.userId} を組織から削除しますか？`)) return;
    setBusy(true);
    try {
      await orgApi.removeMember(m.userId);
      const r = await orgApi.listMembers();
      setMembers(r.members);
      flash('メンバーを削除しました');
    } catch (e) {
      flash(e instanceof Error ? e.message : '削除に失敗しました', true);
    } finally { setBusy(false); }
  };

  /** メンバーの role を変更する */
  const handleToggleRole = async (m: OrgMember) => {
    const next = m.role === 'admin' ? 'member' : 'admin';
    setBusy(true);
    try {
      await orgApi.updateRole(m.userId, next);
      const r = await orgApi.listMembers();
      setMembers(r.members);
      flash('権限を変更しました');
    } catch (e) {
      flash(e instanceof Error ? e.message : '変更に失敗しました', true);
    } finally { setBusy(false); }
  };

  const inputCls = 'w-full px-3 py-2 bg-[var(--bg-base)] border border-[var(--border-color)] rounded text-[var(--text-primary)] text-sm';
  const btnPrimary = 'px-4 py-2 bg-[var(--accent-blue)] text-white rounded text-sm font-medium disabled:opacity-50';

  return (
    <div className="bg-[var(--bg-secondary)] rounded-lg p-6">
      <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-4">Enterprise（組織）</h2>

      {err && <div className="mb-4 bg-[var(--bg-danger)] border border-[var(--border-danger)] text-[var(--text-danger)] px-3 py-2 rounded text-sm">{err}</div>}
      {ok && <div className="mb-4 bg-green-500/20 border border-green-500 text-[var(--text-success)] px-3 py-2 rounded text-sm">{ok}</div>}

      {/* 未所属 */}
      {!organization && (
        <div>
          {issuedCode ? (
            <div className="mb-4 p-4 rounded border border-[var(--accent-blue)] bg-[var(--bg-base)]">
              <p className="text-sm text-[var(--text-secondary)] mb-2">組織を作成しました。以下の<strong>組織ID</strong>と参加パスワードをメンバーに伝えてください。</p>
              <div className="flex items-center gap-2">
                <code className="text-xl font-bold text-[var(--text-primary)]">{issuedCode}</code>
                <button onClick={() => navigator.clipboard?.writeText(issuedCode)} className="px-2 py-1 text-xs border border-[var(--border-color)] rounded text-[var(--text-secondary)]">コピー</button>
              </div>
            </div>
          ) : (
            <>
              <div className="flex gap-2 mb-4">
                <button onClick={() => setTab('create')} className={`px-3 py-1.5 rounded text-sm ${tab === 'create' ? 'bg-[var(--accent-blue)] text-white' : 'bg-[var(--bg-base)] text-[var(--text-secondary)]'}`}>組織を作成</button>
                <button onClick={() => setTab('join')} className={`px-3 py-1.5 rounded text-sm ${tab === 'join' ? 'bg-[var(--accent-blue)] text-white' : 'bg-[var(--bg-base)] text-[var(--text-secondary)]'}`}>組織に参加</button>
              </div>

              {tab === 'create' ? (
                <div className="space-y-3">
                  <input className={inputCls} placeholder="会社名" value={createName} onChange={(e) => setCreateName(e.target.value)} />
                  <input className={inputCls} type="password" placeholder="参加パスワード（4文字以上）" value={createPw} onChange={(e) => setCreatePw(e.target.value)} />
                  <input className={inputCls} type="password" placeholder="参加パスワード（確認）" value={createPw2} onChange={(e) => setCreatePw2(e.target.value)} />
                  <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
                    <input type="checkbox" checked readOnly /> 現在のアカウント（{userEmail || 'あなた'}）を管理者にする
                  </label>
                  <button onClick={handleCreate} disabled={busy} className={btnPrimary}>組織を作成</button>
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-xs text-[var(--text-faint)]">管理者から共有された組織IDと参加パスワードを入力してください。</p>
                  <input className={inputCls} placeholder="組織ID（例: ORG-XXXXXX）" value={joinCode} onChange={(e) => setJoinCode(e.target.value)} />
                  <input className={inputCls} type="password" placeholder="参加パスワード" value={joinPw} onChange={(e) => setJoinPw(e.target.value)} />
                  <button onClick={handleJoin} disabled={busy} className={btnPrimary}>参加</button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* member */}
      {organization && !isAdmin && (
        <div className="space-y-3">
          <p className="text-sm text-[var(--text-secondary)]">
            所属組織: <strong className="text-[var(--text-primary)]">{organization.name}</strong>
          </p>
          <p className="text-xs text-[var(--text-faint)]">この組織の統制下にあります。</p>
          <button onClick={handleLeave} disabled={busy} className="px-4 py-2 border border-[var(--border-danger)] text-[var(--text-danger)] rounded text-sm">脱退する</button>
        </div>
      )}

      {/* admin */}
      {organization && isAdmin && (
        <div className="space-y-6">
          {/* 組織ID */}
          <div>
            <label className="block text-sm font-medium text-[var(--text-secondary)] mb-2">組織ID（メンバーに共有）</label>
            <div className="flex items-center gap-2">
              <code className="text-lg font-bold text-[var(--text-primary)]">{organization.orgCode}</code>
              <button onClick={() => organization.orgCode && navigator.clipboard?.writeText(organization.orgCode)} className="px-2 py-1 text-xs border border-[var(--border-color)] rounded text-[var(--text-secondary)]">コピー</button>
            </div>
          </div>

          {/* 参加パスワード変更 */}
          <div>
            <label className="block text-sm font-medium text-[var(--text-secondary)] mb-2">参加パスワードの変更</label>
            <div className="flex gap-2">
              <input className={inputCls} type="password" placeholder="新しい参加パスワード" value={newPw} onChange={(e) => setNewPw(e.target.value)} />
              <button onClick={handleChangePw} disabled={busy} className={btnPrimary}>変更</button>
            </div>
          </div>

          {/* ロゴ */}
          <div>
            <label className="block text-sm font-medium text-[var(--text-secondary)] mb-2">会社ロゴ（左上に表示）</label>
            <div className="flex items-center gap-4">
              {organization.hasLogo && (
                <img src={`${orgApi.getLogoUrl()}&_=${logoBust}`} alt="logo" className="h-10 w-auto max-w-[160px] object-contain rounded border border-[var(--border-color)]" />
              )}
              <label className="px-3 py-2 bg-[var(--bg-base)] border border-[var(--border-color)] rounded text-sm text-[var(--text-secondary)] cursor-pointer">
                画像を選択
                <input type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleLogoUpload(f); e.target.value = ''; }} />
              </label>
              {organization.hasLogo && (
                <button onClick={handleLogoRemove} disabled={busy} className="text-sm text-[var(--text-danger)]">削除</button>
              )}
            </div>
            <p className="text-xs text-[var(--text-faint)] mt-1">PNG/JPG、512KB以下</p>
          </div>

          {/* メンバー管理 */}
          <div>
            <label className="block text-sm font-medium text-[var(--text-secondary)] mb-2">メンバー（{members.length}名）</label>
            <p className="text-xs text-[var(--text-faint)] mb-2">メンバーは組織ID + 参加パスワードで自己参加します。</p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[var(--text-faint)] border-b border-[var(--border-color)]">
                    <th className="py-2 pr-4">メンバー</th>
                    <th className="py-2 pr-4">権限</th>
                    <th className="py-2 pr-4">参加日</th>
                    <th className="py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((m) => (
                    <tr key={m.userId} className="border-b border-[var(--border-color)]">
                      <td className="py-2 pr-4 text-[var(--text-primary)]">{m.email || m.name || m.userId}{m.isSelf && <span className="text-[var(--text-faint)]">（あなた）</span>}</td>
                      <td className="py-2 pr-4 text-[var(--text-secondary)]">{m.role}</td>
                      <td className="py-2 pr-4 text-[var(--text-faint)]">{new Date(m.createdAt).toLocaleDateString()}</td>
                      <td className="py-2 text-right whitespace-nowrap">
                        {!m.isSelf && (
                          <>
                            <button onClick={() => handleToggleRole(m)} disabled={busy} className="text-xs text-[var(--text-link)] mr-3">{m.role === 'admin' ? 'member にする' : 'admin にする'}</button>
                            <button onClick={() => handleRemoveMember(m)} disabled={busy} className="text-xs text-[var(--text-danger)]">削除</button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* アクティビティ監視 */}
          <div>
            <label className="block text-sm font-medium text-[var(--text-secondary)] mb-2">Member Activity（監視）</label>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[var(--text-faint)] border-b border-[var(--border-color)]">
                    <th className="py-2 pr-4">メンバー</th>
                    <th className="py-2 pr-4">最終利用</th>
                    <th className="py-2 pr-4">セッション</th>
                    <th className="py-2 pr-4">ビルド</th>
                    <th className="py-2">オンライン</th>
                  </tr>
                </thead>
                <tbody>
                  {activity.map((a) => (
                    <tr key={a.userId} className="border-b border-[var(--border-color)]">
                      <td className="py-2 pr-4 text-[var(--text-primary)]">{a.email || a.name || a.userId}</td>
                      <td className="py-2 pr-4 text-[var(--text-faint)]">{a.lastActiveAt ? new Date(a.lastActiveAt).toLocaleString() : '—'}</td>
                      <td className="py-2 pr-4 text-[var(--text-secondary)]">{a.sessionCount}</td>
                      <td className="py-2 pr-4 text-[var(--text-secondary)]">{a.buildCount}</td>
                      <td className="py-2 text-[var(--text-secondary)]">{a.onlineMachines > 0 ? `🟢 ${a.onlineMachines}` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function SettingsPage() {
  const { user } = useAuth();
  const [data, setData] = useState<Record<string, string>>({});
  const [linkedPlatforms, setLinkedPlatforms] = useState<LinkedPlatform[]>([]);
  const [serviceStatus, setServiceStatus] = useState<ServiceStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // API キー入力用のステート（キー名 → 入力値）
  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({});

  // Bot Token 入力
  const [discordToken, setDiscordToken] = useState('');
  const [telegramToken, setTelegramToken] = useState('');
  const [linkCode, setLinkCode] = useState('');
  const [linking, setLinking] = useState(false);
  const [unlinking, setUnlinking] = useState<string | null>(null);

  // 通知音設定
  const [soundEnabled, setSoundEnabled] = useState(() => isNotificationSoundEnabled());

  // チャット右パネル（DocPanel）のタブ表示設定
  const [docPanel, setDocPanel] = useState<DocPanelSettings>(getDocPanelSettings);
  /** DocPanel の指定タブの ON/OFF を切り替えて即保存 */
  const toggleDocPanel = (key: keyof DocPanelSettings) => {
    const next = { ...docPanel, [key]: !docPanel[key] };
    setDocPanel(next);
    setDocPanelSettings(next); // localStorage 保存 + ChatPage へイベント通知
  };

  // チャット表示設定（localStorage）
  const fallbackName = user?.name || user?.email || 'User';
  const [chatDisplay, setChatDisplay] = useState<ChatDisplaySettings>(() => {
    try {
      const raw = localStorage.getItem(CHAT_DISPLAY_KEY);
      if (raw) {
        const p = JSON.parse(raw);
        return {
          userName: p.userName || fallbackName,
          userColor: p.userColor || DEFAULT_USER_COLOR,
          userAvatar: p.userAvatar || undefined,
          aiName: p.aiName || 'DevRelay',
          aiColor: p.aiColor || DEFAULT_AI_COLOR,
          aiAvatar: p.aiAvatar || undefined,
        };
      }
    } catch { /* ignore */ }
    return { userName: fallbackName, userColor: DEFAULT_USER_COLOR, aiName: 'DevRelay', aiColor: DEFAULT_AI_COLOR };
  });

  /** チャット表示設定を保存（localStorage + サーバー） */
  const saveChatDisplay = (updated: ChatDisplaySettings) => {
    setChatDisplay(updated);
    const json = JSON.stringify(updated);
    localStorage.setItem(CHAT_DISPLAY_KEY, json);
    // サーバーにも非同期で保存（fire-and-forget）
    settings.saveChatDisplay(json).catch(() => { /* ignore */ });
  };

  /** チャット表示設定をデフォルトにリセット */
  const resetChatDisplay = () => {
    const defaults: ChatDisplaySettings = { userName: fallbackName, userColor: DEFAULT_USER_COLOR, aiName: 'DevRelay', aiColor: DEFAULT_AI_COLOR };
    saveChatDisplay(defaults);
  };

  // Service restart state
  const [restartingServer, setRestartingServer] = useState(false);
  const [restartingAgent, setRestartingAgent] = useState(false);

  // Agreement テンプレート
  const [agreementData, setAgreementData] = useState<AgreementTemplateResponse | null>(null);
  const [agreementDraft, setAgreementDraft] = useState('');
  const [agreementSaving, setAgreementSaving] = useState(false);
  const [agreementDirty, setAgreementDirty] = useState(false);

  // Allowed Tools（プランモード許可ツール）
  const [atData, setAtData] = useState<AllowedToolsResponse | null>(null);
  const [atLinuxDraft, setAtLinuxDraft] = useState('');
  const [atWindowsDraft, setAtWindowsDraft] = useState('');
  const [atLinuxDirty, setAtLinuxDirty] = useState(false);
  const [atWindowsDirty, setAtWindowsDirty] = useState(false);
  const [atSaving, setAtSaving] = useState<'linux' | 'windows' | null>(null);

  const loadSettings = async () => {
    try {
      const [settingsResult, platformsResult, serviceStatusResult, agreementResult, atResult] = await Promise.all([
        settings.get(),
        platforms.list(),
        services.status().catch(() => null),
        agreementTemplate.get().catch(() => null),
        allowedTools.get().catch(() => null),
      ]);
      setData(settingsResult);
      // サーバーにチャット表示設定があれば localStorage を上書きして反映
      if (settingsResult['chat_display']) {
        try {
          const serverDisplay = JSON.parse(settingsResult['chat_display']);
          const merged: ChatDisplaySettings = {
            userName: serverDisplay.userName || fallbackName,
            userColor: serverDisplay.userColor || DEFAULT_USER_COLOR,
            userAvatar: serverDisplay.userAvatar || undefined,
            aiName: serverDisplay.aiName || 'DevRelay',
            aiColor: serverDisplay.aiColor || DEFAULT_AI_COLOR,
            aiAvatar: serverDisplay.aiAvatar || undefined,
          };
          setChatDisplay(merged);
          localStorage.setItem(CHAT_DISPLAY_KEY, JSON.stringify(merged));
        } catch { /* ignore parse error */ }
      }
      setLinkedPlatforms(platformsResult);
      setServiceStatus(serviceStatusResult);
      if (agreementResult) {
        setAgreementData(agreementResult);
        setAgreementDraft(agreementResult.template);
      }
      if (atResult) {
        setAtData(atResult);
        // カスタム値があればそれを、なければデフォルトをテキストエリアに表示
        setAtLinuxDraft((atResult.linux.tools ?? atResult.linux.defaults).join('\n'));
        setAtWindowsDraft((atResult.windows.tools ?? atResult.windows.defaults).join('\n'));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load settings');
    } finally {
      setLoading(false);
    }
  };

  const handleRestartServer = async () => {
    if (!confirm('Are you sure you want to restart the server? This will temporarily disconnect all agents.')) {
      return;
    }

    setRestartingServer(true);
    setError('');
    setSuccess('');

    try {
      await services.restartServer();
      setSuccess('Server restart initiated. The page will reload shortly...');
      setTimeout(() => {
        window.location.reload();
      }, 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to restart server');
      setRestartingServer(false);
    }
  };

  const handleRestartAgent = async () => {
    if (!confirm('Are you sure you want to restart the agent?')) {
      return;
    }

    setRestartingAgent(true);
    setError('');
    setSuccess('');

    try {
      await services.restartAgent();
      setSuccess('Agent restart initiated');
      setTimeout(async () => {
        try {
          const status = await services.status();
          setServiceStatus(status);
        } catch {}
        setRestartingAgent(false);
      }, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to restart agent');
      setRestartingAgent(false);
    }
  };

  /** サーバーとエージェントを両方再起動 */
  const handleRestartBoth = async () => {
    if (!confirm('Are you sure you want to restart both server and agent? All connections will be temporarily lost.')) {
      return;
    }

    setRestartingServer(true);
    setRestartingAgent(true);
    setError('');
    setSuccess('');

    try {
      // Agent を先に再起動（サーバー再起動後は API 不通になるため）
      await services.restartAgent();
      await services.restartServer();
      setSuccess('Both services restart initiated. The page will reload shortly...');
      setTimeout(() => {
        window.location.reload();
      }, 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to restart services');
      setRestartingServer(false);
      setRestartingAgent(false);
    }
  };

  useEffect(() => {
    loadSettings();
  }, []);

  /** API キー / Bot Token を保存 */
  const handleSaveApiKey = async (key: string, value: string, displayName: string) => {
    if (!value.trim()) {
      setError(`${displayName} cannot be empty`);
      return;
    }

    setSaving(key);
    setError('');
    setSuccess('');

    try {
      await settings.update(key, value);
      setSuccess(`${displayName} saved successfully`);
      // 入力をクリア
      setKeyInputs((prev) => ({ ...prev, [key]: '' }));
      if (key === 'discord_bot_token') setDiscordToken('');
      if (key === 'telegram_bot_token') setTelegramToken('');
      const result = await settings.get();
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save setting');
    } finally {
      setSaving(null);
    }
  };

  /** API キー / Bot Token を削除 */
  const handleDeleteApiKey = async (key: string, displayName: string) => {
    setSaving(key);
    setError('');
    setSuccess('');

    try {
      await settings.delete(key);
      setSuccess(`${displayName} removed`);
      const result = await settings.get();
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove setting');
    } finally {
      setSaving(null);
    }
  };

  /** プロバイダー選択を保存（select 変更時に即座保存） */
  const handleProviderChange = async (key: string, value: string) => {
    setError('');
    setSuccess('');

    try {
      await settings.update(key, value);
      setData((prev) => ({ ...prev, [key]: value }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save provider setting');
    }
  };

  /**
   * Claude モデル設定を保存（select 変更時に即座保存）
   * 空文字（default）選択時はキーを削除して CLI 標準に戻す。
   * `l` コマンドと同じ UserSettings キーを共有するため last-write-wins で整合する。
   */
  const handleModelChange = async (key: string, value: string) => {
    setError('');
    setSuccess('');

    try {
      if (value === '') {
        // (default) 選択 → キー削除で CLI 標準に戻す
        await settings.delete(key);
        setData((prev) => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
      } else {
        await settings.update(key, value);
        setData((prev) => ({ ...prev, [key]: value }));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save model setting');
    }
  };

  const handleLinkPlatform = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!linkCode.trim()) return;

    setLinking(true);
    setError('');
    setSuccess('');

    try {
      const result = await platforms.link(linkCode.trim().toUpperCase());
      const platformName = result.platformName
        ? ` (${result.platformName})`
        : '';
      setSuccess(`${getPlatformDisplayName(result.platform)}${platformName} linked successfully!`);
      setLinkCode('');
      await loadSettings();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to link platform');
    } finally {
      setLinking(false);
    }
  };

  const handleUnlinkPlatform = async (platform: string) => {
    if (!confirm(`Are you sure you want to unlink ${getPlatformDisplayName(platform)}?`)) {
      return;
    }

    setUnlinking(platform);
    setError('');
    setSuccess('');

    try {
      await platforms.unlink(platform);
      setSuccess(`${getPlatformDisplayName(platform)} unlinked`);
      await loadSettings();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to unlink platform');
    } finally {
      setUnlinking(null);
    }
  };

  /** Agreement テンプレートを保存 */
  const handleSaveAgreement = async () => {
    if (!agreementDraft.trim()) {
      setError('Agreement template cannot be empty');
      return;
    }

    setAgreementSaving(true);
    setError('');
    setSuccess('');

    try {
      await agreementTemplate.update(agreementDraft);
      setSuccess('Agreement template saved successfully');
      setAgreementData(prev => prev ? { ...prev, template: agreementDraft, isCustom: true } : prev);
      setAgreementDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save agreement template');
    } finally {
      setAgreementSaving(false);
    }
  };

  /** Agreement テンプレートをデフォルトにリセット */
  const handleResetAgreement = async () => {
    if (!confirm('Reset the Agreement template to default? Your customizations will be lost.')) {
      return;
    }

    setAgreementSaving(true);
    setError('');
    setSuccess('');

    try {
      const result = await agreementTemplate.reset();
      setAgreementDraft(result.template);
      setAgreementData(prev => prev ? { ...prev, template: result.template, isCustom: false } : prev);
      setAgreementDirty(false);
      setSuccess('Agreement template reset to default');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset agreement template');
    } finally {
      setAgreementSaving(false);
    }
  };

  /** Allowed Tools を保存（テキストエリアの内容を1行1コマンドでパースして配列化） */
  const handleSaveAllowedTools = async (os: 'linux' | 'windows') => {
    const draft = os === 'linux' ? atLinuxDraft : atWindowsDraft;
    const tools = draft.split('\n').map(l => l.trim()).filter(l => l.length > 0);

    setAtSaving(os);
    setError('');
    setSuccess('');

    try {
      await allowedTools.update(os, tools);
      setSuccess(`Allowed tools (${os}) saved successfully`);
      if (os === 'linux') {
        setAtLinuxDirty(false);
        setAtData(prev => prev ? { ...prev, linux: { ...prev.linux, tools } } : prev);
      } else {
        setAtWindowsDirty(false);
        setAtData(prev => prev ? { ...prev, windows: { ...prev.windows, tools } } : prev);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to save allowed tools (${os})`);
    } finally {
      setAtSaving(null);
    }
  };

  /** Allowed Tools をデフォルトにリセット */
  const handleResetAllowedTools = async (os: 'linux' | 'windows') => {
    if (!confirm(`Reset ${os} allowed tools to default?`)) return;

    setAtSaving(os);
    setError('');
    setSuccess('');

    try {
      await allowedTools.update(os, null);
      const defaults = os === 'linux' ? atData?.linux.defaults : atData?.windows.defaults;
      const defaultText = (defaults ?? []).join('\n');
      if (os === 'linux') {
        setAtLinuxDraft(defaultText);
        setAtLinuxDirty(false);
        setAtData(prev => prev ? { ...prev, linux: { ...prev.linux, tools: null } } : prev);
      } else {
        setAtWindowsDraft(defaultText);
        setAtWindowsDirty(false);
        setAtData(prev => prev ? { ...prev, windows: { ...prev.windows, tools: null } } : prev);
      }
      setSuccess(`Allowed tools (${os}) reset to default`);
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to reset allowed tools (${os})`);
    } finally {
      setAtSaving(null);
    }
  };

  const getPlatformDisplayName = (platform: string): string => {
    const names: Record<string, string> = {
      discord: 'Discord',
      telegram: 'Telegram',
      line: 'LINE',
      slack: 'Slack',
    };
    return names[platform] || platform;
  };

  const getPlatformIcon = (platform: string): string => {
    const icons: Record<string, string> = {
      discord: '🎮',
      telegram: '✈️',
      line: '💬',
      slack: '💼',
    };
    return icons[platform] || '🔗';
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-[var(--text-muted)]">Loading...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-[var(--text-primary)]">Settings</h1>

      {error && (
        <div className="bg-[var(--bg-danger)] border border-[var(--border-danger)] text-[var(--text-danger)] px-4 py-3 rounded">
          {error}
        </div>
      )}

      {success && (
        <div className="bg-green-500/20 border border-green-500 text-[var(--text-success)] px-4 py-3 rounded">
          {success}
        </div>
      )}

      {/* Enterprise（組織）Section */}
      <EnterpriseSection userEmail={user?.email ?? null} />

      {/* API Keys Section — 3 社分のキー入力 */}
      <div className="bg-[var(--bg-secondary)] rounded-lg p-6">
        <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-4">API Keys</h2>
        <p className="text-[var(--text-muted)] text-sm mb-6">
          Configure API keys for AI features. Keys are encrypted and stored securely.
        </p>

        <div className="space-y-6">
          {API_KEY_FIELDS.map((field) => (
            <div key={field.key}>
              <label className="block text-sm font-medium text-[var(--text-secondary)] mb-2">
                {field.label}
              </label>
              <p className="text-[var(--text-faint)] text-xs mb-2">
                {field.description}{' '}
                <a
                  href={field.linkUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[var(--text-link)] hover:opacity-80"
                >
                  {field.linkText}
                </a>
              </p>

              {data[field.key] ? (
                <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
                  <code className="flex-1 bg-[var(--bg-tertiary)] px-3 py-2 rounded text-[var(--text-secondary)] text-sm break-all">
                    {data[field.key]}
                  </code>
                  <button
                    onClick={() => handleDeleteApiKey(field.key, field.label)}
                    disabled={saving === field.key}
                    className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded disabled:opacity-50 w-full sm:w-auto"
                  >
                    {saving === field.key ? 'Removing...' : 'Remove'}
                  </button>
                </div>
              ) : (
                <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
                  <input
                    type="password"
                    value={keyInputs[field.key] || ''}
                    onChange={(e) => setKeyInputs((prev) => ({ ...prev, [field.key]: e.target.value }))}
                    placeholder={field.placeholder}
                    className="flex-1 px-3 py-2 bg-[var(--input-bg)] border border-[var(--border-color)] rounded text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-blue)]"
                  />
                  <button
                    onClick={() => handleSaveApiKey(field.key, keyInputs[field.key] || '', field.label)}
                    disabled={saving === field.key || !keyInputs[field.key]}
                    className="px-4 py-2 bg-[var(--accent-blue)] hover:bg-[var(--accent-blue-hover)] text-white rounded disabled:opacity-50 w-full sm:w-auto"
                  >
                    {saving === field.key ? 'Saving...' : 'Save'}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* AI Provider Settings Section — 機能ごとのプロバイダー選択 */}
      <div className="bg-[var(--bg-secondary)] rounded-lg p-6">
        <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-4">AI Provider Settings</h2>
        <p className="text-[var(--text-muted)] text-sm mb-6">
          Select which AI provider to use for each feature. The corresponding API key must be configured above.
        </p>

        <div className="space-y-6">
          {PROVIDER_SELECTS.map((field) => (
            <div key={field.key}>
              <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">
                {field.label}
              </label>
              <p className="text-[var(--text-faint)] text-xs mb-2">{field.description}</p>
              <select
                value={data[field.key] || 'none'}
                onChange={(e) => handleProviderChange(field.key, e.target.value)}
                className="w-full sm:w-64 px-3 py-2 bg-[var(--input-bg)] border border-[var(--border-color)] rounded text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-blue)]"
              >
                {PROVIDER_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      </div>

      {/* Claude Model Settings Section — plan/exec 別のデフォルトモデル選択 */}
      <div className="bg-[var(--bg-secondary)] rounded-lg p-6">
        <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-4">Claude Model Settings</h2>
        <p className="text-[var(--text-muted)] text-sm mb-6">
          Plan / Exec モードで使用する Claude モデルのデフォルトを設定します。
          チャットの <code className="px-1 rounded bg-[var(--input-bg)]">l</code> コマンドでも変更でき、同じ設定を共有します（後から変更した方が優先）。
        </p>

        <div className="space-y-6">
          {CLAUDE_MODEL_FIELDS.map((field) => (
            <div key={field.key}>
              <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">
                {field.label}
              </label>
              <p className="text-[var(--text-faint)] text-xs mb-2">{field.description}</p>
              <select
                value={data[field.key] || ''}
                onChange={(e) => handleModelChange(field.key, e.target.value)}
                className="w-full sm:w-64 px-3 py-2 bg-[var(--input-bg)] border border-[var(--border-color)] rounded text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-blue)]"
              >
                {CLAUDE_MODEL_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      </div>

      {/* Agreement Template Section */}
      <div className="bg-[var(--bg-secondary)] rounded-lg p-6">
        <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-2">Agreement Template</h2>
        <p className="text-[var(--text-muted)] text-sm mb-2">
          Customize the DevRelay Agreement rules applied via the <code className="bg-[var(--bg-tertiary)] px-1 rounded">ag</code> command.
        </p>
        {agreementData?.isCustom ? (
          <p className="text-yellow-400 text-xs mb-4">
            Using custom template. Click "Reset to Default" to revert.
          </p>
        ) : (
          <p className="text-[var(--text-faint)] text-xs mb-4">
            Using default template. Edit below to customize.
          </p>
        )}

        <textarea
          value={agreementDraft}
          onChange={(e) => {
            setAgreementDraft(e.target.value);
            setAgreementDirty(true);
          }}
          rows={20}
          className="w-full px-3 py-2 bg-[var(--bg-base)] border border-[var(--border-color)] rounded text-[var(--text-secondary)] text-sm font-mono leading-relaxed focus:outline-none focus:ring-2 focus:ring-[var(--accent-blue)] resize-y"
          placeholder="Agreement template..."
        />

        <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 mt-4">
          <button
            onClick={handleSaveAgreement}
            disabled={agreementSaving || !agreementDirty}
            className="px-4 py-2 bg-[var(--accent-blue)] hover:bg-[var(--accent-blue-hover)] text-white rounded disabled:opacity-50 disabled:cursor-not-allowed w-full sm:w-auto"
          >
            {agreementSaving ? 'Saving...' : 'Save Template'}
          </button>
          {agreementData?.isCustom && (
            <button
              onClick={handleResetAgreement}
              disabled={agreementSaving}
              className="px-4 py-2 bg-[var(--bg-tertiary)] hover:bg-[var(--bg-hover)] text-[var(--text-primary)] rounded disabled:opacity-50 w-full sm:w-auto"
            >
              Reset to Default
            </button>
          )}
        </div>
      </div>

      {/* Allowed Tools Section — プランモード許可ツール（Linux / Windows 横並び） */}
      {atData && (
        <div className="bg-[var(--bg-secondary)] rounded-lg p-6">
          <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-2">Allowed Tools (Plan Mode)</h2>
          <p className="text-[var(--text-muted)] text-sm mb-4">
            Commands allowed in plan mode. One command per line (e.g. <code className="bg-[var(--bg-tertiary)] px-1 rounded">Bash(pm2 logs)</code>).
            Changes are pushed to online agents in real-time.
          </p>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Linux */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm font-medium text-[var(--text-secondary)]">Linux</label>
                {atData.linux.tools !== null ? (
                  <span className="text-yellow-400 text-xs">Custom</span>
                ) : (
                  <span className="text-[var(--text-faint)] text-xs">Default</span>
                )}
              </div>
              <textarea
                value={atLinuxDraft}
                onChange={(e) => {
                  setAtLinuxDraft(e.target.value);
                  setAtLinuxDirty(true);
                }}
                rows={16}
                className="w-full px-3 py-2 bg-[var(--bg-base)] border border-[var(--border-color)] rounded text-[var(--text-secondary)] text-sm font-mono leading-relaxed focus:outline-none focus:ring-2 focus:ring-[var(--accent-blue)] resize-y"
              />
              <div className="flex items-center gap-2 mt-2">
                <button
                  onClick={() => handleSaveAllowedTools('linux')}
                  disabled={atSaving === 'linux' || !atLinuxDirty}
                  className="px-3 py-1.5 text-sm bg-[var(--accent-blue)] hover:bg-[var(--accent-blue-hover)] text-white rounded disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {atSaving === 'linux' ? 'Saving...' : 'Save'}
                </button>
                {atData.linux.tools !== null && (
                  <button
                    onClick={() => handleResetAllowedTools('linux')}
                    disabled={atSaving === 'linux'}
                    className="px-3 py-1.5 text-sm bg-[var(--bg-tertiary)] hover:bg-[var(--bg-hover)] text-[var(--text-primary)] rounded disabled:opacity-50"
                  >
                    Reset
                  </button>
                )}
              </div>
            </div>

            {/* Windows */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm font-medium text-[var(--text-secondary)]">Windows</label>
                {atData.windows.tools !== null ? (
                  <span className="text-yellow-400 text-xs">Custom</span>
                ) : (
                  <span className="text-[var(--text-faint)] text-xs">Default</span>
                )}
              </div>
              <textarea
                value={atWindowsDraft}
                onChange={(e) => {
                  setAtWindowsDraft(e.target.value);
                  setAtWindowsDirty(true);
                }}
                rows={16}
                className="w-full px-3 py-2 bg-[var(--bg-base)] border border-[var(--border-color)] rounded text-[var(--text-secondary)] text-sm font-mono leading-relaxed focus:outline-none focus:ring-2 focus:ring-[var(--accent-blue)] resize-y"
              />
              <div className="flex items-center gap-2 mt-2">
                <button
                  onClick={() => handleSaveAllowedTools('windows')}
                  disabled={atSaving === 'windows' || !atWindowsDirty}
                  className="px-3 py-1.5 text-sm bg-[var(--accent-blue)] hover:bg-[var(--accent-blue-hover)] text-white rounded disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {atSaving === 'windows' ? 'Saving...' : 'Save'}
                </button>
                {atData.windows.tools !== null && (
                  <button
                    onClick={() => handleResetAllowedTools('windows')}
                    disabled={atSaving === 'windows'}
                    className="px-3 py-1.5 text-sm bg-[var(--bg-tertiary)] hover:bg-[var(--bg-hover)] text-[var(--text-primary)] rounded disabled:opacity-50"
                  >
                    Reset
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Bot Tokens Section */}
      <div className="bg-[var(--bg-secondary)] rounded-lg p-6">
        <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-4">Bot Tokens</h2>
        <p className="text-[var(--text-muted)] text-sm mb-6">
          Configure bot tokens for Discord and Telegram.
          <span className="text-yellow-400 ml-1">Server restart required after changes.</span>
        </p>

        <div className="space-y-6">
          {/* Discord Bot Token */}
          <div>
            <label className="block text-sm font-medium text-[var(--text-secondary)] mb-2">
              Discord Bot Token
            </label>
            <p className="text-[var(--text-faint)] text-xs mb-2">
              Get from{' '}
              <a
                href="https://discord.com/developers/applications"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--text-link)] hover:opacity-80"
              >
                Discord Developer Portal
              </a>
            </p>

            {data.discord_bot_token ? (
              <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
                <code className="flex-1 bg-[var(--bg-tertiary)] px-3 py-2 rounded text-[var(--text-secondary)] text-sm break-all">
                  {data.discord_bot_token}
                </code>
                <button
                  onClick={() => handleDeleteApiKey('discord_bot_token', 'Discord Bot Token')}
                  disabled={saving === 'discord_bot_token'}
                  className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded disabled:opacity-50 w-full sm:w-auto"
                >
                  {saving === 'discord_bot_token' ? 'Removing...' : 'Remove'}
                </button>
              </div>
            ) : (
              <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
                <input
                  type="password"
                  value={discordToken}
                  onChange={(e) => setDiscordToken(e.target.value)}
                  placeholder="Bot token..."
                  className="flex-1 px-3 py-2 bg-[var(--input-bg)] border border-[var(--border-color)] rounded text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-blue)]"
                />
                <button
                  onClick={() => handleSaveApiKey('discord_bot_token', discordToken, 'Discord Bot Token')}
                  disabled={saving === 'discord_bot_token' || !discordToken}
                  className="px-4 py-2 bg-[var(--accent-blue)] hover:bg-[var(--accent-blue-hover)] text-white rounded disabled:opacity-50 w-full sm:w-auto"
                >
                  {saving === 'discord_bot_token' ? 'Saving...' : 'Save'}
                </button>
              </div>
            )}
          </div>

          {/* Telegram Bot Token */}
          <div>
            <label className="block text-sm font-medium text-[var(--text-secondary)] mb-2">
              Telegram Bot Token
            </label>
            <p className="text-[var(--text-faint)] text-xs mb-2">
              Get from{' '}
              <a
                href="https://t.me/BotFather"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--text-link)] hover:opacity-80"
              >
                @BotFather
              </a>
              {' '}on Telegram
            </p>

            {data.telegram_bot_token ? (
              <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
                <code className="flex-1 bg-[var(--bg-tertiary)] px-3 py-2 rounded text-[var(--text-secondary)] text-sm break-all">
                  {data.telegram_bot_token}
                </code>
                <button
                  onClick={() => handleDeleteApiKey('telegram_bot_token', 'Telegram Bot Token')}
                  disabled={saving === 'telegram_bot_token'}
                  className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded disabled:opacity-50 w-full sm:w-auto"
                >
                  {saving === 'telegram_bot_token' ? 'Removing...' : 'Remove'}
                </button>
              </div>
            ) : (
              <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
                <input
                  type="password"
                  value={telegramToken}
                  onChange={(e) => setTelegramToken(e.target.value)}
                  placeholder="123456789:ABC..."
                  className="flex-1 px-3 py-2 bg-[var(--input-bg)] border border-[var(--border-color)] rounded text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-blue)]"
                />
                <button
                  onClick={() => handleSaveApiKey('telegram_bot_token', telegramToken, 'Telegram Bot Token')}
                  disabled={saving === 'telegram_bot_token' || !telegramToken}
                  className="px-4 py-2 bg-[var(--accent-blue)] hover:bg-[var(--accent-blue-hover)] text-white rounded disabled:opacity-50 w-full sm:w-auto"
                >
                  {saving === 'telegram_bot_token' ? 'Saving...' : 'Save'}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Connected Platforms Section */}
      <div className="bg-[var(--bg-secondary)] rounded-lg p-6">
        <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-4">Connected Platforms</h2>
        <p className="text-[var(--text-muted)] text-sm mb-6">
          Link your Discord or Telegram account to control your machines from those platforms.
        </p>

        {/* Link Code Input */}
        <div className="mb-6">
          <label className="block text-sm font-medium text-[var(--text-secondary)] mb-2">
            Enter Link Code
          </label>
          <p className="text-[var(--text-faint)] text-xs mb-2">
            Send <code className="bg-[var(--bg-tertiary)] px-1 rounded">link</code> to the DevRelay bot on Discord or Telegram to get a code.
          </p>
          <form onSubmit={handleLinkPlatform} className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
            <input
              type="text"
              value={linkCode}
              onChange={(e) => setLinkCode(e.target.value.toUpperCase())}
              placeholder="ABC123"
              maxLength={6}
              className="w-full sm:w-32 px-3 py-2 bg-[var(--input-bg)] border border-[var(--border-color)] rounded text-[var(--text-primary)] text-center text-lg font-mono tracking-widest placeholder-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-blue)]"
            />
            <button
              type="submit"
              disabled={linking || linkCode.length !== 6}
              className="px-4 py-2 bg-[var(--accent-blue)] hover:bg-[var(--accent-blue-hover)] text-white rounded disabled:opacity-50 disabled:cursor-not-allowed w-full sm:w-auto"
            >
              {linking ? 'Linking...' : 'Link'}
            </button>
          </form>
        </div>

        {/* Linked Platforms List */}
        {linkedPlatforms.length > 0 && (
          <div>
            <div className="text-sm font-medium text-[var(--text-secondary)] mb-3">Linked Accounts</div>
            <div className="space-y-2">
              {linkedPlatforms.map((platform) => (
                <div
                  key={platform.platform}
                  className="flex flex-col sm:flex-row sm:items-center sm:justify-between bg-[var(--bg-tertiary)] px-4 py-3 rounded gap-2"
                >
                  <div className="flex items-center space-x-3">
                    <span className="text-xl">{getPlatformIcon(platform.platform)}</span>
                    <div>
                      <div className="text-[var(--text-primary)] font-medium">
                        {getPlatformDisplayName(platform.platform)}
                        {platform.platformName && (
                          <span className="text-[var(--text-muted)] font-normal ml-2">
                            {platform.platformName}
                          </span>
                        )}
                      </div>
                      <div className="text-[var(--text-faint)] text-xs">
                        Linked {new Date(platform.linkedAt).toLocaleDateString()}
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={() => handleUnlinkPlatform(platform.platform)}
                    disabled={unlinking === platform.platform}
                    className="px-3 py-1 text-sm bg-red-600/20 hover:bg-red-600/40 text-[var(--text-danger)] rounded disabled:opacity-50 w-full sm:w-auto"
                  >
                    {unlinking === platform.platform ? 'Unlinking...' : 'Unlink'}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {linkedPlatforms.length === 0 && (
          <div className="text-[var(--text-faint)] text-sm border border-dashed border-[var(--border-color)] rounded p-4 text-center">
            No platforms linked yet. Send <code className="bg-[var(--bg-tertiary)] px-1 rounded">link</code> to the bot to get started.
          </div>
        )}
      </div>

      {/* Service Management Section */}
      <div className="bg-[var(--bg-secondary)] rounded-lg p-6">
        <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-4">Service Management</h2>
        <p className="text-[var(--text-muted)] text-sm mb-6">
          Restart DevRelay services. Use with caution.
        </p>

        <div className="space-y-4">
          {/* Server */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between bg-[var(--bg-tertiary)] px-4 py-3 rounded gap-2">
            <div className="flex items-center space-x-3">
              <span className="text-xl">🖥️</span>
              <div>
                <div className="text-[var(--text-primary)] font-medium">DevRelay Server</div>
                <div className="text-[var(--text-faint)] text-xs">
                  Status:{' '}
                  <span className={serviceStatus?.server === 'active' ? 'text-[var(--text-success)]' : 'text-[var(--text-danger)]'}>
                    {serviceStatus?.server || 'unknown'}
                  </span>
                </div>
              </div>
            </div>
            <button
              onClick={handleRestartServer}
              disabled={restartingServer}
              className="px-4 py-2 bg-orange-600 hover:bg-orange-700 text-white rounded disabled:opacity-50 disabled:cursor-not-allowed w-full sm:w-auto"
            >
              {restartingServer ? 'Restarting...' : 'Restart'}
            </button>
          </div>

          {/* Agent */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between bg-[var(--bg-tertiary)] px-4 py-3 rounded gap-2">
            <div className="flex items-center space-x-3">
              <span className="text-xl">🤖</span>
              <div>
                <div className="text-[var(--text-primary)] font-medium">DevRelay Agent (Local)</div>
                <div className="text-[var(--text-faint)] text-xs">
                  Status:{' '}
                  <span className={serviceStatus?.agent === 'active' ? 'text-[var(--text-success)]' : 'text-[var(--text-danger)]'}>
                    {serviceStatus?.agent || 'unknown'}
                  </span>
                </div>
              </div>
            </div>
            <button
              onClick={handleRestartAgent}
              disabled={restartingAgent}
              className="px-4 py-2 bg-orange-600 hover:bg-orange-700 text-white rounded disabled:opacity-50 disabled:cursor-not-allowed w-full sm:w-auto"
            >
              {restartingAgent ? 'Restarting...' : 'Restart'}
            </button>
          </div>

          {/* Restart Both */}
          <button
            onClick={handleRestartBoth}
            disabled={restartingServer || restartingAgent}
            className="w-full px-4 py-2 bg-orange-600 hover:bg-orange-700 text-white rounded disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {restartingServer || restartingAgent ? 'Restarting...' : 'Restart Both'}
          </button>
        </div>

        <p className="text-[var(--text-faint)] text-xs mt-4">
          Note: Restarting the server will temporarily disconnect all agents. They will automatically reconnect.
        </p>
      </div>

      {/* Chat Display Section */}
      <div className="bg-[var(--bg-secondary)] rounded-lg p-6">
        <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-4">Chat Display</h2>

        {/* ユーザー設定 */}
        <h3 className="text-sm font-semibold text-[var(--text-secondary)] mb-3">You</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
          {/* ユーザー表示名 */}
          <div>
            <label className="block text-sm text-[var(--text-muted)] mb-1">Display Name</label>
            <input
              type="text"
              value={chatDisplay.userName}
              onChange={e => saveChatDisplay({ ...chatDisplay, userName: e.target.value })}
              placeholder={fallbackName}
              className="w-full bg-[var(--input-bg)] text-[var(--text-primary)] rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent-blue)]"
            />
          </div>

          {/* ユーザーカラー */}
          <div>
            <label className="block text-sm text-[var(--text-muted)] mb-1">Name Color</label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={chatDisplay.userColor}
                onChange={e => saveChatDisplay({ ...chatDisplay, userColor: e.target.value })}
                className="w-10 h-10 rounded cursor-pointer border border-[var(--border-color)] bg-transparent"
              />
              <span className="text-sm font-semibold" style={{ color: chatDisplay.userColor }}>
                {chatDisplay.userName || fallbackName}
              </span>
            </div>
          </div>

          {/* ユーザーアバター */}
          <div className="sm:col-span-2">
            <label className="block text-sm text-[var(--text-muted)] mb-1">Avatar</label>
            <div className="flex items-center gap-3">
              {chatDisplay.userAvatar ? (
                <img src={chatDisplay.userAvatar} alt="avatar" className="w-10 h-10 rounded-full object-cover" />
              ) : (
                <div
                  className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-semibold text-white"
                  style={{ backgroundColor: chatDisplay.userColor }}
                >
                  {(chatDisplay.userName || fallbackName).charAt(0).toUpperCase()}
                </div>
              )}
              <input
                type="file"
                accept="image/*"
                className="hidden"
                id="user-avatar-input"
                onChange={e => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const reader = new FileReader();
                  reader.onload = () => {
                    saveChatDisplay({ ...chatDisplay, userAvatar: reader.result as string });
                  };
                  reader.readAsDataURL(file);
                  e.target.value = '';
                }}
              />
              <button
                onClick={() => document.getElementById('user-avatar-input')?.click()}
                className="px-3 py-1.5 text-sm bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] rounded hover:bg-[var(--bg-hover)] transition-colors"
              >
                Upload
              </button>
              {chatDisplay.userAvatar && (
                <button
                  onClick={() => saveChatDisplay({ ...chatDisplay, userAvatar: undefined })}
                  className="px-3 py-1.5 text-sm text-[var(--text-danger)] hover:opacity-80 border border-red-400/30 hover:border-red-400/50 rounded transition-colors"
                >
                  Remove
                </button>
              )}
            </div>
          </div>
        </div>

        {/* AI 設定 */}
        <h3 className="text-sm font-semibold text-[var(--text-secondary)] mb-3">AI</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
          {/* AI 表示名 */}
          <div>
            <label className="block text-sm text-[var(--text-muted)] mb-1">Display Name</label>
            <input
              type="text"
              value={chatDisplay.aiName}
              onChange={e => saveChatDisplay({ ...chatDisplay, aiName: e.target.value })}
              placeholder="DevRelay"
              className="w-full bg-[var(--input-bg)] text-[var(--text-primary)] rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent-blue)]"
            />
          </div>

          {/* AI カラー */}
          <div>
            <label className="block text-sm text-[var(--text-muted)] mb-1">Name Color</label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={chatDisplay.aiColor}
                onChange={e => saveChatDisplay({ ...chatDisplay, aiColor: e.target.value })}
                className="w-10 h-10 rounded cursor-pointer border border-[var(--border-color)] bg-transparent"
              />
              <span className="text-sm font-semibold" style={{ color: chatDisplay.aiColor }}>
                {chatDisplay.aiName || 'DevRelay'}
              </span>
            </div>
          </div>

          {/* AI アバター */}
          <div className="sm:col-span-2">
            <label className="block text-sm text-[var(--text-muted)] mb-1">Avatar</label>
            <div className="flex items-center gap-3">
              {chatDisplay.aiAvatar ? (
                <img src={chatDisplay.aiAvatar} alt="avatar" className="w-10 h-10 rounded-full object-cover" />
              ) : (
                <div
                  className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-semibold text-white"
                  style={{ backgroundColor: chatDisplay.aiColor }}
                >
                  {(chatDisplay.aiName || 'DevRelay').charAt(0).toUpperCase()}
                </div>
              )}
              <input
                type="file"
                accept="image/*"
                className="hidden"
                id="ai-avatar-input"
                onChange={e => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const reader = new FileReader();
                  reader.onload = () => {
                    saveChatDisplay({ ...chatDisplay, aiAvatar: reader.result as string });
                  };
                  reader.readAsDataURL(file);
                  e.target.value = '';
                }}
              />
              <button
                onClick={() => document.getElementById('ai-avatar-input')?.click()}
                className="px-3 py-1.5 text-sm bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] rounded hover:bg-[var(--bg-hover)] transition-colors"
              >
                Upload
              </button>
              {chatDisplay.aiAvatar && (
                <button
                  onClick={() => saveChatDisplay({ ...chatDisplay, aiAvatar: undefined })}
                  className="px-3 py-1.5 text-sm text-[var(--text-danger)] hover:opacity-80 border border-red-400/30 hover:border-red-400/50 rounded transition-colors"
                >
                  Remove
                </button>
              )}
            </div>
          </div>
        </div>

        {/* プレビュー */}
        <div className="mt-4 bg-[var(--bg-base)] rounded-lg p-3">
          <p className="text-xs text-[var(--text-faint)] mb-2">Preview</p>
          <div className="flex gap-3 py-1">
            {chatDisplay.userAvatar ? (
              <img src={chatDisplay.userAvatar} alt="avatar" className="w-8 h-8 rounded-full object-cover shrink-0" />
            ) : (
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold text-white shrink-0"
                style={{ backgroundColor: chatDisplay.userColor }}
              >
                {(chatDisplay.userName || fallbackName).charAt(0).toUpperCase()}
              </div>
            )}
            <div>
              <div className="flex items-baseline gap-2">
                <span className="font-semibold text-sm" style={{ color: chatDisplay.userColor }}>
                  {chatDisplay.userName || fallbackName}
                </span>
                <span className="text-xs text-[var(--text-faint)]">14:30</span>
              </div>
              <p className="text-sm text-[var(--text-secondary)]">Hello!</p>
            </div>
          </div>
          <div className="flex gap-3 py-1">
            {chatDisplay.aiAvatar ? (
              <img src={chatDisplay.aiAvatar} alt="avatar" className="w-8 h-8 rounded-full object-cover shrink-0" />
            ) : (
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold text-white shrink-0"
                style={{ backgroundColor: chatDisplay.aiColor }}
              >
                {(chatDisplay.aiName || 'DevRelay').charAt(0).toUpperCase()}
              </div>
            )}
            <div>
              <div className="flex items-baseline gap-2">
                <span className="font-semibold text-sm" style={{ color: chatDisplay.aiColor }}>
                  {chatDisplay.aiName || 'DevRelay'}
                </span>
                <span className="text-xs text-[var(--text-faint)]">14:31</span>
              </div>
              <p className="text-sm text-[var(--text-secondary)]">How can I help you?</p>
            </div>
          </div>
        </div>

        {/* 通知音 */}
        <h3 className="text-sm font-semibold text-[var(--text-secondary)] mt-6 mb-3">Notification</h3>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-[var(--text-primary)]">Completion Sound</p>
            <p className="text-xs text-[var(--text-muted)]">AI の応答完了時に通知音を鳴らす</p>
          </div>
          <button
            onClick={() => {
              const next = !soundEnabled;
              setSoundEnabled(next);
              setNotificationSoundEnabled(next);
              if (next) playNotificationSound();
            }}
            className={`relative w-11 h-6 rounded-full transition-colors ${soundEnabled ? 'bg-[var(--accent-blue)]' : 'bg-[var(--bg-tertiary)]'}`}
          >
            <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${soundEnabled ? 'translate-x-5' : ''}`} />
          </button>
        </div>

        {/* チャット右パネル（DocPanel）の表示設定 */}
        <h3 className="text-sm font-semibold text-[var(--text-secondary)] mt-6 mb-3">Chat Side Panel</h3>
        <p className="text-xs text-[var(--text-muted)] mb-3">
          ON にしたタブだけチャット画面右側のパネルに表示します。すべて OFF にするとパネル自体を非表示にします。
        </p>
        {([
          { key: 'approvals', label: 'Approvals', desc: 'ツール承認履歴' },
          { key: 'docs', label: 'Docs', desc: 'エージェントドキュメント' },
          { key: 'issues', label: 'Issues', desc: 'doc/issues.md' },
          { key: 'plan', label: 'Plan', desc: '最新プランファイル' },
        ] as { key: keyof DocPanelSettings; label: string; desc: string }[]).map((item) => (
          <div key={item.key} className="flex items-center justify-between py-1.5">
            <div>
              <p className="text-sm text-[var(--text-primary)]">{item.label}</p>
              <p className="text-xs text-[var(--text-muted)]">{item.desc}</p>
            </div>
            <button
              onClick={() => toggleDocPanel(item.key)}
              className={`relative w-11 h-6 rounded-full transition-colors ${docPanel[item.key] ? 'bg-[var(--accent-blue)]' : 'bg-[var(--bg-tertiary)]'}`}
            >
              <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${docPanel[item.key] ? 'translate-x-5' : ''}`} />
            </button>
          </div>
        ))}

        {/* リセットボタン */}
        <div className="mt-4 flex justify-end">
          <button
            onClick={resetChatDisplay}
            className="px-3 py-1.5 text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)] border border-[var(--border-color)] hover:border-[var(--text-faint)] rounded transition-colors"
          >
            Reset to defaults
          </button>
        </div>
      </div>
    </div>
  );
}
