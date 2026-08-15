# Agent 二重起動による無応答障害レポート（2026-08-14）

## 概要

同一 `machineId` の Agent が最大 4 プロセス同時稼働し、サーバーの「新接続時に旧 WebSocket を切断する」仕様と噛み合って
**約 1Hz の相互キック無限再接続ループ**が発生。AI の応答は生成されていたにもかかわらず、
配信先の WebSocket が常に閉じかけているため**ユーザーに届かず消失**していた（DevRelay 上の症状は「無応答」＋「AI 側の異常/タイムアウト」表示）。
副次症状としてログが急増した。

| 項目 | 値 |
|------|-----|
| 発生時刻 | 2026-08-14 15:58 JST（pm2 への Agent 重複登録） |
| 悪化時刻 | 同 16:07 / 20:01 JST（自動更新が起動するたびに重複が増加） |
| 検知時刻 | 同 20:02 JST（ユーザーが「無応答が多い、agent.log が急増している」と報告） |
| 復旧完了 | 同 20:11 JST（Agent 再起動） |
| データ損失 | ループ中に配信されなかった AI 応答（DB 未保存分）。会話履歴・DB 本体は無事 |
| サービス停止 | なし（ただしループ中は応答が届かない状態が断続的に継続） |

## 発生事象

ユーザーから「DevRelay の応答が無い事象が結構出ている。DevRelay 上では AI 側の異常＋タイムアウト要因と言っているが、
最近の修正が影響していると思う。`agent.log` がかなりの勢いで増えている」と報告。実態は以下：

- `~/.pm2/logs/devrelay-server-out.log` が **992MB** まで肥大（3 月以降ローテーションされず蓄積）
- `~/.devrelay/logs/agent.log` が **約 2.6MB/時**で増加中
- `agent.log` の末尾が「接続 → 認証 → プロジェクトスキャン → version-check → 切断 → 0.6〜0.9 秒後に再接続」を延々と反復
- サーバー側ログも同期して `New agent connection attempt` / `Closing stale WebSocket` / `Agent disconnected` を反復

直近 20 万行における出現回数：

| ログ行 | 回数 |
|--------|------|
| `🔌 New agent connection attempt` | 17,694 |
| `🔌 Closing stale WebSocket for <ID> before new connection` | 17,650 |
| `📤 sendToAgent FAILED: type=..., ws=true, readyState=3` | **1,792** |
| `⚠️ No tracker found for session <ID>` | **219** |

下 2 つが「無応答」の直接証拠。`readyState=3`（CLOSED）は**サーバーが閉じ済みソケットに送信して失敗**した記録であり、
`No tracker found` は**AI 出力は届いているのに対応するトラッカーが別接続側にあって破棄された**記録である。

## タイムライン

| 時刻 (JST) | 出来事 |
|------------|--------|
| 2026-03-19 05:47 | `agents/linux/dist/` の最終ビルド。**これ以降ビルドが失敗し続けていた**（後述） |
| 2026-08-09 15:13 | crontab `@reboot` により Agent 起動（PID 900）。以後この 3 月ビルドのコードで稼働 |
| 2026-08-14 15:58 | `/opt/devrelay/agents/linux` を pm2 `devrelay-agent` として登録（PID 379039）→ **重複 #1** |
| 同 16:07 | 自動更新スクリプトが実行され、旧プロセスを kill できないまま新プロセス起動（PID 380225）→ **重複 #2** |
| 同 18:01 | リモートに `3d6a6ee`（#297/#299）が push される |
| 同 20:01 | bake time 120 分が明けて自動更新が再実行 → **重複 #3**（PID 608452）。計 4 プロセスに |
| 同 20:02 | 調査開始 |
| 同 20:04 | pm2 `devrelay-agent` を stop + delete + save |
| 同 20:05 | 自動更新が生んだ重複 2 プロセスを kill → **ループ停止を実測で確認** |
| 同 20:06 | ログを gzip で退避 |
| 同 20:07 | pm2-logrotate 導入・設定 |
| 同 20:08 | `pm2 flush devrelay-server`（992MB → 0） |
| 同 20:09〜20:10 | `pnpm install` 修復 → shared / agent ビルド成功（dist が 5 ヶ月ぶりに更新） |
| 同 20:11 | Agent 本体を再起動（PID 611310）。修正済みコード `3d6a6ee` を読み込み |

