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
import { SCAFFOLD_TEMPLATE_DEFS, type ScaffoldTemplateOs } from '@devrelay/shared';

/** OS コードを表示ラベルに変換 */
function scaffoldOsLabel(os: ScaffoldTemplateOs): string {
  return ({ linux: 'Linux', darwin: 'macOS', win32: 'Windows' } as Record<string, string>)[os] || os;
}

/** SCAFFOLD_TEMPLATE_DEFS から SKILL.md 用のテンプレート表の行を生成 */
function scaffoldTemplateTableRows(): string {
  return SCAFFOLD_TEMPLATE_DEFS.map((t) => {
    const osLabels = t.os.map(scaffoldOsLabel).join(' / ');
    const toolNote = t.requiredTool ? `（要 \\\`${t.requiredTool}\\\`）` : '';
    return `| \\\`${t.id}\\\` | ${t.description}${toolNote} | ${osLabels} |`;
  }).join('\n');
}

/** SCAFFOLD_TEMPLATE_DEFS から create.sh の使い方表示用 echo 行を生成 */
function scaffoldTemplateEchoLines(): string {
  return SCAFFOLD_TEMPLATE_DEFS.map(
    (t) => `  echo "  ${t.id.padEnd(16)}${t.description}"`,
  ).join('\n');
}

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

/** devrelay-read-messages スキルディレクトリ（他プロジェクトの会話履歴読み取り、#324） */
const READ_MSG_SKILL_DIR = path.join(SKILLS_BASE, 'devrelay-read-messages');
const READ_MSG_SCRIPTS_DIR = path.join(READ_MSG_SKILL_DIR, 'scripts');

/** devrelay-create-project スキルディレクトリ */
const CREATE_SKILL_DIR = path.join(SKILLS_BASE, 'devrelay-create-project');
const CREATE_SCRIPTS_DIR = path.join(CREATE_SKILL_DIR, 'scripts');

