# Devin CLI ガードレール サイクル1: 純関数エンジン実装 + Phase 0 手順書（2026-11-05）

ユーザー要望（Discord/Telegram経由のチャット）「Devin CLI にガードレールを作りたい。`rm` を実行禁止もしくは承認制にしたい。特定の IP レンジ（本番系）を参照不可にしたい」への対応サイクル。

調査の全文は `doc/devin_gate_investigation.md`（サイクル D0, 2026-09-17）を参照。本ドキュメントはその続き。

## 本サイクルで実施したこと（コード変更・テスト済み）

### 1. `git-guard-core.ts` の潜在バグ修正（3 OS: `agents/{linux,macos,windows}`）

`GUARD_EXCLUDED_PATTERN` に `.devin` を追加した。Devin CLI 自身のセッション状態・設定ディレクトリ（`.devin/`）が除外対象に無かったため、plan ターン終了時に未追跡の `.devin/` 配下が `.devrelay/reverted/` へ quarantine されるリスクがあった（Devin 自身の管理領域を DevRelay が巻き戻す必要は無い）。

- 変更前: `/(^|\/)(\.git|\.devrelay|\.devrelay-output)(\/|$)/`
- 変更後: `/(^|\/)(\.git|\.devrelay|\.devrelay-output|\.devin)(\/|$)/`

テスト追加（`agents/{linux,macos}/tests/git-guard-core.test.mjs`）: `.devin/config.json` / `.devin/hooks.v1.json` が除外されることを確認。

**挙動変更ゼロで安全**: 既存の除外対象を狭めるのではなく広げるだけ。独立した小さな修正であり、他の Phase とは無関係に効く。

### 2. 新規純関数モジュール `devin-guard-rules.ts`（3 OS byte-for-byte 同一・**未配線**）

`agents/{linux,macos,windows}/src/services/devin-guard-rules.ts` を新設。Devin の `permissions`（`Exec()`/`Read()`/`Write()`/`Fetch()`）deny-only ルールを安全に組み立てる純関数群（外部 import ゼロ、`devin-diagnostics.ts` 等と同じ流儀）。

**重要: このモジュールは `ai-runner.ts` の devin spawn 分岐に一切接続されていない。** 現在の Devin 起動挙動は 1 バイトも変わっていない。理由は後述の「まだ実施できないこと」。

提供する関数:

| 関数 | 用途 |
|---|---|
| `isValidDevinPermissionRule(rule)` | ルール文字列の構造検証。`Exec()` 内の glob（`*`/`?`/`[]`）を拒否（公式ドキュメント実測で `Exec(**)` が無効ルールと判明済みのため）。`Read()`/`Write()`/`Fetch()` は glob 許可 |
| `buildDevinGuardOrgPolicy(ruleSet)` | **Devin 組織ダッシュボード**（Terminal Permissions）に貼り付ける `{deny, ask:[], allow:[]}` を生成。`ask`/`allow` は常に空配列（`-p` 非対話では `ask` が無音 exit 0 になるため。allow-list の罠を再発させないため） |
| `buildDevinAgentConfig(ruleSet)` | （**将来の Phase 2 用・未配線**）`--agent-config` に渡す `{permissions:{deny}}` を生成。`allow`/`ask` キーを型レベルで持たない |

プリセット定数:
- `DEVIN_GUARD_IRREVERSIBLE_EXEC_PREFIXES`: `dd`/`mkfs`/`shred`/`sudo`/`doas`/`git push`/`git reset --hard`/`git clean`/`pm2 delete`/`pm2 restart`/`systemctl stop|restart|disable`/`docker rm|rmi|stop`/`shutdown`/`reboot`
- `DEVIN_GUARD_SECRET_READ_GLOBS`: `~/.ssh/**`, `**/.env*`, `**/credentials*`
- `DEVIN_GUARD_SECRET_WRITE_GLOBS`: `/etc/**`, `~/.ssh/**`, `**/.env*`

**`rm` は意図的に含めていない。** `Exec(rm)` は「プロジェクト外のみ禁止」のような条件付き表現ができず、全面禁止にすると `rm -rf node_modules` 等の正常作業まで止まる（#362〜#368 のモグラ叩きの再演）。`rm` の扱いはユーザー判断事項（本ドキュメント末尾）。

テスト: `agents/{linux,macos}/tests/devin-guard-rules.test.mjs`（26 ケース）。`pnpm build` 6 workspace green、`node --test` で linux 1275/1275・macos 757/757（既存含む）非退行確認、3 OS 間 byte-for-byte 同一性を `diff` で確認。

## 今すぐ使える成果物: Devin 組織ダッシュボードに貼り付ける JSON

上記モジュールをビルドして実際に実行し生成した JSON（コードとドキュメントの drift を防ぐため、手で書かず生成した値をそのまま記録）:

