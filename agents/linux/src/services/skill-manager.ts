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

/** devrelay-list-inventory スキルディレクトリ */
const INVENTORY_SKILL_DIR = path.join(SKILLS_BASE, 'devrelay-list-inventory');
const INVENTORY_SCRIPTS_DIR = path.join(INVENTORY_SKILL_DIR, 'scripts');

/** devrelay-create-project スキルディレクトリ */
const CREATE_SKILL_DIR = path.join(SKILLS_BASE, 'devrelay-create-project');
const CREATE_SCRIPTS_DIR = path.join(CREATE_SKILL_DIR, 'scripts');

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

  # メンバー一覧に見つからない場合、inventory API にフォールバック（Team 未登録でも問い合わせ可能にする）
  if [ -z "$TARGET_ID" ]; then
    INV_RESPONSE=$(curl -s -f -w "\\n%{http_code}" \\
      -H "Authorization: Bearer $TOKEN" \\
      "\${API_URL}/api/agent/inventory" 2>&1) || true

    INV_HTTP=$(echo "$INV_RESPONSE" | tail -1)
    INV_BODY=$(echo "$INV_RESPONSE" | sed '$d')

    if [ "$INV_HTTP" = "200" ]; then
      TARGET_ID=$(echo "$INV_BODY" | jq -r --arg name "$PROJECT" '[.[].projects[] | select((.name | ascii_downcase | contains($name | ascii_downcase)) or ((.originalName // "") | ascii_downcase | contains($name | ascii_downcase)))] | first | .id // empty')
      TARGET_NAME=$(echo "$INV_BODY" | jq -r --arg name "$PROJECT" '[.[].projects[] | select((.name | ascii_downcase | contains($name | ascii_downcase)) or ((.originalName // "") | ascii_downcase | contains($name | ascii_downcase)))] | first | .name // empty')
    fi
  fi

  if [ -z "$TARGET_ID" ]; then
    echo "エラー: '$PROJECT' に一致するプロジェクトが見つかりません"
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
  # tr -d '\\r' で Windows CRLF を除去（Git Bash + プロキシ環境での Content-Length 不一致防止）
  JSON_BODY=$(jq -n --arg id "$TARGET_ID" --arg q "$QUESTION" '{targetProjectId: $id, question: $q}' | tr -d '\\r')

  # 送信（ask: 10分、teamexec: 60分）
  # printf + curl -d @- でパイプ渡し（Content-Length を確実に一致させる）
  RESPONSE=$(printf '%s' "$JSON_BODY" | curl -s -f -w "\\n%{http_code}" --max-time $CURL_TIMEOUT \\
    -X POST \\
    -H "Content-Type: application/json" \\
    -H "Authorization: Bearer $TOKEN" \\
    -d @- \\
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
 * list-inventory SKILL.md の内容を生成
 */
function generateInventorySkillMd(): string {
  return `---
name: devrelay-list-inventory
description: ユーザーの全マシン・プロジェクト・オンライン状態を一覧表示します。「どのサーバーがあるか」「プロジェクト一覧を見せて」「何が動いてる？」など、インベントリ確認に使用します。
allowed-tools: Bash(bash ~/.claude/skills/devrelay-list-inventory/scripts/list.sh *)
---

## DevRelay インベントリ一覧

ユーザーの全マシン・プロジェクト・オンライン状態を取得します。

### 一覧表示

\\\`\\\`\\\`bash
bash ~/.claude/skills/devrelay-list-inventory/scripts/list.sh
\\\`\\\`\\\`

結果にはマシンごとにプロジェクト名、パス、AI ツール、オンライン状態が含まれます。
`;
}

/**
 * list.sh スクリプトの内容を生成
 */
function generateInventoryScript(serverUrl: string, token: string): string {
  const httpUrl = wsToHttpUrl(serverUrl);

  return `#!/bin/bash
# DevRelay インベントリ一覧スクリプト
# Agent が自動生成。手動編集は次回起動時に上書きされます。

set -euo pipefail

API_URL="${httpUrl}"
TOKEN="${token}"

RESPONSE=$(curl -s -f -w "\\n%{http_code}" \\
  -H "Authorization: Bearer $TOKEN" \\
  "\${API_URL}/api/agent/inventory" 2>&1) || {
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
  MACHINE_COUNT=$(echo "$BODY" | jq 'length')
  if [ "$MACHINE_COUNT" = "0" ]; then
    echo "登録済みマシンはありません。"
    exit 0
  fi

  echo "=== インベントリ ($MACHINE_COUNT マシン) ==="
  echo ""
  echo "$BODY" | jq -r '.[] | "\\(if .online then "🟢" else "⚪" end) \\(.machine) (\\(.machineName))\\(.projects | map("  - \\(.name) [\\(.defaultAi)] \\(.path)") | "\\n" + join("\\n"))"'
else
  echo "$BODY"
fi
`;
}

/**
 * create-project SKILL.md の内容を生成
 */
function generateCreateProjectSkillMd(): string {
  return `---
name: devrelay-create-project
description: 対象マシンに新しいプロジェクトの雛形を作成します。「新しいプロジェクトを作って」「yyyyにWebアプリを作成して」など、新規プロジェクトの scaffold に使用します。
allowed-tools: Bash(bash ~/.claude/skills/devrelay-create-project/scripts/create.sh *)
---

## DevRelay プロジェクト作成（Scaffold）

対象マシンに新しいプロジェクトの雛形を作成します。

### プロジェクト作成

\\\`\\\`\\\`bash
bash ~/.claude/skills/devrelay-create-project/scripts/create.sh --machine <マシン名> --name <プロジェクト名> --template <テンプレート名>
\\\`\\\`\\\`

### 利用可能なテンプレート

| テンプレート | 説明 |
|-------------|------|
| \\\`vite-react-web\\\` | Vite + React 19 + TypeScript + Tailwind CSS v4 |

### パラメータ

- \\\`--machine\\\`: 対象マシン名（部分一致で検索）
- \\\`--name\\\`: プロジェクト名（英小文字で始まり、英小文字・数字・ハイフンで構成、3〜30文字）
- \\\`--template\\\`: テンプレート名（上記参照）

### 例

\\\`\\\`\\\`bash
bash ~/.claude/skills/devrelay-create-project/scripts/create.sh --machine yyyy --name mviewer-web --template vite-react-web
\\\`\\\`\\\`

### 注意事項
- 対象マシンのエージェントがオンラインである必要があります
- プロジェクト名は一意である必要があります
- 作成後、プロジェクトは自動的にインベントリに登録されます
- **Bash ツールの timeout を 360000（6分）に設定してください**（npm install に時間がかかる場合があります）
`;
}

/**
 * create.sh スクリプトの内容を生成
 */
function generateCreateScript(serverUrl: string, token: string): string {
  const httpUrl = wsToHttpUrl(serverUrl);

  return `#!/bin/bash
# DevRelay プロジェクト作成（Scaffold）スクリプト
# Agent が自動生成。手動編集は次回起動時に上書きされます。

set -euo pipefail

API_URL="${httpUrl}"
TOKEN="${token}"

# 引数チェック
if [ $# -eq 0 ]; then
  echo "使い方:"
  echo "  bash $0 --machine <マシン名> --name <プロジェクト名> --template <テンプレート名>"
  echo ""
  echo "テンプレート:"
  echo "  vite-react-web  Vite + React 19 + TypeScript + Tailwind CSS v4"
  exit 1
fi

# 引数パース
MACHINE=""
NAME=""
TEMPLATE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --machine) MACHINE="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --template) TEMPLATE="$2"; shift 2 ;;
    *) echo "不明な引数: $1"; exit 1 ;;
  esac
done

if [ -z "$MACHINE" ] || [ -z "$NAME" ] || [ -z "$TEMPLATE" ]; then
  echo "エラー: --machine, --name, --template の全てが必要です"
  exit 1
fi

echo "📦 プロジェクト作成中..."
echo "  マシン: $MACHINE"
echo "  名前: $NAME"
echo "  テンプレート: $TEMPLATE"
echo ""

# jq で安全に JSON を構築
JSON_BODY=$(jq -n --arg m "$MACHINE" --arg n "$NAME" --arg t "$TEMPLATE" '{machineName: $m, name: $n, template: $t}' | tr -d '\\r')

RESPONSE=$(printf '%s' "$JSON_BODY" | curl -s -f -w "\\n%{http_code}" --max-time 300 \\
  -X POST \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $TOKEN" \\
  -d @- \\
  "\${API_URL}/api/agent/scaffold" 2>&1) || {
  echo "エラー: プロジェクト作成に失敗しました（タイムアウトまたは接続エラー）"
  echo "$RESPONSE"
  exit 1
}

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" != "200" ]; then
  echo "エラー (HTTP $HTTP_CODE):"
  if command -v jq &>/dev/null; then
    echo "$BODY" | jq -r '.error // .'
  else
    echo "$BODY"
  fi
  exit 1
fi

echo "✅ プロジェクト作成完了！"
if command -v jq &>/dev/null; then
  echo "  名前: $(echo "$BODY" | jq -r '.name')"
  echo "  パス: $(echo "$BODY" | jq -r '.path')"
  echo "  マシン: $(echo "$BODY" | jq -r '.machine')"
fi
`;
}

/**
 * devrelay-docs + devrelay-ask-member + devrelay-list-inventory + devrelay-create-project
 * スキルファイルを作成・更新する
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

    // devrelay-list-inventory スキル
    await fs.mkdir(INVENTORY_SCRIPTS_DIR, { recursive: true });

    const inventorySkillMdPath = path.join(INVENTORY_SKILL_DIR, 'SKILL.md');
    await fs.writeFile(inventorySkillMdPath, generateInventorySkillMd(), 'utf-8');

    const listShPath = path.join(INVENTORY_SCRIPTS_DIR, 'list.sh');
    await fs.writeFile(listShPath, generateInventoryScript(config.serverUrl, config.token), {
      encoding: 'utf-8',
      mode: 0o755,
    });

    // devrelay-create-project スキル
    await fs.mkdir(CREATE_SCRIPTS_DIR, { recursive: true });

    const createSkillMdPath = path.join(CREATE_SKILL_DIR, 'SKILL.md');
    await fs.writeFile(createSkillMdPath, generateCreateProjectSkillMd(), 'utf-8');

    const createShPath = path.join(CREATE_SCRIPTS_DIR, 'create.sh');
    await fs.writeFile(createShPath, generateCreateScript(config.serverUrl, config.token), {
      encoding: 'utf-8',
      mode: 0o755,
    });

    console.log('🔧 Claude Code skill files updated: ~/.claude/skills/devrelay-{docs,ask-member,list-inventory,create-project}/');
  } catch (error: any) {
    console.error('Failed to create skill files:', error.message);
  }
}
