#!/bin/bash
# =============================================================================
# DevRelay Testflight 事前準備スクリプト
#
# testflight コマンドを使用する前に一度だけ実行する。
# sudo 権限が必要。
#
# Usage:
#   sudo bash scripts/setup-testflight.sh
# =============================================================================

set -euo pipefail

echo "🚀 DevRelay Testflight 事前準備を開始します..."

# 1. Caddy sites.d ディレクトリ作成
echo ""
echo "📁 Caddy sites.d ディレクトリを作成中..."
if [ -d /etc/caddy/sites.d ]; then
  echo "   ✅ /etc/caddy/sites.d は既に存在します"
else
  mkdir -p /etc/caddy/sites.d
  echo "   ✅ /etc/caddy/sites.d を作成しました"
fi

# 2. Caddyfile に import 追加（まだなければ）
echo ""
echo "📝 Caddyfile に import ディレクティブを追加中..."
if grep -q 'import /etc/caddy/sites.d' /etc/caddy/Caddyfile 2>/dev/null; then
  echo "   ✅ import ディレクティブは既に存在します"
else
  echo "" >> /etc/caddy/Caddyfile
  echo "import /etc/caddy/sites.d/*" >> /etc/caddy/Caddyfile
  echo "   ✅ import ディレクティブを追加しました"
fi

# 3. sudoers ルール追加
echo ""
echo "🔐 sudoers ルールを設定中..."
cat > /etc/sudoers.d/devrelay-testflight << 'EOF'
# DevRelay Testflight: Caddy 設定管理
devrelay ALL=(root) NOPASSWD: /usr/bin/tee /etc/caddy/sites.d/*
devrelay ALL=(root) NOPASSWD: /bin/rm /etc/caddy/sites.d/*
devrelay ALL=(root) NOPASSWD: /bin/systemctl reload caddy

# DevRelay Testflight: PostgreSQL DB 管理
devrelay ALL=(postgres) NOPASSWD: /usr/bin/createdb *
devrelay ALL=(postgres) NOPASSWD: /usr/bin/createuser *
devrelay ALL=(postgres) NOPASSWD: /usr/bin/dropdb *
devrelay ALL=(postgres) NOPASSWD: /usr/bin/dropuser *
devrelay ALL=(postgres) NOPASSWD: /usr/bin/psql *
EOF
chmod 0440 /etc/sudoers.d/devrelay-testflight
echo "   ✅ /etc/sudoers.d/devrelay-testflight を作成しました"

# 4. sudoers ファイルの構文チェック
echo ""
echo "🔍 sudoers 構文チェック中..."
if visudo -cf /etc/sudoers.d/devrelay-testflight; then
  echo "   ✅ 構文チェック OK"
else
  echo "   ❌ sudoers 構文エラー。ファイルを確認してください。"
  exit 1
fi

# 5. testflight ベースディレクトリ作成
echo ""
echo "📁 testflight ベースディレクトリを作成中..."
if [ -d /home/devrelay/testflight ]; then
  echo "   ✅ /home/devrelay/testflight は既に存在します"
else
  mkdir -p /home/devrelay/testflight
  chown devrelay:devrelay /home/devrelay/testflight
  echo "   ✅ /home/devrelay/testflight を作成しました"
fi

# 5.5. /home/devrelay に実行権限を追加（Caddy がプレースホルダーファイルを読めるように）
echo ""
echo "🔓 /home/devrelay にディレクトリ通過権限を設定中..."
chmod o+x /home/devrelay
echo "   ✅ chmod o+x /home/devrelay（通過のみ許可、一覧表示は不可）"

# 6. Caddy リロード
echo ""
echo "🔄 Caddy をリロード中..."
systemctl reload caddy
echo "   ✅ Caddy リロード完了"

echo ""
echo "✅ セットアップ完了！"
echo ""
echo "これで testflight コマンドが使えます:"
echo "  testflight <name>      - 新規サービス作成"
echo "  testflight             - サービス一覧"
echo "  testflight info <name> - 詳細表示"
echo "  testflight rm <name>   - アーカイブ"