```json
{
  "deny": [
    "Exec(dd)",
    "Exec(mkfs)",
    "Exec(shred)",
    "Exec(sudo)",
    "Exec(doas)",
    "Exec(git push)",
    "Exec(git reset --hard)",
    "Exec(git clean)",
    "Exec(pm2 delete)",
    "Exec(pm2 restart)",
    "Exec(systemctl stop)",
    "Exec(systemctl restart)",
    "Exec(systemctl disable)",
    "Exec(docker rm)",
    "Exec(docker rmi)",
    "Exec(docker stop)",
    "Exec(shutdown)",
    "Exec(reboot)",
    "Read(~/.ssh/**)",
    "Read(**/.env*)",
    "Read(**/credentials*)",
    "Write(/etc/**)",
    "Write(~/.ssh/**)",
    "Write(**/.env*)"
  ],
  "ask": [],
  "allow": []
}
```

**貼り付け先**: `app.devin.ai/org/<orgName>/settings/desktop` の Terminal Permissions。**DevRelay のコード変更ゼロ**で即日効く（公式ドキュメント上、組織設定の deny は permission mode からも上書き不可と明文化されている唯一の層）。

⚠️ **注意**: 組織設定は**その組織の全メンバー・全マシンに適用される**。DB 実測で Devin は 17 マシン / 36 プロジェクトに入っており、大半が他の方の実案件（`Lafit`・`SalesForce`・`intra-mart`・`MEBIUS` 等）。上記リストは意図的に「調査系コマンド（`git log`/`git status`/`ls`/`grep`等）を一切塞がない」よう絞っているが、登録前に他メンバーへの周知を推奨する。

## まだ実施できないこと（Phase 0: 実機検証が必須）

以下は実機でしか確定できないため、本サイクルでは**コードを書かず検証のみ**にスコープを絞った（DevRelay の「証拠なしに直すと外す」#345 の教訓に従う）。

### なぜこのセッションから直接検証できないか
1. 対象機は Windows（`DESKTOP-Q43QT7L/fwjg2`、プロジェクト `TestClock`）で、このサーバー（`ubuntu-prod/devrelay`）から直接操作できない。
2. `TestClock` は DevRelay の Team ページに**未登録**のため、`devrelay-ask-member` スキル経由でも指示を送れない（登録済みは `chrome-bookmark-flutter` / `googlephoto` / `pixblog-flutter-windows` / `mimamori-flutter` のみ）。

### P0-0. Devin CLI の最新化（ユーザー判断・方針確定済み）
実機は `2026.8.18`（hooks 無し）。最新安定版は `3000.11.234`（`3000.11.205` で hooks 強化が入っている）。**`TestClock` 1 台のみ更新**し、他 16 マシンには展開しない（実案件保護）。

```powershell
# 更新前の記録
devin --version
devin --help > "$env:USERPROFILE\devin-help-before.txt"
Copy-Item "$env:APPDATA\devin\config.json" "$env:APPDATA\devin\config.json.pre-update" -Force

devin update --help      # 先に read-only で読む
devin update              # 実行

# 更新後の確認
devin --version
devin --help > "$env:USERPROFILE\devin-help-after.txt"
devin --help | Select-String -Pattern '--config|--agent-config|--permission-mode|--prompt-file|--export|--respect-workspace-trust|--model|--sandbox|--print|--resume'
devin --help | Select-String -Pattern 'hook'
devin sandbox --help
Get-Content "$env:APPDATA\devin\config.json"
Compare-Object (Get-Content "$env:USERPROFILE\devin-help-before.txt") (Get-Content "$env:USERPROFILE\devin-help-after.txt")
```

### P0-1〜P0-9. フラグ構成・deny の実効性・hooks の実在等
`doc/devin_gate_investigation.md` の Q5 手順（カナリア方式）を使う。詳細は会話ログに記録済み。要点:
- `--permission-mode dangerous` が user/project レベルの `permissions.deny` を上書きするか（**最重要・未決**）
- `Exec()` のマッチ境界（トークンか生文字列か）
- hooks（`PreToolUse`/`PermissionRequest`）が実在するか
- `--agent-config` の strict parsing で受理される最小スキーマ

これらが判明した時点で、`buildDevinAgentConfig()` を `ai-runner.ts` の devin spawn 分岐（`agents/linux/src/services/ai-runner.ts:2316` 付近）へ配線する Phase 2、または hooks 経由の Phase 3 に進む。

## ユーザー判断が必要な残課題

1. **`rm` の扱い**: (1) 全面禁止／(2) 破滅的なものだけ限定列挙／(3) hooks 対応後にパス条件つき
2. **「承認制」をどこまで求めるか**: (a) 禁止のみ／(b) 非同期ワンショット昇格（`allow rm` で次ターン許可）／(c) `devin update` して hooks 経由で同期承認
3. **本番 IP レンジの具体的な CIDR と、何経由のアクセスを止めたいか**
4. **OS レベル firewall をスコープに含めるか**（CIDR 単位の確実な遮断はこれしかない）
5. **ガードレールの適用範囲**: Devin だけか Gemini も対象にするか
6. **`TestClock` の Phase 0 検証をどう実施するか**: ユーザー自身が実機で実行する、または `TestClock` を Team ページに登録して `devrelay-ask-member` 経由で依頼する
