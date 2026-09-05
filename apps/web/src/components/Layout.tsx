import { useState, useRef, useEffect, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useOrganization } from '../contexts/OrganizationContext';
import { useTheme } from '../contexts/ThemeContext';
import { org as orgApi } from '../lib/api';
import { isNotificationSoundEnabled, setNotificationSoundEnabled } from '../utils/notification-sound';
import { useLanguage } from '../contexts/LanguageContext';
import { openManagerInNewTab } from '../lib/managerRedirect';

interface LayoutProps {
  children: ReactNode;
}

export function Layout({ children }: LayoutProps) {
  const { user, logout } = useAuth();
  const { organization } = useOrganization();
  const { theme, toggleTheme } = useTheme();
  const { t } = useLanguage();
  const location = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(() => isNotificationSoundEnabled());
  // 歯車ドロップダウン（開発レポート/プロジェクト/設定）の開閉状態
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false);
  const settingsMenuRef = useRef<HTMLDivElement>(null);

  /** 通知音のオン/オフを切り替える */
  const toggleSound = () => {
    const next = !soundEnabled;
    setSoundEnabled(next);
    setNotificationSoundEnabled(next);
  };

  // admin/manager は配下メンバーの活動を閲覧できる（統制 v3 #270）
  const canSupervise = organization?.role === 'admin' || organization?.role === 'manager';

  // ヘッダーに常時表示する主要ナビ
  const navigation = [
    { name: t('nav.chat'), href: '/chat' },
    { name: t('nav.dashboard'), href: '/' },
    { name: t('nav.conversations'), href: '/conversations' },
    // Activity は監督者（admin/manager）のみ表示
    ...(canSupervise ? [{ name: t('nav.activity'), href: '/activity' }] : []),
    { name: t('nav.agents'), href: '/machines' },
    { name: t('nav.team'), href: '/team' },
  ];

  // 歯車メニュー（デスクトップ）／モバイルメニュー下段に出す二次ナビ
  const secondaryNavigation = [
    { name: t('nav.devReports'), href: '/dev-reports' },
    { name: t('nav.projects'), href: '/projects' },
    { name: t('nav.settings'), href: '/settings' },
  ];

  const isActive = (href: string) => {
    if (href === '/') return location.pathname === '/';
    return location.pathname.startsWith(href);
  };

  const isSecondaryActive = secondaryNavigation.some((item) => isActive(item.href));

  // メニュー外クリック・Escape キーでドロップダウンを閉じる
  useEffect(() => {
    if (!settingsMenuOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (settingsMenuRef.current && !settingsMenuRef.current.contains(event.target as Node)) {
        setSettingsMenuOpen(false);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSettingsMenuOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [settingsMenuOpen]);

  return (
    <div className="min-h-screen bg-[var(--bg-base)]">
      {/* Header */}
      <nav className="relative bg-[var(--bg-secondary)] border-b border-[var(--border-color)]">
        {/* #279: ロゴ + ナビ本体を flex フローで横並びにする（absolute オーバーレイだと狭いウィンドウ幅でロゴがナビ項目=DevRelay/Chat を覆い隠すため） */}
        <div className="flex items-center">
          {/* エンタープライズ組織ロゴ（左端ベタ付け・flex フロー内なのでナビと重ならない） */}
          {organization?.hasLogo && (
            <img
              src={orgApi.getLogoUrl()}
              alt={organization.name}
              title={organization.name}
              className="flex-shrink-0 ml-2 h-7 max-w-[84px] md:h-10 md:max-w-[196px] w-auto object-contain rounded"
            />
          )}
          <div className="flex-1 min-w-0 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            {/* Logo and desktop nav */}
            <div className="flex items-center">
              <Link to="/" className="text-xl font-bold text-[var(--text-primary)]">
                DevRelay
              </Link>
              {/* Desktop navigation */}
              <div className="hidden md:flex ml-10 items-baseline space-x-4">
                {navigation.map((item) => (
                  <Link
                    key={item.name}
                    to={item.href}
                    className={`px-3 py-2 rounded-md text-sm font-medium ${
                      isActive(item.href)
                        ? 'bg-[var(--bg-base)] text-[var(--text-primary)]'
                        : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
                    }`}
                  >
                    {item.name}
                  </Link>
                ))}
              </div>
            </div>

            {/* Desktop user info + theme toggle */}
            <div className="hidden md:flex items-center space-x-4">
              <button
                onClick={toggleTheme}
                className="p-1.5 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors"
                title={theme === 'dark' ? t('nav.lightMode') : t('nav.darkMode')}
              >
                {theme === 'dark' ? (
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2.25m6.364.386-1.591 1.591M21 12h-2.25m-.386 6.364-1.591-1.591M12 18.75V21m-4.773-4.227-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z" />
                  </svg>
                ) : (
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M21.752 15.002A9.72 9.72 0 0 1 18 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 0 0 3 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 0 0 9.002-5.998Z" />
                  </svg>
                )}
              </button>
              <button
                onClick={toggleSound}
                className="p-1.5 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors"
                title={soundEnabled ? t('nav.soundOff') : t('nav.soundOn')}
              >
                {soundEnabled ? (
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.114 5.636a9 9 0 0 1 0 12.728M16.463 8.288a5.25 5.25 0 0 1 0 7.424M6.75 8.25l4.72-4.72a.75.75 0 0 1 1.28.53v15.88a.75.75 0 0 1-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.009 9.009 0 0 1 2.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75Z" />
                  </svg>
                ) : (
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 9.75 19.5 12m0 0 2.25 2.25M19.5 12l2.25-2.25M19.5 12l-2.25 2.25m-10.5-6 4.72-4.72a.75.75 0 0 1 1.28.53v15.88a.75.75 0 0 1-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.009 9.009 0 0 1 2.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75Z" />
                  </svg>
                )}
              </button>
              {/* 歯車ドロップダウン: 開発レポート / プロジェクト / 設定 */}
              <div className="relative" ref={settingsMenuRef}>
                <button
                  onClick={() => setSettingsMenuOpen((open) => !open)}
                  className={`p-1.5 rounded-md transition-colors ${
                    isSecondaryActive
                      ? 'bg-[var(--bg-base)] text-[var(--text-primary)]'
                      : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'
                  }`}
                  title={t('nav.settingsMenu')}
                  aria-label={t('nav.settingsMenu')}
                  aria-haspopup="menu"
                  aria-expanded={settingsMenuOpen}
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 0 1 0 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 0 1 0-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281Z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                  </svg>
                </button>
                {settingsMenuOpen && (
                  <div
                    role="menu"
                    className="absolute right-0 mt-2 w-48 z-50 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-md shadow-lg py-1"
                  >
                    {secondaryNavigation.map((item) => (
                      <Link
                        key={item.name}
                        to={item.href}
                        role="menuitem"
                        onClick={() => setSettingsMenuOpen(false)}
                        className={`block px-4 py-2 text-sm ${
                          isActive(item.href)
                            ? 'bg-[var(--bg-base)] text-[var(--text-primary)]'
                            : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
                        }`}
                      >
                        {item.name}
                      </Link>
                    ))}
                  </div>
                )}
              </div>
              <button
                onClick={openManagerInNewTab}
                title={t('nav.openManagerTitle')}
                className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] text-sm"
              >
                {t('nav.openManager')}
              </button>
              <span className="text-[var(--text-secondary)] text-sm">{user?.name || user?.email}</span>
              <button
                onClick={logout}
                className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] text-sm"
              >
                {t('nav.logout')}
              </button>
            </div>

            {/* Mobile menu button */}
            <div className="md:hidden flex items-center gap-2">
              <button
                onClick={toggleTheme}
                className="p-1.5 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              >
                {theme === 'dark' ? (
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2.25m6.364.386-1.591 1.591M21 12h-2.25m-.386 6.364-1.591-1.591M12 18.75V21m-4.773-4.227-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z" />
                  </svg>
                ) : (
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M21.752 15.002A9.72 9.72 0 0 1 18 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 0 0 3 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 0 0 9.002-5.998Z" />
                  </svg>
                )}
              </button>
              <button
                onClick={toggleSound}
                className="p-1.5 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                title={soundEnabled ? t('nav.soundOff') : t('nav.soundOn')}
              >
                {soundEnabled ? (
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.114 5.636a9 9 0 0 1 0 12.728M16.463 8.288a5.25 5.25 0 0 1 0 7.424M6.75 8.25l4.72-4.72a.75.75 0 0 1 1.28.53v15.88a.75.75 0 0 1-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.009 9.009 0 0 1 2.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75Z" />
                  </svg>
                ) : (
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 9.75 19.5 12m0 0 2.25 2.25M19.5 12l2.25-2.25M19.5 12l-2.25 2.25m-10.5-6 4.72-4.72a.75.75 0 0 1 1.28.53v15.88a.75.75 0 0 1-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.009 9.009 0 0 1 2.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75Z" />
                  </svg>
                )}
              </button>
              <button
                onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
                className="inline-flex items-center justify-center p-2 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] focus:outline-none focus:ring-2 focus:ring-inset focus:ring-white"
                aria-expanded={mobileMenuOpen}
              >
                <span className="sr-only">{t('nav.openMenu')}</span>
                {mobileMenuOpen ? (
                  <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                ) : (
                  <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
                  </svg>
                )}
              </button>
            </div>
          </div>
          </div>
        </div>

        {/* Mobile menu */}
        {mobileMenuOpen && (
          <div className="md:hidden">
            <div className="px-2 pt-2 pb-3 space-y-1">
              {navigation.map((item) => (
                <Link
                  key={item.name}
                  to={item.href}
                  onClick={() => setMobileMenuOpen(false)}
                  className={`block px-3 py-2 rounded-md text-base font-medium ${
                    isActive(item.href)
                      ? 'bg-[var(--bg-base)] text-[var(--text-primary)]'
                      : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  {item.name}
                </Link>
              ))}
            </div>
            <div className="px-2 pt-2 pb-3 space-y-1 border-t border-[var(--border-color)]">
              {secondaryNavigation.map((item) => (
                <Link
                  key={item.name}
                  to={item.href}
                  onClick={() => setMobileMenuOpen(false)}
                  className={`block px-3 py-2 rounded-md text-base font-medium ${
                    isActive(item.href)
                      ? 'bg-[var(--bg-base)] text-[var(--text-primary)]'
                      : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  {item.name}
                </Link>
              ))}
            </div>
            <div className="pt-4 pb-3 border-t border-[var(--border-color)]">
              <div className="px-4 flex items-center justify-between">
                <span className="text-[var(--text-secondary)] text-sm">{user?.name || user?.email}</span>
                <button
                  onClick={() => {
                    setMobileMenuOpen(false);
                    openManagerInNewTab();
                  }}
                  title={t('nav.openManagerTitle')}
                  className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] text-sm"
                >
                  {t('nav.openManager')}
                </button>
                <button
                  onClick={() => {
                    setMobileMenuOpen(false);
                    logout();
                  }}
                  className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] text-sm"
                >
                  {t('nav.logout')}
                </button>
              </div>
            </div>
          </div>
        )}
      </nav>

      {/* Main content: ChatPage は常時マウント（display:none で制御）されるため、
           /chat 時はフル幅、それ以外は max-w-7xl で表示 */}
      <main className={location.pathname === '/chat' ? '' : 'max-w-7xl mx-auto py-6 px-4 sm:px-6 lg:px-8'}>
        {children}
      </main>
      {location.pathname !== '/chat' && (
        <footer className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="text-center text-[var(--text-faint)] text-xs">
            DevRelay v{__APP_VERSION__}
          </div>
        </footer>
      )}
    </div>
  );
}
