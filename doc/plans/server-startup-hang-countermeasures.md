# サーバー起動ハング対策 仕様検討

- 作成日: 2026-10-18
- ステータス: **対策A 実装済み**（2026-10-18。D/B/C は未実施。実装記録は `doc/server_listen_hang_20261018.md`）

## 1. 事象

2026-10-18 02:46 頃のマシン再起動後、`devrelay-server` が応答しなくなった。09:12 に手動で `pm2 restart` するまで、約 6.5 時間止まっていた。

- pm2 上は `online`。プロセスは生きていたが、ポート 3005 で待ち受けていなかった
- `https://app.devrelay.io/ws/agent` が 502 を返していた（Caddy → 3005 に繋がらない）
- 各 Agent は再接続に 30 回失敗し（約 15 分）、`Max reconnect attempts (30) reached. Giving up.` で再接続をやめていた
  → サーバーを復旧しても Agent は戻らず、マシンごとに手動で再起動する必要があった

## 2. 原因

### 2.1 サーバーが listen しなかった理由

`apps/server/src/index.ts` の起動処理は、外部サービスへの接続を **`app.listen()` より前に await している**。

```ts
// index.ts:229
await setupDiscordBot(discordToken);   // 内部で await client.login()（platforms/discord.ts:281）
...
// index.ts:237
await setupTelegramBot(telegramToken); // 内部で await bot.getMe()（platforms/telegram.ts:75）
...
// index.ts:251
await app.listen({ port: PORT, host: HOST });
```

再起動直後はまだ外部ネットワークに出られず、`discord.com:443` への接続がタイムアウトした（`UND_ERR_CONNECT_TIMEOUT`）。その後 `client.login()` から処理が戻らず、`app.listen()` まで進まなかった。

ログの最終行は `🔐 Discord tool approval interaction handler registered`（discord.ts:666、`client.login()` の直前）で止まっており、`🤖 Discord bot logged in` は出ていない。再起動後は即座にログインが成功し、待ち受けも始まった。

### 2.2 DB は原因ではない

- `postgresql@16-main` の起動は 02:46:57、`pm2-devrelay` は 02:47:03 で、DB の方が先に起動していた
- error.log の Prisma エラー（P1017 / P1001）は、再起動前のシャットダウン時に出たもの

### 2.3 影響範囲

マシン再起動時に限らず、**Discord / Telegram の API に繋がらないだけで DevRelay 本体（Web UI・Agent 接続・API）が全部止まる**。Discord 側の障害でも同じことが起きうる。

## 3. 対策

| # | 内容 | 位置付け | 優先度 |
|---|---|---|---|
| A | bot の起動を `listen()` の後ろに回し、待たずに実行してリトライさせる | 根本対策 | **高** |
| D | Agent の再接続を回数制限なしにする | 復旧の自動化 | **高** |
| B | systemd unit に起動順序を追加する | 保険 | 中 |
| C | 外部から /health を監視して自動で再起動する | 保険 | 低 |

### A. 外部 bot の起動を非ブロッキングにする（サーバー）

**方針**: 外部サービスに繋がるかどうかで、サーバー本体の起動が左右されないようにする。

1. `app.listen()` を Discord / Telegram bot の起動より **前** に移す
   - heartbeat monitor・session cleanup などの内部処理は、今の順序のままでよい
2. bot の起動は `await` しない。バックグラウンドのタスクとして動かす
   ```ts
   startBotWithRetry('discord', () => setupDiscordBot(discordToken));
   startBotWithRetry('telegram', () => setupTelegramBot(telegramToken));
   ```
3. `startBotWithRetry` の仕様
   - 1 回の試行に **タイムアウト（例: 30 秒）** を付ける（`Promise.race`）。discord.js の `login()` が戻ってこないケースへの対策
   - 失敗やタイムアウトのときは、間隔を伸ばしながらリトライする（例: 10 秒 → 20 秒 → … 最大 5 分）。**回数の上限は設けない**
   - タイムアウトしたら、`client.destroy()` で前回の client を破棄してから作り直す。二重ログインや、ハンドラが二重に登録されるのを防ぐため
     - `setupDiscordBot()` はイベントハンドラの登録と `login()` を一緒に行っている。リトライできるように、client の生成・ハンドラ登録・ログインを 1 つの「作り直し可能な単位」にまとめる必要がある
   - 状態を `connecting / ready / failed(lastError)` として保持し、ログに出す
4. bot がまだ準備できていない間に送信されたときの扱い
   - `sendDiscordMessage()` などは、今も `if (!client)` でガードしている。準備中は警告ログを出して捨てる（または失敗を返す）。キューイングは今回はやらない
5. `/health` のレスポンスに bot の状態を任意項目として追加する（監視用）。**bot が準備できていなくても HTTP は 200 を返す**
   ```json
   { "status": "ok", "timestamp": "...", "bots": { "discord": "ready", "telegram": "disabled" } }
   ```

