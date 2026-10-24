/**
 * 会社 private リポジトリ clone 対応サイクル: Agent 自身のリポジトリ（`~/.devrelay/agent`）を
 * 会社 private repo から取得・自己更新するための純粋関数群（外部 import ゼロ。
 * `update-busy-rules.ts` 等と同じ流儀で `agents/linux`/`agents/macos` にそれぞれ複製する）。
 *
 * 背景: 本流は個人 GitHub（`murata1215/devrelay`、public）のまま、社内展開用に会社 private
 * リポジトリへのコピーを置き、Agent のインストール/自己更新（`u`）だけを repo URL 可変にする。
 * 認証は Fine-grained PAT（対象リポジトリのみ・Contents: Read のみ）。
 *
 * PAT の保存方式は repo ローカル・URL スコープの `http.<repoUrl>.extraHeader`
 * （`git config --local` で `.git/config` に書く）を採用した。credential helper を一度も経由しない
 * ため、GCM/keyring 等の対話プロンプトが起動する余地がなく、開発者本人の github.com 資格情報
 * （Git Credential Manager 等）にも一切干渉しない。
 *
 * 読取PATのサーバー配布サイクル: 前サイクルはインストーラーが人間から PAT を受け取って
 * `.git/config` に書く一方通行だったが、本サイクルで Agent 自身が `server:repo:auth`
 * （WS、要求ドリブン）経由でサーバーから最新 PAT を取得し、同じ `.git/config` を書き換える
 * 経路を追加した（`handleVersionCheck()`/`handleAgentUpdate()` から呼ぶ。`connection.ts` 側）。
 * **origin が公開既定 URL（`DEFAULT_AGENT_REPO_URL`）の機体は一切サーバーに問い合わせない**
 * （`shouldRequestServerRepoAuth()` が false を返す＝既存の個人 devrelay.io 運用に影響ゼロ）。
 */

/** インストーラー/Agent が未指定時に使う既定の clone 先（本流・public） */
export const DEFAULT_AGENT_REPO_URL = 'https://github.com/murata1215/devrelay.git';

/**
 * `git config --local http.<key>.extraHeader` に使う key を作る。
 *
 * **重要**: `git config --get-urlmatch` は URL の **完全一致**（末尾の `.git` の有無も区別する）
 * でしかマッチしない（実測済み: `tisa-devin/devrelay` ← `.git` なし ← では
 * `tisa-devin/devrelay.git` に一致しない）。そのため本関数は repoUrl を `trim()` するだけで、
 * 末尾の `.git` を補ったり削ったりしない。**remote に設定するのと同一の文字列**を渡すことが
 * 呼び出し側の責務（インストーラー側でも同じ `$REPO_URL`/`$RepoUrl` 変数を使う）。
 */
export function buildExtraHeaderConfigKey(repoUrl: string): string {
  return `http.${repoUrl.trim()}.extraHeader`;
}

/**
 * Basic 認証の Authorization ヘッダ値を作る（GitHub の PAT は Basic 認証のパスワード欄にそのまま
 * 使える。ユーザー名は何でもよいが GitHub 公式ドキュメントの慣例に合わせ `x-access-token` を使う）。
 *
 * @param base64Encode `Buffer` に依存しない呼び出し側の base64 実装（Node では `Buffer.from(s).toString('base64')`
 *   を渡す。`packages/shared` 等と違い Agent は Node 専用なので Buffer 利用は問題ないが、本関数は
 *   テスト容易性のため encode を注入可能にしてある）
 */
export function buildBasicAuthHeaderValue(pat: string, base64Encode: (s: string) => string): string {
  return `Authorization: Basic ${base64Encode(`x-access-token:${pat}`)}`;
}

/**
 * `u`（自己更新）や clone 時に git へ渡す非対話化 env（`capabilities/git-cli.ts` と同趣旨）。
 * `GIT_ASKPASS` は非 win32 のみ別途呼び出し側で追加する（`/bin/true` が無い Windows では未設定のままにする）。
 */
