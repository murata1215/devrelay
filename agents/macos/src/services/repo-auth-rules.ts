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
 */
export function buildRepoAuthFailureMessage(kind: GitRemoteFailureKind): string {
  if (kind === 'auth') {
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