**受け入れ条件**
- `discord.com` に繋がらない状態（例: hosts で 127.0.0.1 に向ける）でサーバーを起動しても、3005 で待ち受けが始まり、Web UI と Agent 接続が使えること
- ネットワークが戻ったら、手作業なしで Discord bot がログインすること
- Discord が使えるようになった後も、メッセージハンドラが二重に動かないこと（1 メッセージに返信が 1 回だけ）

### D. Agent の再接続を回数制限なしにする（Agent: linux / macos / windows）

**今の仕様**: `packages/shared/src/constants.ts` の `DEFAULTS.reconnect`
- baseDelay 2 秒、maxDelay 30 秒、**maxAttempts 30**、jitter 0〜1 秒
- 約 15 分で再接続をやめ、その後は手動で再起動するまで復帰しない

**変更内容**
1. `maxAttempts` で再接続を打ち切るのをやめる（3 つの OS の `connection.ts` の `scheduleReconnect()`）
   - linux: `agents/linux/src/services/connection.ts:2251`
   - macos: `agents/macos/src/services/connection.ts:2180`
   - windows: `agents/windows/src/services/connection.ts:1242`
2. 長時間止まる場合に備えて、間隔の上限を 2 段階にする
   - 30 回目までは今と同じ（最大 30 秒間隔）
   - それ以降は **5 分間隔** にする。数百台の Agent が同時に再接続するのを、jitter（例: 0〜30 秒）で分散させる
3. ログ: 30 回目を超えたら、毎回ではなく 10 回に 1 回だけ出す（agent.log が増えすぎないように）
4. `protocolUpdateRequired` のときに再接続しない動作は **今のまま**（バージョン不足で拒否されたときは、リトライしても意味がない）
5. 401 / 403 など、認証エラーで拒否された場合も再接続しない対象にするかを検討する（今回の対象外でも可）

**配布**: Agent の更新が必要。配布は既存の `u` コマンドと auto-update sweep で行う。サーバー側の変更（A）とは独立して出せる。

**受け入れ条件**
- サーバーを 20 分以上止めてから起動し直しても、Agent が自動で再接続すること
- サーバーが止まっている間の agent.log の増え方が、1 時間あたり数十行以内であること

### B. systemd unit の起動順序（インフラ・sudo が必要）

`/etc/systemd/system/pm2-devrelay.service` は今 `After=network.target` だけ。これを次のようにする。

```ini
[Unit]
Wants=network-online.target
After=network-online.target postgresql.service
```

- `network-online.target` を待つように、`systemd-networkd-wait-online` または `NetworkManager-wait-online` が有効になっていることを確認する
- A を入れれば必須ではないが、DB の起動が遅れたときの保険になる
- 反映: `sudo systemctl daemon-reload`（次の起動から効く）
- 注意: `pm2 startup` をやり直すと unit が上書きされるので、`systemctl edit pm2-devrelay` で drop-in（`/etc/systemd/system/pm2-devrelay.service.d/override.conf`）として置く

### C. ヘルスチェックで自動再起動（任意）

- 例: cron で 5 分ごとに `curl -fsS -m 5 http://127.0.0.1:3005/health` を実行し、**2 回続けて** 失敗したら `pm2 restart devrelay-server` して、ログに記録する
- A を入れれば今回のケースは起きないため、優先度は低い。原因不明のハングに備える最後の手段として、必要になってから入れればよい
- pm2 の `online` 表示だけでは、今回のような「プロセスは生きているが listen していない」状態を検出できない点に注意

## 4. 実装順序（案）

1. **A**（サーバー）: 実装済み（2026-10-18）。ビルド済み。`pm2 restart devrelay-server` で反映（未実施・ユーザー実行待ち）。数秒止まる
2. **D**（Agent 3 OS）: **今回は実施しない（2026-10-18 ユーザー決定）**。配布経路（`u`/auto-update）が WebSocket 経由のため、Agent が再接続を諦めた後は原理的に配れない点に注意。必要になったら別サイクルで
3. **B**: sudo を持っている人が drop-in を置く（未実施）
4. **C**: 様子を見て必要なら入れる（未実施）

## 5. 今回の暫定対応（実施済み・2026-10-18 09:12）

- `pm2 restart devrelay-server` → 3005 で待ち受け開始、`/health` 200、Discord bot ログインを確認
- 本番機（devrelay ユーザー）の Agent を crontab @reboot と同じコマンドで起動し直した（pm2 には登録していない）
- 他のマシンの Agent のうち、再接続をやめているものは手動での再起動が必要（D を入れるまで）

## 6. 対策A 実装記録（2026-10-18）

実装の詳細・変更ファイル一覧は `doc/server_listen_hang_20261018.md` を参照。
