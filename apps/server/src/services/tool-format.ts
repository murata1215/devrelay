/**
 * ツール入力をテキスト形式にフォーマットする共通ユーティリティ
 * Discord/Telegram のツール承認メッセージで使用
 */

/**
 * ツール名と入力に基づいて、人間が読みやすいテキスト表現を返す
 * @returns フォーマット済みテキスト。表示不要の場合は空文字列
 */
export function formatToolInputForText(toolName: string, toolInput: Record<string, unknown>): string {
  switch (toolName) {
    case 'Bash':
      return typeof toolInput.command === 'string' ? toolInput.command : '';
    case 'Read':
    case 'Write':
      return typeof toolInput.file_path === 'string' ? toolInput.file_path : '';
    case 'Edit':
      return typeof toolInput.file_path === 'string' ? toolInput.file_path : '';
    case 'Glob':
      return typeof toolInput.pattern === 'string' ? toolInput.pattern : '';
    case 'Grep':
      return [
        typeof toolInput.pattern === 'string' ? toolInput.pattern : '',
        typeof toolInput.path === 'string' ? `in ${toolInput.path}` : '',
      ].filter(Boolean).join(' ');
    default: {
      // その他のツールは JSON を120文字に切り詰め
      const json = JSON.stringify(toolInput);
      return json.length > 120 ? json.substring(0, 117) + '...' : json;
    }
  }
}
