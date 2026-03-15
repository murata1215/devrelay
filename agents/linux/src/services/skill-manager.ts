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

/** devrelay-ask-member スキルディレクトリ */
const ASK_SKILL_DIR = path.join(SKILLS_BASE, 'devrelay-ask-member');
const ASK_SCRIPTS_DIR = path.join(ASK_SKILL_DIR, 'scripts');

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
 * ask-member SKILL.md の内容を生成
 */
function generateAskMemberSkillMd(): string {
  return `---
name: devrelay-ask-member
description: 他プロジェクトのエージェントに質問します。「pixblogに聞いて」「サーバー側のAPI仕様を確認して」「他プロジェクトの実装を教えて」など、別プロジェクトの情報が必要な場合に使用します。
allowed-tools: Bash(bash ~/.claude/skills/devrelay-ask-member/scripts/ask.sh *)
---

## DevRelay クロスプロジェクトクエリ

他プロジェクトのエージェントに質問を送信し、そのプロジェクトのコードを分析した回答を得ます。
質問先のプロジェクトで新しい Claude セッションが起動され、コードベースを参照して回答します。

### メンバー一覧を確認

まず質問可能なメンバー（プロジェクト）を確認します:

\\\`\\\`\\\`bash
bash ~/.claude/skills/devrelay-ask-member/scripts/ask.sh --list
\\\`\\\`\\\`

### 質問を送信

\\\`\\\`\\\`bash
bash ~/.claude/skills/devrelay-ask-member/scripts/ask.sh --project <プロジェクト名> --question "質問内容"
\\\`\\\`\\\`

例:
- \\\`bash ~/.claude/skills/devrelay-ask-member/scripts/ask.sh --project pixblog --question "POST /api/v1/categories の仕様を教えて"\\\`
- \\\`bash ~/.claude/skills/devrelay-ask-member/scripts/ask.sh --project pixdraft --question "AI生成APIのレスポンスにcategoryフィールドはある？"\\\`

### 注意事項
- 質問先のエージェントがオンラインである必要があります
- 回答には数分かかる場合があります（Claude Code がコードを分析するため）
- 回答はターゲットプロジェクトのコードベースに基づいて生成されます
`;
}

/**
 * ask.sh スクリプトの内容を生成
 */
