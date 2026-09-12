# 別紙: `murata1215/devrelay-plugins` の雛形（人間側で作成、DevRelay 外）

public リポとして作成（v1 の Agent は git 認証を持たない前提）。
これは **Claude adapter が使うマーケットプレイス**であり、DevRelay 全 provider 共通の仕様ではない。Codex / Devin を足すときに同じリポに provider 別 manifest を置くか別リポにするかは、その時点の各ツールの公式仕様を見て決める。

```
devrelay-plugins/
├── .claude-plugin/
│   └── marketplace.json      # 索引（これだけで動く）
├── plugins/                  # 自作・社内プラグインの本体だけ置く（外部品は参照のみ）
│   └── codegraph/            # 後日: pip → build → CLAUDE.md 追記を SessionStart hook に包む
└── README.md
```

`.claude-plugin/marketplace.json`（`name` は DevRelay 側の marketplaceName と一致させる）:

```json
{
  "name": "devrelay",
  "owner": { "name": "Keisuke Murata" },
  "plugins": [
    {
      "name": "commit-commands",
      "description": "E2E 用。公式リポの plugins/commit-commands を参照",
      "source": {
        "source": "git-subdir",
        "url": "https://github.com/anthropics/claude-code.git",
        "path": "plugins/commit-commands",
        "sha": "<40 文字の commit SHA>"
      }
    },
    {
      "name": "unity",
      "description": "Unity 公式プラグイン（参照のみ）",
      "source": { "source": "github", "repo": "<claude-plugins-official の unity エントリの source をそのまま転記>", "sha": "<固定したい commit>" }
    }
  ]
}
```

メモ:
- 外部プラグインは **参照 + `sha` 固定** で載せる。sha 固定 = DevRelay が承認したソース commit を固定する、の意味
- ただし Agent 側の更新判定は Claude Code の version resolution（plugin.json の `version` → marketplace entry の `version` → git commit SHA の優先順）に従うため、**SHA を変えただけで更新されるとは限らない**（上流 plugin.json の version が同じなら「更新なし」と判断され得る）。承認版を確実に上げたいときは marketplace entry の `version` も併せて上げる
- `source` の書式は `github`（`repo` / `ref` / `sha`）、サブディレクトリは `git-subdir`（`url` / `path` / `ref` / `sha`）。上流 marketplace.json のエントリを転記するのが確実（`anthropics/claude-plugins-official` の `.claude-plugin/marketplace.json` を参照）
- URL 直配信（`https://…/marketplace.json`）にはしない。相対パスのプラグインが入らないため
- リポ側の宣言例（案件専用・local スコープで入る）: `.claude/settings.json`
  ```json
  { "enabledPlugins": { "unity@devrelay": true } }
  ```
- 手動確認コマンド（ubuntu-prod/uso8m 等で）:
  `claude plugin marketplace add murata1215/devrelay-plugins` → `claude plugin list` → `claude plugin install commit-commands@devrelay --scope user`