## 根本原因

### 1. 自動更新スクリプトの kill 失敗（主因）

稼働中だった旧 Agent（`13c7446` 時点のコード）が生成する更新スクリプトは以下の形だった：

```bash
export PATH="..." && cd "/home/devrelay/.devrelay/agent" \
  && git fetch origin && git reset --hard origin/main \
  && pnpm install --frozen-lockfile --ignore-scripts 2>&1 || true \
  && pnpm --filter @devrelay/shared build 2>&1 \
  && pnpm --filter @devrelay/agent build 2>&1 \
  && sleep 2 \
  && pgrep -u $(whoami) -f "\.devrelay.*index\.js" | xargs kill 2>/dev/null || true; \
  sleep 1; cd .../dist && nohup node .../index.js < /dev/null > .../agent.log 2>&1 &
```

欠陥が 2 つある。

**(a) `pgrep` が自分自身にマッチする**

`spawn('bash', ['-c', script])` で起動されるため、この bash プロセスの cmdline に
`.devrelay` と `index.js` の両方が含まれる。実測した結果：

```
$ pgrep -u devrelay -f "\.devrelay.*index\.js"
843     ← cron の sh -c ラッパー
900     ← 本来 kill したい Agent
380224  ← 更新スクリプト自身の bash    ★自分
380225  ← 更新スクリプトが起動した Agent
608451  ← もう 1 本の更新スクリプトの bash ★自分
608452  ← そのスクリプトが起動した Agent
```

`xargs kill` に自 PID が混ざるため、kill の途中でスクリプト自身が死ぬ。

**(b) kill は `&&` 連鎖・起動は `;` 連鎖**

`... && sleep 2 && pgrep ... | xargs kill || true; sleep 1; ... nohup ... &` という構造のため、
**ビルドが失敗すると `&&` の短絡で kill 部分だけがスキップされ、`;` 以降の新プロセス起動は必ず実行される**。
結果、更新のたびに Agent が 1 つずつ増える。

### 2. ビルドが 5 ヶ月間失敗し続けていた（増悪要因）

`~/.devrelay/agent` の `dist/` は **2026-03-19 ビルドのまま**だった一方、git のソースは `3d6a6ee`（8/14）に更新済みだった。
原因は `node_modules` の欠落。調査時点で以下が存在しなかった：

- `@xterm/headless`
- `@homebridge/node-pty-prebuilt-multiarch`

このため `tsc` が `Cannot find module` および `@devrelay/shared has no exported member ...`（shared の dist も 3 月のまま）で失敗し、
上記 (b) の経路に毎回はまっていた。復旧時に `pnpm install --frozen-lockfile --ignore-scripts` を実行したところ
**365 パッケージが追加され（`Packages: +368 -7`）5 秒で成功**したため、恒久的な依存問題ではなく
`node_modules` が欠けた状態のまま放置されていたと判断される。

### 3. pm2 への重複登録（引き金）

この機体の Agent は **crontab `@reboot` による nohup 起動**が正であり、pm2 で管理しているのは `devrelay-server` のみ。
15:58 に `/opt/devrelay/agents/linux/dist/index.js`（＝開発リポジトリ側）を pm2 `devrelay-agent` として登録したことで、
同一 `machineId` を名乗る 2 系統目が生まれた。

### 4. なぜ「無応答」になるのか

`apps/server/src/services/agent-manager.ts:316`：

```ts
console.log(`🔌 Closing stale WebSocket for ${machine.id} before new connection`);
```

