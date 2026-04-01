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
description: 他プロジェクトのエージェントに質問や実行依頼を送ります。「pixblogに聞いて」「サーバー側のAPI仕様を確認して」「pixdraftにREADME更新を依頼して」など、別プロジェクトとの連携に使用します。
allowed-tools: Bash(bash ~/.claude/skills/devrelay-ask-member/scripts/ask.sh *)
---

## DevRelay クロスプロジェクト連携

他プロジェクトのエージェントに質問を送信したり、実行依頼（teamexec）を送ることができます。

### メンバー一覧を確認

まず連携可能なメンバー（プロジェクト）を確認します:

\\\`\\\`\\\`bash
bash ~/.claude/skills/devrelay-ask-member/scripts/ask.sh --list
\\\`\\\`\\\`

### 質問を送信（プランモード）

\\\`\\\`\\\`bash
bash ~/.claude/skills/devrelay-ask-member/scripts/ask.sh --project <プロジェクト名> --question "質問内容"
\\\`\\\`\\\`

### 実行依頼を送信（exec モード）

\\\`\\\`\\\`bash
bash ~/.claude/skills/devrelay-ask-member/scripts/ask.sh --exec --project <プロジェクト名> --question "実行指示"
\\\`\\\`\\\`

例:
- \\\`bash ~/.claude/skills/devrelay-ask-member/scripts/ask.sh --project pixblog --question "POST /api/v1/categories の仕様を教えて"\\\`
- \\\`bash ~/.claude/skills/devrelay-ask-member/scripts/ask.sh --exec --project pixdraft --question "アカウント削除APIを実装して"\\\`

### 注意事項
- 質問/依頼先のエージェントがオンラインである必要があります
- **Bash ツールの timeout を十分に設定してください:**
  - \\\`--exec\\\` なし（質問）: timeout 720000（12分）
  - \\\`--exec\\\` あり（実行依頼）: timeout 3660000（61分）
- \\\`--exec\\\` を付けると exec モードで実装まで実行します（コード変更あり）
- \\\`--exec\\\` なしはプランモードで質問のみ（コード変更なし）
`;
}

/**
 * ask.sh スクリプトの内容を生成
 */
function generateAskScript(serverUrl: string, token: string): string {
  const httpUrl = wsToHttpUrl(serverUrl);

  return `#!/bin/bash
# DevRelay クロスプロジェクトクエリ / 実行依頼スクリプト
# Agent が自動生成。手動編集は次回起動時に上書きされます。

set -euo pipefail

API_URL="${httpUrl}"
TOKEN="${token}"

# 引数チェック
if [ $# -eq 0 ]; then
  echo "使い方:"
  echo "  メンバー一覧:  bash $0 --list"
  echo "  質問送信:      bash $0 --project <プロジェクト名> --question \\"質問内容\\""
  echo "  実行依頼:      bash $0 --exec --project <プロジェクト名> --question \\"実行指示\\""
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
EXEC_MODE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --question) QUESTION="$2"; shift 2 ;;
    --exec) EXEC_MODE="1"; shift ;;
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

# プロジェクト名でメンバーを検索（displayName と originalName の両方で部分一致）
if command -v jq &>/dev/null; then
  TARGET_ID=$(echo "$MEMBERS_BODY" | jq -r --arg name "$PROJECT" '[.[] | select((.memberProjectName | ascii_downcase | contains($name | ascii_downcase)) or ((.memberProjectOriginalName // "") | ascii_downcase | contains($name | ascii_downcase)))] | first | .memberProjectId // empty')
  TARGET_NAME=$(echo "$MEMBERS_BODY" | jq -r --arg name "$PROJECT" '[.[] | select((.memberProjectName | ascii_downcase | contains($name | ascii_downcase)) or ((.memberProjectOriginalName // "") | ascii_downcase | contains($name | ascii_downcase)))] | first | .memberProjectName // empty')

  if [ -z "$TARGET_ID" ]; then
    echo "エラー: '$PROJECT' に一致するメンバーが見つかりません"
    echo ""
    echo "登録済みメンバー:"
    echo "$MEMBERS_BODY" | jq -r '.[] | "  - \\(.memberProjectName) (\\(.memberMachineName))"'
    exit 1
  fi

  # モードに応じてエンドポイント・ラベル・タイムアウトを切り替え
  if [ -n "$EXEC_MODE" ]; then
    API_ENDPOINT="\${API_URL}/api/agent/teamexec-member"
    MODE_LABEL="実行依頼"
    EMOJI="🚀"
    CURL_TIMEOUT=3600  # teamexec: 60分（コード変更は時間がかかる）
  else
    API_ENDPOINT="\${API_URL}/api/agent/ask-member"
    MODE_LABEL="質問"
    EMOJI="📨"
    CURL_TIMEOUT=600   # ask: 10分（質問は比較的短時間）
  fi

  echo "$EMOJI $TARGET_NAME に\${MODE_LABEL}を送信中..."
  echo "\${MODE_LABEL}: $QUESTION"
  echo "(タイムアウト: \${CURL_TIMEOUT}秒)"
  echo ""

  # jq で安全に JSON を構築（shell エスケープの問題を回避）
  JSON_BODY=$(jq -n --arg id "$TARGET_ID" --arg q "$QUESTION" '{targetProjectId: $id, question: $q}')

  # 送信（ask: 10分、teamexec: 60分）
  RESPONSE=$(curl -s -f -w "\\n%{http_code}" --max-time $CURL_TIMEOUT \\
    -X POST \\
    -H "Content-Type: application/json" \\
    -H "Authorization: Bearer $TOKEN" \\
    -d "$JSON_BODY" \\
    "$API_ENDPOINT" 2>&1) || {
    echo "エラー: \${MODE_LABEL}に失敗しました（タイムアウトまたは接続エラー）"
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