export const GIT_NONINTERACTIVE_ENV: Readonly<Record<string, string>> = {
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
};

export type GitRemoteFailureKind = 'auth' | 'network' | 'other';

/**
 * `git fetch`/`git pull`/`git ls-remote` 等の失敗時の stderr から、認証失敗かどうかを分類する。
 * PAT 期限切れ・スコープ不足・repo 名違いはどれも概ねこのいずれかのメッセージで現れる。
 */
export function classifyGitRemoteFailure(stderr: string): GitRemoteFailureKind {
  const s = stderr.toLowerCase();
  const authPatterns = [
    'authentication failed',
    'could not read username',
    'could not read password',
    'terminal prompts disabled',
    'repository not found',
    'access denied',
    '403',
    'bad credentials',
  ];
  if (authPatterns.some((p) => s.includes(p))) return 'auth';
  const networkPatterns = [
    'could not resolve host',
    'connection timed out',
    'network is unreachable',
    'ssl certificate problem',
    'could not connect',
  ];
  if (networkPatterns.some((p) => s.includes(p))) return 'network';
  return 'other';
}

/**
 * チャット（`agent:update:status.error`）・update.log に出す案内文を作る。
 * 生の git stderr はそのまま出さず（PAT が万一混入していても漏らさないため、必ずこちらを使う）、
 * 本関数が返す固定文のみを使う。
 *
 * @param opts.serverDistributed 読取PATのサーバー配布サイクル: この機体が `server:repo:auth` で
 *   PAT を受け取った実績がある場合は true を渡す。案内文を「管理者に `.env` の更新を依頼」に
 *   切り替える（手入力運用の機体には従来どおり `--repo-auth-only` を案内する）。省略時は従来どおり
 *   手入力案内（既存呼び出し元・既存テストへの後方互換のため第2引数は任意）。
 */
export function buildRepoAuthFailureMessage(
  kind: GitRemoteFailureKind,
  opts?: { serverDistributed?: boolean }
): string {
  if (kind === 'auth') {
    if (opts?.serverDistributed) {
      return (
        'リポジトリの認証に失敗しました（PAT の期限切れ・権限不足の可能性）。' +
        '更新を中止し、既存の Agent を維持しました。' +
        '管理者にサーバー側の `.env` の `DEVRELAY_AGENT_REPO_TOKEN` 更新を依頼してください。'
      );
    }
    return (
      'リポジトリの認証に失敗しました（PAT の期限切れ・権限不足の可能性）。' +
      '更新を中止し、既存の Agent を維持しました。' +
      'PAT を更新した場合は `--repo-auth-only` 付きでインストーラーを再実行してください。'
    );
  }
  if (kind === 'network') {
    return 'リポジトリへのネットワーク接続に失敗しました。更新を中止し、既存の Agent を維持しました。';
  }
  return 'リポジトリの取得に失敗しました。更新を中止し、既存の Agent を維持しました。';
}

/**
 * update.log / チャットに出す前に、万一紛れ込んだ秘密情報を伏せ字にする最後の防御線。
 * 通常の運用では PAT は URL にも stderr にも出ない設計だが、想定外の git メッセージ
 * （例: 一部の認証エラーで URL をそのまま echo する実装）に備えた保険。
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/Authorization:\s*Basic\s+\S+/gi, 'Authorization: Basic ***')
    .replace(/https?:\/\/[^/\s@]+@/gi, (m) => `${m.slice(0, m.indexOf('://') + 3)}***@`);
}

// =============================================================================
// 読取PATのサーバー配布サイクル: `.git/config` の `http.<repoUrl>.extraHeader` を
// 読み書きする純関数（`git config` を spawn しない＝PAT が argv に出る経路がそもそも無い）。
// 書式は `scripts/install-agent.sh` の `write_repo_auth()` / `install-agent.ps1` の
// `Write-RepoAuth` と同じ `[http "<repoUrl>"]` セクション + タブ区切りの `extraHeader = ...`。
// =============================================================================

/**
 * `.git/config` の生テキストから、指定 repoUrl の `[http "<repoUrl>"]` セクション内
 * `extraHeader = ...` の値（`Authorization: Basic ...` を含む文字列）を読み取る。
 *
 * セクションの判定は `buildExtraHeaderConfigKey()` と同じ**行完全一致**
 * （`git config --get-urlmatch` の URL 完全一致制約に合わせるため、末尾 `.git` の有無等も
 * そのまま区別する。呼び出し側は origin に設定されている文字列をそのまま渡すこと）。
 * 見つからない場合は `null`（セクション自体が無い／`extraHeader` 行が無い のいずれも同じ扱い）。
 */