サーバーは同一 machineId の新接続を受けると旧 WebSocket を切断する。
切断された側の Agent は 0.6〜0.9 秒後に再接続する。これが双方向に起きるため無限ループになる。
この状態では、

1. セッション開始時のトラッカーは接続 A 側に紐づく
2. AI 出力が届く頃には接続 A は切断済みで、現在の接続は B
3. `sendToAgent` は `readyState=3` で失敗、または `No tracker found` で出力が破棄される

つまり **AI は応答を返しているのに、サーバー内で行き先を失って捨てられる**。
DevRelay が表示していた「AI 側の異常＋タイムアウト」は結果であって原因ではなかった。

## 影響範囲

| 対象 | 影響 |
|------|------|
| `x220-158-18-103/devrelay` の Agent 応答 | **断続的に消失**（15:58〜20:05、特に 16:07 以降） |
| ログ | `devrelay-server-out.log` 992MB / `agent.log` 約 2.6MB 毎時。ディスクは 145G 中 50G 使用で逼迫はせず |
| DB・会話履歴 | 無事（配信されなかった応答は DB 未保存のため復元不可） |
| 他ユーザーの Agent | **影響なし**。`pixblog` / `keisuke` / `wprewriter` / `uso8m` / `pixwriter` / `ribbon` は各 1 プロセスで重複なしを確認 |
| `devrelay-server` 本体 | プロセスは正常稼働。ループ由来の負荷とログ出力のみ |

## 復旧手順（実施済み）

```bash
# 1. pm2 側の重複を除去
pm2 stop devrelay-agent && pm2 delete devrelay-agent && pm2 save

# 2. 自動更新が生んだ重複プロセスを停止（cron 起動の正規プロセスは残す）
kill 608452 380225

# 3. ログを退避（~/.devrelay/logs/archive/ に gzip 保存）
tail -n 300000 ~/.pm2/logs/devrelay-server-out.log | gzip > ~/.devrelay/logs/archive/server-out-20260814-tail300k.log.gz

# 4. ログローテーション導入
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 50M
pm2 set pm2-logrotate:retain 7
pm2 set pm2-logrotate:compress true
pm2 set pm2-logrotate:rotateInterval '0 0 * * *'
pm2 set pm2-logrotate:workerInterval 60
pm2 flush devrelay-server

# 5. ビルド修復
cd ~/.devrelay/agent
export PATH="$HOME/.devrelay/node/bin:$PATH"
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter @devrelay/shared build
pnpm --filter @devrelay/agent build

# 6. Agent を修正済みコードで再起動
kill 900
cd ~/.devrelay/agent/agents/linux/dist
nohup ~/.nvm/versions/node/v20.20.0/bin/node \
  ~/.devrelay/agent/agents/linux/dist/index.js < /dev/null >> ~/.devrelay/logs/agent.log 2>&1 & disown
```

## 復旧の検証結果

| 指標 | 対処前 | 対処後 |
|------|--------|--------|
| `agent.log` 増加量 | 約 45,600 bytes / 60 秒 | **122 bytes / 60 秒**（約 370 分の 1） |
| `devrelay-server-out.log` 増加量 | 約 69,000 bytes / 60 秒 | 8,681 bytes / 60 秒（他マシン分を含む通常量） |
| `Closing stale WebSocket` | 17,650 回 / 20 万行 | **0 回** |
| `sendToAgent FAILED` | 1,792 回 / 20 万行 | **0 回** |
| `No tracker found for session` | 219 回 / 20 万行 | **0 回** |
| 稼働 Agent プロセス数 | 4 | **1**（PID 611310） |
| `dist/services/connection.js` | 2026-03-19 ビルド | 2026-08-14 20:10 ビルド（`3d6a6ee`） |

