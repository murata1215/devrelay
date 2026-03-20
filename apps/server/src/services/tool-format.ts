/**
 * ツール入力をテキスト形式にフォーマットする共通ユーティリティ
 * Discord/Telegram のツール承認メッセージで使用
 */

/**
 * ツール名と入力から、常時許可ルールのパターンを生成する
 * Plan Mode の allowedTools と同じ形式（Bash(cmd *) など）
 * @returns 生成されたルールパターン（例: "Bash(git *)", "Edit", "Read"）
 */
export function generateToolRule(toolName: string, toolInput: Record<string, unknown>): string {
  if (toolName === 'Bash' && typeof toolInput.command === 'string') {
    // コマンドの先頭語を抽出してプレフィックスマッチルールを生成
    const command = toolInput.command.trim();
    const firstWord = command.split(/\s+/)[0];
    if (firstWord) {
      return `Bash(${firstWord} *)`;
    }
  }
  // Bash 以外のツール（Edit, Read, Write, Glob, Grep 等）はツール名のみ
  return toolName;
}

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