export function readExtraHeaderFromGitConfig(configText: string, repoUrl: string): string | null {
  const sectionLine = `[http "${repoUrl.trim()}"]`;
  const lines = configText.split('\n');
  let inSection = false;
  for (const line of lines) {
    if (!inSection) {
      if (line.trim() === sectionLine) inSection = true;
      continue;
    }
    if (/^\s*\[/.test(line)) break; // 次のセクションに入った
    const m = line.match(/^\s*extraHeader\s*=\s*(.+)$/);
    if (m) return m[1].trim();
  }
  return null;
}

/**
 * `.git/config` の生テキストに対し、指定 repoUrl の `[http "<repoUrl>"]` セクションを
 * 冪等に書き換える（既存セクションは行完全一致で除去してから書き直す。
 * `write_repo_auth()`/`Write-RepoAuth` と同じアルゴリズム）。
 *
 * `headerValue` が `null`/空文字なら削除のみ（新セクションは追加しない）。
 * 戻り値は書き換え後の全文（呼び出し側が `writeFileAtomic()` で書き込む）。
 */
export function upsertExtraHeaderInGitConfig(configText: string, repoUrl: string, headerValue: string | null): string {
  const trimmedUrl = repoUrl.trim();
  const sectionLine = `[http "${trimmedUrl}"]`;
  const lines = configText.split('\n');
  const output: string[] = [];
  let skip = false;
  for (const line of lines) {
    if (!skip && line.trim() === sectionLine) {
      skip = true;
      continue;
    }
    if (skip && /^\s*\[/.test(line)) {
      skip = false;
    }
    if (skip) continue;
    output.push(line);
  }
  let result = output.join('\n');
  if (headerValue) {
    if (result.length > 0 && !result.endsWith('\n')) result += '\n';
    result += `${sectionLine}\n\textraHeader = ${headerValue}\n`;
  }
  return result;
}

/**
 * Agent の `config.serverUrl` が HTTPS/WSS 相当（`wss://`、または localhost/127.0.0.1/[::1] 宛の
 * `ws://`）かどうかを判定する。要件5「HTTPS/WSS 以外では送らない」の実体。
 * 平文 `ws://` の社内サーバーに PAT を送って漏えいする経路を構造的に閉じる
 * （localhost/ループバックのみ `ws://` を許可するのは、開発環境でのローカル検証を妨げないため）。
 */
export function isSecureServerUrl(serverUrl: string): boolean {
  if (/^wss:\/\//i.test(serverUrl)) return true;
  const m = serverUrl.match(/^ws:\/\/([^/:]+)/i);
  if (!m) return false;
  const host = m[1].toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

/**
 * サーバーに `agent:repo:auth:request` を送るべきかを判定する（後方互換の要）。
 *
 * - origin が公開既定 URL（`DEFAULT_AGENT_REPO_URL`）→ false（PAT が不要な機体。
 *   個人 devrelay.io を含む既存の全環境がここに該当し、新しい WS トラフィックは一切発生しない）
 * - `serverUrl` が HTTPS/WSS 相当でない → false（要件5）
 * - それ以外（private repo を使っていて HTTPS/WSS 経由）→ true
 */
export function shouldRequestServerRepoAuth(input: { originUrl: string; serverUrl: string }): boolean {
  if (input.originUrl.trim() === DEFAULT_AGENT_REPO_URL) return false;
  if (!isSecureServerUrl(input.serverUrl)) return false;
  return true;
}
