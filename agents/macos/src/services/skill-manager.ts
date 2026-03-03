/**
 * Claude Code スキル管理
 *
 * Agent 起動時に ~/.claude/skills/devrelay-docs/ に
 * ドキュメント検索用スキルファイルを自動配置する。
 *
 * スキルの仕組み:
 * - SKILL.md: Claude Code にスキルの使い方を教える
 * - scripts/search.sh: サーバー API を叩いて検索結果を返すスクリプト
 * - config.yaml の serverUrl / token を使って認証
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type { AgentConfig } from './config.js';

/** スキルのベースディレクトリ */
const SKILLS_BASE = path.join(os.homedir(), '.claude', 'skills');

/** devrelay-docs スキルディレクトリ */
const SKILL_DIR = path.join(SKILLS_BASE, 'devrelay-docs');
const SCRIPTS_DIR = path.join(SKILL_DIR, 'scripts');

/**
 * WebSocket URL を HTTP URL に変換
 * ws:// → http://, wss:// → https://, /ws/agent パスを除去
 */
function wsToHttpUrl(wsUrl: string): string {
  return wsUrl
    .replace(/^wss:\/\//, 'https://')
    .replace(/^ws:\/\//, 'http://')
    .replace(/\/ws\/agent\/?$/, '');
}

/**
 * SKILL.md の内容を生成
 */
function generateSkillMd(): string {
  return `---
name: devrelay-docs
description: DevRelayに保存されたドキュメントを検索・参照します。「〜を参照して」「さっきのファイルを見て」「マニュアルを確認して」「前に作った〜」などドキュメント参照が必要な場合に使用します。
allowed-tools: Bash(bash ~/.claude/skills/devrelay-docs/scripts/search.sh *)
---

## DevRelay ドキュメント検索

DevRelayサーバーに保存された過去のセッションのファイル（ユーザーアップロード・AI生成）をセマンティック検索で見つけます。

### 検索

\`\`\`bash
bash ~/.claude/skills/devrelay-docs/scripts/search.sh "検索クエリ"
\`\`\`

検索クエリは自然言語で記述します。例:
- \`bash ~/.claude/skills/devrelay-docs/scripts/search.sh "pixdraft のマニュアル"\`
- \`bash ~/.claude/skills/devrelay-docs/scripts/search.sh "API 設計書"\`
- \`bash ~/.claude/skills/devrelay-docs/scripts/search.sh "データベーススキーマ"\`

### ファイル全文取得

検索結果のテキストが切り詰められている場合、ID を指定して全文を取得:

\`\`\`bash
bash ~/.claude/skills/devrelay-docs/scripts/search.sh --get <fileId>
\`\`\`

### 結果の利用

検索結果にはファイル名、類似度、テキスト内容が含まれます。
内容を参照してユーザーのリクエストに応答してください。
`;
}

/**
 * search.sh スクリプトの内容を生成
 * config.yaml から serverUrl と token を読み取り、サーバー API を呼び出す
 */
function generateSearchScript(serverUrl: string, token: string): string {
  const httpUrl = wsToHttpUrl(serverUrl);

  return `#!/bin/bash
# DevRelay ドキュメント検索スクリプト
# Agent が自動生成。手動編集は次回起動時に上書きされます。

set -euo pipefail

API_URL="${httpUrl}"
TOKEN="${token}"

# 引数チェック
if [ $# -eq 0 ]; then
  echo "使い方:"
  echo "  検索:     bash $0 \\"検索クエリ\\""
  echo "  全文取得: bash $0 --get <fileId>"
  exit 1
fi

# --get モード: ファイル全文取得
if [ "$1" = "--get" ]; then
  if [ -z "\${2:-}" ]; then
    echo "エラー: ファイル ID を指定してください"
    exit 1
  fi
  FILE_ID="$2"
  RESPONSE=$(curl -s -f -w "\\n%{http_code}" \\
    -H "Authorization: Bearer $TOKEN" \\
    "\${API_URL}/api/agent/documents/\${FILE_ID}" 2>&1) || {
    echo "エラー: API リクエストに失敗しました"
    echo "$RESPONSE"
    exit 1
  }

  # HTTP ステータスコードをチェック
  HTTP_CODE=$(echo "$RESPONSE" | tail -1)
  BODY=$(echo "$RESPONSE" | sed '$d')

  if [ "$HTTP_CODE" != "200" ]; then
    echo "エラー (HTTP $HTTP_CODE): $BODY"
    exit 1
  fi

  echo "$BODY"
  exit 0
fi

# 検索モード
QUERY="$*"
RESPONSE=$(curl -s -f -w "\\n%{http_code}" \\
  -X POST \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $TOKEN" \\
  -d "{\\"query\\": \\"$(echo "$QUERY" | sed 's/"/\\\\"/g')\\", \\"limit\\": 5}" \\
  "\${API_URL}/api/agent/documents/search" 2>&1) || {
  echo "エラー: API リクエストに失敗しました"
  echo "$RESPONSE"
  exit 1
}

# HTTP ステータスコードをチェック
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" != "200" ]; then
  echo "エラー (HTTP $HTTP_CODE): $BODY"
  exit 1
fi

# 結果をフォーマット出力（jq が使える場合）
if command -v jq &>/dev/null; then
  RESULT_COUNT=$(echo "$BODY" | jq '.results | length')
  if [ "$RESULT_COUNT" = "0" ]; then
    echo "検索結果: 0 件（クエリ: $QUERY）"
    exit 0
  fi

  echo "=== 検索結果: $RESULT_COUNT 件（クエリ: $QUERY）==="
  echo ""
  echo "$BODY" | jq -r '.results[] | "--- [\\(.similarity | . * 100 | floor)%] \\(.filename) (\\(.projectName), \\(.direction)) ---\\nID: \\(.id)\\n作成日: \\(.createdAt)\\n\\(.textContent // "(テキストなし)")\\n"'
else
  # jq がない場合はそのまま出力
  echo "$BODY"
fi
`;
}

/**
 * devrelay-docs スキルファイルを作成・更新する
 * Agent 接続成功時に呼び出される
 *
 * @param config - Agent 設定（serverUrl, token を使用）
 */
export async function ensureSkillFiles(config: AgentConfig): Promise<void> {
  try {
    // ディレクトリ作成
    await fs.mkdir(SCRIPTS_DIR, { recursive: true });

    // SKILL.md を書き込み
    const skillMdPath = path.join(SKILL_DIR, 'SKILL.md');
    await fs.writeFile(skillMdPath, generateSkillMd(), 'utf-8');

    // search.sh を書き込み
    const searchShPath = path.join(SCRIPTS_DIR, 'search.sh');
    await fs.writeFile(searchShPath, generateSearchScript(config.serverUrl, config.token), {
      encoding: 'utf-8',
      mode: 0o755,
    });

    console.log('🔧 Claude Code skill files updated: ~/.claude/skills/devrelay-docs/');
  } catch (error: any) {
    console.error('Failed to create skill files:', error.message);
  }
}