function generateAskScript(serverUrl: string, token: string): string {
  const httpUrl = wsToHttpUrl(serverUrl);

  return `#!/bin/bash
# DevRelay クロスプロジェクトクエリスクリプト
# Agent が自動生成。手動編集は次回起動時に上書きされます。

set -euo pipefail

API_URL="${httpUrl}"
TOKEN="${token}"

# 引数チェック
if [ $# -eq 0 ]; then
  echo "使い方:"
  echo "  メンバー一覧: bash $0 --list"
  echo "  質問送信:     bash $0 --project <プロジェクト名> --question \\"質問内容\\""
  exit 1
fi

# --list モード: メンバー一覧取得
if [ "$1" = "--list" ]; then
  RESPONSE=$(curl -s -f -w "\\n%{http_code}" \\
    -H "Authorization: Bearer $TOKEN" \\
    "\${API_URL}/api/agent/members" 2>&1) || {
    echo "エラー: API リクエストに失敗しました"
    echo "$RESPONSE"
    exit 1
  }

  HTTP_CODE=$(echo "$RESPONSE" | tail -1)
  BODY=$(echo "$RESPONSE" | sed '$d')

  if [ "$HTTP_CODE" != "200" ]; then
    echo "エラー (HTTP $HTTP_CODE): $BODY"
    exit 1
  fi

  if command -v jq &>/dev/null; then
    MEMBER_COUNT=$(echo "$BODY" | jq 'length')
    if [ "$MEMBER_COUNT" = "0" ]; then
      echo "登録済みメンバーはありません。WebUI でメンバーを追加してください。"
      exit 0
    fi
    echo "=== 登録済みメンバー ($MEMBER_COUNT 件) ==="
    echo ""
    echo "$BODY" | jq -r '.[] | "チーム: \\(.teamName) → メンバー: \\(.memberProjectName) (\\(.memberMachineName)) [\\(.memberMachineStatus)]"'
  else
    echo "$BODY"
  fi
  exit 0
fi

# 引数パース
PROJECT=""
QUESTION=""
while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --question) QUESTION="$2"; shift 2 ;;
    *) echo "不明な引数: $1"; exit 1 ;;
  esac
done

if [ -z "$PROJECT" ] || [ -z "$QUESTION" ]; then
  echo "エラー: --project と --question の両方が必要です"
  exit 1
fi

# まずメンバー一覧からプロジェクト ID を取得
MEMBERS_RESPONSE=$(curl -s -f -w "\\n%{http_code}" \\
  -H "Authorization: Bearer $TOKEN" \\
  "\${API_URL}/api/agent/members" 2>&1) || {
  echo "エラー: メンバー一覧の取得に失敗しました"
  exit 1
}

MEMBERS_HTTP=$(echo "$MEMBERS_RESPONSE" | tail -1)
MEMBERS_BODY=$(echo "$MEMBERS_RESPONSE" | sed '$d')

if [ "$MEMBERS_HTTP" != "200" ]; then
  echo "エラー (HTTP $MEMBERS_HTTP): $MEMBERS_BODY"
  exit 1
fi

# プロジェクト名でメンバーを検索（部分一致）
if command -v jq &>/dev/null; then
  TARGET_ID=$(echo "$MEMBERS_BODY" | jq -r --arg name "$PROJECT" '[.[] | select(.memberProjectName | ascii_downcase | contains($name | ascii_downcase))] | first | .memberProjectId // empty')
  TARGET_NAME=$(echo "$MEMBERS_BODY" | jq -r --arg name "$PROJECT" '[.[] | select(.memberProjectName | ascii_downcase | contains($name | ascii_downcase))] | first | .memberProjectName // empty')

  if [ -z "$TARGET_ID" ]; then
    echo "エラー: '$PROJECT' に一致するメンバーが見つかりません"
    echo ""
    echo "登録済みメンバー:"
    echo "$MEMBERS_BODY" | jq -r '.[] | "  - \\(.memberProjectName) (\\(.memberMachineName))"'
    exit 1
  fi

  echo "📨 $TARGET_NAME に質問を送信中..."
  echo "質問: $QUESTION"
  echo ""

  # 質問送信（タイムアウト 5 分）
  RESPONSE=$(curl -s -f -w "\\n%{http_code}" --max-time 300 \\
    -X POST \\
    -H "Content-Type: application/json" \\
    -H "Authorization: Bearer $TOKEN" \\
    -d "{\\"targetProjectId\\": \\"$TARGET_ID\\", \\"question\\": \\"$(echo "$QUESTION" | sed 's/"/\\\\\\\\"/g')\\"}" \\
    "\${API_URL}/api/agent/ask-member" 2>&1) || {
    echo "エラー: クエリに失敗しました（タイムアウトまたは接続エラー）"
    echo "$RESPONSE"
    exit 1
  }

  HTTP_CODE=$(echo "$RESPONSE" | tail -1)
  BODY=$(echo "$RESPONSE" | sed '$d')

  if [ "$HTTP_CODE" != "200" ]; then
    echo "エラー (HTTP $HTTP_CODE): $BODY"
    exit 1
  fi

  echo "=== $TARGET_NAME からの回答 ==="
  echo ""
  echo "$BODY" | jq -r '.answer'
else
  echo "エラー: jq が必要です"
  exit 1
fi
`;
}

/**
 * devrelay-docs + devrelay-ask-member スキルファイルを作成・更新する
 * Agent 接続成功時に呼び出される
 *
 * @param config - Agent 設定（serverUrl, token を使用）
 */
export async function ensureSkillFiles(config: AgentConfig): Promise<void> {
  try {
    // devrelay-docs スキル
    await fs.mkdir(SCRIPTS_DIR, { recursive: true });

    const skillMdPath = path.join(SKILL_DIR, 'SKILL.md');
    await fs.writeFile(skillMdPath, generateSkillMd(), 'utf-8');

    const searchShPath = path.join(SCRIPTS_DIR, 'search.sh');
    await fs.writeFile(searchShPath, generateSearchScript(config.serverUrl, config.token), {
      encoding: 'utf-8',
      mode: 0o755,
    });

    // devrelay-ask-member スキル
    await fs.mkdir(ASK_SCRIPTS_DIR, { recursive: true });

    const askSkillMdPath = path.join(ASK_SKILL_DIR, 'SKILL.md');
    await fs.writeFile(askSkillMdPath, generateAskMemberSkillMd(), 'utf-8');

    const askShPath = path.join(ASK_SCRIPTS_DIR, 'ask.sh');
    await fs.writeFile(askShPath, generateAskScript(config.serverUrl, config.token), {
      encoding: 'utf-8',
      mode: 0o755,
    });

    console.log('🔧 Claude Code skill files updated: ~/.claude/skills/devrelay-docs/ + devrelay-ask-member/');
  } catch (error: any) {
    console.error('Failed to create skill files:', error.message);
  }
}