再起動後の `agent.log` に `(defaultAi=claude)` や 5 種のスキル生成ログが現れたことで、
実際に新しいコードが読み込まれたことを確認済み（旧プロセスでは `devrelay-docs/` のみだった）。

## 再発防止

### コード側：修正は既に入っている

**(a) と (b) の両方は `3d6a6ee`（#297）で修正済み**だった。`agents/linux/src/services/connection.ts:2341-2361`：

```ts
// nohup の場合: restartCmd.command をそのまま使うと、bash -c の cmdline に
// .devrelay.*index.js が含まれ、pgrep が自身の bash プロセスもマッチして
// スクリプトが自殺する。専用リスタートコマンドを構築して $$ で自 PID を除外する。
'{ pgrep -u $(whoami) -f "\\.devrelay.*index\\.js"; pgrep -u $(whoami) -fx "node index\\.js"; } 2>/dev/null | sort -u | grep -v "^$$\\$" | xargs kill 2>/dev/null || true',
// ...
// ビルド成否に関わらず、必ずリスタートを実行
const script = `${buildSteps}; ${log('restarting...')}; sleep 2; ${actualRestartCmd}`;
```

**しかし修正コードは Agent 自身が生成するため、Agent が新しい dist で再起動するまで効かない。**
今回はビルドが 5 ヶ月失敗していたため修正が永久に適用されない状態だった。この
「**自己更新機構のバグは、自己更新では直せない**」という構造が今回の本質。

### 運用側

1. **この機体の Agent を pm2 に登録しない**。正は crontab `@reboot` の nohup 起動。
   `CLAUDE.md` の再起動案内から `devrelay-agent` を除外済み。
2. **二重起動の判定コマンド**を定着させる。node プロセスが 2 つ以上あれば重複：
   ```bash
   pgrep -u $(whoami) -af "\.devrelay.*index\.js" | grep -v "bash -c"
   ```
3. **ログ増加量を異常検知の指標にする**。正常時の目安は
   `devrelay-server-out.log` が約 8KB/分、`agent.log` が約 2KB/分。桁が違えば異常。
4. **pm2-logrotate 導入済み**（50M / 7 世代 / 圧縮 / 日次）。992MB のような肥大は再発しない。

### 未対処の課題

| # | 課題 | 内容 |
|---|------|------|
| 1 | stale dist を検知できない | `auto-updater.ts:165` の `runningCodeStale` は Agent が報告する任意フィールド。**古い Agent は送ってこないため `undefined` となり、`!runningCodeStale` が真になって「成功」と誤判定される**。今回 3 月ビルドで動き続けた機体が 5 ヶ月間検知されなかった直接の理由。古い Agent は `unknown` として扱い、少なくとも WebUI に警告を出すべき |
| 2 | バージョン表示が git rev のみ | サーバーには `local=13c7446`（8/14）と報告されていたが、実際に動いていたのは 3 月ビルド。`Machine` に**実行中コードのビルド時刻**も保存し、`localCommit` との乖離を可視化する（`runningCodeMtime` は既に version-check で送られている） |
| 3 | 更新スクリプトのログが残らない | `~/.devrelay/logs/` に `update.log` が存在しなかった。ビルド失敗が 5 ヶ月間サイレントだった一因。`runAndLog` の出力先を確実にファイルへ残す |
| 4 | DB の状態が `pending` のまま | 本レポート作成時点で `Machine.lastAutoUpdateStatus='pending'` / `autoUpdateAttempts=1` / `localCommit=13c7446`。次回 version-check で `reconcileLastAttempt` が `success` に落とすはずだが、要確認 |

## 参考

- 関連セクション: `rules/project.md` の「nohup Agent の restart コマンド」「Agent 自動更新（サーバー主導）(#296)」
- 関連 issue: #256（stale dist 無限再起動の抑止）、#296（自動更新）、#297（ロールアウト停滞の修正）
- 退避ログ: `~/.devrelay/logs/archive/server-out-20260814-tail300k.log.gz` ほか
