# サイクル P3-A 承認時の確定事項 — Devin native skill 配布 adapter（`devin:skill`）

- 日付: 2026-09-15
- submission: `cmu19s7nb06lrkrskbuzv7xds`（devrelay core）
- Plan: `/home/devrelay/.claude/plans/floofy-giggling-pine.md`
- 本ファイルは Plan §10 の未決事項 5 件への回答と、exec 時に守る確定事項をまとめたもの。指示書（サイクル P3-A）と Plan に矛盾する箇所があれば本ファイルを優先する。

## Plan §10 未決事項への回答

| # | 未決事項 | 判断 | 理由 |
|---|---|---|---|
| 1 | `removed?: string[]` の型解禁の可否 | 追加する | 削除だけ観測不能なのは不自然。updated への相乗りは意味を壊す |
| 2 | ケース (c)（capabilityConfig 全体 null）での cleanup を有効にするか | 有効にする | Capability を全部 OFF にしたのに managed skill が残る方が危険 |
| 3 | skill-tree-io.ts の 20MB / 500 ファイル / 深さ 16 の上限値 | v1 暫定値として採用 | 十分余裕があり安全弁として有効。定数化して後で変更可能にする |
| 4 | Windsurf 同梱チャンネル（`~/.codeium/<channel>/skills/`） | v1 非対応のまま | スコープを広げない。env override 1 箇所で十分 |
| 5 | `probeDevinCapabilities()` の ai-runner.ts からの切り出し | P2 | 今回の feature と無関係なリファクタを混ぜない |

## 確定事項（exec で守ること）

Plan を承認します。以下を確定事項として実装してください。

1. `CapabilityResult` に `removed?: string[]` を追加する。
   削除を updated 等へ相乗りさせず、撤去結果を独立して観測可能にする。

2. capabilityConfig 全体が null の場合も cleanup を有効にする。
   ただし authoritative cleanup の条件は、
   `configDelivered === true && capabilityConfig === null`
   とすること。

   `configDelivered` は payload に `capabilityConfig` キー自体が存在したことを根拠にする。
   具体的には `server:connect:ack` / `server:config:update` の payload に `capabilityConfig` キーそのものが存在した場合のみ true。
   旧 server 等でフィールドが未配信の場合は false とし、cleanup してはいけない。

3. skill tree の安全上限は v1 では
   - aggregate size: 20MB
   - files: 500
   - depth: 16
   を採用する。
   定数化し単体テストすること。
   上限超過時は failed とし、既存 managed skill は last-known-good として保持する（取得・検証失敗と同じ扱い）。

4. Windsurf 同梱チャンネルへの複数配布は v1 非対応のままとする。
   `DEVRELAY_DEVIN_SKILLS_DIR` による単一 destination override のみ許可する。
   `providers.devin.skillsDir` は今回追加しない。

5. `probeDevinCapabilities()` の共通化・ai-runner.ts からの切り出しは P2 とする。
   今回は Plan 記載の locator で実装し、無関係なリファクタを混ぜない。

6. Devin CLI 未検出時の早期 return は active reconcile
   （install / update / present）のみに適用する。
   provider OFF / authoritative config=null の cleanup は filesystem 操作だけで
   実行可能なので、managed state があれば CLI 不在でも撤去する。

7. `sourceCommit` は provenance として marker に保持してよいが、
   marketplace repository の HEAD SHA の変化だけを理由に updated としない。
   更新判定は plugin.json version → marketplace entry version →
   対象 skill / plugin subtree の content hash を使用する。

8. marketplace clone / fetch / manifest 解析失敗、tree 検証失敗時は
   desired state を確定できなかったものとして撤去しない。
   last-known-good を保持して failed を報告する。

9. unmanaged の同名 skill directory は上書きも削除もしない。
   conflict / failed として報告する。

10. D1〜D4（Agent 側）を先に実装・検証し、D5（web UI）は最後にする。
    旧 Agent に Devin provider を送って unsupported-provider にしない順序を守る。

11. 完了時:
    - 全テスト / build
    - `doc/devrelay_capability_spec_v2.md` を必要に応じ v2.2 へ更新
    - `doc/devlog/YYYY-MM-DD_HHMMSS.md` を新規 1 ファイル（`TZ=Asia/Tokyo` で採番）
    - `doc/devlog/INDEX.md` の末尾に 1 行
    - 本ファイルを含めて commit / push
    - 人間側作業（`u` 対象機、pnpm build、pm2 restart 要否）を明記