/** devrelay-flutter-deploy スキルディレクトリ */
const FLUTTER_DEPLOY_SKILL_DIR = path.join(SKILLS_BASE, 'devrelay-flutter-deploy');
const FLUTTER_DEPLOY_SCRIPTS_DIR = path.join(FLUTTER_DEPLOY_SKILL_DIR, 'scripts');

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
  RESPONSE=$(curl -s -w "\\n%{http_code}" \\
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
RESPONSE=$(curl -s -w "\\n%{http_code}" \\
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

### 使用 AI を指定して質問（--ai）

質問（\\\`--exec\\\` なし）に限り、対象プロジェクトの既定 AI と無関係に使用する AI を1回だけ指定できます:

\\\`\\\`\\\`bash
bash ~/.claude/skills/devrelay-ask-member/scripts/ask.sh --project <プロジェクト名> --ai claude --question "質問内容"
bash ~/.claude/skills/devrelay-ask-member/scripts/ask.sh --project <プロジェクト名> --ai codex --question "質問内容"
\\\`\\\`\\\`

- 指定した AI が対象マシンに**未インストールの場合はエラーで停止**します（黙って別の AI にフォールバックしません）。エラーメッセージにそのマシンで利用可能な AI 一覧が表示されます
- \\\`--ai\\\` は \\\`--exec\\\`（実行依頼）とは併用できません
- \\\`--ai\\\` を省略した場合は従来どおり対象プロジェクトの既定 AI が使われます

例:
- \\\`bash ~/.claude/skills/devrelay-ask-member/scripts/ask.sh --project pixblog --question "POST /api/v1/categories の仕様を教えて"\\\`
- \\\`bash ~/.claude/skills/devrelay-ask-member/scripts/ask.sh --exec --project pixdraft --question "アカウント削除APIを実装して"\\\`
- \\\`bash ~/.claude/skills/devrelay-ask-member/scripts/ask.sh --project pixblog --ai codex --question "この仕様どう思う？"\\\`

### 宛先が複数ある場合

同じ名前のプロジェクトが複数のマシンに存在する場合、スクリプトは**勝手に選ばず候補一覧を出してエラー終了**します。
その場合は \\\`--machine <マシン名>\\\` でマシンを指定してください:

\\\`\\\`\\\`bash
bash ~/.claude/skills/devrelay-ask-member/scripts/ask.sh --exec --project pixblog --machine x220-158-18-103/pixblog --question "..."
\\\`\\\`\\\`

### 注意事項
- **宛先は WebUI の Team ページで登録されたプロジェクトだけです**（\\\`--list\\\` に出るものが全て）。一覧に無いプロジェクトへは送れません（サーバーが 403 を返します）。**勝手に別のプロジェクトへ送り直さず**、ユーザーに登録を依頼してください
- 質問/依頼先のエージェントがオンラインである必要があります
- **Bash ツールの timeout を十分に設定してください:**
  - \\\`--exec\\\` なし（質問）: timeout 720000（12分）
  - \\\`--exec\\\` あり（実行依頼）: timeout 3660000（61分）
- \\\`--exec\\\` を付けると exec モードで実装まで実行します（コード変更あり）
- \\\`--exec\\\` なしはプランモードで質問のみ（コード変更なし）
- **失敗しても同じ依頼を文面を変えて再送しないでください。**2 回失敗したらユーザーに状況を報告して止まってください（過去に再送ループで大量のセッションが起動した事故があります）
- **teamexec（実行依頼）で受け取った作業を、さらに別プロジェクトへ転送しないでください。** 自分で実行できない場合は、その理由を依頼元への回答として返してください（サーバー側でも 429 で拒否されます）
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

# #348: 自分の素性を拾う（DEVRELAY_PROJECT / DEVRELAY_SESSION_ID は全 AI 起動経路で注入済みの環境変数。
# set -euo pipefail のため \${VAR:-} 形式が必須。自己宛のガードはサーバー側が最終防衛だが、
# ここでも候補から自分自身を除外し、そもそも誤送信の選択肢を見せない）
SELF_PATH="\${DEVRELAY_PROJECT:-}"
SELF_SESSION="\${DEVRELAY_SESSION_ID:-}"

# 引数チェック
if [ $# -eq 0 ]; then
  echo "使い方:"
  echo "  メンバー一覧:  bash $0 --list"
  echo "  質問送信:      bash $0 --project <プロジェクト名> --question \\"質問内容\\""
  echo "  実行依頼:      bash $0 --exec --project <プロジェクト名> --question \\"実行指示\\""
  echo "  AI 指定質問:   bash $0 --project <プロジェクト名> --ai <claude|codex|...> --question \\"質問内容\\"（--exec とは併用不可）"
  exit 1
fi

# --list モード: メンバー一覧取得
if [ "$1" = "--list" ]; then
  RESPONSE=$(curl -s -w "\\n%{http_code}" \\
    -H "Authorization: Bearer $TOKEN" \\
    "\${API_URL}/api/agent/members" 2>&1) || {
    echo "エラー: API リクエストに失敗しました"
    echo "$RESPONSE"
    exit 1
  }

  HTTP_CODE=$(echo "$RESPONSE" | tail -1)
  BODY=$(echo "$RESPONSE" | sed '$d')

  if [ "$HTTP_CODE" != "200" ]; then
    # #349: curl -f を外したことで BODY にサーバーのエラー詳細が入るようになった。jq 不在・非 JSON ボディでは生ボディにフォールバック
    DETAIL=$(printf '%s' "$BODY" | jq -r '.error // .message // empty' 2>/dev/null || true)
    if [ -n "$DETAIL" ]; then
      echo "エラー (HTTP $HTTP_CODE): $DETAIL"
    else
      echo "エラー (HTTP $HTTP_CODE): $BODY"
    fi
    exit 1
  fi

  if command -v jq &>/dev/null; then
    MEMBER_COUNT=$(echo "$BODY" | jq 'length')
    if [ "$MEMBER_COUNT" = "0" ]; then
      echo "登録済みメンバーはありません。WebUI の Team ページで宛先プロジェクトを登録してください。"
      exit 0
    fi
    # #295: チームごとにグルーピングし、同名メンバーには --machine 必須の警告を付ける
    echo "=== 登録済みメンバー ($MEMBER_COUNT 件） ==="
    echo "（ask / teamexec で送れるのはこの一覧の宛先だけです）"
    echo ""
    echo "$BODY" | jq -r '
      ( group_by(.memberProjectName) | map(select(length > 1) | .[0].memberProjectName) ) as $dups
      | group_by(.teamName)[]
      | "[\\(.[0].teamName)]",
        ( .[] | "  - \\(.memberProjectName) (\\(.memberMachineName)) [\\(.memberMachineStatus)]"
          + (if .isSameMachine then " [自マシン]" else "" end)
          + (if (.memberProjectName | IN($dups[])) then " ⚠️ 同名あり: --machine 指定が必要" else "" end) ),
        ""
    '
  else
    echo "$BODY"
  fi
  exit 0
fi

# 引数パース
PROJECT=""
QUESTION=""
EXEC_MODE=""
MACHINE=""
AI=""
while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --question) QUESTION="$2"; shift 2 ;;
    --machine) MACHINE="$2"; shift 2 ;;
    --exec) EXEC_MODE="1"; shift ;;
    --ai) AI="$2"; shift 2 ;;
    *) echo "不明な引数: $1"; exit 1 ;;
  esac
done

if [ -z "$PROJECT" ] || [ -z "$QUESTION" ]; then
  echo "エラー: --project と --question の両方が必要です"
  exit 1
fi

# #325: --ai は質問（--exec なし）専用。teamexec 側の既存挙動には一切影響させない
if [ -n "$AI" ] && [ -n "$EXEC_MODE" ]; then
  echo "エラー: --ai は質問（--exec なし）専用です。--exec と同時には使えません"
  exit 1
fi

# まずメンバー一覧からプロジェクト ID を取得
MEMBERS_RESPONSE=$(curl -s -w "\\n%{http_code}" \\
  -H "Authorization: Bearer $TOKEN" \\
  "\${API_URL}/api/agent/members" 2>&1) || {
  echo "エラー: メンバー一覧の取得に失敗しました"
  exit 1
}

MEMBERS_HTTP=$(echo "$MEMBERS_RESPONSE" | tail -1)
MEMBERS_BODY=$(echo "$MEMBERS_RESPONSE" | sed '$d')

if [ "$MEMBERS_HTTP" != "200" ]; then
  # #349: curl -f を外したことで MEMBERS_BODY にサーバーのエラー詳細が入るようになった。jq 不在・非 JSON ボディでは生ボディにフォールバック
  DETAIL=$(printf '%s' "$MEMBERS_BODY" | jq -r '.error // .message // empty' 2>/dev/null || true)
  if [ -n "$DETAIL" ]; then
    echo "エラー (HTTP $MEMBERS_HTTP): $DETAIL"
  else
    echo "エラー (HTTP $MEMBERS_HTTP): $MEMBERS_BODY"
  fi
  exit 1
fi

# プロジェクト名でメンバーを検索
# #294: 「最初の部分一致を黙って採用」をやめ、完全一致 > オンライン > 同一マシン の優先順で絞り込み、
# それでも複数残る場合は自動選択せずエラーにする（同名プロジェクトが複数マシンにあるため、
# 誤った宛先へ実行依頼が飛んで無限ピンポンを起こした事故への対策）
if command -v jq &>/dev/null; then
  # 候補の絞り込みフィルタ（members / inventory の両方で共用）
  # 入力: [{id, name, orig, machine, online, same, path, self}]
  # #348: 自動選択（$same が1件なら無条件採用）は輻輳事故の直接原因だったため廃止。
  # 代わりに候補一覧そのものから自分自身（.self）を除外する
  FILTER_JQ='
    ( map(select(.self | not)) ) as $noself
    | ( if ($machine | length) > 0
      then ($noself | map(select(.machine | ascii_downcase | contains($machine | ascii_downcase))))
      else $noself end ) as $scoped
    | ( $scoped | map(select((.name | ascii_downcase) == ($name | ascii_downcase) or (.orig | ascii_downcase) == ($name | ascii_downcase))) ) as $exact
    | ( if ($exact | length) > 0 then $exact
        else ($scoped | map(select((.name | ascii_downcase | contains($name | ascii_downcase)) or (.orig | ascii_downcase | contains($name | ascii_downcase))))) end ) as $named
    | ( $named | map(select(.online)) ) as $online
    | ( if ($online | length) > 0 then $online else $named end ) as $avail
    | $avail
  '

  # #348: self は path 完全一致による best-effort 判定（正規化はサーバー側 decideCrossTarget が最終防衛）
  CANDIDATES=$(echo "$MEMBERS_BODY" | jq --arg self_path "$SELF_PATH" '[ .[] | {
    id: .memberProjectId,
    name: .memberProjectName,
    orig: (.memberProjectOriginalName // .memberProjectName),
    machine: .memberMachineName,
    online: (.memberMachineStatus == "online"),
    same: (.isSameMachine // false),
    path: (.memberProjectPath // ""),
    self: (($self_path | length) > 0 and ((.memberProjectPath // "") == $self_path))
  } ]')
  MATCHED=$(echo "$CANDIDATES" | jq --arg name "$PROJECT" --arg machine "$MACHINE" "$FILTER_JQ")
  MATCH_COUNT=$(echo "$MATCHED" | jq 'length')

  # #295: 宛先は Team に登録済みのものだけ。以前は inventory API（ユーザーの全プロジェクト）へ
  # フォールバックしていたが、当てずっぽうに別マシンの同名プロジェクトを選んで暴走の起点になったため廃止。
  # サーバー側も未登録宛先を 403 で拒否する
  if [ "$MATCH_COUNT" = "0" ]; then
    echo "エラー: '$PROJECT' は宛先として登録されていません"
    echo ""
    echo "送信できる宛先:"
    echo "$CANDIDATES" | jq -r '.[] | "  - \\(.name) (\\(.machine)) [\\(if .online then "online" else "offline" end)]" + (if .self then " ⚠️ 自分自身（送信不可）" else "" end)'
    echo ""
    echo "この一覧に無いプロジェクトへは送れません。WebUI の Team ページで登録するようユーザーに依頼してください。"
    echo "別のプロジェクトに送り直したり、同じ依頼を文面を変えて再送したりしないでください。"
    exit 1
  fi

  if [ "$MATCH_COUNT" != "1" ]; then
    # #294: 同名プロジェクトが複数マシンにある場合、勝手に選ばない（誤爆すると依頼が跳ね返り続ける）
    echo "エラー: '$PROJECT' に一致するプロジェクトが $MATCH_COUNT 件あります。宛先を特定できません。"
    echo ""
    echo "候補:"
    echo "$MATCHED" | jq -r '.[] | "  - \\(.name) (\\(.machine)) [\\(if .online then "online" else "offline" end)]" + (if .self then " ⚠️ 自分自身（送信不可）" else "" end)'
    echo ""
    echo "--machine <マシン名> でマシンを指定して実行し直すか、どのマシンのプロジェクトかユーザーに確認してください。"
    echo "同じ依頼を文面を変えて再送しないでください。"
    exit 1
  fi

  TARGET_ID=$(echo "$MATCHED" | jq -r '.[0].id')
  TARGET_NAME=$(echo "$MATCHED" | jq -r '.[0].name')
  TARGET_MACHINE=$(echo "$MATCHED" | jq -r '.[0].machine')

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

  echo "$EMOJI $TARGET_NAME ($TARGET_MACHINE) に\${MODE_LABEL}を送信中..."
  echo "\${MODE_LABEL}: $QUESTION"
  if [ -n "$AI" ]; then
    echo "使用 AI: $AI（未インストールの場合はフォールバックせずエラーで停止します）"
  fi
  echo "(タイムアウト: \${CURL_TIMEOUT}秒)"
  echo ""

  # jq で安全に JSON を構築（shell エスケープの問題を回避）
  # tr -d '\\r' で Windows CRLF を除去（Git Bash + プロキシ環境での Content-Length 不一致防止）
  # #325: --ai 省略時は従来と1バイト同一の body にする（後方互換の要）
  if [ -n "$AI" ]; then
    BASE_BODY=$(jq -n --arg id "$TARGET_ID" --arg q "$QUESTION" --arg ai "$AI" '{targetProjectId: $id, question: $q, ai: $ai}')
  else
    BASE_BODY=$(jq -n --arg id "$TARGET_ID" --arg q "$QUESTION" '{targetProjectId: $id, question: $q}')
  fi
  # #348: SELF_PATH（DEVRELAY_PROJECT）が空の場合は従来と1バイト同一の body にする（後方互換の要、旧 Agent はこの変数を持たない）
  if [ -n "$SELF_PATH" ]; then
    JSON_BODY=$(echo "$BASE_BODY" | jq --arg cp "$SELF_PATH" '. + {callerProjectPath: $cp}' | tr -d '\\r')
  else
    JSON_BODY=$(echo "$BASE_BODY" | tr -d '\\r')
  fi

  # 送信（ask: 10分、teamexec: 60分）
  # printf + curl -d @- でパイプ渡し（Content-Length を確実に一致させる）
  RESPONSE=$(printf '%s' "$JSON_BODY" | curl -s -w "\\n%{http_code}" --max-time $CURL_TIMEOUT \\
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
    # #349: curl -f を外したことで BODY にサーバーのエラー詳細（#348 の noRetryNote 等）が入るようになった。jq 不在・非 JSON ボディでは生ボディにフォールバック
    DETAIL=$(printf '%s' "$BODY" | jq -r '.error // .message // empty' 2>/dev/null || true)
    if [ -n "$DETAIL" ]; then
      echo "エラー (HTTP $HTTP_CODE): $DETAIL"
    else
      echo "エラー (HTTP $HTTP_CODE): $BODY"
    fi
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
 * read-messages SKILL.md の内容を生成（他プロジェクトの会話履歴読み取り、#324）
 */
function generateReadMessagesSkillMd(): string {
  return `---
name: devrelay-read-messages
description: 他プロジェクトの直近の会話履歴を読み取ります。「pixblogで何を話したか見せて」「あちらの直近のAI回答を確認して」など、別プロジェクトの履歴参照に使用します。
allowed-tools: Bash(bash ~/.claude/skills/devrelay-read-messages/scripts/read.sh *)
---

## DevRelay 会話履歴読み取り（クロスプロジェクト）

他プロジェクトの直近の会話履歴（Message）を読み取ります。**読み取り専用**で相手の AI セッションは起動しません
（\\\`devrelay-ask-member\\\` とは別物。課金なし・待ち時間なし）。

### メンバー一覧を確認

\\\`\\\`\\\`bash
bash ~/.claude/skills/devrelay-read-messages/scripts/read.sh --list
\\\`\\\`\\\`

### 直近の会話履歴を取得

\\\`\\\`\\\`bash
bash ~/.claude/skills/devrelay-read-messages/scripts/read.sh --project <プロジェクト名> --limit 10
\\\`\\\`\\\`

例:
- \\\`bash ~/.claude/skills/devrelay-read-messages/scripts/read.sh --project pixblog --limit 10\\\`
- \\\`bash ~/.claude/skills/devrelay-read-messages/scripts/read.sh --project pixblog --role assistant --limit 5\\\`（AI の回答だけ）

### オプション
- \\\`--limit <N>\\\`: 直近何件取得するか（既定 20、上限 50）
- \\\`--role user|assistant\\\`: 片方だけに絞り込み（省略時は両方、system は含まれません）

### 宛先が複数ある場合

同じ名前のプロジェクトが複数のマシンに存在する場合、スクリプトは**勝手に選ばず候補一覧を出してエラー終了**します。
\\\`--machine <マシン名>\\\` でマシンを指定してください。

### 注意事項
- **対象は WebUI の Team ページで登録されたプロジェクトだけです**（\\\`--list\\\` に出るものが全て）。一覧に無いプロジェクトへは送れません（サーバーが 403 を返します）
- 応答が長い場合があります。必要な件数だけ \\\`--limit\\\` で絞ってください
`;
}

/**
 * read.sh スクリプトの内容を生成（他プロジェクトの会話履歴読み取り、#324）
 * 名前→ID解決は ask.sh の FILTER_JQ ブロックと同じロジックを流用する
 * （#294 の同名曖昧性対策をここでも踏襲し、サーバ側に2本目の名前解決を作らない）
 */
function generateReadMessagesScript(serverUrl: string, token: string): string {
  const httpUrl = wsToHttpUrl(serverUrl);

  return `#!/bin/bash
# DevRelay クロスプロジェクト会話履歴読み取りスクリプト
# Agent が自動生成。手動編集は次回起動時に上書きされます。

set -euo pipefail

API_URL="${httpUrl}"
TOKEN="${token}"

# #348: 自分の素性を拾う（DEVRELAY_PROJECT / DEVRELAY_SESSION_ID は全 AI 起動経路で注入済みの環境変数。
# set -euo pipefail のため \${VAR:-} 形式が必須）
SELF_PATH="\${DEVRELAY_PROJECT:-}"
SELF_SESSION="\${DEVRELAY_SESSION_ID:-}"

# 引数チェック
if [ $# -eq 0 ]; then
  echo "使い方:"
  echo "  メンバー一覧:  bash $0 --list"
  echo "  履歴取得:      bash $0 --project <プロジェクト名> [--limit <N>] [--role user|assistant] [--machine <マシン名>]"
  exit 1
fi

# --list モード: メンバー一覧取得
if [ "$1" = "--list" ]; then
  RESPONSE=$(curl -s -w "\\n%{http_code}" \\
    -H "Authorization: Bearer $TOKEN" \\
    "\${API_URL}/api/agent/members" 2>&1) || {
    echo "エラー: API リクエストに失敗しました"
    echo "$RESPONSE"
    exit 1
  }

  HTTP_CODE=$(echo "$RESPONSE" | tail -1)
  BODY=$(echo "$RESPONSE" | sed '$d')

  if [ "$HTTP_CODE" != "200" ]; then
    # #349: curl -f を外したことで BODY にサーバーのエラー詳細が入るようになった。jq 不在・非 JSON ボディでは生ボディにフォールバック
    DETAIL=$(printf '%s' "$BODY" | jq -r '.error // .message // empty' 2>/dev/null || true)
    if [ -n "$DETAIL" ]; then
      echo "エラー (HTTP $HTTP_CODE): $DETAIL"
    else
      echo "エラー (HTTP $HTTP_CODE): $BODY"
    fi
    exit 1
  fi

  if command -v jq &>/dev/null; then
    MEMBER_COUNT=$(echo "$BODY" | jq 'length')
    if [ "$MEMBER_COUNT" = "0" ]; then
      echo "登録済みメンバーはありません。WebUI の Team ページで対象プロジェクトを登録してください。"
      exit 0
    fi
    echo "=== 登録済みメンバー ($MEMBER_COUNT 件） ==="
    echo "（読み取れるのはこの一覧の宛先だけです）"
    echo ""
    echo "$BODY" | jq -r '
      ( group_by(.memberProjectName) | map(select(length > 1) | .[0].memberProjectName) ) as $dups
      | group_by(.teamName)[]
      | "[\\(.[0].teamName)]",
        ( .[] | "  - \\(.memberProjectName) (\\(.memberMachineName)) [\\(.memberMachineStatus)]"
          + (if .isSameMachine then " [自マシン]" else "" end)
          + (if (.memberProjectName | IN($dups[])) then " ⚠️ 同名あり: --machine 指定が必要" else "" end) ),
        ""
    '
  else
    echo "$BODY"
  fi
  exit 0
fi

# 引数パース
PROJECT=""
LIMIT="20"
ROLE=""
MACHINE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --limit) LIMIT="$2"; shift 2 ;;
    --role) ROLE="$2"; shift 2 ;;
    --machine) MACHINE="$2"; shift 2 ;;
    *) echo "不明な引数: $1"; exit 1 ;;
  esac
done

if [ -z "$PROJECT" ]; then
  echo "エラー: --project が必要です"
  exit 1
fi

# まずメンバー一覧からプロジェクト ID を取得
MEMBERS_RESPONSE=$(curl -s -w "\\n%{http_code}" \\
  -H "Authorization: Bearer $TOKEN" \\
  "\${API_URL}/api/agent/members" 2>&1) || {
  echo "エラー: メンバー一覧の取得に失敗しました"
  exit 1
}

MEMBERS_HTTP=$(echo "$MEMBERS_RESPONSE" | tail -1)
MEMBERS_BODY=$(echo "$MEMBERS_RESPONSE" | sed '$d')

if [ "$MEMBERS_HTTP" != "200" ]; then
  # #349: curl -f を外したことで MEMBERS_BODY にサーバーのエラー詳細が入るようになった。jq 不在・非 JSON ボディでは生ボディにフォールバック
  DETAIL=$(printf '%s' "$MEMBERS_BODY" | jq -r '.error // .message // empty' 2>/dev/null || true)
  if [ -n "$DETAIL" ]; then
    echo "エラー (HTTP $MEMBERS_HTTP): $DETAIL"
  else
    echo "エラー (HTTP $MEMBERS_HTTP): $MEMBERS_BODY"
  fi
  exit 1
fi

# プロジェクト名でメンバーを検索
# ask.sh と同じ絞り込み: 完全一致 > オンライン > 同一マシン の優先順、複数残れば自動選択せずエラー（#294 の踏襲）
if command -v jq &>/dev/null; then
  # #348: 自動選択（$same が1件なら無条件採用）は輻輳事故の直接原因だったため廃止。
  # 代わりに候補一覧そのものから自分自身（.self）を除外する
  FILTER_JQ='
    ( map(select(.self | not)) ) as $noself
    | ( if ($machine | length) > 0
      then ($noself | map(select(.machine | ascii_downcase | contains($machine | ascii_downcase))))
      else $noself end ) as $scoped
    | ( $scoped | map(select((.name | ascii_downcase) == ($name | ascii_downcase) or (.orig | ascii_downcase) == ($name | ascii_downcase))) ) as $exact
    | ( if ($exact | length) > 0 then $exact
        else ($scoped | map(select((.name | ascii_downcase | contains($name | ascii_downcase)) or (.orig | ascii_downcase | contains($name | ascii_downcase))))) end ) as $named
    | ( $named | map(select(.online)) ) as $online
    | ( if ($online | length) > 0 then $online else $named end ) as $avail
    | $avail
  '

  # #348: self は path 完全一致による best-effort 判定（正規化はサーバー側 decideCrossTarget が最終防衛）
  CANDIDATES=$(echo "$MEMBERS_BODY" | jq --arg self_path "$SELF_PATH" '[ .[] | {
    id: .memberProjectId,
    name: .memberProjectName,
    orig: (.memberProjectOriginalName // .memberProjectName),
    machine: .memberMachineName,
    online: (.memberMachineStatus == "online"),
    same: (.isSameMachine // false),
    path: (.memberProjectPath // ""),
    self: (($self_path | length) > 0 and ((.memberProjectPath // "") == $self_path))
  } ]')
  MATCHED=$(echo "$CANDIDATES" | jq --arg name "$PROJECT" --arg machine "$MACHINE" "$FILTER_JQ")
  MATCH_COUNT=$(echo "$MATCHED" | jq 'length')

  if [ "$MATCH_COUNT" = "0" ]; then
    echo "エラー: '$PROJECT' は対象として登録されていません"
    echo ""
    echo "読み取れる宛先:"
    echo "$CANDIDATES" | jq -r '.[] | "  - \\(.name) (\\(.machine)) [\\(if .online then "online" else "offline" end)]" + (if .self then " ⚠️ 自分自身（読み取り不可）" else "" end)'
    echo ""
    echo "この一覧に無いプロジェクトは読み取れません。WebUI の Team ページで登録するようユーザーに依頼してください。"
    exit 1
  fi

  if [ "$MATCH_COUNT" != "1" ]; then
    echo "エラー: '$PROJECT' に一致するプロジェクトが $MATCH_COUNT 件あります。対象を特定できません。"
    echo ""
    echo "候補:"
    echo "$MATCHED" | jq -r '.[] | "  - \\(.name) (\\(.machine)) [\\(if .online then "online" else "offline" end)]" + (if .self then " ⚠️ 自分自身（読み取り不可）" else "" end)'
    echo ""
    echo "--machine <マシン名> でマシンを指定して実行し直してください。"
    exit 1
  fi

  TARGET_ID=$(echo "$MATCHED" | jq -r '.[0].id')
  TARGET_NAME=$(echo "$MATCHED" | jq -r '.[0].name')
  TARGET_MACHINE=$(echo "$MATCHED" | jq -r '.[0].machine')

  echo "📜 $TARGET_NAME ($TARGET_MACHINE) の直近 $LIMIT 件を取得中..."
  echo ""

  # GET リクエスト（--get --data-urlencode でクエリパラメータを安全に構築）
  ROLE_ARG=()
  if [ -n "$ROLE" ]; then
    ROLE_ARG=(--data-urlencode "role=$ROLE")
  fi

  RESPONSE=$(curl -s -w "\\n%{http_code}" --max-time 60 \\
    -H "Authorization: Bearer $TOKEN" \\
    --get \\
    --data-urlencode "projectId=$TARGET_ID" \\
    --data-urlencode "limit=$LIMIT" \\
    "\${ROLE_ARG[@]}" \\
    "\${API_URL}/api/agent/messages" 2>&1) || {
    echo "エラー: 履歴取得に失敗しました（タイムアウトまたは接続エラー）"
    echo "$RESPONSE"
    exit 1
  }

  HTTP_CODE=$(echo "$RESPONSE" | tail -1)
  BODY=$(echo "$RESPONSE" | sed '$d')

  if [ "$HTTP_CODE" != "200" ]; then
    # #349: curl -f を外したことで BODY にサーバーのエラー詳細が入るようになった。jq 不在・非 JSON ボディでは生ボディにフォールバック
    DETAIL=$(printf '%s' "$BODY" | jq -r '.error // .message // empty' 2>/dev/null || true)
    if [ -n "$DETAIL" ]; then
      echo "エラー (HTTP $HTTP_CODE): $DETAIL"
    else
      echo "エラー (HTTP $HTTP_CODE): $BODY"
    fi
    exit 1
  fi

  echo "=== $TARGET_NAME の直近の会話履歴 ==="
  echo ""
  echo "$BODY" | jq -r '.messages[] | "[\\(.role)\\(if .model then " / " + .model else "" end)] \\(.createdAt)\\n\\(.content)\\n"'
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

RESPONSE=$(curl -s -w "\\n%{http_code}" \\
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

| テンプレート | 説明 | 対応OS |
|-------------|------|--------|
${scaffoldTemplateTableRows()}

**注意**: テンプレートには対応 OS 制限があります（例: \\\`xcode-swiftui\\\` は macOS マシンのみ）。対象マシンの OS に合わないテンプレートを指定するとサーバーがエラーを返します。一部テンプレートは対象マシンに CLI ツール（flutter / xcodegen 等）のインストールが必要です。

### パラメータ

- \\\`--machine\\\`: 対象マシン名（部分一致で検索）
- \\\`--name\\\`: プロジェクト名（英小文字で始まり、英小文字・数字・ハイフンで構成、3〜30文字）
- \\\`--template\\\`: テンプレート名（上記参照）

### 例

\\\`\\\`\\\`bash
bash ~/.claude/skills/devrelay-create-project/scripts/create.sh --machine yyyy --name mviewer-web --template vite-react-web
bash ~/.claude/skills/devrelay-create-project/scripts/create.sh --machine mac-mini --name my-app --template flutter-app
\\\`\\\`\\\`

### 注意事項
- 対象マシンのエージェントがオンラインである必要があります
- プロジェクト名は一意である必要があります
- 作成後、プロジェクトは自動的にインベントリに登録されます
- **Bash ツールの timeout を 360000（6分）に設定してください**（依存インストールやジェネレータに時間がかかる場合があります）
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
${scaffoldTemplateEchoLines()}
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

RESPONSE=$(printf '%s' "$JSON_BODY" | curl -s -w "\\n%{http_code}" --max-time 300 \\
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
 * flutter-deploy SKILL.md の内容を生成
 */
function generateFlutterDeploySkillMd(): string {
  return `---
name: devrelay-flutter-deploy
description: Flutterアプリを USB 接続された実機（iPhone/Android）にビルド＆インストールします。「SE3に入れて」「実機にデプロイして」「Androidに入れて」などデバイスへのアプリ配備依頼に使用します。
allowed-tools: Bash(bash ~/.claude/skills/devrelay-flutter-deploy/scripts/deploy.sh *)
---

## DevRelay Flutter 実機デプロイ

Flutter アプリを USB 接続された実機（iPhone / Android）にビルドしてインストールします。
flutter run（対話型）は使わず、build → install を非対話で実行します。

### デプロイ

\`\`\`bash
bash ~/.claude/skills/devrelay-flutter-deploy/scripts/deploy.sh --device <名前の一部> [--project <path>] [--debug] [--flavor X] [--dart-define K=V]
\`\`\`

- \`--device\`: デバイス名の一部（部分一致・大文字小文字無視。例: se3 → iPhoneSE3、pixel → Pixel 7）
- \`--project\`: Flutter プロジェクトのパス（省略時はカレントディレクトリ）
- \`--debug\`: debug ビルドでデプロイ（iOS 16 実機で release 起動不可の既知問題対応）
- \`--flavor\`: Flutter の flavor をパススルー
- \`--dart-define\`: dart-define をパススルー（複数指定可）

### 接続中の実機を一覧表示

\`\`\`bash
bash ~/.claude/skills/devrelay-flutter-deploy/scripts/deploy.sh --list
\`\`\`

### 例

\`\`\`bash
bash ~/.claude/skills/devrelay-flutter-deploy/scripts/deploy.sh --device se3 --project ~/development/mimamori
bash ~/.claude/skills/devrelay-flutter-deploy/scripts/deploy.sh --device pixel --debug
\`\`\`

### 対応 OS × ターゲット
- macOS: iPhone 実機（USB）/ Android 実機
- Windows / Linux: Android 実機（iOS 指定はエラー）

### 注意事項
- **USB 接続前提**です。デバイスをロック解除し、iOS は Developer Mode ON、Android は USB デバッグ許可が必要です。
- iOS ビルドは macOS でのみ可能です（Windows / Linux で iOS 実機を指定するとエラーになります）。
- ビルドは数分かかります。**Bash ツールの timeout を 900000（15分）に設定してください。**
- 失敗した場合はスクリプトが出力するビルドログ末尾をそのままユーザーに報告してください（署名エラー / pod install 失敗 / Gradle エラー等）。
`;
}

/**
 * deploy.sh スクリプトの内容を生成
 * flutter コマンドをローカル実行するだけのため serverUrl / token は不要
 */
function generateFlutterDeployScript(): string {
  return `#!/bin/bash
# DevRelay Flutter 実機デプロイスクリプト
# Agent が自動生成。手動編集は次回起動時に上書きされます。

set -euo pipefail

# --- flutter コマンド解決（PATH はマシンにより異なる） ---
FLUTTER=""
if command -v flutter &>/dev/null; then
  FLUTTER="$(command -v flutter)"
else
  for cand in "$HOME/development/flutter/bin/flutter" "$HOME/flutter/bin/flutter" "$HOME/fvm/default/bin/flutter" "/opt/flutter/bin/flutter"; do
    if [ -x "$cand" ]; then FLUTTER="$cand"; break; fi
  done
fi
if [ -z "$FLUTTER" ]; then
  echo "エラー: flutter コマンドが見つかりません。PATH または ~/development/flutter/bin を確認してください。"
  exit 1
fi

if ! command -v jq &>/dev/null; then
  echo "エラー: jq が必要です。"
  exit 1
fi

# --- 引数パース ---
DEVICE=""
PROJECT="."
MODE="release"
LIST_ONLY=""
FLAVOR=""
BUILD_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --device) DEVICE="$2"; shift 2 ;;
    --project) PROJECT="$2"; shift 2 ;;
    --debug) MODE="debug"; shift ;;
    --list) LIST_ONLY="1"; shift ;;
    --flavor) FLAVOR="$2"; BUILD_ARGS+=("--flavor" "$2"); shift 2 ;;
    --dart-define) BUILD_ARGS+=("--dart-define" "$2"); shift 2 ;;
    *) echo "不明な引数: $1"; exit 1 ;;
  esac
done

# --- デバイス列挙（実機のみ。エミュレータ・デスクトップ・Web を除外） ---
DEVICES_JSON=$("$FLUTTER" devices --machine 2>/dev/null || echo "[]")
REAL_DEVICES=$(echo "$DEVICES_JSON" | jq '[.[] | select(.emulator == false) | select((.targetPlatform // "") | test("^(ios|android)"))]')

if [ -n "$LIST_ONLY" ]; then
  COUNT=$(echo "$REAL_DEVICES" | jq 'length')
  if [ "$COUNT" = "0" ]; then
    echo "接続中の実機が見つかりません。"
    echo "USB ケーブル接続とロック解除（iOS は Developer Mode ON / Android は USB デバッグ許可）を確認してください。"
    exit 0
  fi
  echo "=== 接続中の実機 ($COUNT 台) ==="
  echo "$REAL_DEVICES" | jq -r '.[] | "  \\(.name) [\\(.targetPlatform)] id=\\(.id)"'
  exit 0
fi

# --- プロジェクト検証 ---
if [ ! -f "$PROJECT/pubspec.yaml" ]; then
  echo "エラー: '$PROJECT' は Flutter プロジェクトではありません（pubspec.yaml が見つかりません）。"
  exit 1
fi

if [ -z "$DEVICE" ]; then
  echo "エラー: --device <名前の一部> を指定してください。"
  echo "接続中の実機:"
  echo "$REAL_DEVICES" | jq -r '.[] | "  \\(.name) [\\(.targetPlatform)]"'
  exit 1
fi

# --- 部分一致でデバイス解決 ---
MATCHED=$(echo "$REAL_DEVICES" | jq --arg q "$DEVICE" '[.[] | select((.name | ascii_downcase | contains($q | ascii_downcase)) or (.id | ascii_downcase | contains($q | ascii_downcase)))]')
MATCH_COUNT=$(echo "$MATCHED" | jq 'length')

if [ "$MATCH_COUNT" = "0" ]; then
  echo "エラー: '$DEVICE' に一致する実機が見つかりません。"
  echo "USB ケーブル接続とロック解除（iOS は Developer Mode ON / Android は USB デバッグ許可）を確認してください。"
  ALL_COUNT=$(echo "$REAL_DEVICES" | jq 'length')
  if [ "$ALL_COUNT" != "0" ]; then
    echo "検出済みの実機:"
    echo "$REAL_DEVICES" | jq -r '.[] | "  \\(.name) [\\(.targetPlatform)]"'
  fi
  exit 1
fi

if [ "$MATCH_COUNT" -gt 1 ]; then
  echo "エラー: '$DEVICE' に複数の実機が一致しました。より具体的に指定してください:"
  echo "$MATCHED" | jq -r '.[] | "  \\(.name) [\\(.targetPlatform)] id=\\(.id)"'
  exit 1
fi

DEVICE_ID=$(echo "$MATCHED" | jq -r '.[0].id')
DEVICE_NAME=$(echo "$MATCHED" | jq -r '.[0].name')
TARGET=$(echo "$MATCHED" | jq -r '.[0].targetPlatform')
CONN=$(echo "$MATCHED" | jq -r '.[0].connectionInterface // ""')

# ワイヤレス警告（USB 接続を推奨）
if [ "$CONN" = "wireless" ]; then
  echo "⚠️ 警告: '$DEVICE_NAME' はワイヤレス接続です。検出・インストールが不安定な場合があります。USB 接続を推奨します。"
fi

# --- OS × ターゲット検証（iOS は macOS のみ） ---
OS_NAME="$(uname)"
IS_IOS=""
case "$TARGET" in
  ios) IS_IOS="1" ;;
esac

if [ -n "$IS_IOS" ] && [ "$OS_NAME" != "Darwin" ]; then
  echo "エラー: iOS ビルドは macOS でのみ実行できます（現在の OS: $OS_NAME）。Android 実機を指定してください。"
  exit 1
fi

# --- ビルド ---
cd "$PROJECT"
SECONDS=0
echo "🔨 ビルド中... (デバイス: $DEVICE_NAME [$TARGET], モード: $MODE)"

if [ -n "$IS_IOS" ]; then
  BUILD_TYPE="ios"
else
  BUILD_TYPE="apk"
fi

BUILD_LOG=$(mktemp)
if ! "$FLUTTER" build "$BUILD_TYPE" "--$MODE" \${BUILD_ARGS[@]+"\${BUILD_ARGS[@]}"} 2>&1 | tee "$BUILD_LOG"; then
  echo ""
  echo "❌ ビルド失敗。ログ末尾:"
  tail -n 80 "$BUILD_LOG"
  rm -f "$BUILD_LOG"
  exit 1
fi

# --- インストール ---
echo ""
echo "📲 インストール中... ($DEVICE_NAME)"
INSTALL_ARGS=()
if [ -n "$FLAVOR" ]; then INSTALL_ARGS+=("--flavor" "$FLAVOR"); fi
if ! "$FLUTTER" install "--$MODE" -d "$DEVICE_ID" \${INSTALL_ARGS[@]+"\${INSTALL_ARGS[@]}"} 2>&1 | tee -a "$BUILD_LOG"; then
  echo ""
  echo "❌ インストール失敗。ログ末尾:"
  tail -n 80 "$BUILD_LOG"
  rm -f "$BUILD_LOG"
  exit 1
fi

ELAPSED=$SECONDS
rm -f "$BUILD_LOG"

# --- 結果報告 ---
echo ""
echo "✅ デプロイ完了！"
echo "  デバイス: $DEVICE_NAME [$TARGET]"
echo "  モード: $MODE"
echo "  所要時間: $((ELAPSED / 60))分$((ELAPSED % 60))秒"
if [ -n "$IS_IOS" ]; then
  APP_PATH="build/ios/iphoneos/Runner.app"
  if [ -d "$APP_PATH" ]; then echo "  生成物: $(du -sh "$APP_PATH" | cut -f1) ($APP_PATH)"; fi
else
  APK=$(ls -1t build/app/outputs/flutter-apk/*.apk 2>/dev/null | head -1 || true)
  if [ -n "$APK" ]; then echo "  生成物: $(ls -lh "$APK" | awk '{print $5}') ($APK)"; fi
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

    // devrelay-read-messages スキル（他プロジェクトの会話履歴読み取り、#324）
    await fs.mkdir(READ_MSG_SCRIPTS_DIR, { recursive: true });

    const readMsgSkillMdPath = path.join(READ_MSG_SKILL_DIR, 'SKILL.md');
    await fs.writeFile(readMsgSkillMdPath, generateReadMessagesSkillMd(), 'utf-8');

    const readMsgShPath = path.join(READ_MSG_SCRIPTS_DIR, 'read.sh');
    await fs.writeFile(readMsgShPath, generateReadMessagesScript(config.serverUrl, config.token), {
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

    // devrelay-flutter-deploy スキル（flutter コマンドをローカル実行、サーバー API 不要）
    await fs.mkdir(FLUTTER_DEPLOY_SCRIPTS_DIR, { recursive: true });

    const flutterDeploySkillMdPath = path.join(FLUTTER_DEPLOY_SKILL_DIR, 'SKILL.md');
    await fs.writeFile(flutterDeploySkillMdPath, generateFlutterDeploySkillMd(), 'utf-8');

    const deployShPath = path.join(FLUTTER_DEPLOY_SCRIPTS_DIR, 'deploy.sh');
    await fs.writeFile(deployShPath, generateFlutterDeployScript(), {
      encoding: 'utf-8',
      mode: 0o755,
    });

    console.log('🔧 Claude Code skill files updated: ~/.claude/skills/devrelay-{docs,ask-member,read-messages,list-inventory,create-project,flutter-deploy}/');
  } catch (error: any) {
    console.error('Failed to create skill files:', error.message);
  }
}
