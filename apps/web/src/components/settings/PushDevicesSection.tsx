import { useEffect, useState } from 'react';
import { pushDevices } from '../../lib/api';
import {
  deriveHealthBadge,
  derivePushDeviceStatus,
  formatRelativeTime,
  sortDevices,
  type PushDevicesResponse,
  type PushTestResponse,
} from '../../lib/push-device-rules';

/**
 * 設定 > Notification 節: FCM プッシュ通知の登録済み端末一覧 + テスト送信ボタン。
 *
 * 2026-10-22 の事故（iPhone アプリの再インストールで通知許可がリセットされ、サーバーには
 * 配信先の無い古いトークンだけが残り、エラーも出ないまま通知が届かなくなった）の再発防止策。
 * サーバー側（`fcm-service.ts`）は何件送って何件失敗したかをログに残すようになったが、
 * それだけでは「気づく」導線にならないため、ユーザーが自分で確認できる画面をここに置く。
 */
export function PushDevicesSection() {
  const [data, setData] = useState<PushDevicesResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<PushTestResponse | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [removingPrefix, setRemovingPrefix] = useState<string | null>(null);

  const load = () => {
    pushDevices
      .list()
      .then((res) => {
        setData(res);
        setLoadError(null);
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : '読み込みに失敗しました'));
  };

  useEffect(() => {
    load();
  }, []);

  const handleTest = async () => {
    setTesting(true);
    setTestError(null);
    setTestResult(null);
    try {
      const res = await pushDevices.test();
      setTestResult(res);
      load(); // lastSuccessAt / lastErrorCode が更新されるので一覧を再取得
    } catch (e) {
      setTestError(e instanceof Error ? e.message : 'テスト送信に失敗しました');
    } finally {
      setTesting(false);
    }
  };

  const handleRemove = async (tokenPrefix: string) => {
    setRemovingPrefix(tokenPrefix);
    try {
      await pushDevices.remove(tokenPrefix);
      load();
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : '削除に失敗しました');
    } finally {
      setRemovingPrefix(null);
    }
  };

  if (loadError) {
    return <p className="text-xs text-[var(--text-danger)] mt-3">{loadError}</p>;
  }
  if (!data) {
    return <p className="text-xs text-[var(--text-muted)] mt-3">読み込み中...</p>;
  }

  if (!data.enabled) {
    return (
      <div className="mt-3 p-3 rounded bg-[var(--bg-tertiary)] text-xs text-[var(--text-muted)]">
        サーバーで FCM が未設定です（<code>FIREBASE_SERVICE_ACCOUNT_PATH</code> 未設定）。
        モバイルアプリへのプッシュ通知は送信されません。
      </div>
    );
  }

  const nowIso = new Date().toISOString();
  const badge = deriveHealthBadge(data.health.status);
  const devices = sortDevices(data.devices);
  const badgeColor =
    badge.tone === 'error' ? 'text-[var(--text-danger)]' : badge.tone === 'warn' ? 'text-amber-500' : 'text-[var(--text-success)]';

  return (
    <div className="mt-3 space-y-3">
      <div className={`text-xs font-medium ${badgeColor}`}>
        {badge.tone === 'ok' ? '✅' : badge.tone === 'warn' ? '⚠️' : '🔴'} {badge.label}
      </div>

      {data.metrics.dropNoToken > 0 && (
        <p className="text-xs text-amber-500">
          配信先なしで破棄された通知: {data.metrics.dropNoToken} 件（サーバー起動（
          {formatRelativeTime(data.metrics.since, nowIso) ?? data.metrics.since}
          ）以降）
        </p>
      )}

      {devices.length > 0 && (
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead>
              <tr className="text-[var(--text-muted)]">
                <th className="px-2 py-1 text-left">端末</th>
                <th className="px-2 py-1 text-left">登録</th>
                <th className="px-2 py-1 text-left">最終成功</th>
                <th className="px-2 py-1 text-left">直近エラー</th>
                <th className="px-2 py-1" />
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-color)]">
              {devices.map((d) => {
                const tone = derivePushDeviceStatus(d);
                const toneColor = tone === 'error' ? 'text-[var(--text-danger)]' : tone === 'warn' ? 'text-amber-500' : 'text-[var(--text-success)]';
                return (
                  <tr key={d.tokenPrefix}>
                    <td className="px-2 py-1.5 text-[var(--text-primary)]">
                      {d.deviceLabel ?? `${d.platform} ${d.tokenPrefix}`}
                    </td>
                    <td className="px-2 py-1.5 text-[var(--text-muted)]">
                      {formatRelativeTime(d.lastRegisteredAt, nowIso) ?? '-'}
                    </td>
                    <td className={`px-2 py-1.5 ${toneColor}`}>
                      {formatRelativeTime(d.lastSuccessAt, nowIso) ?? '一度も成功していません'}
                    </td>
                    <td className="px-2 py-1.5 text-[var(--text-muted)]">
                      {d.lastErrorCode ? `${d.lastErrorCode}${d.consecutiveFailures > 1 ? ` (×${d.consecutiveFailures})` : ''}` : '-'}
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <button
                        onClick={() => handleRemove(d.tokenPrefix)}
                        disabled={removingPrefix === d.tokenPrefix}
                        className="text-[var(--text-danger)] disabled:opacity-50"
                      >
                        削除
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div>
        <button
          onClick={handleTest}
          disabled={testing || devices.length === 0}
          className="px-3 py-1.5 bg-[var(--accent-blue)] text-white rounded text-xs font-medium disabled:opacity-50"
        >
          {testing ? '送信中...' : 'テスト通知を送る'}
        </button>
        {testError && <p className="mt-2 text-xs text-[var(--text-danger)]">{testError}</p>}
        {testResult && (
          <div className="mt-2 text-xs space-y-0.5">
            {testResult.hint && <p className="text-[var(--text-muted)]">{testResult.hint}</p>}
            {testResult.results.map((r) => (
              <p key={r.tokenPrefix} className={r.ok ? 'text-[var(--text-success)]' : 'text-[var(--text-danger)]'}>
                {r.ok ? '✅' : '❌'} {r.tokenPrefix} {r.errorCode ? `(${r.errorCode})` : ''}
              </p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
