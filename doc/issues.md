# Issues

既知の未対応課題を記録する。実装はせず、発見時点の事実と対策案のみを残す
（実装した場合は `doc/changelog.md` / `doc/devlog/` へ移す）。

---

## exec ターン実行中の Agent 自己更新で AI 子プロセスが kill され、Session が active のまま固着する

- 発生日時: 2026-10-10 18:14 JST
- submission: `cmv250bf60a8byut2sxd9eona`
- 事実: exec ターン実行中（18:02 開始、コード生成進行中）に `server:agent:update`（Agent 自己更新）が走り、
  18:14:18 に Agent プロセスが再起動。これにより実行中だった AI 子プロセス（claude）が kill され、
  ターンが完了せず Session が `active` のまま固着した（人間が WebUI から終了させるまで残る）。
  中断時点の最後のツール実行ログは残るが、その成否（例: `pnpm build` の結果）は記録されない。
- 対策案:
  1. 実行中ターンがある間は Agent 自己更新を保留する（ターン完了後に更新を実行）
  2. または、自己更新で再起動する前に該当ターンの tracker を `failed` 確定させ、ユーザーに通知する
