# DevRelay プロジェクト固有ルール

> このファイルには、DevRelay の開発時に守るべき設計判断・注意事項を記載する。
> 変更履歴は `doc/changelog.md` に記載すること。

---

## Devin セッションIDとモデルは常に対で扱う・拒否検出は実測文言に追随（#360）

`agents/{linux,macos,windows}/src/services/ai-runner.ts` の `devinCurrentModelForResume` は `devin`
ブロック内の `const` ではなく `devinResumedSessionId` と同じ**関数スコープの `let`** で宣言すること。
ブロックスコープの `const` にすると、`proc.on('close', ...)` コールバック（同一関数内だがブロック外）から
参照できずビルドエラーになる（前セッションが実際に踏んだ罠）。

`clearDevinSessionId()` を呼ぶ箇所には**必ず `clearDevinModel()` も並べる**（不変条件: セッションIDと
モデルは常に対で扱う。片方だけクリアすると、次ターンで古いモデルのまま別セッションを resume する不整合が
起きうる）。

Devin CLI のツール拒否検出文言はバージョンアップで無警告に変わることがある（v3000.6.14 で
`rejected a tool call that requires confirmation` という新パターンが実測で判明、旧2パターンとは不一致）。
検出ロジックは `devin-diagnostics.ts` の純関数 `isDevinToolRejectionText()` に一本化し、直接の文字列/正規表現
比較を分散させないこと（新パターンが出るたびに複数箇所を直すことになる）。

`AI_MODEL_CATALOG.devin` の対応モデル一覧は CLI の実測でしか確定できない（公式ドキュメントの記載と実際に
CLI が受理する slug が食い違うことがある、#353 と同種の教訓）。effort サフィックス等の表現力が無い項目は
`description` 文字列に注記するだけに留め、スキーマ拡張や実装は伴わせない（「実装ゼロ」の判断はプランの
スコープ記述と `git diff --stat -- apps/ prisma/` が空であることで検証する）。

---

## SDK auto-compact ループガードは「進捗」を出力ゼロで判定する（#355）

Claude SDK 経由（`sendPromptToAiSdk()`）の実行が `compact_boundary` を無進捗のまま連発する事故（実測 138.3 分・79 回連続）が発生した。既存の無応答タイムアウト（進捗トラッカー）はサーバー側で出力イベントの有無しか見ておらず、SDK が `tool_use`/テキスト以外の出力を一切出さない compact ループを検知できなかった。

`agents/{linux,macos}/src/services/sdk-loop-guard.ts` のパターンに従うこと:

- 「進捗あり」は **P1（前回 compact 以降にアシスタントテキスト1文字以上）または P2（異なるツール2種類以上使用）の OR** で定義する。回数や時間だけで切ると、Edit/Read/Grep を繰り返す正常な長時間作業を誤検知で巻き込む（実測で確認済み）。
- **同一ツール連打カウンタは compact でリセットしない**。`COMPACT→tool→COMPACT→tool` という実際の事故パターンは、compact のたびにカウンタをリセットすると永久に閾値に到達しない。
- 打ち切り閾値は「無進捗 compact 回数」「同一ツール連打回数」「実行時間（ハードキャップ）」の3種類を独立に持ち、実行時間の閾値は**サーバー側の無応答タイムアウトより必ず先に発火する**値にすること（後から発火しても手遅れ）。
- 外部 import ゼロの純関数として切り出し、linux/macos で byte-for-byte 同一を維持する（#350 以降の一貫した流儀）。

### SDK 実行のキャンセルは「実際に止められたか」を正直に報告する

`cancelAiSession()` は PTY プロセスだけでなく SDK 実行（`process: null` で登録される）にも対応させ、`AbortController` で実際に中断できるようにすること。**キャンセルが成功したかどうかを構造的に不明なまま「キャンセルしました」と表示してはならない**（#325 静かなフォールバック禁止の一種）— `cancelled?: boolean` のような明示フィールドで区別し、失敗時はその旨をユーザーに伝える。

`AbortController.abort()` によって発生する `AbortError` は、既存の「resume 失敗」判定（エラーメッセージの文字列マッチ等）に誤って一致し、同一プロンプトの自動再送を引き起こしうる。abort 由来のエラーである旨を示すガード変数を `catch` ブロックの**最初の文**でチェックし、以降のリトライロジックに到達させないこと。

---

## running-code の stale 判定は単一エントリファイルではなく複数ファイルで見る（#354）

Agent の起動時 stale チェック（実行中のコードが最新ビルドかどうか）を `process.argv[1]`（エントリファイル、通常
`dist/index.js`）1本の mtime だけで判定してはいけない。`pnpm --filter agent build` は tsc が1ファイルでもエラーに
なると全体が失敗するはずだが、部分的な成果物残存（例: 以前のビルドの `services/ai-runner.js` が残ったまま
`index.js` だけ再生成される等）や将来のビルド構成変更を考慮すると、単一ファイル判定は「本当に最新か」を
保証しない。

`agents/{linux,macos}/src/services/running-code-stale.ts` の `decideRunningCodeStale(files, commitMs)` /
`buildRunningCodeTargets(entryPath)` のパターンに従うこと:

- 判定対象はエントリファイル + 主要な `services/*.js` の複数ファイル（AND 判定、1つでも commit より古ければ stale）
- fail-open を徹底する: `commitMs` が `NaN`（git 情報取得失敗等）なら `stale: false`、個別ファイルの `stat` が失敗
  （`mtimeMs: null`）していればそのファイルはスキップし stale 扱いにしない。「判定できない」を「stale」に誤変換
  しないこと（#350〜#352 の fail-open 設計を踏襲）。
- 外部 import ゼロの純関数として切り出し、`node --test` でコンパイル済み `dist/` を直接 import してテストする
  （#350 `agent-update-decision.ts` 以降の一貫した流儀）。

---

## 依存コマンドの検証は「存在」ではなく「機能」で行う（#352）

Windows の `u`（自己更新）で、`pnpm`/`node`/`git` が使えるかを `Get-Command <name>` の**存在チェック**だけで判定してはいけない。PowerShell のコマンド解決優先順位は Alias > Function > Cmdlet > ExternalScript > Application であり、裸の `pnpm` は環境によって `pnpm.cmd`/`pnpm.exe` ではなく `pnpm.ps1`（ExternalScript）に解決されることがある。この経路は「実在するので `Get-Command` は成功する」が「実行しても無音で何も返さず `$LASTEXITCODE` も更新しない」ことが実機で確認された（#352）。存在チェックは「呼べるかどうか」しか保証せず「呼んだら動くかどうか」は保証しない。

そのため依存コマンドの事前ゲートは**実際に実行して結果を検証する**（`agents/linux/src/services/update-script.ts` の `buildDependencyProbeBlock()`）。あわせて `.ps1` shim を避け `.cmd`/`.exe` を明示的に優先探索する（`buildExecutableResolver()`）。

この「機能プローブ」パターンは Windows の PATH 解決が絡む依存コマンド検証全般に適用できる汎用パターンであり、今後同種の判定を追加する場合は `Get-Command` 単体で済ませず、上記のいずれかの方式（機能プローブ、または少なくとも `.cmd`/`.exe` への明示解決）を検討すること。

### 訂正: 判定の厳しさより「間違えたときのコスト」で設計する（#356、2026-09-03）

#352 当初は「①タイムアウト内に終了したか、②標準出力が版番号らしいか、③ exit code が 0 か」の3条件 AND で判定していたが、これ自体が**新たな自己永続ロックアウト**を生んだ（`4ed208d` 導入コミットで6台がロックアウト）。実装に2つの独立バグが同居していた:

- 版番号一致チェックの `-match` 左辺を `'$outVar'` とシングルクォートで書いてしまい、変数展開されずリテラル文字列と照合されるため常に false（B1）
- 判定に使う正規表現が `^\d+\.\d+` という先頭アンカーで、`git version 2.52.0.windows.1` のような実際の出力形と一致しない（B2）
- （副次）`UseShellExecute=$false` は `.cmd`/`.bat`（pnpm の既定パス）を起動できず、B1/B2 を直しても pnpm プローブだけ中止し続ける（B3）

このプローブは `git fetch` より前に配置されているため、判定式の些細なバグがそのまま「毎回中止」に直結し、しかも壊れた `update.ps1` を生成するのはディスク上の stale dist 自身のため `u` を何度送っても直らない自己永続ロックアウトになった。

教訓: 成果物の鮮度ゲート（`buildArtifactFreshnessGate`、dist は `.gitignore` 対象・非 incremental ビルドのため成功時は必ず mtime が動く）が既に「ビルドが実際に走ったか」を独立に担保しているなら、**手前のプローブの判定を厳しくしても安全性は上がらず、むしろ判定式自身のバグがロックアウトの新たな原因になる**。ハード中止（`return`）は「実行ファイル未検出」「タイムアウト」の2条件のみに絞り、exit code 不一致・版番号不一致は警告を残して処理を継続する設計に変更した（#356）。判定を追加する箇所では「これが誤検知したときに復旧不能になるか」を先に問うこと。

---

## 人間入力テキストの provenance fence（#334）

AI へ連結するプロンプトに人間入力テキスト（ゲート①`approve_implementation.note` / ②チャット
`e,<指示>` / ③`submit_instruction.instruction`）を埋め込む際は、`apps/server/src/services/human-text-fence.ts`
の `fenceHumanText(kind, text)` で囲うこと。

- **fence はセキュリティ境界ではない**。権限制御は #332/#333 の `permissionPolicy`/`decidePlanPermission()`
  （構造判定、プロンプト文言を一切参照しない）が担う。fence の役割は「この部分は人間由来のデータであり、
  システム命令でも承認状態でもない」ことを示す provenance 境界のみ。
- 長さ検証（`validateHumanTextLength`）は fence 適用より前、かつ**その経路のあらゆる状態変更・副作用より前**
  に行うこと。「エラーを返したが一部状態だけ変更済み」を作らない。
- 長さの定義は `string.length`（UTF-16 code unit 数）。サロゲートペア（絵文字等）は2文字としてカウントされる。
- 超過時は切り詰めず明示エラーで拒否する（静かなフォールバック禁止、#325）。エラー本文に実長と上限を含める。
- `w` コマンド等 DevRelay 自身が生成した固定プロンプトの判定は、fence 適用後の文字列（`startsWith` 等）に
  依存させず、パース時点で付与する構造的なフィールド（`promptOrigin: 'human' | 'system'`）を使うこと。
- 監査は `Message.humanTextMeta`（JSON文字列、メタ情報のみ）+ `rawRef` で raw text の所在
  （`Message.content` / `Session.approvalNote`）を指す設計とする。メタのみで raw text が復元できない
  設計は「監査可能」とみなさない。

---

## サービス再起動禁止

DevRelay 自身のサーバーやエージェントを修正した場合：
- ビルド（`pnpm build`）は実行してOK
- **サービスの再起動は実行しない**（`systemctl restart` / `pm2 restart` 禁止）
- **ソースコード（`.ts` ファイル等）を変更して `pnpm build` を実際に実行した場合のみ**、再起動案内を出す
- ドキュメント（`.md`）のみの変更ではビルド・再起動案内は **不要**

理由：自分自身を再起動すると WebSocket 接続が切れ、応答が途中で消失するため。

### ChannelSession の stale レコード防止

Web クライアントが WS 切断した際は、`ChannelSession` テーブルからもレコードを削除すること。
DB に残った stale レコードはサーバー再起動時に復元され、メッセージが大量の無効 chatId にブロードキャストされる原因となる。

### testflight PostgreSQL 識別子のクォート

`testflight-manager.ts` で PostgreSQL のユーザー名・DB 名を使う場合は必ずダブルクォートで囲むこと。
ハイフン含みの名前（例: `tf-2048`）がクォートなしだと SQL 構文エラーになる。

### Stale セッションの自動クリーンアップ

サーバー起動時（pm2 restart 時）に以下を自動実行する：
- 24時間以上活動がない active セッション → `ended` に更新 + ChannelSession 削除
- 30分以上経過した pending ツール承認 → `timeout` に更新

`restoreSessionParticipants()` より前に実行し、stale 参加者の復元を防止する。

### ツール承認/質問カードの復元

`getPendingToolApprovalsForSession()` はメモリ Map ベースで動作する（DB round-trip なし）。
復元は2箇所でトリガーされる：
1. **WS 接続直後**: 同一タブのリロード時（`getSessionIdByChatId` でセッションが見つかる場合）
2. **`//connect` 後**: 新タブ時（セッション参加者登録後に復元）

タイムアウトは12時間（`TOOL_APPROVAL_TIMEOUT`）。承認忘れ ≠ 拒否のため長めに設定。

### 端末インタフェースモード（Terminal Mode）

`Project.terminalMode` が true の場合、Agent は Agent SDK の `query()`（`-p` 相当）ではなく PTY 経由で `claude` をインタラクティブ起動する（`agents/<os>/src/services/terminal-runner.ts`）。1 要求 1 セッションで都度起動・都度終了。

- **設定スコープ**: **Project 単位**（既存 `Machine.skipPermissions` / `Machine.disableAsk` の Machine 単位とは異なる）
  - 理由: プロジェクトごとに性質が違う（実験用と本番用で挙動を分けたい）
  - WebUI 状態キャッシュは `terminalModeMap: Record<projectId, boolean>` を使う（machineId ベースの既存 2 つと混同しないこと）
- **新規プロジェクトのデフォルト**: `schema.prisma` の `Project.terminalMode @default(false)`（＝SDK モード）。`0b32c83`（2026-06-21）で一時 `@default(true)` に変更されたが、2026-07-17 に `@default(false)` へ戻した（新規スキャン/scaffold プロジェクトは端末モード無効で登録）。既存プロジェクトの個別設定は WebUI/API で切替。スキーマ 1 行 + DB カラムデフォルト（`ALTER COLUMN ... SET DEFAULT`）の変更のみで、コードは DB デフォルトを参照するだけ
- **配信方式**: WebSocket リアルタイム push（`pushConfigUpdate`）は使わず、サーバーが `server:ai:prompt` / `server:conversation:exec` 送信時に DB から `Project.terminalMode` を取得して payload に含める
  - 理由: プロジェクト数だけ配信先が増えるとオーバーヘッドが大きい。メッセージ送信のたびに DB 参照（1 クエリ）するほうが単純
- **セッション継続は `--resume <session id>`** で行う（`--continue` は使わない）。`.devrelay/claude-session-id` に保存された UUID を `loadClaudeSessionId(projectPath)` で読み、CLI の `--resume` に渡す
  - SDK と CLI は `~/.claude/projects/<hash>/sessions/<id>.jsonl` を共有しているため互換。CLI が同じファイルに追記 → 次回 SDK 起動時もそのまま読み取れる = 双方向の継続が成立
  - `--continue` は cwd ベースで「No conversation found to continue」即死するため不採用
  - **terminal mode 自身も session id を保存する**（#228 続編 3）: SDK 経路でしか書き込まれないと terminal mode 専用プロジェクトでは継続性が失われる。`extractClaudeSessionIdFromBuffer(rendered)` で Claude CLI exit 時の `Resume this session with: claude --resume <UUID>` を抽出して `saveClaudeSessionId` で `.devrelay/claude-session-id` に保存。`finish()` と外側 `onExit` ハンドラの両方で実行（正常終了 / 予期せぬ exit の両ケース対応）
  - session id が無い場合（fresh プロジェクト）は `--resume` を付けず、CLI が新規セッションを採番。1 回目の exit で agent が UUID を捕捉して保存 → 2 回目以降は `--resume <id>` で継続
- **terminal mode は prompt への history 注入を skip**（#228 続編 3）: `connection.ts` の `needsHistoryInPrompt` 判定で `aiTool === 'claude' && terminalMode === true` の場合は強制 false。理由: terminal mode は Claude CLI 自身が JSONL でセッション管理するため prompt への `Previous conversation:` 注入は不要、むしろ Claude が過去文脈に強く引きずられて新規質問より過去の作業継続を選ぶ症状が発生する。`--resume` あり → JSONL 復元、`--resume` なし → fresh session（agent が後で session id を保存して次回継続できるようにする）
- **検出の二経路**: `runStartupDetection()` を onData 駆動（fast path）と 250ms setInterval（無音時の safety net）の両方から呼ぶ
  - 理由: Claude CLI が信頼プロンプトや入力プロンプトを表示後すぐ無音化（ユーザー入力待ち）→ onData が発火しない → 検出されない → 15s タイムアウトでクラッシュ、という症状が Windows ConPTY で顕著に発生。polling で「無音中に立っているプロンプト」を捕捉する
- **検出は仮想画面のレンダリング結果に対して行う**: raw PTY バッファに `strip-ansi` するだけだとカーソル位置指定で配置された単語が密着する（"trust this folder" → "trustthisfolder"）。`@xterm/headless` でレンダリングしてから `extractFinalOutput(term)` で取り出した文字列を検出対象にする
  - `detectPromptReady` には番号付き選択肢を除外する `(?!\d+\.)` の negative lookahead が必須。これが無いと信頼プロンプトの `❯ 1. Yes, I trust this folder` 行に false-match して、信頼承認直後にユーザープロンプトを送ってしまい Claude が混乱して exit code=1 で死ぬ
- **完了検出は「画面アイドル + プロンプト復帰 + 新規バレットあり」**: 500ms setInterval で「最後の画面変化から 5 秒以上経過 + `detectPromptReady` true + 承認待ち無し + `newBullets > 0`」を判定。onData 駆動で完了判定すると入力ボックスの `❯` が常駐するため永遠に発火しない。元は 1.5 秒だったが、Claude CLI がツール完了→次トークンの隙間で `❯` を一瞬表示する際に誤完了する事故（pixblog で exec が 14 秒で kill）が発生したため 5 秒に引き上げ（#233）
  - **`newBullets > 0` のガードが必須**: Claude の思考フェーズ初期は PTY が無音になる（API リクエスト送信 → first token までの latency）。この期間を「処理完了」と誤判定して `/exit` を queue してしまう症状が Windows mviewer で確定（#228 続編）。応答 1 個目の `●` バレットが出るまでは完了とみなさない
  - **新規バレット判定は `Map<text, count>` の per-text 差分**: Set 比較は「同じ質問の re-ask で前回応答が JSONL 履歴に保存されている」ケースで baseline Set に同一テキストが既存し新規判定が漏れる。count 単純比較は scrollback trim で current < baseline の負数になり破綻する。`bulletCountMap(lines): Map<text, number>` を baseline と current で取り、`Math.max(0, currentCount - baseCount)` を全テキスト合計するロジックなら「全く新規 / 同じテキストの再描画 / scrollback で trim」のすべてに対応（#228 続編 2）
  - **completion check は毎 tick で `extractFinalOutput(term)` を fresh 取得**: `lastRenderedForChangeTracking` は onData 内でしか更新されないため、xterm sync update mode 等で `rendered === lastRenderedForChangeTracking` が常時成立する状況だとトラッカーがフリーズする。500ms setInterval の冒頭で必ず fresh rendered を取り tracker も同時更新（#228 続編 2）。`extractFinalOutput` は scrollback 10000 行を全走査するため CPU 影響あるが正確性優先
  - **3 段階 safety net**: (1) `IDLE_FOR_COMPLETION_MS = 5000ms`（5 秒）画面アイドル（#233 で 1.5s→5s に引き上げ）、(2) `FIRST_BULLET_TIMEOUT_MS = 10 分` バレット未到来時の強制完了（画像複数や 100k+ token 履歴では 5 分超は普通なので 10 分）、(3) `IDLE_TIMEOUT_MS = 10 分` の onData ベース最終 timeout
  - **延長アイドル完了パス** (`EXTENDED_IDLE_FOR_COMPLETION_MS = 30_000`): `detectPromptReady` が false でも 30 秒以上画面変化なし + 新規バレットあり → `extended-idle-complete` で正常終了。Claude が `npm run build` 等のバックグラウンドタスク実行中は `❯` カーソルが隠れるため必須（#228 続編 3）
  - **shell running 完了抑制**（#237）: `idle-and-prompt-ready` の条件に `hasRunningShells(rendered)` を追加。Claude CLI が Bash コマンドをバックグラウンド実行中に表示する `✻ ... still running` インジケータを検出し、画面にこの文字列がある間は完了判定を抑制する。これにより `electron-builder` 等の長時間ビルドがバックグラウンドで動いている間に `/exit` が送られてプロセスが kill される事故を防止。exec モードのプロンプト指示にも「フォアグラウンドで実行」を追加する 2 層防御（belt-and-suspenders）
- **xterm scrollback は 10000 行**: default 1000 だと `claude --resume` で 40+ メッセージ復元 + Claude 継続 redraw で満杯になり古いバレット行が押し出される。10000 で実用上ほぼ trim 起きない（Map<text,count> 比較で trim 耐性はあるが、scrollback ヘッドルームも持たせる二重防御）
- **idle タイムアウト**: 最終出力から 10 分無音で強制終了（10 min = `IDLE_TIMEOUT_MS`）。`onData` 発火ごとにリセット
- **プロンプト投入はチャンク + 明示 submit**: 末尾の `\r\n` を除去 → 200 char × 30ms ずつ書く → 400ms 待つ → 単独 `\r` で submit。一括 write すると末尾 `\n\r` が CRLF 1 つに丸められて submit に至らない
- **応答配信は「バレット逐次ストリーミング + 思考ハートビート + 最終整形ブロック」**: 完了 check 内で未送信の `●` バレット行を発見次第 `opts.onOutput` で WebUI に配信（200 char で truncate）。バレット未到来 + 直近 20s バレット送信なし + 30s 間隔 max で `extractThinkingIndicator(rendered)` を抽出して `⏳ [Xs 経過] Doing (Xs · Y tokens)` 形式のハートビート配信。完了時は `extractClaudeResponse` で最新応答ブロックのみ抽出して送信
  - **ストリーミングは Set<text> で「一度きり配信」 + prefix フィルタ + debounce 3 tick**: 完了判定の Map<text,count> 差分は streaming に不適（同一バレットの画面再描画で 30+ 回配信される事故）。Set<text> で一度送ったら二度と送らない。さらに別候補が prefix として持つテキストは部分文字列スキップ、3 tick (1.5s) 安定待ちで Claude の char-by-char rendering 中の partial を吸収（#228 続編 3）
  - **ツール呼び出しバレット / partial / `⎿` tool 出力サマリは streaming + 最終応答の両方で除外**: `isToolCallBullet`（Bash/PowerShell/Read/Write/Update/Edit/MultiEdit/Searching/Glob/Grep/TodoWrite/WebFetch/WebSearch/NotebookEdit/Task/Background/I used the wrong shell）と `isLikelyPartialBullet`（本文 8 文字未満 + 完全な区切り文字無し）で WebUI ノイズを削減。SDK モードと同じ「ツール実行は user に直接見せず説明文だけ送る」流儀（#228 続編 3）
  - **最終応答は最新ブロックのみ抽出**: `extractClaudeResponse` は入力枠を anchor として下から走査 → 最後の `●` バレットが応答末尾 → そこから上方走査して `Previous conversation:` / `User:` / `Assistant:` / 連続空行 / banner で停止 → そのブロックのみ返す。旧実装「baseline に無い最初のバレットから次の separator まで」は baseline=0 のケースで全 scrollback dump になり 7000+ chars のゴミ応答を生成していた（#228 続編 3）
- **キャンセル経路**: `cancelAiSession()` が PTY プロセスも対象に。`cancelTerminalProcess(sessionId)` で `IPty.kill()` → 5 秒猶予 → SIGKILL（既存 SIGTERM/SIGKILL の二段階パターンと同等）
- **任意の選択肢プロンプトは全て WS カード経由でユーザーに委ねる**（#228 続編 2）: 設計思想「ターミナルモードは Claude CLI の薄い UI ラッパ」に基づき、agent が自動判断せずユーザーに選択させる
  - **会話中の tool 承認** (`detectToolApprovalPrompt`): 番号付き選択肢の下に独立 `❯` 入力行があるパターン
  - **起動時のシステム選択肢** (`detectStartupChoicePrompt`): `Enter to confirm · Esc to cancel` + 番号付き選択肢の共通パターン（trust folder / resume from summary / 将来追加されるもの）。カーソル `❯` が option 1 行頭に乗る形式に対応するため `extractChoicePrompt` の regex 先頭に `[❯>]?` 許容を追加。**検出は画面末尾 30 行のみ**（#235: scrollback 上部に確認済み prompt が残ると二重検出される事故が pixdraft で発生）。dedup hash は **options のみ**（question は画面上部に依存して不安定）
  - 両者とも `extractChoicePrompt` で `{question, options}` に分解 → `onToolApprovalRequest` callback（SDK と共通の `ToolApprovalRequest` 形式）で server → WS 承認カード → ユーザー応答を PTY に書き戻す。Server/WebUI/Discord/Telegram は変更ゼロ
  - **応答の PTY 書き込み方式はプロンプト型で分岐**（#234）:
    - **カーソル選択型**（`detectStartupChoicePrompt` = `Enter to confirm` パターン。trust folder / Resume from summary）: option 1 → `\r`（Enter のみ）、option N → `\x1B[B` × (N-1) + 100ms 後に `\r`（矢印キー移動 + Enter）。番号タイプ `${choice}\r` は Claude CLI の SelectInput を混乱させて Enter が効かなくなるため使わない
    - **テキスト入力型**（`detectToolApprovalPrompt` = bare `❯` 入力行。tool 承認）: `${choice}\r`（番号タイプ + Enter）のまま
  - **`extractChoicePrompt` の優先順位は「最下部優先」**（#232 で「最長連続シーケンス」から変更）: 画面下から `num===1` 候補を遡って試し、forward に 2,3,... が続けば現プロンプトと判定。Claude CLI の choice プロンプトは常に画面最下部に出る UI 規約に依存。スクロールバックに残った過去の番号付きリストが現プロンプトより長くても誤検出しない（pixblog の Resume from summary 事故対応）
  - 起動時は startup timer を選択肢検出時に停止し、応答後に `installStartupTimer()` で再起動（summary 生成は 30-60s かかる可能性に対応）
  - `onChoiceRequest` 未配線の自動実行環境では option 1 自動選択でフォールバック（後方互換）
  - 将来 Claude CLI が新規プロンプトを追加してもコード変更不要（汎用 `detectStartupChoicePrompt` が拾う）。trust folder 専用の auto-confirm は削除して汎用経路に統合した
- **Ask 無効化**: PTY モードでは SDK `disallowedTools` が使えないため、画面パースで AskUserQuestion プロンプトを検出 → Ctrl+C 中断 + エラー返却
- **既存挙動の保証**: `terminalMode = false`（デフォルト）の場合は完全 no-op。terminal-runner / @xterm/headless は ai-runner.ts から動的 import するため、端末モード未使用時は node-pty も @xterm/headless もロードされない
- **PTY パッケージ選定**: `@homebridge/node-pty-prebuilt-multiarch@0.13.1` を採用。理由: `microsoft/node-pty@1.x` は Linux x64 プリビルドを同梱せず Agent ホストに build-essential / python3 が必須となり、`install-agent.sh --ignore-scripts` 環境ではビルド失敗が頻発。homebridge フォークは API 完全互換のまま Linux/macOS/Windows のプリビルドを GitHub Releases から `prebuild-install` 経由で download するためビルドツール不要。`pnpm.onlyBuiltDependencies` に `@homebridge/node-pty-prebuilt-multiarch` を追加して postinstall を許可する
- **`@xterm/headless` の CJS 互換性**: webpack バンドル済み CJS なので `import { Terminal } from '@xterm/headless'` は ESM ランタイムで `SyntaxError: Named export 'Terminal' not found` になる。`import xtermHeadless from '@xterm/headless'; const { Terminal } = xtermHeadless;` の default-import + destructure パターンを使う
- **Windows での PTY プリビルド手動 fallback**: Windows では `pnpm rebuild @homebridge/node-pty-prebuilt-multiarch` が走っても `prebuild-install` が `build/Release/` に `conpty.node` を配置しないケースがある（Node 24 ABI 137 + pnpm 10 で確認）。`install-agent.ps1` と `agents/linux/src/services/connection.ts` の Windows update buildSteps に **`build/Release/conpty.node` の存在確認 → 無ければ GitHub Releases から ABI 別 tarball を `Invoke-WebRequest` + `tar.exe` (Windows 10+ 標準同梱) で手動展開** するフォールバックを組み込む。`pnpm rebuild` の引数は `"@homebridge/..."` と引用符で囲む（PowerShell の splat operator 誤解釈防止）
- **usageData 取得（JSONL 直読み）**: 端末モード完了時に `~/.claude/projects/<hash>/<sessionId>.jsonl` を直接読んで model・tokens を集計する。PTY に `/status` コマンドを送ってパースする方式は対話型 UI のため不採用。JSONL のパスハッシュは `projectPathToHash()`（`/` → `-` 置換）で計算し、完全一致 → 末尾部分一致 → 全走査のフォールバック付き検索で解決する
- **--resume は exec モード時のみ使用する**（#238）: plan モードで前回 exec のセッション ID を `--resume` で渡すと、Claude が前回の exec コンテキスト（「実装を開始してください」）を復元して実装作業を丸ごと再実行する暴走が発生する。`sendPromptToTerminalClaude()` で `options.usePlanMode ? undefined : await loadClaudeSessionId()` として plan モードは常に新規セッションで起動する
- **usageData の durationMs フォールバック**（#238）: Claude CLI インタラクティブモード（PTY 起動）は `~/.claude/projects/<hash>/<sessionId>.jsonl` を書き出さないため、`parseSessionJsonlUsage()` が常に null を返す。JSONL 取得失敗時は `{ durationMs }` のみの usageData を返して Conversations 画面の Duration 列だけは表示する
- **finish() 内の onExit で usageData を取得する**（#239）: `terminal-runner.ts` は `finish()` 関数内とトップレベルの 2 箇所に `ptyProcess.onExit()` を登録している。正常完了（idle-and-prompt-ready 等）は全て `finish()` 経由のため、usageData 抽出は `finish()` 内の onExit で行う必要がある。トップレベルの onExit は PTY 直接 exit（crash 等）のフォールバック
- **--resume 失敗時の自動リトライ**: `--resume <id>` 付きで早期 exit（30 秒以内 + 出力空）した場合、セッション ID を削除して `--resume` なしでリトライする（1 回のみ）。古い/壊れたセッション復元失敗への堅牢な対処
- **スコープ外**: スケジュール起動・cron 連携・無人自動実行は実装しない（人間が WebUI から手動で 1 要求を投げる前提）

### Devin CLI 統合（spawn パターン）

Devin for Terminal は Gemini/Codex/Aider と同じ spawn パターンで統合する。
- 実行（plan、フル対応 CLI）: `devin [-r <session-id>] -p --agent-config <tmpConfig> --prompt-file <tmp>`
- 実行（exec、フル対応 CLI）: `devin -p --permission-mode dangerous --prompt-file <tmp>`
- プロンプト: `--prompt-file` 一時ファイル経由（stdin パイプは panic するため使用不可）。**位置引数（`args.push('--', prompt)`）フォールバックは #344 で完全に削除した**。理由: Node の `spawn(..., {shell:true})` は引数をクォートしないため、DevRelay が毎回前置する ~170 行の Agreement/プランモード指示（`\n\n` やバッククォートを含む）がシェルに解釈される**コマンド注入経路**になっていた（実証済み）。`--prompt-file` が非対応と判明した場合は静かに劣化させず `devin.promptFileUnsupported` で明示的に中止する（#325「静かなフォールバック禁止」）
- セッション継続: `-r <session-id>` で明示的に resume（`devin list --format json` で取得・`.devrelay/devin-session-id` に保存）
- パーミッション（plan、#363 で再設計）: `Exec()` はプレフィックス一致であり `Exec(**)` は無効なルール（公式ドキュメント明記）。`--config`/`--agent-config` で `allow:['Read(**)', ...Exec 許可プレフィックス]`（読み取り専用コマンド・`git log`/`git status`/`git diff`/`git show`/`git branch`・DevRelay スキルディレクトリ配下の bash 実行）、`deny:['Write(**)', ...Exec 拒否プレフィックス]`（書き込みコマンド + `sudo`）を明示生成する（`devin-plan-config.ts`、3 OS byte-for-byte 同一の純関数）。`--permission-mode auto` は「読み取り専用ツールのみ」を自動承認するだけでシェル実行（Exec）は対象外（`devin --help` 実測）——これが #260〜#362 で見落とされていた本当の根本原因。`smart` は「ルールが決めていない場合のみ安全性を判定して自動実行」するため、対応していれば `auto` より `smart` を優先する（`resolveDevinPlanPermissionMode()`）。キルスイッチ `DEVRELAY_DEVIN_PLAN_EXEC_DENY=1` で `allow:['Read(**)']`/`deny:['Write(**)']` のみ（Exec 許可/拒否なし）+ `--permission-mode auto` に戻せる（#260〜#362 の壊れていた挙動と等価）
- パーミッション（exec）: `--permission-mode dangerous`（全ツール自動承認）
- **フラグはケーパビリティ駆動（#329、#344 で判定方針を反転、#345 で診断項目追加）**: `--agent-config`/`--permission-mode`/`--prompt-file`/`--model`/`--export`/`--respect-workspace-trust` の対応可否は `devin --help` の単一 probe（キャッシュ付き、`probeDevinCapabilities()`）で判定する。**probe 自体が失敗した場合は #344 で「全て false（悲観）」から「全て true（楽観）」に反転した**——悲観側は「実際は devin が正しく対応しているのに probe だけが（PATH 不在・更新直後のキャッシュ汚染・`--help` の非 0 終了等で）失敗した」場合に、誤った非対応警告と（当時存在した）危険な argv フォールバックを静かに発動させてしまう構造的な穴だった。楽観側に倒しても、実際に非対応だった場合は `unexpected argument` を検出する既存の自動リトライ（最大3フラグ、#344 で2→3に引き上げ）が安全網として受け止める。失敗キャッシュのみ `DEVRELAY_DEVIN_PROBE_TTL_MS`（既定60000ms）で期限切れにし、成功キャッシュは Agent プロセス寿命いっぱい保持。plan モードで `--agent-config` 非対応の場合は `--permission-mode auto`（#274 の劣化パスと同レベル）→ さらに非対応なら `-p` のみへ段階的に劣化し、**読み取り専用強制が効かなくなる旨を必ずチャットに警告する**（#325「静かなフォールバック禁止」、ただし probe が実際に成功して非対応と判定した`ok===true`のときのみ警告——probe 自体が失敗した`ok===false`のときは代わりに `devin.probeFailed` を1回だけ通知）。`close` ハンドラでも `unexpected argument '--flag'` を検知したら該当フラグを落として自動リトライし、それでも失敗する場合は実際の stderr 末尾5行を明示エラーとして返す（`(No response from AI)` に丸め込まない）。**診断強化（#345）**: `probeDevinCapabilities()` は `devin --version`/`helpBytes`/`ok`/`reason` も保持し、劣化通知3キー（`devin.readonlyUnsupported`/`devin.execPermissionUnsupported`/`devin.probeFailed`）に `{detail}`（例: `devin 3000.1.27 / help 4128 chars / probe=ok`）として表示する——ある端末で `ok:true` かつ `agentConfig:false` のように「probe 自体は成功しているのに実機の `--help` と矛盾する」ケースが発生し、正規表現バグでもリトライ未発火でもなく環境差（Agent が解決する devin 実体がユーザーの対話シェルと別／devin config の差）が疑われたが証拠不足で断定できなかったため、**憶測で直さず**次回のチャット1回で切り分けられるようこの診断行を追加した
- **workspace trust 対応（#345）**: devin は `-p`（非対話/print モード）では `--respect-workspace-trust` の既定が `false`（`devin --help` に明記）だが、実機では対象マシンの devin config（`respect_workspace_trust`）が CLI 既定より優先され `Refusing to run in an untrusted workspace` で拒否されるケースがある。DevRelay はリモート実行のため対話の trust プロンプトを人間が押せず構造的に復旧不能なので、`devinHasRespectWorkspaceTrust` かつ `DEVRELAY_DEVIN_RESPECT_WORKSPACE_TRUST !== '1'` のとき `--respect-workspace-trust false` を明示的に付与する（devin 自身が文書化している非対話モードの既定へ戻すだけで権限拡大ではない。キルスイッチ `DEVRELAY_DEVIN_RESPECT_WORKSPACE_TRUST=1` で従来動作に戻せる、`devinDroppedFlags` の自動リトライにも自動的に乗る）。当該フラグを付与してもなお拒否された場合（旧 devin での非対応や config の別経路）は `cli-failure.ts` の `isWorkspaceTrustError(stderr)`（`classifyCliFailure()` 本体は無変更のまま追加した純関数）が `Refusing to run in an untrusted workspace`/`respect_workspace_trust` を検出し、生 stderr の代わりに `devin.workspaceUntrusted`（対処手順3点）を表示する
- **`--agent-config` は新しいバージョンで廃止済み（#346 で確定）**: #345 では「probe 自体は成功しているのに実機の `--help` と矛盾する」ケース（H-A/H-B）を憶測せず診断強化のみに留めていたが、Devin 公式ドキュメント（`cli/reference/commands`）を確認した結果 `--agent-config` は現行バージョンに一切記載がなく**新しいバージョンで恒久的に廃止されたフラグ**と判明した。誤警告ではなく真陽性（正しく非対応と判定できていた）。permission 制御は現行では config ファイル（`.devin/config.json`・`.devin/config.local.json`・`~/.config/devin/config.json`/`%APPDATA%\devin\config.json`）の `permissions: {allow, deny, ask}`（`Read(glob)`/`Write(glob)`/`Exec(prefix)`/`Fetch(pattern)` 構文）に移行している。`devin.readonlyUnsupported` の文言は「対応していない」ではなく「このバージョンには無い（更新しても直らない）」とし、恒久対策として `permissions.deny` ルール追加を案内する（#329〜#345 の `--agent-config` 検出・段階的劣化ロジック自体は無変更、文言のみ訂正）
- **診断表示の集約 + フラグ一覧の可視化（#346）**: `formatDevinVersion`/`buildDevinCapabilityDetail`/`formatDevinFlagList` を新規 `devin-diagnostics.ts`（外部 import ゼロの純関数、3 OS byte-for-byte 同一）に集約——従来は `ai-runner.ts` 内にローカル関数として 3 OS 個別定義されており `devin ${caps.version}` の二重前置バグ（`devin devin 3000.6.7 ...` という表記重複）が実機 E2E で発生していた。`probeDevinCapabilities()` の戻り値に `flags: string[]`（既にログ専用に計算されていた `detectedFlags` を戻り値にも含めるだけ）を追加し、`--agent-config` 非対応時（`devinDegradedReason==='planReadonly'`）に「このマシンで実際に使えるフラグ一覧」をプロセス寿命中1回だけ `devin.flagList` としてチャットへ追送する（従来は `agent.log` にしか出ておらず、Team 未登録・SSH 不可の端末では確認手段がなかった）
- **出力ゼロ終了の分類（#344）**: 上記の既存分岐（unknownFlag 自動リトライ・exit 0 空応答案内等）に該当しなかった残りのケースは `cli-failure.ts` の `classifyCliFailure()`（外部 import ゼロの純関数、linux/macos/windows で byte-for-byte 同一）で分類する。`commandNotFound`（PATH に無い/ENOENT）→ `ai.cliNotFound`（`u` での再検出を案内）、`emptyNonZero`（原因不明の非 0 終了、workspace trust エラーの場合は上記のとおり専用メッセージ）→ `ai.cliFailed`（exit code + stderr 末尾5行を必ず表示）。シグナル kill 等（`exitCode===null`）は CLI 自体の失敗ではないため従来どおり `(No response from AI)`
- **`--config` による読み取り専用の再強制（#347）**: `--agent-config`（#346 で廃止確定）の後継として `--config <PATH>` が現行 CLI に存在する（Phase0 実測、devin 3000.6.7）。プラン分岐の優先順位を `devinHasConfig || devinHasAgentConfig` に変更し、`--config` が使える端末では従来どおり `permissions.{allow,deny}` で読み取り専用を実効的に強制する。実測で判明した3つの罠に対応: ①**merge ではなく replace**（渡したファイルの内容のみが有効になる）——生成 JSON を `permissions` のみの最小構成に保ちユーザー config をマージしない既存方針（#56 Step3）で対応済み、②**devin 自身がファイルを書き換える**、③`shell.setup_complete` が無いファイルを渡すと `Welcome to Devin CLI!` 等の**初回起動バナー**が毎ターン stdout に出る——生成 JSON に `version:1, shell:{setup_complete:true}` を追加してバナー発生自体を抑止しつつ、`devin-diagnostics.ts` の `isDevinBannerLine(line)`（trim 後の完全一致/正規表現一致のみで判定する保守的な純関数）で出力からバナー行のみをフィルタする二重対策。④**非対話 deny は拒否テキストを一切出さず exit 0 で完全無音**——`devinPlanToolRejected`（#274）に3つ目の OR 条件 `devinPlanConfigApplied && code===0` を追加し、無音 deny でも `--permission-mode auto` フォールバック（既存の `--agent-config` 非対応時と同レベルの劣化パス）が発火するようにした。`--config`/`--agent-config` どちらも無い端末だけが従来どおり `devin.readonlyUnsupported` の対象になる（文言をこの実態に合わせて更新、キー名・`{detail}` は不変）。一時ファイル名は `devrelay-devin-plan-config-<sessionId>.json` に改名（旧名 `devrelay-devin-agent-config-` の掃除行は1バージョン残置）
- **PATH 汚染ガード（#344）**: `config.aiTools.devin.command`/`gemini.command` はベース名のみ保存されるため `path.dirname(command)` が `'.'` になり得る（プロジェクトの cwd が PATH の先頭に積まれ、悪意あるリポジトリ内の `git`/`node` を拾う穴）。`dir === '.'` のときは PATH に追加しない
- **`-r` resume は plan モード時のみ**: Devin の resume は元セッションの permission-mode を保持して CLI の `--permission-mode dangerous` を上書きしない仕様。exec モードでは新規セッションを起動して dangerous を確実に効かせる（#231 で判明）。session continuity は plan 中のみ。plan→exec は元々文脈リセット点なので問題なし
- 会話履歴: 非 Claude ツールでは常にプロンプトに会話履歴を含める（`isClaudeSdk` 判定で Claude は従来通り SDK --resume）。Devin が exec で `-r` を使わなくても、この履歴注入で文脈は維持される
- PATH: コマンドのディレクトリを自動追加（サービス実行時の PATH 不足を回避）
- 有効化: Agent 起動時に自動検出（`detectAndUpdateAiTools()`）、または手動設定
- Server / WebUI / DB は変更不要（`Session.aiTool` は String 型、`AI_TOOL_NAMES` で動的表示）
- Cloud API (v3 REST) は将来対応（ローカル CLI 優先）

### Codex CLI 統合（非対話 exec パターン）（#308）

Codex CLI（`codex`）は `codex exec`（非対話サブコマンド）を使う。以前は他ツールと同じ汎用 shell フォールバック（`codex '<prompt>'`）で扱われ、対話 TUI が起動してハングしていた。
- 実行（plan）: `codex exec --json --skip-git-repo-check -c sandbox_mode="read-only" [resume <thread_id>] -`
- 実行（exec）: `codex exec --json --skip-git-repo-check -c sandbox_mode="workspace-write" -c approval_policy="never" [resume <thread_id>] -`
- プロンプト: 必ず stdin 経由（`-` を最後の引数に）。argv に埋め込まない — Windows `cmd.exe` のコマンドライン長上限（約8191文字）で確実に壊れるため（gemini/devin と同じ理由）
- **権限は CLI/サンドボックスレベルで強制**: plan = `sandbox_mode="read-only"`（ファイル書き込み・シェル実行を OS レベルでブロック、プロンプト指示だけに頼らない）。exec = `sandbox_mode="workspace-write"` + `approval_policy="never"`（全承認）
- **`-s/--sandbox` ではなく `-c sandbox_mode=` を使う**: `codex exec resume` サブコマンドには `-s`/`-C` フラグが存在しない（実機確認済み）。`-c` に統一することで新規／resume 両方でフラグ列を完全共通化できる。値は TOML パースされるため文字列は内側にダブルクォートが必要（`sandbox_mode="read-only"`）
- セッション継続: `codex exec resume <thread_id>`（`.devrelay/codex-session-id` に保存、`x` でクリア）。thread_id は `--json` の `thread.started` イベントから取得
- **`resume` は capability プローブで対応可否を確認**: `codex exec --help` の出力をキャッシュ付きでプローブ（`--json`/`resume` 両方チェック）。旧バージョンでは `--json` を付けずプレーンテキストとして扱う
- JSONL イベント: `thread.started`（セッション ID）、`item.completed`（`agent_message`=本文、`reasoning`=非表示、その他=10秒スロットルで進捗表示）、`turn.completed`（`usage` を claude 互換キーにマップ）、`turn.failed`（理由付きで完了通知）
- resume 空振り対策: resume した thread が出力ゼロで終了 → セッション ID を破棄し `resumeFailed` を立てて汎用リトライ（新規スレッド）に委譲（Devin と同一設計）
- 30秒ハートビート（`⏳ Codex 実行中...`）: Devin と同じ理由（サーバー側 5 分無出力タイムアウトの誤爆防止）
- PATH: コマンドのディレクトリを自動追加。Windows は `codex.cmd` シム実行のため `shell: true` が必須（agents/linux は `process.platform === 'win32'` で条件分岐、agents/windows は Electron GUI で常に Windows なので無条件）
- **Linux 実行環境の前提**: `codex exec` の非対話サンドボックスは bubblewrap（`bwrap`）に依存する。Ubuntu 24.04+ で `kernel.apparmor_restrict_unprivileged_userns=1` の場合、`bubblewrap` パッケージ導入だけでは不十分で `/etc/apparmor.d/bwrap` に `userns,` を許可するプロファイルを追加し `apparmor_parser -r` で反映する必要がある（Ubuntu の bubblewrap パッケージは AppArmor プロファイルを同梱しない）
- Server / WebUI / DB は変更不要（`Session.aiTool` は String 型、`AI_TOOL_NAMES` で動的表示）— ただし `apps/server/src/services/command-parser.ts` の `ai:`/`a` コマンド許可リストに `devin` が漏れていた別バグを同時修正

### ファイル出力指示（OUTPUT_DIR_INSTRUCTION）

ユーザー向けの成果物ファイルは、原則 `.devrelay-output/` に保存すると自動送信される（`output-collector.ts` の `collectOutputFiles()` がディレクトリを走査）。
- **強制ではなくデフォルト**: プロンプト末尾の指示文は「**特にパス指定がなければ** `.devrelay-output/` に保存」+「**ユーザー明示指定があればそれを優先**」（#231 で「必ず」から弱めた）
- 理由: ユーザーが「ルートフォルダに置いて」「`~/foo` に書いて」のような明示指定をした場合、システム指示で `.devrelay-output/` に強制すると UX が悪い
- 文言: Linux/macOS=日本語、Windows=英語（Agent OS ごとに `agents/{os}/src/services/output-collector.ts` の `OUTPUT_DIR_INSTRUCTION` 定数で管理）

### AI ツール自動検出（detectAndUpdateAiTools）

Agent 起動時に `which`/`where` で全既知 AI ツールを検出し、config.yaml に自動追加する。
- **追加のみ、削除しない**: CLI が一時的に PATH にない環境（Docker、SSH 等）で設定が消えないように
- **既存設定を上書きしない**: ユーザーがカスタムパス（`/usr/local/bin/claude-nightly` 等）を設定していたら維持
- **config.yaml に永続化**: 検出結果を保存し、次回起動時の再検出コストを削減
- 対象ツール: claude, gemini, codex, aider, devin（`KNOWN_AI_TOOLS` 配列で管理）

### AskUserQuestion 無効化（disableAsk）

`Machine.disableAsk` が true の場合、SDK `disallowedTools: ['AskUserQuestion']` でツール自体をモデルのコンテキストから除去する。
`canUseTool` での deny ではなく SDK レベルで除去するため、Claude は質問しようとすること自体がなくなる（無駄なターンなし）。

skipPermissions と同じパターン: DB カラム + API + WS リアルタイムプッシュ + WebUI トグル + exec フォールバック同期。

### ExitPlanMode のハード封じ（#303）

プランモード（`permissionMode: 'plan'` / `--permission-mode plan`）は編集自体は正常に抑止するが、
`ExitPlanMode` は SDK/CLI が用意する**正規の脱出ハッチ**であり、モデルが自発的に呼べる。
対話版 CLI ではモデルが `ExitPlanMode` を呼ぶと人間に確認を求め、承認して初めて解除される。
DevRelay（SDK 版）はその人間確認を `canUseTool` に置き換えているため、`ExitPlanMode` を他の
非質問ツールと同様に `allow` してしまうと、**ユーザーの `exec` を待たずにプランモードが自己解除**される
（mimamori-server 2026-08-15 の事故: モデルが `ExitPlanMode` を呼び自動承認 → 以後の Edit/Write/Bash
も同じ寛容な `canUseTool` で自動承認 → 無人で実装・本番 DB 操作・pm2 restart まで完走した）。

対策は `disableAsk` と同じ `disallowedTools` 方式（`canUseTool` の deny より根本的、ツール自体を
モデルの手札から除去）。plan モード中は `disallowedTools` に `ExitPlanMode` を必ず含める:

- **linux/macos**（SDK `query()` 版）: `disableAsk`/`usePlanMode` を合流させて `disallowedTools` を構築。
  念のため plan モード `canUseTool` の先頭（skipPermissions 分岐より前）にも `ExitPlanMode` の
  早期 deny を残し二重防御にしている
- **windows**（Electron GUI・CLI subprocess版。`canUseTool`/`disallowedTools` の SDK フックを持たない
  別実装）: `--permission-mode plan` 指定時に CLI フラグ `--disallowedTools ExitPlanMode` を追加
- 解除経路は従来どおりユーザーの `e`/`exec`（`usePlanMode=false` への遷移）のみに一本化。
  プロンプトレベルの警告（`PLAN_MODE_INSTRUCTION` 等）はソフトガードとして併用（三重防御）

**注意**: `skipPermissions`（自動承認 ON）は plan モードでも `ExitPlanMode` を含む全ツールを
即 allow する分岐を持つため、`disallowedTools` によるツール除去がこの分岐より優先されることを確認済み
（`disallowedTools` はモデルのツール一覧自体から除去するため、`skipPermissions` の値に関係なく効く）。

### loadOlderMessages の連鎖発火防止

`loadHistory` 完了後、React の DOM 更新で `scrollTop=0` → `handleScroll` → `loadOlderMessages` が連鎖発火する問題がある。
`initialLoadCompleteRef` フラグで初回 loadHistory + auto-scroll 完了（2秒後）まで `loadOlderMessages` をブロックすること。

### SW skipWaiting ハンドラ

`sw.ts` に `SKIP_WAITING` メッセージハンドラを必ず含めること。
これがないと `vite-plugin-pwa` の `registerType: 'autoUpdate'` が機能せず、新しいビルドが全タブを閉じるまで反映されない。

### WebUI `//connect` 応答と clearProgressOnTab

`//connect` の応答（`web:response`）は AI の完了ではないため、`clearProgressOnTab` で `completed = true` にしてはならない。
`suppressConnectRef.current` が `true` の場合は早期 return すること。

再起動案内の条件：
- `.ts` ファイルを変更した → `pnpm build` を実行 → 成功 → 案内を出す
- `.md` ファイルのみ変更 → ビルド不要 → 案内も不要

案内例（ビルド実行時のみ）：
```
ビルド完了。以下のコマンドでサービスを再起動してください：
pm2 restart devrelay-server devrelay-agent
```

---

## アーキテクチャ概要

### ディレクトリ構造
```
devrelay/
├── apps/
│   ├── server/          # Center Server (Fastify + WebSocket + Prisma)
│   ├── web/             # WebUI (Vite + React)
│   └── landing/         # ランディングページ (devrelay.io)
├── agents/
│   ├── linux/           # CLI Agent (Linux + Windows クロスプラットフォーム)
│   ├── macos/           # CLI Agent (macOS 専用、launchd 管理)
│   └── windows/         # Windows Agent (Electron タスクトレイアプリ)
├── packages/
│   └── shared/          # 共通型定義・ユーティリティ
├── scripts/             # インストーラー (install-agent.sh, install-agent.ps1)
├── rules/               # DevRelay ルール・設計判断
├── doc/                 # 変更履歴・ドキュメント
└── CLAUDE.md            # 軽量ハブ
```

### 主要ファイル

#### Server
| ファイル | 責務 |
|---------|------|
| `apps/server/src/services/agent-manager.ts` | Agent 通信管理・セッション復元 |
| `apps/server/src/services/session-manager.ts` | セッション管理 |
| `apps/server/src/services/command-handler.ts` | コマンド処理の中心 |
| `apps/server/src/services/command-parser.ts` | コマンドパース・NLP統合 |
| `apps/server/src/services/build-summarizer.ts` | AI ビルド要約（マルチプロバイダー） |
| `apps/server/src/services/natural-language-parser.ts` | 自然言語コマンド解析 |
| `apps/server/src/services/user-settings.ts` | ユーザー設定（API キー暗号化保存） |
| `apps/server/src/services/dev-report-generator.ts` | Dev Reports 生成（マルチプロバイダー） |
| `apps/server/src/routes/api.ts` | REST API エンドポイント |
| `apps/server/src/routes/public-api.ts` | パブリック API（トークン検証） |
| `apps/server/src/platforms/discord.ts` | Discord Bot |
| `apps/server/src/platforms/telegram.ts` | Telegram Bot |

#### Agent (Linux/Windows 共通 CLI)
| ファイル | 責務 |
|---------|------|
| `agents/linux/src/services/connection.ts` | WebSocket 接続・メッセージ処理 |
| `agents/linux/src/services/ai-runner.ts` | Claude Code / Gemini CLI 実行 |
| `agents/linux/src/services/output-collector.ts` | 出力ファイル収集・Agreement 定数 |
| `agents/linux/src/services/conversation-store.ts` | 会話履歴の永続化 |
| `agents/linux/src/services/session-store.ts` | セッション ID・コンテキスト使用量 |
| `agents/linux/src/services/management-info.ts` | 管理コマンド生成（環境自動検出） |
| `agents/linux/src/services/config.ts` | 設定管理（OS 別パス分岐） |
| `agents/linux/src/services/approval-logger.ts` | ツール承認 JSONL ログ（ローテーション付き） |

#### Agent (macOS 専用 CLI)
| ファイル | 責務 |
|---------|------|
| `agents/macos/src/services/management-info.ts` | macOS 管理コマンド生成（launchd/PM2/nohup） |
| `agents/macos/src/services/config.ts` | macOS 設定管理（ホームディレクトリのみ） |
| `agents/macos/src/cli/commands/setup.ts` | launchd LaunchAgent 登録 |
| `agents/macos/src/cli/commands/status.ts` | launchctl ベースのステータス確認 |
| `agents/macos/src/cli/commands/uninstall.ts` | launchctl unload + plist 削除 |

#### Shared
| ファイル | 責務 |
|---------|------|
| `packages/shared/src/types.ts` | 共通型定義 |
| `packages/shared/src/constants.ts` | ショートカット定義・allowedTools デフォルト定数 |
| `packages/shared/src/token.ts` | トークンユーティリティ |

---

## shared パッケージ制約

- Node.js 固有 API を使わない（`Buffer` 不可）
- `btoa`/`atob` は `declare` で型宣言して使用
- tsconfig: `"lib": ["ES2022"]`（DOM なし）
- `packages/shared` は **CJS のみのビルド**（`package.json` は `main: ./dist/index.js` のみ、`exports`/`module` フィールドなし）
- **`apps/web`（Vite）から利用する場合は `resolve.alias` で TS ソースを直接参照すること**（#309→#310 で確定）: pnpm workspace のシンボリックリンクは realpath が `node_modules` の**外**（`/opt/devrelay/packages/shared/dist`）になるため、Rollup/Vite の `commonjsOptions.include`（既定 `[/node_modules/]`）に掛からず CJS が変換されずバンドルに混入し、ブラウザで `require is not defined` が発生して画面が真っ白になる（namespace import に変えても `pnpm build` の静的解析エラーが消えるだけで実行時には直らない）。`apps/web/vite.config.ts` に `resolve.alias: { '@devrelay/shared': '<abs>/packages/shared/src/index.ts' }` を設定し、CJS interop 自体を発生させないこと。`packages/shared/src` は相対 import のみで外部依存ゼロなのでこの方式で安全
- **教訓**: shared 等の外部パッケージ import を追加した後は `pnpm build` の green だけで安全と判断せず、`grep -c 'require(' apps/web/dist/assets/index-*.js` が 0 であることを確認すること

---

## machineName フォーマット

- `hostname/username` 形式（スラッシュ区切り）
- 例: `ubuntu-dev/pixblog`, `DESKTOP-Q43QT7L/fwjg2`
- 1 Agent = 1 User モデル（同一マシン上の複数ユーザーを区別）

---

## トークン形式

- 新形式: `drl_<serverUrl_base64url>_<random64hex>`
  - Base64URL: 標準 Base64 の `+` → `-`, `/` → `_`, パディング `=` を除去
- 旧形式: `machine_<random64hex>`（後方互換のためサポート継続）

---

## Agent 追加フロー

1. WebUI「+ Add Agent」→ 名前入力なし → 即座にトークン＋ワンライナー表示
2. サーバーが仮名 `agent-N` を自動生成 → Agent 接続時に `hostname/username` で上書き
3. 名前自動更新条件: 仮名（`agent-*`）または旧形式（hostname のみ → hostname/username）の場合に上書き

---

## Agent 再起動メカニズム（OS 別）

- **Linux**: systemd ユーザーサービス（`Restart=always`）または PM2 が `process.exit(0)` 後に自動再起動
- **macOS**: launchd の `KeepAlive` が `process.exit(0)` 後に自動再起動
- **Windows**: **サービスマネージャが存在しない**ため、`server:agent:restart` ハンドラが自身で `wscript.exe "<binDir>/start-agent.vbs"` を `detached: true, stdio: 'ignore'` で spawn してから `process.exit(0)` する（#230）
  - `start-agent.vbs` は `WshShell.Run` を 1 度実行するだけのワンショット
  - Startup フォルダ / Task Scheduler ONLOGON は OS 再起動・ログオン時のみ発火
  - したがって process exit のたびに自身で再起動を仕掛ける必要がある
  - `handleAgentUpdate()` の Windows 分岐も同じパターン（PowerShell スクリプト末尾で `restartCmd.command` 実行）

## Agent 再起動セッション復元

- `needsSessionRestart` Set（machineId ベース）で Agent 再接続を検知
- `handleAiPrompt()`/`handleExec()` でフラグ確認 → 新セッション作成 + `server:session:start` 再送
- **参加者マイグレーション**: 新セッション作成時、旧セッションの全参加者を新セッションに引き継ぐ（#155 で追加）。送信者のみ引き継ぐと他ブラウザに AI レスポンスが届かない
- `handleProjectConnect()` でフラグクリア（自動再接続時の二重作成防止）
- **レースコンディション注意**: ブラウザが Agent より先に再接続すると `clearAgentRestarted` → `needsSessionRestart.add` の順になり、フラグが残る。参加者マイグレーションでこのケースに対応
- `handleAgentDisconnect()` で stale WebSocket 判定（Race Condition 防止）
- `sendToAgent()` で CLOSED な WebSocket を検出時に自動クリーンアップ（stale 参照の自己修復）
- `handleAgentConnect()` で旧 WebSocket が残っていれば `terminate()` で即座に破棄（`close()` はハンドシェイク待ちで stuck するため不可）

## AI モデル選択（`l` コマンド + Settings 共有）(#251-#253, #309 で codex/gemini/devin にも拡張)

AI SDK/CLI モードで使うモデルを Plan/Exec 別に選択する仕組み。当初は Claude 専用だったが #309 で claude/codex/gemini/devin の 4 ツール共通の仕組みに拡張した。

- **UserSettings キー**: `claude_model_plan` / `claude_model_exec`。プロンプト送信のたびに読み込み → WS payload `model` → Agent SDK `sdkOptions.model`
- **`l` コマンド**: `l`（一覧）、`l sonnet`（両方）、`l plan:haiku` / `l exec:opus`（個別）。端末モードは対象外（Claude CLI 自体がモデル制御）
- **設計判断（Settings と `l` の共有）**: WebUI Settings ページとチャット `l` コマンドは**同じ UserSettings キーを共有**する。専用の優先順位ロジックや新キーは作らず、last-write-wins で「後から変更した方が優先」を実現 → サーバー変更ゼロで両者が整合。Settings 画面には `l` での変更値もそのまま反映される
- **設計判断（フル ID でエイリアス解決をバイパス）**: `AVAILABLE_MODELS` / `CLAUDE_MODEL_OPTIONS` にフルモデル ID（`claude-opus-4-8`, `claude-fable-5`）を持たせる。SDK/CLI のエイリアス（`opus` → `opus-4-6`）解決は CLI バージョンに依存するため、古い CLI では新モデルに解決されない。フル ID は API に直接渡るため CLI・Node.js を更新せず最新モデルが使える（CLI 2.1.197 + Node 20.20.0 で `claude-opus-4-8` / `claude-fable-5` 動作確認済み）
- **`l` のコマンド判定バグ (#252)**: `isTraditionalCommand()` に `'l'` 判定を追加。未追加だとセッション接続中に `parseCommandWithNLP` が `l` を AI プロンプトとして流してしまう（`'a'` コマンドと同様の 1 文字キー特殊対応が必要）
- **macOS Agent への移植漏れ (#259)**: #251 の `model` 適用は当初 `agents/linux` にしか実装されておらず、`agents/macos` が payload の `model` を無視して CLI デフォルト（`opus-4-6[1m]`）で実行していた（Mac のプロジェクトだけモデル設定が効かない）。サーバーは全 Agent に `model` を送っているため、Agent 側が受け取って `sdkOptions.model` に適用しないと機能しない。**原則（#256 の教訓と同じ）: Agent 機能追加時は `agents/linux` と `agents/macos` の両方に実装すること**。macOS の伝搬経路は本実行 `sendOptions` / exec 転送 / resume 失敗リトライ `retryOptions` の 3 箇所
- **ask/teamexec/MCP 経由の model 欠落 (#306)**: 直接メッセージ・`x`(exec) は `command-handler.ts` が UserSettings から `model` を解決して渡すが、クロスプロジェクト経路（`ask`/`teamexec` → `agent-manager.ts` の `executeCrossProjectQuery`/`executeCrossProjectExec`）と MCP 経由（`mcp/tools.ts` の `submit_instruction`/`approve_implementation`）は呼び出し時に `model` 引数を渡していなかった。Agent 側 `ai-runner.ts` は `model: options.model` を無条件代入するため、`undefined` のまま送られると Claude SDK が UserSettings を無視して自前のデフォルトモデル（1M コンテキストβ対応アカウントでは `opus-4-6[1m]`）を選択していた。**設計判断（呼び出し元4箇所を直さず送信関数1点に既定値解決を集約）**: `sendPromptToAgent`/`execConversation` 自身が `model===undefined` の時だけ `getUserSetting(userId, CLAUDE_MODEL_PLAN/EXEC)` で補完する方式にした。呼び出し元ごとに引数を追加する方式だと将来の新経路（4例目以降）でまた同じ穴が空く（#86→#90, #293→#304 と同型の分散同期漏れ）。切り分けの教訓: モデル不一致は「累積トークン量」ではなく「送信経路（直接 or ask/teamexec/MCP）」で先に疑うべきだった — 累積トークンが少ない（111.7K）クロスプロジェクト実行でも `[1m]` になっていたことが決め手になった
- **codex/gemini/devin への拡張 (#309)**: `AVAILABLE_MODELS`/`CLAUDE_MODEL_OPTIONS` を `packages/shared/src/constants.ts` の `AI_MODEL_CATALOG`（4 ツール × モデル候補）に統合し、server/web の重複定義を削除。UserSettings キーは `<tool>_model_<mode>` 規則（`codex_model_plan` 等）で `modelSettingKey`/`resolveModelForTool` ヘルパに集約。`sendPromptToAgent`/`execConversation` の #306 修正が claude 決め打ちだった潜在バグ（aiTool を見ず常に claude キーを読む）も同時修正。Agent 側フラグは各 CLI の実運用に合わせて分岐: **codex は `-c model="..."`**（`sandbox_mode` と同じ理由で `codex exec resume` に `-m` が無いため新規/resume 両方で `-c` に統一）、**gemini は `-m`**、**devin は `--model`**（fuzzy 名可）。`isUnsafeModelId`/`safeModelArg()` で危険文字（`"`/空白/`;`/`$`/バッククォート/改行）を二重サニタイズ。**Windows Electron GUI agent (`agents/windows`) は claude ですら `model` が配線されておらず**（macos/linux は #251 で対応済みだったが windows だけ漏れていた）、`SendPromptOptions`/`connection.ts` に `model` を新規追加して解消
- **#309 が誘発した本番障害 (#310)**: web が `@devrelay/shared` に初めて依存した際、Vite の CJS 変換が pnpm workspace のシンボリックリンクに対応しておらず `app.devrelay.io` が全画面白画面になった。詳細は「shared パッケージ制約」節を参照
- **Claude Fable 5.1 追加 (#353)**: `AI_MODEL_CATALOG.claude` の先頭に `claude-fable-5-1` を追加（2026-09-01 リリース、$10/$50 per MTok、文脈1M/出力128K、adaptive thinking 常時）。依頼時の「公式ラインナップは Fable 5.1/Opus 5/Sonnet 5/Haiku 4.5 の4モデル」という前提は Anthropic の deprecation table 実測で誤りと判明（`claude-fable-5`/`claude-opus-4-8` もどちらも Active）だったため**削除は0件**（`l` はカタログ外 ID もそのまま指定できる設計のため、実在しないモデルを消す以外の理由で削除する積極的な動機がない）。Fable 5.1 の breaking changes 3点（`tool_choice` 強制エラー・旧モデルの thinking block 非対応・過去ターン編集で thinking block 無効化）はいずれも該当コード0件（DevRelay は `tool_choice`/`thinking`/`budget_tokens` を一切使わず、messages 配列も手編集しない）。副次発見として、カタログ**外**で要約/解析用に7箇所ハードコードされていた `'claude-haiku-4-5-20251001'`（`chat-provider.ts`/`build-summarizer.ts`/`conversation-summarizer.ts`/`natural-language-parser.ts`/`dev-report-generator.ts`/`agent-manager.ts`×2）を値そのままで `UTILITY_MODEL_ANTHROPIC` 定数（`packages/shared/src/constants.ts`）に集約——この7箇所は全て `temperature` を渡しており、Opus 4.7 以降は `temperature` で400エラーになるため、退役日が近い（≥2026-10-15、カタログ内最短）からといって安易に新モデルへ差し替えると一斉に壊れる。実際のモデル差し替えは本サイクルのスコープ外（値は無変更）。`command-handler.ts` の `handleModelList()`（`l`）にカタログ外 ID 警告を追加（保存値は書き換えない、表示のみ）。既定モデルはそもそも存在しない（`resolveModelForTool()` は未設定時 `undefined` を返し Agent が CLI 引数自体を省略）ため「既定を変えるか」は不要判断。Agent（3 OS）・DB・WebUI 個別コードは無変更（`SettingsPage.tsx` はカタログ import 経由で自動追従）。料金テーブル・Flutter UI は元々リポジトリに存在せず新設もしていない
- Agent 側の `connectToServer()` で旧 WS を `removeAllListeners()` + `terminate()` でクリーンアップしてから新 WS を作成
- Agent 側の close ハンドラで `thisWs` 参照をキャプチャし、既に新 WS に置き換えられていたら再接続をスキップ
- `context.userId` は Discord プラットフォーム ID。DB の `Session.userId` には `oldSession.userId` を使う
- **サーバー起動時の ChannelSession 保持**: マシンがオフラインでも `currentMachineId`/`currentSessionId` をクリアしない。サーバー起動時は全マシンが offline のため、クリアすると全セッション情報が消失する。Agent 再接続時に `restoreSessionParticipantsForMachine()` で復元される
- **Agent 更新完了通知**: `pendingUpdateNotify` Map で更新リクエスト元を記録し、Agent 再接続時に `handleAgentConnect()` で完了メッセージを送信
- **Web 参加者の stale 防止**: WS 切断時に `removeWebParticipantFromAllSessions()` で全セッションから即座に除去。再接続時は `//connect` で再登録される。旧実装では Web クライアントは `handleProjectConnect()` で旧セッションから除去されず、stale 参加者が蓄積してメッセージ重複の原因となっていた（#202 で修正）
- **pendingMessages の即座クリア**: WS 切断時に `pendingMessages.delete(chatId)` で即座にクリア。旧実装の 60 秒待機は stale キューのフラッシュによるメッセージ重複を引き起こしていた

---

## Phaser テンプレート対戦基盤

- `testflight --phaser` で生成されるテンプレートにターン制対戦インフラが内蔵
- **GameAdapter パターン**: ゲーム固有ロジック（初期状態、手の適用、CPU AI、表示用状態）をアダプタとして抽象化
- **Vite プラグイン方式**: `configureServer` フックで dev サーバーに WS + 管理画面を追加（追加プロセス不要）
- **WS は noServer モード必須**: `WebSocketServer({ server: httpServer })` は Vite HMR と `upgrade` イベントが衝突する。`noServer: true` + 手動 `handleUpgrade` でパス `/ws` のみゲーム WS に振り分け（#203 で修正）
- **管理画面**: `/stats` でダッシュボード HTML、`/api/stats` で JSON API。Vite の `server.middlewares` で追加
- **マッチメイキング**: FIFO キュー、10秒タイムアウト → CPU フォールバック
- **DB**: Prisma で Player（連勝追跡）+ Match モデル、`prisma db push` でデプロイ時に自動適用
- **デプロイフロー**: `testflight-manager.ts` の `deployPhaserTemplate()` に `prisma db push` ステップ追加

---

## Windows CLI Agent の構造

- `agents/linux/` が Linux + Windows 両対応（`process.platform === 'win32'` で分岐）
- パッケージ名: `@devrelay/agent`（`@devrelay/agent-linux` からリネーム）
- Windows config: `%APPDATA%\devrelay\config.yaml`
- Windows 自動起動: Startup フォルダ + VBS ランチャー（CMD+VBS 二段構成）
- Windows Claude ラッパー: `.cmd` バッチファイル（symlink ではなく）
- PowerShell インストーラー: `scripts/install-agent.ps1`

---

## macOS Agent の構造

- `agents/linux/` をフォークして `agents/macos/` に macOS 専用 Agent を配置
- パッケージ名: `@devrelay/agent-macos`（`agents/linux` の `@devrelay/agent` とは別パッケージ）
- プロセス管理: launchd（LaunchAgent plist）。systemd の macOS 相当
- plist パス: `~/Library/LaunchAgents/io.devrelay.agent.plist`
- macOS config: `~/.devrelay/config.yaml`（Linux と同じパス）
- デフォルト projectsDirs: ホームディレクトリのみ（`/opt` は macOS で一般的でないため除外）
- install-agent.sh: `uname -s` で OS 判定、macOS は `base64 -D`、`sed -i ''`、`darwin-arm64` Node.js URL
- launchd restart: `launchctl kickstart -k gui/$(id -u)/io.devrelay.agent`
- Apple Silicon Homebrew パス: `/opt/homebrew/bin` を PATH に含む

---

## Machine DisplayName (Hostname Alias)

- DB: `Machine.displayName String?`（nullable）
- 表示ルール: `displayName ?? name` を全箇所で使用
- ホスト名レベルエイリアス: `PUT /api/machines/hostname-alias` で同一ホスト名の全 Agent を一括更新
- 自動計算: `handleAgentConnect()` で兄弟マシンの displayName からエイリアスを継承

---

## マルチプロバイダー AI

- SDK: `@anthropic-ai/sdk`, `@google/generative-ai`（apps/server に追加）
- 型: `AiProvider = 'openai' | 'anthropic' | 'gemini' | 'none'`
- SettingKeys: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `BUILD_SUMMARY_PROVIDER`, `CHAT_AI_PROVIDER`
- モデル: gpt-4o-mini / `UTILITY_MODEL_ANTHROPIC`（`claude-haiku-4-5-20251001`、#353 で `packages/shared/src/constants.ts` に集約。要約/解析用の内部固定モデルで `AI_MODEL_CATALOG`＝ユーザー選択可能なモデルとは別軸） / gemini-2.0-flash
- `build-summarizer.ts`: マルチプロバイダー要約サービス（fire-and-forget パターン）
- **`UTILITY_MODEL_ANTHROPIC` を差し替える際の注意（#353）**: 参照元7箇所（`chat-provider.ts`/`build-summarizer.ts`/`conversation-summarizer.ts`/`natural-language-parser.ts`/`dev-report-generator.ts`/`agent-manager.ts`×2）は全て `temperature` を渡している。`temperature`/`top_p`/`top_k` は Claude Opus 4.7 以降で 400 エラーになるため、Opus/Sonnet 系スナップショットへ差し替える場合は先に `temperature` を外すこと。このスナップショット（`claude-haiku-4-5-20251001`）の retirement は 2026-10-15 以降でカタログ内最短

---

## インストーラーの依存関係

| ツール | Linux/macOS | Windows | 扱い |
|-------|------------|---------|------|
| git | 必須（手動インストール） | 必須（手動） | 不足時は中断 |
| Node.js 20+ | 自動インストール（`~/.devrelay/node`） | 自動インストール（`%APPDATA%\devrelay\node`、#327） | 自動インストール失敗時のみ `$Missing++` |
| pnpm | 自動インストール（npm→sudo） | 自動インストール（npm） | 自動 |
| AI CLI（claude/gemini/codex/aider/devin） | 任意（いずれか1つ推奨） | 任意 | 警告のみ・続行 |

- **Windows も #327 (2026-08-28) で Node.js 20 未検出時に公式 zip（`node-v20.20.0-win-<x64|arm64>.zip`）を自動インストールするようになった**（Linux/macOS の `install-agent.sh` と同じ設計）。Windows zip は `bin/` を持たず `node.exe` がアーカイブ直下にある点、`npm install -g pnpm` 直後の `$env:Path` 丸ごとリフレッシュがポータブル Node の PATH 先頭付与を消す点の2つが罠

- **AI CLI は任意**（#261 で Claude Code の必須要件を撤廃）。claude / gemini / codex / aider / devin のいずれか 1 つあれば動作し、1 つも無くても Agent はインストール・起動できる（起動時の `detectAndUpdateAiTools()` が後からインストールされた CLI を config に追加する）。Devin 専用マシンのオンボーディングが可能
  - 経緯: Claude Code は #112 で一度必須依存に変更されたが、Agent 本体は claude なしでも動作する（claude の spawn はセッション実行時のみ、他ツールは各自 spawn）ため #261 で任意に戻した
- **config.yaml の default 決定**: インストーラーは検出された AI CLI のみ `aiTools:` に出力し、`default:` を優先順（claude > devin > gemini > codex > aider）で最初に検出したものにする。1 つも無ければ従来どおり `claude`（起動時自動検出とサーバー側 `aiTools.default || 'claude'` fallback に整合）
- Linux/macOS: `~/.local/bin/claude` がある場合は自動 PATH 追加で救済（従来どおり）

---

## AI ツールの解決順序（セッションがどの AI で動くか）

- **新規セッションの AI ツールは `Project.defaultAi`（DB）を初期値とする**。セッション作成時に `targetProject.defaultAi` を payload に載せ、Agent がそれを spawn する（`command-handler.ts` / `agent-manager.ts`）
- `config.aiTools.default` は **payload に aiTool が無いときのフォールバック**（Agent 側 `config.aiTools.default || 'claude'`）でのみ使われる
- **プロジェクト自動検出時の defaultAi**（#262）: `scanProjects` / `autoDiscoverProjects` は新規登録するプロジェクトの `defaultAi` に `config.aiTools.default` を採用する（引数で伝搬）。これにより Devin 専用マシン（claude 未ログイン）でも自動検出プロジェクトが devin で起動する
  - 以前は `defaultAi: 'claude'` ハードコードで、Devin 専用マシンでも全プロジェクトが claude 扱いになり「Not logged in」で失敗していた（#262 で修正）
  - **Agent→Server の projects sync（upsert）は既存プロジェクトの `defaultAi` を上書きしない**（#307 で変更。以前は毎回上書きしていたため `a` で切り替えた選択がプロジェクト同期のたびに config 由来の値へ巻き戻る潜在バグがあった）。`defaultAi` は `create` 時の初期値としてのみ config 由来の値を使い、以後は DB（サーバー側）を正とする
- **`a`（`handleAiSwitch`）は `Session.aiTool` に加えて `Project.defaultAi` にも永続化する**（#307）。これにより ask/teamexec/MCP などセッションを跨ぐ経路でも選択した AI ツールが引き継がれる
- **セッション切断→再接続時の AI ツール継承**（#307）: `handleProjectConnect()` は active セッションが無い場合、同一 user+project+machine の直近セッション（status 問わず）の `aiTool` を継承して新規セッションを作る。無ければ `Project.defaultAi` にフォールバック。Agent の一時切断（スリープ/NW断）でセッションが `ended` になっても `a` で選んだ AI ツールが claude に巻き戻らないようにするための対策（バグ調査: `doc/changelog.md` #307）
- **`execConversation()`（exec 実行）は DB の `Session.aiTool` を `server:conversation:exec` payload に含めて Agent に伝搬する**（#307）。Agent 側 `handleConversationExec()` はこれを `resolveEffectiveAiTool()`（#289 の未インストール時フォールバックを内包）経由で解決する。以前は Agent 再起動で `sessionInfoMap` が消えていると無条件 `'claude'` にフォールバックする潜在バグがあった（#306 の model 渡し漏れと同型）
- **未ログインガイダンス**（#262）: claude 出力に「Not logged in · Please run /login」を検出したら、生エラーではなく「ログインするか `a` で別 AI に切替」を案内する（3 Agent の ai-runner.ts）
- **Devin plan モードの resume フォールバック**（#263）: devin は plan モードで前回セッション ID を `-r` で resume するが、`-r` + `-p`/`--agent-config` の組み合わせで CLI が**エラーも出力も出さず exit 0 で空振り**することがある。close ハンドラで「resume 使用 + 出力ゼロ」を exit code 不問で検出 → `clearDevinSessionId` で ID 破棄 → `resumeFailed` を立てて汎用リトライへ委譲 → `-r` なしの新規セッションで再実行する（3 Agent の ai-runner.ts）。会話文脈はプロンプトの History context で毎回渡すため resume が切れても継続性は保たれる。exec モードは元々 resume しない（resume したセッションは元の権限モードを保持するため）

---

## インストーラーのトラブルシューティング知見

- **Linux nohup**: `< /dev/null` 必須（`curl|bash` で stdin が消費される）
- **Linux pgrep**: `\.devrelay.*index\.js` パターン（node パスに devrelay が含まれるケースに対応）
- **Linux node パス**: `$(which node)` で絶対パス取得
- **Windows プロセス検出**: `Get-CimInstance Win32_Process` を使う（`Get-Process` は VBS 経由起動で CommandLine が空）
- **Windows アンインストール**: `Stop-Process` 後に `Start-Sleep -Seconds 2` が必要
- **set -e + pgrep/grep**: `|| true` を必ず付ける
- **再インストール時の config.yaml**: token・serverUrl・machineName の3つ全てを更新
- **プロキシ設定順序**: プロキシプロンプトは依存ツールチェック（Step 1）より前に配置（Node.js DL / pnpm 自動インストールで必要）
- **npm/pnpm の proxy config 自動投入**（#229）: `HTTP_PROXY`/`HTTPS_PROXY` 環境変数だけでは `pnpm install` がプロキシを拾わない環境向けに、プロキシ指定時のみ `npm config set proxy/https-proxy`（Node.js セットアップ完了後・pnpm 自動インストール前）と `pnpm config set proxy/https-proxy`（pnpm 検出/インストール完了直後）を実行する。`~/.npmrc` / `~/.config/pnpm/rc` に永続化されるが意図的（次回ビルドでも有効）。削除手順を完了サマリーに明示
- **pnpm 自動インストール**: `npm install -g pnpm` → 権限不足なら `sudo npm install -g pnpm` にフォールバック
- **systemd サービス PATH**: `.bashrc` を読み込まないため `~/.local/bin`（claude CLI）、`~/.devrelay/bin`（devrelay-claude）、Node.js ディレクトリを `Environment=PATH=...` で明示指定
- **systemd プロキシ**: プロキシ環境では `HTTP_PROXY`/`HTTPS_PROXY`/`http_proxy`/`https_proxy` を `Environment=` で設定（大文字・小文字両方必要）
- **macOS LaunchAgent**: plist の `EnvironmentVariables` で PATH に `~/.local/bin` を含め、プロキシも設定
- **crontab 環境変数**: `@reboot PATH=... HTTP_PROXY=... cd ... && node ...` 形式でインライン指定
- **`irm | iex` 配布時の `exit` 罠（#327, 2026-08-28）**: Windows インストーラーは `irm https://.../install-agent.ps1 | iex` のワンライナーで配布される。`Invoke-Expression` はスクリプト文字列を**呼び出し元のスコープ**で実行するため、スクリプト内のトップレベル `exit` は「スクリプト終了」ではなく「呼び出し元の PowerShell ホストそのものの終了（ウィンドウが閉じる）」になる。エラーメッセージを表示した直後に `exit 1` すると、ユーザーが文言を読む前にウィンドウが消える。対策は `exit` の代わりに `return` を使うこと（`iex` 経由でも `.ps1` 直接実行でも安全にスクリプトブロックだけを抜けられる。`try`/`catch` 内でも同様に動作）。あわせて `$ErrorActionPreference = "Stop"` のような対話セッション設定を変更する場合は、実行前に元の値を退避し、全終了経路（各 `return` 直前・正常終了時）で明示的に復元すること（`iex` 実行時はスクリプトのグローバル変更が呼び出し元セッションに残留してしまうため）
- **PowerShell のネイティブコマンドは非ゼロ終了しても例外を投げない（#328, 2026-08-28）**: pnpm/git/npm 等のネイティブコマンド（cmdlet ではない外部 exe）は非ゼロ終了コードを返しても PowerShell の例外機構に乗らない。`$ErrorActionPreference = "Stop"` を設定していても `try`/`catch` では絶対に捕まらない——確認できるのは `$LASTEXITCODE` のみ。これを確認せずに「コマンドを実行した後に処理を続ける」コードは、失敗を握りつぶして成功したかのように先へ進む（実例: `install-agent.ps1` の旧 Step 3 が `pnpm install`/`tsc build` の失敗を検知できず、`agents/linux/dist/index.js` が存在しないまま「インストール完了！」を表示し壊れた Agent を自動起動に登録していた）。**対策は2段構え**: ①ネイティブコマンド実行直後に `$LASTEXITCODE` を確認する（cmdlet を挟んでも `ForEach-Object` 等は上書きしないため、パイプライン処理後でも取得可能。ただしコマンド自体が見つからない場合は `$LASTEXITCODE` が更新されず前回値が残るため、実行前に `$global:LASTEXITCODE = 0` へリセットしておく）。②終了コードだけでなく**期待される成果物ファイルの `Test-Path` も確認する**（`tsc` 等が exit 0 を返しつつ出力を生成しないケースへの保険、二段ゲート）。副次の罠: `$ErrorActionPreference="Stop"` のままネイティブコマンドの stderr をリダイレクト（`2>$null`/`2>&1`）すると、PowerShell 5.1 / 7.0-7.1 では stderr 1 行ごとに `NativeCommandError` が**終了エラー**として送出される（pnpm 等の進捗表示が stderr のため、成功時でも catch に落ちる）。安全に `2>&1` でログを取りたい場合は、実行中だけ `$ErrorActionPreference = "Continue"` に切替え `finally` で復元すること（`install-agent.ps1` の `Invoke-LoggedCommand` ヘルパーが実装例）

---

## 設定ファイル

### Agent 設定
- Linux: `~/.devrelay/config.yaml`
- macOS: `~/.devrelay/config.yaml`
- Windows: `%APPDATA%\devrelay\config.yaml`

```yaml
machineName: ubuntu-dev/user
machineId: ""
serverUrl: wss://devrelay.io/ws/agent
token: drl_xxxxx_xxxxx
projectsDirs:
  - /home/user
  - /opt
aiTools:
  default: claude
  claude:
    command: claude
logLevel: debug
proxy:  # オプション
  url: http://proxy.example.com:8080
```

---

## 起動方法

### 開発時
```bash
cd apps/server && pnpm start      # Server
cd agents/linux && pnpm start     # Agent
cd agents/windows && pnpm build && npx electron .  # Windows Electron Agent
```

### 本番（PM2）
```bash
pm2 start /opt/devrelay/apps/server/dist/index.js --name devrelay-server
pm2 start /opt/devrelay/agents/linux/dist/index.js --name devrelay-agent
pm2 save && pm2 startup
```

---

## インフラ

- ドメイン: `devrelay.io` (server), `app.devrelay.io` (WebUI)
- リバースプロキシ: Caddy
- DB: PostgreSQL
- プロセスマネージャー: PM2
- Git: `murata1215` / `fwjg2507@gmail.com`

---

## Agreement v6 アーキテクチャ

- Agreement ルール本体は `rules/devrelay.md` に配置（CLAUDE.md には軽量マーカーのみ）
- `getAgreementStatusType()` は `rules/devrelay.md` → CLAUDE.md の順でチェック（後方互換）
- v5 以前のプロジェクトに v6 Agent が接続 → `'outdated'` 表示 → `ag` コマンドで v6 に更新可能
- `AGREEMENT_APPLY_PROMPT` はマルチファイル作成: `rules/devrelay.md` + `doc/changelog.md`（ヘッダー） + `rules/project.md`（ヘッダー）+ `doc/issues.md`（Issue 管理）+ CLAUDE.md マーカー更新
- `w` コマンドは `doc/changelog.md` → `rules/project.md` → CLAUDE.md（最小限のみ）→ `doc/issues.md`（Issue ステータス更新）の順で更新

### テンプレート配信方式

- Agreement テンプレートは **Server 側** (`apps/server/src/services/agreement-template.ts`) で管理
- `ag` コマンド実行時、Server が `buildAgreementApplyPrompt()` でプロンプトを生成 → `payload.agreementPrompt` として Agent に配信
- Agent は `payload.agreementPrompt` があればそれを使用、なければローカルの `AGREEMENT_APPLY_PROMPT` にフォールバック
- テンプレート更新は **Server の再起動のみ**で全 Agent に即反映（Agent の再インストール不要）
- Agent 側の `output-collector.ts` のテンプレートはフォールバック用に残す
- WebUI Settings ページからカスタムテンプレートの編集が可能（UserSettings に保存）

### Machine ソフトデリート

- Machine 削除は **論理削除**（`deletedAt` カラム）で行う。物理削除は禁止。
- 削除時に `name` を `${name}__deleted_${timestamp}` にリネーム → `@@unique([userId, name])` 制約を回避
- 削除時に `token` も `deleted_${timestamp}_${token}` にリネーム → 再利用防止
- 関連データ（Session/Message/BuildLog/Project）は一切削除しない → 過去の会話履歴を保持
- 全 Machine クエリに `deletedAt: null` フィルタが必要（約20箇所）
- `findUnique` は `deletedAt` 条件を追加できないため `findFirst` に変更する（Prisma の制約）
- Conversations ページでは relation 経由で削除済み Machine の名前が引き続き表示される

### メッセージファイル BLOB 保存

- `MessageFile` モデル: PostgreSQL `bytea` 型でファイル本体を保存
- `direction`: `'input'`（ユーザー添付）/ `'output'`（AI 出力）
- Server がファイル中継時に MessageFile レコードを同時作成
- `GET /api/files/:id` でバイナリ配信（認証 + Session オーナーチェック）

### ドキュメントディレクトリ構成

```
rules/devrelay.md   ← Agreement ルール（全プロジェクト共通）
rules/project.md    ← 設計判断・注意事項（プロジェクト固有）
doc/changelog.md    ← 実装履歴
doc/                ← その他ドキュメント
CLAUDE.md           ← 軽量ハブ（2,000 トークン以内）
```

---

## WebUI サーバー概念（タブグルーピング）

- 「サーバー」= ユーザー定義のプロジェクトグループ（「開発系」「本番系」等）
- データ構造: `ChatServer { id, name, projectIds }` を `UserSettings` の `chat_servers` キーに JSON 保存
- 左サイドバーが `[Agents] [Servers]` 切り替え（排他表示、上に行を増やさない設計）
- Agents モードでプロジェクト追加時、アクティブサーバーがあれば `projectIds` に自動登録
- タブバーは `activeServerId` で `visibleTabs` にフィルタ（null = 「すべて」表示）
- タブ → サーバーへのドラッグ&ドロップ: `dataTransfer.setData('text/x-devrelay-project', projectId)` で実装
- サーバー内プロジェクト名は `tabCustomNames` → `projectNameMap` → `pid` の順でフォールバック

---

## Agent プロキシ環境変数注入

- Agent の `config.yaml` に `proxy.url` がある場合、Claude Code / Gemini CLI 起動時の `spawn` env に `HTTP_PROXY` / `HTTPS_PROXY` / `http_proxy` / `https_proxy` を自動注入
- Agent 自身の WebSocket 接続は `connection.ts` で `HttpsProxyAgent` / `SocksProxyAgent` を使用（既存）
- AI プロセスは `process.env` を継承するが、Windows の VBS→CMD→node 起動経路では OS 環境変数がないケースがある
- Linux/macOS Agent (`agents/linux`, `agents/macos`) の両方で対応

---

## Server → Agent 設定配信（pending リトライ）

WebUI から Agent の設定（`projectsDirs` 等）を変更した場合、Server は `server:config:update` を WebSocket 経由で Agent に送信する。
ただし WebSocket が半開き状態（TCP は生きているが実際にはメッセージが届かない）になることがあり、
単発の `ws.send()` だけでは配信が保証されない。

### 解決策: ping リトライ機構

1. `pushConfigUpdate()` で `pendingConfigUpdates` Map に登録（`{ config, retries }` 構造）
2. Agent の `agent:ping` 受信時に、ping ハンドラの `ws`（確実に生きている）を使ってリトライ送信
3. Agent は処理完了後に `agent:config:ack` を送信 → Server が pending を削除
4. 旧バージョン Agent は ack を返さないため、最大5回でリトライ打ち切り
5. Agent 再接続時は `server:connect:ack` で DB 最新値が届くため、pending は不要（即クリア）

**重要**: `sendToAgent(machineId, ...)` は `connectedAgents` Map 経由で WebSocket を取得するが、
ping ハンドラでは `ws.on('message')` のコールバックから直接取得した `ws` を使用する。
後者は Agent からメッセージを受信した実績がある WebSocket なので、送信も成功する可能性が高い。

---

## プランモード allowedTools

プランモード（`--permission-mode plan`）はデフォルトで全ての Bash コマンドをブロックする。
しかしログ確認やシステム状態の調査は読み取り専用であり、プラン立案に必要な情報収集のために許可すべき。

### 仕組み

- Claude Code の `--allowedTools` フラグでコマンドパターンを許可
- `--permission-mode plan` と `--allowedTools` を併用すると、指定パターンのみ許可される
- `Bash(pm2 logs)` は pm2 logs を許可するが pm2 restart はブロック（細粒度制御）

### Server DB 管理（#99）

許可ツールリストは UserSettings テーブルで管理し、WebUI から編集可能。

- **UserSettings キー**: `allowedTools:linux`, `allowedTools:windows`（JSON 文字列配列）
- **デフォルト定数**: `DEFAULT_ALLOWED_TOOLS_LINUX` / `DEFAULT_ALLOWED_TOOLS_WINDOWS`（`packages/shared/src/constants.ts`）
- **優先順位**: UserSettings の値 > コード定数（最終フォールバック）
- **Agent 配信**: `server:connect:ack` + `server:config:update` で Agent に配信
  - `managementInfo.os`（`'linux' | 'darwin' | 'win32'`）で Agent の OS を判定
  - Agent 側は `serverAllowedTools` メモリ変数で保持
  - **macOS 注意**: `pushAllowedToolsToAgents()` は `win32` 以外を全て Linux 扱い（`handleAgentConnect` と同じロジック）。`darwin` を個別に判定してはいけない
- **プランモードでのスキル**: Skill ツールはプランモードでブロックされる。`PLAN_MODE_INSTRUCTION` で Bash 経由の直接実行を指示
- **WebUI**: Settings ページで Linux / Windows を横並びで表示（各 OS ごとに独立した Save / Reset ボタン）
- **ユーザー全体設定**: Machine 単位ではなく、ユーザー単位で統一管理

### --allowedTools フォーマット注意点

```
# 正しい: カンマ区切りで1つの --allowedTools に渡す + 引数許可に * 必須
--allowedTools "Bash(pm2 logs *),Bash(pm2 status *),Bash(git log *)"

# 間違い: ツールごとに --allowedTools を繰り返す
--allowedTools "Bash(pm2 logs *)" --allowedTools "Bash(pm2 status *)"

# 間違い: * なし → 完全一致のみ（引数付きコマンドがブロックされる）
--allowedTools "Bash(pm2 logs)"
# → `pm2 logs` は許可されるが `pm2 logs devrelay-agent --lines 10` はブロック
```

**ワイルドカード `*` の意味:**
- `Bash(pm2 logs)` → 完全一致のみ（`pm2 logs` だけ許可）
- `Bash(pm2 logs *)` → プレフィックスマッチ（`pm2 logs` + 任意の引数を許可）
- Claude Code はコマンドチェーン（`&&`, `||`）を検出してブロックするため、`*` があっても安全

### deploy-agent スクリプト

開発リポ（`/opt/devrelay/`）でビルドした Agent を、PM2 で稼働中のインストール済み Agent（`~/.devrelay/agent/`）にデプロイするスクリプト。

```bash
pnpm deploy-agent
# = pnpm build && cp -r agents/linux/dist/* ~/.devrelay/agent/agents/linux/dist/
```

PM2 は `~/.devrelay/agent/` のコードを実行するため、`/opt/devrelay/` でビルドしただけでは反映されない。
このスクリプトでコピー後、`pm2 restart devrelay-agent` で反映される。

---

## Agent リモート更新（#101）

Discord/Telegram から `u` / `update` コマンドで Agent のバージョン確認・更新を実行できる。

### フロー

1. 1回目 `u`: Server → Agent に `server:agent:version-check` 送信
2. Agent が `git fetch` + コミット比較 → `agent:version:info` で結果を返却
3. 更新がある場合、2回目 `u` で `server:agent:update` を送信
4. Agent が detached 子プロセスで `git pull + pnpm build + restart` を実行

### 設計判断

- **detached 子プロセス**: Agent 自身が再起動対象のため、親プロセスが終了してもスクリプトは継続する
- **開発リポジトリ検出**: `~/.devrelay/agent/` 配下でなければ開発リポとみなし更新拒否（`pnpm deploy-agent` を案内）
- **管理コマンド**: `generateManagementInfo()` で検出した restart コマンドを使用（PM2/systemd/nohup 自動判定）
- **Promise パターン**: `checkAgentVersion()` は 30 秒タイムアウトの Promise（git fetch に時間がかかる場合あり）
- **エラー通知**: `pendingUpdateNotify` Map でリクエスト元のチャットに通知（`sendMessage()` 使用）
- **2回連続確認**: `x`（clear）コマンドと同パターンの `pendingUpdate` Set

### stale dist デッドロックの教訓（#256）

**症状**: `u` → `u` が git reset・build まで exit=0 で「成功」するのに、Agent の実行コードがいつまでも古いまま更新されない（Mac で約3ヶ月潜伏）。

**根本原因**: 更新スクリプトを組み立てるのは「今動いている dist」。その dist の update ハンドラが誤ったワークスペース（`@devrelay/agent` = linux）をビルドしていると、実際に実行される dist（`agents/macos/dist`）が再ビルドされない。ソース側でハンドラを修正しても、その修正版 dist が実行されないと反映されない **鶏卵デッドロック**が成立する。git reset は成功するのでログ上はすべて正常に見える。

**教訓・原則**:
- **各 OS Agent の update ハンドラは、必ず自分自身のワークスペースをビルドすること**（macOS は `@devrelay/agent-macos`、Windows は `@devrelay/agent`、Linux は `@devrelay/agent`）。ビルド対象を取り違えると自己更新不能に陥る
- **git commit ベースの表示だけでは stale dist を検知できない**。#256 で `u` のバージョン確認に「実行中コード（`process.argv[1]`）の mtime」を追加。ローカルコミット日時より古ければ `⚠️ 実行中コードが古い可能性` を表示して再ビルド漏れを可視化する（`AgentVersionInfoPayload.runningCodeMtime` / `runningCodeStale`、`command-handler.ts` の `formatRunningCodeLines()`）
- **デッドロックの外部からの破壊**: 一度でも正しいビルドコマンドを外部（teamexec / 手動 SSH）で実行すれば新 dist に置き換わり、以降は自己更新が正常化する

**続き（#350）**: 上記までで「stale dist の可視化」（`⚠️ 実行中コードが古い可能性`）はできていたが、**そこから `u` だけで抜け出す手段が無かった**。`hasUpdate===false`（git は最新）かつ `runningCodeStale===true`（実行中 dist は古い＝ビルド失敗のまま）という組み合わせのとき、`handleUpdate()` は警告表示だけで再ビルドを促す経路が無く、チャットからは自力復旧不可能だった（#328/#329 の成果物ゲートが「壊れたビルドで旧 Agent を殺さない」ことには成功していた分、逆に「壊れたまま生き続ける」固定化を招いていた）。新規 `apps/server/src/services/agent-update-decision.ts` の純関数 `decideUpdateAction()` で `'update'|'rebuild'|'upToDate'` の3値判定に分離し、`'rebuild'`（stale dist デッドロック）のときも `'update'` と同じ `pendingUpdate` フローに乗せて2回目の `u` で既存の再ビルド機構を呼べるようにした（新しい WS メッセージ型・新コマンドは追加せず、既存機構の再利用のみ）。**教訓**: 「異常を検知して可視化する」機能を追加した後は、必ず「検知した異常から実際に復旧できる経路があるか」を別途確認すること。可視化だけでは詰み状態を固定化するだけになりうる。

---

## コマンド定義の単一ソース・オブ・トゥルース

コマンドの定義は `packages/shared/src/constants.ts` の `SHORTCUTS` 定数に集約する。

### SHORTCUTS が参照される箇所
- `command-parser.ts` の `parseCommand()`: ショートカット → UserCommand 変換
- `natural-language-parser.ts` の `isTraditionalCommand()`: 入力がコマンドか AI プロンプトかの判定

### 新コマンド追加時の手順
1. `packages/shared/src/constants.ts` の `SHORTCUTS` にキーを追加
2. `apps/server/src/services/command-parser.ts` の `parseShortcut()` に case を追加
3. `apps/server/src/services/command-handler.ts` にハンドラを追加
4. `apps/server/src/services/command-parser.ts` の `getHelpText()` にヘルプ追加

**注意**: `isTraditionalCommand()` は `SHORTCUTS` を直接参照するため、個別の修正は不要。
動的パターン（`log\d+`, `sum\d+d?`, `ai:*`, `a <arg>` 等）のみ正規表現で個別チェックを行う。

---

## Dev Reports（AI 開発レポート生成）

会話履歴から AI を使って開発レポートを自動生成する機能。

### アーキテクチャ

- **DB モデル**: `DevReport`（レポート全体: タイトル・サマリー・日付範囲）+ `DevReportEntry`（各 exec のエントリ: 要約・変更ファイル・影響度）
- **ジェネレーター**: `apps/server/src/services/dev-report-generator.ts`（マルチプロバイダー対応）
- **独立プロバイダー設定**: `DEV_REPORT_PROVIDER` は他機能（ビルド要約・チャット AI）と独立して設定
- **API キー取得**: `getApiKeyForDevReport()` で Dev Report 用プロバイダーの API キーを取得
- **WebUI**: `DevReportsPage.tsx` でプロジェクト・日付選択 → 生成 → 一覧・詳細・ダウンロード

### API エンドポイント

| メソッド | パス | 説明 |
|---------|------|------|
| GET | `/api/dev-reports/projects` | レポート対象プロジェクト一覧 |
| GET | `/api/dev-reports` | レポート一覧 |
| GET | `/api/dev-reports/:id` | レポート詳細 |
| POST | `/api/dev-reports` | レポート生成 |
| GET | `/api/dev-reports/:id/download` | マークダウンダウンロード |
| DELETE | `/api/dev-reports/:id` | レポート削除 |

---

## nohup Agent の restart コマンド

nohup 起動の Agent は、restart コマンド実行時に旧プロセスを kill してから新プロセスを起動する。

### 背景

systemd/PM2 の restart は自動的に旧プロセスを停止するが、nohup には停止の仕組みがない。
`u` コマンドによる Agent 更新時に旧プロセスが残り、同一 machineId で複数インスタンスが
同時稼働して重複メッセージが発生する問題があった。

### 実装

```bash
# restart コマンド（management-info.ts）
NODE_BIN="<nodePath>"; [ ! -x "$NODE_BIN" ] && NODE_BIN=node; pgrep -u $(whoami) -f "\\.devrelay.*index\\.js" | grep -v "^$$\$" | xargs kill 2>/dev/null || true; sleep 1; cd <dir> && nohup "$NODE_BIN" <index.js> < /dev/null >> <logfile> 2>&1 &
```

- `pgrep -u $(whoami)`: 自分のユーザーの Agent プロセスのみ検索（他ユーザーに影響しない）
- `grep -v "^$$\$"`: 自身の PID を除外（`bash -c "..."` で実行時、cmdline にパターンが含まれるため自殺防止）
- `|| true`: プロセスが見つからなくてもエラーにならない
- `; sleep 1;`: kill の完了を待つ（`&&` ではなく `;` で kill 失敗時も続行）
- `NODE_BIN` フォールバック: `process.execPath` が存在しない場合は PATH 上の `node` を使用

### `u` コマンド更新スクリプトでの注意

`handleAgentUpdate()` は `spawn('bash', ['-c', script])` で更新スクリプトを起動する。
nohup の場合、`restartCmd.command`（management-info.ts 由来）をそのまま使うと、
bash プロセスの cmdline に `.devrelay.*index.js` が含まれるため `pgrep` が自身にマッチし自殺する。

**対策**: nohup installType の場合は `restartCmd.command` を使わず、connection.ts 内で
専用のリスタートコマンドを構築する（`grep -v "^$$\$"` + PATH 上の `node`）。

> **注意**: このスクリプトを生成するのは Agent 自身なので、**修正は対象機の Agent が新しい dist で
> 再起動するまで効かない**。ビルドが失敗し続けている機体では旧スクリプトが使われ続け、
> 更新のたびにプロセスが 1 つずつ増える。2026-08-14 に実際に発生した
> （`doc/agent_noresponse_20260814.md`）。

### Windows Agent のパス判定: `homedir()` vs `getConfigDir()`

Windows では `homedir()` (`C:\Users\<user>`) と `getConfigDir()` (`%APPDATA%\devrelay`) が異なる。
`homedir()` ベースのパスは Linux 固定になるため、Windows で以下の問題が発生する：

1. **`isInstalledAgent()`**: `homedir() + '.devrelay/agent'` → Windows で常に devRepo 判定 → `u` 拒否
2. **`logsDir`**: `homedir() + '.devrelay/logs'` → `update.log` が間違った場所に書き込まれる

**対策**: パス構築には常に `getConfigDir()` を使う。

```typescript
// ✅ 正しい（OS 分岐済みの getConfigDir() を使用）
const installedDir = join(getConfigDir(), 'agent');
const logsDir = join(getConfigDir(), 'logs');

// ❌ 誤り（Linux パス固定 → Windows で不一致）
const installedDir = join(homedir(), '.devrelay', 'agent');
const logsDir = join(homedir(), '.devrelay', 'logs');
```

### Windows 更新スクリプトの stop + restart

Windows の restart コマンドは `wscript.exe` で新プロセスを起動するだけで旧プロセスを停止しない。
更新スクリプトでは restart の前に stop コマンド（`Get-CimInstance Win32_Process` で kill）を実行すること。
Linux nohup では `pgrep | grep -v $$ | xargs kill` で旧プロセスを停止してからリスタートしている。

### Windows PowerShell スクリプト実行: VBS ラッパー経由

Node.js の `spawn('powershell', [...], { detached: true })` は Windows で `DETACHED_PROCESS` フラグを使い、
コンソールなしでプロセスを作成する。PowerShell 5.1 はコンソールなしだとサイレントに即終了する。

**対策**: Agent 起動で実績のある `wscript.exe` + VBS パターンで PowerShell を起動する。

```typescript
// ✅ 正しい（VBS ラッパー経由で PowerShell を起動）
const scriptPath = join(logsDir, 'update.ps1');
writeFileSync(scriptPath, scriptLines.join('\n'), 'utf-8');

const vbsContent = [
  'Set objShell = CreateObject("Wscript.Shell")',
  `objShell.Run "powershell -ExecutionPolicy Bypass -NoProfile -File ""${scriptPath}""", 0, False`,
].join('\r\n');
const vbsPath = join(logsDir, 'update.vbs');
writeFileSync(vbsPath, vbsContent, 'utf-8');

spawn('wscript.exe', [vbsPath], { detached: true, stdio: 'ignore' });

// ❌ 誤り（spawn で直接 PowerShell を起動 → DETACHED_PROCESS でサイレント終了）
spawn('powershell', ['-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
  detached: true, stdio: 'ignore',
});
```

注意:
- `-Command` ではなく `-File` を使うこと（二重引用符の競合回避）
- VBS `.Run` の第2引数 `0` = 非表示、第3引数 `False` = 完了を待たない
- `-NoProfile` でプロファイル読み込みによる遅延を回避

### bash 更新スクリプトのシェル演算子優先順位

`bash -c` で `nohup node ... & disown` を実行する際、`&&` と `&` の優先順位に注意。
bash では `&&` が `&` より高い優先順位を持つため:

```bash
# ❌ 誤り: (cd X && nohup node Y) & disown
# → cd && nohup node 全体がサブシェルで実行され、node がサブシェル内フォアグラウンドになる
# → サブシェル（bash）が node 終了まで残り続ける
cd "/path" && nohup node "/path/index.js" < /dev/null >> "/path/agent.log" 2>&1 & disown

# ✅ 正しい: cd と nohup を `;` で分離
# → nohup node ... & だけがバックグラウンド実行、disown 後に bash 即終了
cd "/path" ; nohup node "/path/index.js" < /dev/null >> "/path/agent.log" 2>&1 & disown
```

`cd` が失敗しても node は絶対パスなので影響なし。

---

## マシン名の自動更新と重複解決

Agent 接続時に DB のマシン名を自動更新する条件:
1. **仮名** (`agent-N`) → 正式名 (`hostname/username`)
2. **旧形式** (`hostname` のみ) → 新形式 (`hostname/username`)

### 重複マシン名の自動解決

同名の offline マシンが既に存在する場合、旧マシン名に `(old)` を付与してリネームし、新マシンに名前を譲る。
例: `tisa-MPro-M600/tisa` (offline) → `tisa-MPro-M600/tisa (old)` にリネーム → 新マシンが `tisa-MPro-M600/tisa` を使用。

online のマシンが重複している場合はリネームしない（意図しない上書きを防止）。

---

## AI 応答の完了メッセージ制御

Agent から Server への `agent:ai:output` メッセージで `isComplete=true` が複数回送信されると、DB に重複 Message が作成される。

### 防止策（二重ガード）
1. **ai-runner.ts**: `completionSent` フラグで `onOutput(true)` の二重呼び出しを防止（`error` + `close` イベント競合対策）
2. **connection.ts**: コールバック側でも `completionSent` ガードを追加（万が一のフォールスルー対策）
3. **resumeFailed**: フラグ設定後に `resolve + return` で早期リターン（retry 側のみが完了メッセージを送信）
4. **connection.ts に try/catch**: `sendPromptToAi` でエラーが発生してもセッションがハングしないよう、エラーを `agent:ai:output` でユーザーに通知

### クロスプラットフォーム同期の注意

`agents/linux/src/services/connection.ts` と `agents/linux/src/services/ai-runner.ts` に安定性修正を入れた場合、**必ず `agents/windows/` の同名ファイルにも同じ修正を適用すること**。Windows Agent はコードベースが別で、乖離するとバグが再発する（#143 で発覚）。

同期すべき主要ポイント:
- `completionSent` ガード（ai-runner.ts + connection.ts 両方）
- `try/catch` for `sendPromptToAi`（connection.ts）
- `usageData` / `allowedTools` / `isExec` / `execPrompt` の対応
- `server:ai:cancel` ハンドラ
- `resumeFailed` 時の早期 return

---

## MessageFile ベクトル検索

### 設計判断

| 判断 | 選択 | 理由 |
|------|------|------|
| 新規モデル vs 既存拡張 | MessageFile に直接 embedding 追加 | ファイルは既に MessageFile に全て保存済み。二重管理を避ける |
| アップロード方法 | 自動（既存フローにフック） | ユーザーの手間ゼロ。ファイル保存時に fire-and-forget で embedding 生成 |
| ベクトル DB | pgvector（PostgreSQL 拡張） | 既存 DB を流用、別サービス不要 |
| embedding モデル | OpenAI text-embedding-3-small (1536次元) | コスト効率と品質のバランス |
| 検索 API 認証 | マシントークン（Authorization: Bearer） | Agent（Claude Code スキル）からの直接呼び出し用 |
| Claude Code 連携 | スキル（SKILL.md + search.sh） | Agent 起動時に自動配置。「〜を参照して」で自動発火 |
| チャンク分割 | なし（全文 embedding、30K文字上限） | シンプルさ優先。大半のファイルは上限内 |

### embedding 処理フロー

```
MessageFile 作成 → fire-and-forget で processMessageFilesEmbedding()
  ├→ テキスト系: 抽出 → OpenAI embedding → pgvector に保存 → status = 'done'
  ├→ バイナリ: status = 'skipped'
  └→ API キーなし: textContent は保存、status = 'skipped'
```

### スキル自動配置

Agent 接続成功時に `~/.claude/skills/devrelay-docs/` を作成・更新:
- `SKILL.md`: スキル定義（Claude Code が自動検出）
- `scripts/search.sh`: config.yaml から認証情報を読み取り、サーバー API を呼び出す

## サービス追加の運用パターン

本番サーバーへの新サービス追加は `doc/service-setup-guide.md` の手順に従う。

### 開発ドメイン方式（推奨）

- 開発用の個人ドメイン（例: `murata1215.jp`）でワイルドカード DNS を設定
- `*.murata1215.jp` → サーバー IP の A レコード1つで全サブドメインが利用可能
- 新サービス追加時は Caddyfile にエントリ追加 + `sudo systemctl reload caddy` だけ
- 本番ドメイン取得後は Caddyfile のドメインを差し替えて移行

### サービス = Linux ユーザー

- 1サービス = 1 Linux ユーザー（例: pixshelf, pixdraft, clipped）
- 各ユーザーが独自の SSH 鍵、DevRelay Agent、Claude Code 認証を持つ
- コード配置先: `/opt/<サービス名>/`

---

## WebUI チャット設計判断

### チャット表示設定は localStorage
- サーバー API を使わず、`localStorage` で管理（キー: `devrelay-chat-display`）
- 即座に反映、軽量、サーバー負荷なし
- `storage` イベントで他タブと同期
- アバター画像も data URL で localStorage に保存（数十KB、容量問題なし）

### 履歴画像の認証方式
- `<img>` タグは Bearer ヘッダーを送れないため、`/api/files/:id?token=xxx` クエリパラメータ方式
- `getToken()` で localStorage からトークン取得
- 既存の `getDownloadUrl()` と同じパターン

### 添付ファイルの二段階表示
- **リアルタイム（送信直後）**: `content`（base64）→ blob URL で表示
- **履歴（API 取得）**: メタデータのみ（`id`, `filename`, `mimeType`）→ `/api/files/:id` で表示
- `ChatMessage.files` の型で `id?` / `content?` を両方オプショナルにして統一

### ChatPage 常時マウント
- 画面遷移時に ChatPage をアンマウントすると WebSocket 接続やメッセージ state が失われる
- `ProtectedContent` コンポーネントで ChatPage を常時マウントし、`display:none` で表示/非表示を制御
- `/chat` 以外のページでは ChatPage は DOM に存在するが非表示

### チャット履歴のクロスセッション取得
- セッション単位（`GET /api/sessions/:id/messages`）だと、サーバー再起動で新セッション作成後に旧メッセージに遡れない
- プロジェクト単位（`GET /api/projects/:projectId/messages`）で全セッション横断取得に変更
- `loadHistory()` / `loadOlderMessages()` は `projectId` ベースで API を呼ぶ
- コンテナが非スクロール（メッセージ少）な場合は `useEffect` で自動追加読み込み

### ピン止めタブのサーバー永続化
- `UserSettings.PINNED_TABS` キーでサーバーに保存
- 復元時: サーバー → localStorage フォールバック
- 異なるデバイスからアクセスしてもタブ状態が同期される

### Doc Folder ファイル同期
- DocPanel にアップロードしたファイルは DB（AgentDocument）に保存 + Agent ローカル（`~/.devrelay/docs/`）にも同期
- WebSocket メッセージ `server:doc:sync`（base64 ファイル送信）/ `server:doc:delete` で同期
- ファイル名にパストラバーサル（`/`, `\`, `..`）が含まれる場合は拒否
- bodyLimit: Fastify デフォルト 1MB → ドキュメント API は 50MB に引き上げ
- Embedding: text-embedding-3-small の 8192 トークン制限 → MAX_TEXT_LENGTH 6000（CJK は約 1.5 倍トークン消費）

### --resume スタートアップタイムアウト
- `--resume` で古い/巨大なセッションを再開すると Claude Code プロセスがハングすることがある
- 60 秒以内に stdout 出力がなければ `resumeFailed = true` → SIGTERM → `--resume` なしでリトライ
- 既存の `resumeFailed` メカニズム（exit code 1）と統合

### Git リモートブランチ動的検出
- `u` コマンドで `origin/main` がハードコードされていると、デフォルトブランチが異なるリポジトリでエラー
- `detectRemoteBranch()`: `git symbolic-ref refs/remotes/origin/HEAD` → `origin/main` → `origin/master` の順で検出
- bash/PowerShell 更新スクリプト内でも同様にインラインで動的検出

---

## チーム管理 + クロスプロジェクトクエリ

### データモデル
- `Team`: ユーザーが作成する名前付きグループ（`@@unique([userId, name])`）
- `TeamMember`: Team に属するプロジェクト（`@@unique([teamId, projectId])`、`onDelete: Cascade`）
- 旧 `ProjectMember` モデル（プロジェクト→プロジェクトの1対多）は #160 で廃止

### API 構成
- **WebUI 向け**: `GET/POST/DELETE /api/teams`、`POST/DELETE /api/teams/:teamId/members`
- **Agent 向け**: `GET /api/agent/members`（チームメイト一覧）、`POST /api/agent/ask-member`（質問送信）、`POST /api/agent/teamexec-member`（実行依頼送信）
- **Discord/Telegram**: `ask <project>: <question>` / `teamexec <project>: <instruction>` / `te <project>: <instruction>` コマンド

### クロスプロジェクトクエリの流れ（ask）
1. 質問送信 → `executeCrossProjectQuery()` で一時セッション作成（`crossquery_` プレフィックス）
2. ターゲットプロジェクトの Agent に `server:session:start` + 質問プロンプト送信
3. Agent が Claude Code を起動してコードを分析・回答
4. `handleAiOutput(isComplete=true)` → `pendingCrossQueries` Map の Promise を resolve
5. 回答を HTTP レスポンスとして返却（タイムアウト: 5分）

### ask への `--ai` 上書きオプション（#325, 2026-08-23。Council v1 の土台）
- `POST /api/agent/ask-member` の body に任意の `ai` を追加すると、対象プロジェクトの `Project.defaultAi` を無視してその ask 1 回だけ使用 AI を上書きできる（`ask.sh --ai codex` 等）。省略時は完全に従来どおり
- **「対象マシンで利用可能な AI」の判定は DB ではなくライブ問い合わせ**: `Machine` に利用可能 AI を保持するカラムは無く、Agent 接続時に送られてくる `AgentConnectPayload.availableAiTools` もサーバー側で destructure されるだけで未使用（実測確認）。新カラム・新 WS メッセージ型は作らず、`a` コマンドが使う既存の `getAiToolList(machineId, sessionId)`（`server:ai:list` 往復）をそのまま再利用した。`sessionId` は Agent 側でエコーバックにしか使われないため、未作成の一時 ID（`aicheck_<uuid>`）を渡しても安全
- **静かなフォールバック禁止の実現方法**: Agent 側 `resolveEffectiveAiTool()`（#289 の Devin 専用端末救済）は未インストール AI を要求されると黙って別 AI に差し替えるため、そのままでは「明示エラーで停止」を満たせない。**サーバー側で送信前に可用性チェックを行い、通らなければ 400 で止める**ことで対応（Agent 側は無変更、#289 の既存救済ロジックも無傷）
- `--ai` は ask 専用。`teamexec-member` ルート・`ask.sh` の teamexec 分岐には一切変更を加えていない（`--ai`+`--exec` はスクリプト側でエラー終了）

### クロスプロジェクト実行依頼の流れ（teamexec）
1. 実行指示送信 → `executeCrossProjectExec()` で一時セッション作成（`teamexec_` プレフィックス）
2. `startSession()` → 500ms 遅延 → `execConversation()` で exec マーカー付きセッションを起動
3. `execConversation()` 内部で `handleConversationExec()` → exec マーカー追加 + `handleAiPrompt()` 自動呼び出し
4. Agent は `--dangerously-skip-permissions` でコード変更を含む実行を行う
5. `handleAiOutput(isComplete=true)` → `pendingCrossQueries` Map の Promise を resolve
6. 回答を HTTP レスポンスとして返却
7. HTTP 切断検知: `request.raw.on('close')` → `cancelPendingCrossQuery()` でセッションクリーンアップ

### タイムアウト階層（#214）

| レイヤー | ask (質問) | teamexec (実行依頼) | 備考 |
|---------|-----------|-------------------|------|
| curl `--max-time` | 600秒（10分） | 3600秒（60分） | ask.sh 内 |
| SKILL.md Bash timeout | 720000（12分） | 3660000（61分） | curl より長く設定必須 |
| サーバー Promise | 43200000ms（12時間） | 43200000ms（12時間） | 最終防衛線 |

**重要**: curl が先にタイムアウトするとサーバーの Promise だけが残り、セッションが active のまま stuck する。
そのため `request.raw.on('close')` で HTTP 切断を検知し、`cancelPendingCrossQuery()` でクリーンアップする。

### Project displayName（#212）

`Project.displayName` カラムで表示名をユーザーが変更可能（null なら `name` = ディレクトリ名を使用）。
Machine.displayName と同じパターン。内部は全て projectId で動作するため表示層のみの変更。
ask.sh のメンバー検索は `displayName` と元の `name` の両方で部分一致検索する。

### Agent スキル
- `devrelay-ask-member`: エージェント起動時に `~/.claude/skills/` に自動配置
- `ask.sh --project X --question "..."` で質問（プランモード）、`ask.sh --exec --project X --question "..."` で実行依頼（exec モード）
- 質問/依頼する側のみスキルが必要。受ける側はサーバーが直接 Claude Code を起動
- **JSON 構築には `jq -n --arg` を使用**（shell エスケープは脆弱なため禁止）
- **SKILL.md に Bash timeout 指示が必須**（ask: 720000ms、teamexec: 3660000ms — curl timeout より長く設定）

### 送信元プロジェクト表示（#199）
- `Message.sourceProjectName` カラムでクロスクエリの送信元を記録
- REST API 経由: `auth.machineId` から DB でプロジェクト名を特定（1マシン1プロジェクトならプロジェクト名、複数ならマシン displayName）
- Discord/Telegram 経由: `context.currentProjectName` を使用
- WebUI チャット: ユーザー名横にバッジ、Conversations: 🔗 バッジに送信元名追加

### Google ID Token 検証（#199）
- `POST /api/auth/google/token`: Flutter `google_sign_in` の `idToken` を検証してセッション発行
- Google `tokeninfo` エンドポイント + `aud` チェック（外部ライブラリ不要）
- Flutter 側 `serverClientId` に Web 用 `GOOGLE_CLIENT_ID` を指定すれば追加対応不要

### 注意事項
- `authenticate` ミドルウェアは `request.user` を設定。`request.userId` ではない
- Team API エンドポイントは `(request as any).user.id` でユーザー ID を取得

---

## 今後の課題

- LINE 対応
- Gemini CLI / Codex / Aider 対応
- ベクトル検索のチャンク分割対応（大規模ドキュメント向け）
- WebUI でのドキュメント横断検索インターフェース
- 複数ユーザー同時接続
- エラーハンドリング強化

---

## Agent SDK 移行 (#178)

### 設計判断

1. **Claude のみ SDK 移行**: `@anthropic-ai/claude-agent-sdk` の `query()` で実行。Gemini/Codex/Aider は従来の `spawn` パスを維持
2. **`canUseTool` コールバックによるパーミッション制御**: exec モードでは SDK の `canUseTool` が全ツール実行前に呼ばれ、WebSocket 経由でユーザー承認を求める。30分以上の非同期待機にも耐える（実証済み）
3. **「以降すべて許可」モード**: `approveAllMode` フラグ（Agent 側メモリ）で管理。セッション単位で有効、Agent 再起動でリセット
4. **承認カード 2秒後自動非表示**: 許可/拒否確定後に 2秒で承認カードをチャットエリアから削除。右パネルの Approval History には永続表示
5. **参加者フォールバック**: `getSessionParticipants()` で Web 参加者が見つからない場合、全 Web クライアントにフォールバックブロードキャスト（サーバー再起動後の参加者復元不整合を回避）
6. **machineId**: Agent からの承認リクエストでは `currentMachineId`（Server から受信した DB ID）を優先使用。`currentConfig.machineId` は config.yaml 由来で空文字列の場合があるためフォールバックのみ
7. **`approveAllMode` リセット**: `handleSessionStart()` で `resetApproveAllMode()` を呼び出し、新セッション開始時に自動的にリセット。これにより「以降すべて許可」は現在のセッション限定で有効

### ツール承認履歴の永続化 (#179-#180)

- **DB**: `ToolApproval` テーブルに全承認イベント（pending/allow/deny/auto/timeout）を記録
- **API**: `GET /api/projects/:projectId/approvals` （カーソルベースページネーション、デフォルト100件）
- **WebUI**: タブ切替時に API から履歴ロード。WebSocket リアルタイム通知とマージ。ブラウザ更新でも履歴が消えない
- **Agent JSONL ログ**: `~/.devrelay/approvals/current.jsonl` に追記。Agent 起動時に `archive/` にローテーション（削除なし）
- **自動承認通知**: `agent:tool:approval:auto` → `web:tool:approval:auto` で WebUI に中継。🔓 紫色アイコンで表示

### ツール個別許可 (#185)

Claude Code のパーミッションシステムと同等の機能。承認カードの「📌 常に許可」ボタンで永続ルールを作成。

- **ルール形式**: Plan Mode の `allowedTools` と同じパターン（`Bash(git *)`, `Edit`, `Read` 等）
- **ルール生成**: `generateToolRule()` — Bash はコマンド先頭語をプレフィックスマッチ、他ツールはツール名のみ
- **永続化**: UserSettings `execAllowedTools` キー（JSON 文字列配列）
- **配信**: `server:connect:ack` / `server:config:update` の `execAllowedTools` フィールド
- **Agent 側**: `canUseTool` の先頭で `isToolExecAllowed()` チェック → マッチ時に自動承認 + `agent:tool:approval:auto` 通知
- **チェック優先順**: exec allowed rules → approveAllMode → ユーザーに聞く
- **全プラットフォーム**: WebUI / Discord / Telegram に「📌 常に許可」ボタン追加
- **Settings ページ**: 「Allowed Tools (Exec Mode)」セクション（チップ/タグ形式、× で個別削除）
- **API**: `GET/PUT /api/settings/exec-allowed-tools`

## プロトコルバージョン管理 (#186)

Agent/Server 間の互換性管理。古い Agent を検出し会話を制限する仕組み。

- **PROTOCOL_VERSION**: `packages/shared/src/types.ts` に定義（Agent がビルド時に焼き込む整数値）
- **MIN_PROTOCOL_VERSION**: `apps/server/src/services/agent-manager.ts` に定義
- **ソフトリジェクション**: 接続は許可（オンライン表示）、`sendPromptToAgent` でブロック
  - 古い Agent は `u` コマンドで更新可能（接続が維持されるため）
  - `outdatedAgents` Set で管理、disconnect 時にクリア
- **バージョンアップ手順**: shared の `PROTOCOL_VERSION` インクリメント → server の `MIN_PROTOCOL_VERSION` を上げる

## AskUserQuestion 対応 (#191)

Claude Code の `AskUserQuestion` ツールを DevRelay 経由で中継する仕組み。

- **deny-with-answer パターン**: `canUseTool` で `AskUserQuestion` をインターセプト → ユーザーに質問送信 → 回答を `{ behavior: 'deny', message: 'User answered: ...' }` で Claude に返す
  - `deny` で返す理由: `allow` だと CLI が TUI ダイアログ表示しようとして headless 環境でハングする
  - Claude は `message` を tool_result として読み取り、回答を理解して続行する
- **既存パイプライン流用**: `ToolApprovalRequestPayload` に `isQuestion?: boolean` フラグ追加、`ToolApprovalResponsePayload` に `answers?: Record<string, string>` 追加
- **plan/exec 両モード対応**: plan モードでも `canUseTool` を設定し AskUserQuestion のみインターセプト
- **approveAllMode スキップ**: 質問は常にユーザーに聞く（自動承認しない）
- **WebUI QuestionCard**: 選択肢ボタン + 「その他...」自由テキスト入力。ダークモードでもライトと同じ配色（明るい背景 + 黒文字）
- **AskUserQuestion の input 構造**: `{ questions: [{ question, header, multiSelect, options: [{ label, description }] }] }`

## Agent ログローテーション (#189)

- **方式**: copyTruncate（nohup stdout リダイレクトと互換、fd を壊さない）
- **タイミング**: 起動時 + 24時間ごとに `agent.log` をチェック
- **ローテーション**: 最終更新が昨日以前 → `agent_YYYYMMDD.log` にコピー → truncate
- **保持期間**: 7日超の `agent_*.log` を自動削除
- **実装**: `agents/linux/src/services/log-rotator.ts`（macOS も同一）

## Agent ごとの全許可モード (#194)

- **Machine.skipPermissions**: DB カラム（Boolean, default false）
- **配信**: `server:connect:ack` / `server:config:update` の `skipPermissions` フィールド
- **Agent 側**: `canUseTool` の先頭（sessionApproved / approveAllMode の前）でチェック
- **AskUserQuestion 除外**: 質問は常にユーザーに聞く（skipPermissions の対象外）
- **WebUI**: Agent Settings モーダルにトグルスイッチ、`PUT /api/machines/:id/skip-permissions` API
- **リアルタイム反映**: WebUI で ON/OFF → `pushConfigUpdate()` → Agent に即時配信

## プロジェクト概要 Ask (#211)

チーム管理ページからエージェントにプロジェクト概要を問い合わせる機能。

- **DB**: `Project.description String?` カラム（概要テキスト保存用）
- **API**: `POST /api/projects/:projectId/ask-description` → `executeCrossProjectQuery()` で「概要を教えて」→ 回答を `Project.description` に保存
- **WebUI**: チーム名横「Ask 📋」ボタン → 全オンラインメンバーに並列リクエスト → メンバー行下に表示
- **設計判断**: 概要は DB に永続化。次回表示時は API から取得、Ask ボタンで再取得可能。60秒タイムアウト

## クロスプロジェクトループ防止 (#211, #294)

同一マシンから同一ターゲットへの自己送信ループを防止。

- **検出**: `ask-member`/`teamexec-member` で同一マシン → 同一ターゲットの直近5分以内のセッション数をカウント
- **閾値**: 3回以上で HTTP 429 拒否
- **表示**: `/api/agent/members` に `isSameMachine` フラグ、ask.sh で `[自マシン]` マーク
- **設計判断**: 送信自体はブロックしない（nim → devrelay のような正当な同一マシン間通信を許可）。閾値で異常検知

### 宛先の事前登録を強制 (#295)

宛先は **Team に登録されたプロジェクトだけ**。許可集合＝ `/api/agent/members` が返すもの（発信元マシンと同じ Team のメンバー）。

- **サーバーが最終防衛線**: `document-api.ts` の `checkCrossTargetAllowed()` を ask/teamexec 両エンドポイントで実行し、未登録は 403。
  判定クエリは members エンドポイントの絞り込みと**同形**にすること（一覧と許可判定がズレると「見えるのに送れない／見えないのに送れる」が起きる）
- **フォールバックを作らない**: 旧 `ask.sh` は未ヒット時に `/api/agent/inventory`（ユーザーの全プロジェクト）へフォールバックしていた。
  こういう経路は許可リストを無効化するので置かない
- **チャット側も同じ許可集合**: `command-handler.ts` の `resolveCrossTargetByName()`。発信元マシンが曖昧なため
  「ユーザー所有 Team のメンバー全体」を許可集合とし、複数一致は候補提示で中止
- **移行措置**: Team を 1 つも作っていないユーザーのみ従来どおり全許可（`legacy: true` でログに警告）。1 つ作れば厳格モード
- **同一マシン上の別プロジェクトも登録必須**: 31 プロジェクト載っているマシンがあり、無条件許可ではノイズが戻るため

### マシン跨ぎのピンポン対策 (#294)

#211 の同一マシン限定ガードでは **A→B→A のマシン跨ぎ往復**を止められず、2026-08-13 に teamexec が
8 分で 30 ホップ超える暴走を起こした（同名の `pixblog` が 16 台に存在し、本番 DB を持たない Windows 機へ
実行依頼が飛び、実行不能なので送り返される、を繰り返した）。以下を多層で追加（`document-api.ts`）。

- **ホップ制限（本命）**: `findInflightTeamExec()` で発信元マシンに実行中（65分窓）の `teamexec_*` セッションがあれば 429。
  teamexec の転送を禁止＝**ホップ深さを 1 に固定**する。ask（読み取り専用）は転送を許可（B が C に事実確認する正当用途があるため）
- **マシン横断レート制限**: teamexec は同一ターゲット 5 回/5分・ユーザー全体 12 回/5分、ask は 8 回・20 回で 429。
  ユーザー全体の閾値は「同一ターゲットで弾かれた AI が宛先を変えて回り続ける」逃げ道を塞ぐためのもの（実際に wprewriter-agent へ飛び火した）
- **429 文面に `NO_RETRY_NOTE` を必ず付ける**: AI はエラーを**文面を変えた再送**で回避しようとするため、
  「同じ依頼を文面を変えて再送しないでください。ユーザーに報告して停止してください」を明記する
- **起動時スイープ**（`index.ts`）: `teamexec_`/`crossquery_` の `status='active'` を `ended` に。
  これらは HTTP リクエストの生存期間しか意味を持たず、取り残されるとホップ判定が誤検知する
- **宛先解決の厳格化**（`skill-manager.ts` linux/macos）: ask.sh は 完全一致 > online > 同一マシン の順に絞り、
  **複数残ったら自動選択せず候補一覧を出して exit 1**（`--machine <マシン名>` で指定）。
  「先頭一致を黙って採用」は同名プロジェクトが複数マシンにある環境で暴走の起点になる
- **調査の勘所**: `Message.sourceProjectName` で送信元→宛先のホップを追跡できる。
  `BuildLog #N created for X` がプロジェクト交互に出ていたらピンポンを疑う

## クロスプロジェクト承認中継 (#210)

teamexec/crossquery で発信元タブにも承認カードを表示する仕組み。

- **参加者コピー**: `document-api.ts` の teamexec/ask-member エンドポイントで、発信元マシンのアクティブセッション参加者を一時セッションに `addParticipant()` でコピー
- **originProjectId**: `handleToolApprovalRequest()` で `teamexec_`/`crossquery_` セッション検出 → 発信元プロジェクト ID を取得 → ペイロードに追加
- **WebUI フィルタ**: `.filter(a => ... || a.originProjectId === activeTabId)` で発信元タブにも承認カード表示
- **設計判断**: ターゲット側にも引き続き表示（Web 全クライアントフォールバック）。どちら側からでも承認/拒否可能

## crontab PATH 修正 (#210)

crontab `@reboot` エントリで環境変数が子プロセスに継承されない問題の修正。

- **原因**: `PATH=... cd ...` だと PATH が cd にしか適用されず、`node` の `process.env.PATH` に含まれない
- **修正**: `export PATH=...; cd ...`（export + セミコロン追加）
- **install-agent.sh**: 新規デプロイ時に正しい形式で登録
- **Agent update**: `handleAgentUpdate()` の buildSteps に sed 修正ステップ追加。`u` コマンドで既存 crontab も自動修正

## プロジェクト検出マーカー (#192, #255)

`looksLikeProject()`（内部で `detectProjectMarker()` を呼ぶ）で以下のマーカーを検出:
1. `CLAUDE.md` ファイル（従来・最優先）
2. `.xcodeproj` ディレクトリ（iOS/macOS 開発）
3. `pubspec.yaml`（Flutter/Dart。#255 で追加）
4. `settings.gradle` / `settings.gradle.kts`（Android/Gradle。#255 で追加）

### 生 `flutter create` 対応（#255）
- **背景**: 対象マシン上の Claude は `devrelay-create-project` スキルを使わず素の `Bash: flutter create` を実行することがある（スキル使用を強制できない）。素の生成物は CLAUDE.md を置かないため、#254 まではマーカー 1・2 だけでは認識されず一覧に現れなかった
- **CLAUDE.md 自動配置**: `autoDiscoverProjects()` がマーカー検出で**新規登録した**プロジェクトに CLAUDE.md が無ければ `ensureAutoClaudeMd()` で最小限のもの（検出タイプ付き）を自動生成する。「作成したプロジェクトには CLAUDE.md 必須」ポリシーを維持。既存プロジェクトは上書きせず、書き込み失敗は warn ログのみで登録は継続（非致命的）
- **top-level 検出の副次効果**: pubspec.yaml マーカーにより Flutter プロジェクトが top-level で検出されて再帰スキャンが止まるため、`<app>/ios/Runner.xcodeproj` や `<app>/macos` サブフォルダが誤ってプロジェクト登録される潜在バグも防げる

### exec 完了時の自動再スキャン（#255）
- `connection.ts` の `rescanProjectsAndSync(config)` が projectsDirs を再スキャン → `loadProjects` → `sendProjectsUpdate` を実行（scaffold ハンドラと同じ 3 ステップを関数化）
- 呼び出しは **exec モードの AI 実行完了時のみ**（`isComplete && isExecTriggered`。通常経路 + --resume リトライ経路の 2 箇所、linux/macos とも）。plan モードでは走らない（プロジェクト作成は exec で起こるため）
- これにより「flutterアプリ作って」→ exec 完了と同時に一覧へ反映される（Agent 再起動不要）。Server 変更なし（既存 `agent:projects` 同期を利用）

## Manager（オーケストレーター）機能 (#240)

案B（オーケストレーター Agent + スキル）。Manager は通常プロジェクト上の Claude Code として動作し、既存の ask/teamexec/Plan-Exec を再利用する。

### API 設計
- **`/api/agent/inventory`** は Team に依存しない全プロジェクト一覧。`userId` で Machine → Project を引く
  - `/api/agent/members` は Team ベースのメンバー一覧（ask-member 用）として分離
  - 理由: Manager は全プロジェクトを見たいが、Team 登録に依存すると Manager プロジェクト自体を全 Team に入れる運用が必要になり煩雑
- **`/api/agent/scaffold`** は WS `server:scaffold:create` → `agent:scaffold:created` で Agent に雛形作成を指示
  - `pendingScaffolds` Map で応答待ち（5 分 timeout）、testflight-manager と同じバリデーションルール

### スキル構成
- `devrelay-list-inventory`: inventory API 呼び出し（Team 不要の全一覧）
- `devrelay-create-project`: scaffold API 呼び出し（テンプレート展開）
- `devrelay-ask-member`: 既存流用（質問 / exec 委譲）。**inventory フォールバック付き** — `/api/agent/members` で見つからなければ `/api/agent/inventory` で再検索するため Team 未登録プロジェクトにも問い合わせ可能
- Agent 起動時に `ensureSkillFiles()` で 4 スキル全て自動生成

### 接続プロジェクト方式（Remote Command Forwarding）
- teamexec 成功後、ターゲットを `UserContext.lastRemoteProjectId` に記憶
- `handleExec()` 冒頭で `lastRemoteProjectId` があれば `handleTeamExec()` に転送（`e` / `w` 両方対応）
- `d` / `disconnect` コマンドで接続解除 → 以降の exec は自身のプロジェクトに戻る
- 新しい teamexec が走ったら接続先が上書きされる
- 転送対象は exec 系（`e`, `w`）のみ。`p`, `x`, `s` 等の管理コマンドは転送しない

### v1 スキップ項目
- `UserSettings.manager_project`（ルーティング未実装のため不要）
- `scaffoldDir` config（`projectsDirs[0]` をデフォルト使用）
- route-resolver フック（ルーティング機能自体が未実装）

## scaffold テンプレート（#254）

#240 の `vite-react-web` 単一テンプレートを、モバイル/マルチプラットフォーム対応の 5 テンプレートに拡張。

### テンプレート一覧

| ID | 生成方法 | 対応 OS | 要ツール |
|----|---------|--------|---------|
| `vite-react-web` | 静的ファイル + `npm install` | 全 OS | なし |
| `flutter-app` | `flutter create --project-name <snake> --org com.devrelay .` | 全 OS | `flutter` |
| `android-kotlin` | 静的 Gradle Kotlin DSL 展開 + `gradle wrapper`（任意） | 全 OS | なし |
| `xcode-swiftui` | `project.yml` 展開 → `xcodegen generate` | **darwin のみ** | `xcodegen` |
| `empty` | CLAUDE.md + .gitignore のみ | 全 OS | なし |

### 設計判断
- **単一ソース**: テンプレートの id / os / requiredTool は shared `SCAFFOLD_TEMPLATE_DEFS`（`constants.ts`）で一元管理。サーバー検証・スキル SKILL.md/create.sh 生成が全てこれを参照する（重複定義を排除）
- **OS 自動制限**: サーバー `document-api.ts` が `Machine.managementInfo.os` を見て、テンプレートの `os` 配列に含まれなければ 400 で拒否（例: Linux マシンに `xcode-swiftui` を指定 → 「macOS マシンでのみ使用できます」）
- **CLI ジェネレータ方式**: `flutter` / `xcodegen` はマシンにインストール済み前提。Agent 側 `commandExists()`（which/where）で検出し、未検出時は `agent:scaffold:created` で `ok: false` + `brew install` 等の案内を返す（生成前にフェイルファスト）
- **CLAUDE.md 必須配置**: 全テンプレートで CLAUDE.md を後置きする（CLI ジェネレータ実行後）。`looksLikeProject()` が CLAUDE.md 検出ベースのため、これがないと作成直後に DevRelay へ認識されない（生の `flutter create` だけでは認識されない事故があった）
- **flutter プロジェクト名**: ハイフン不可のため `--project-name` には `name.replace(/-/g, '_')` を渡す（ディレクトリ名は指定名のまま）
- **テンプレート実体は Agent 側のみ**: `SCAFFOLD_TEMPLATES` レジストリ（`agents/<os>/src/services/scaffold-templates.ts`）に `kind: 'files' | 'command'` + `requiredTool` / `buildCommand` / `postCommand` / `postInstall` で構造化。npm install ハードコードを廃し per-template 化。サーバー `web-templates.ts` は二重管理を避けるため未参照

### macOS Agent への移植
- `xcode-swiftui` は macOS 専用のため、scaffold 機能一式（connection.ts の `server:scaffold:create` ハンドラ + handleScaffoldCreate + commandExists、scaffold-templates.ts、skill-manager.ts の `devrelay-create-project` スキル生成）を linux から macOS Agent へ移植。テンプレート内容は linux と同一

## Flutter 実機デプロイスキル `devrelay-flutter-deploy`（#266）

Flutter アプリを USB 接続された実機（iPhone/Android）にチャット経由でビルド＆インストールするスキル。`flutter run --release` の手打ち（NoMachine 経由）を排除する。GUI 案（flutter-manager）は中止し、DevRelay 標準スキルとして整備。

### 設計判断
- **ローカル実行スキル = サーバー API 不要**: docs/ask-member/create-project スキルは DevRelay サーバー API を叩くため `serverUrl`/`token` を埋め込むが、flutter-deploy は `flutter` コマンドをマシン上でローカル実行するだけなので serverUrl/token 不要。`generateFlutterDeployScript()` は**引数なし**。これによりサーバー・DB・shared の変更ゼロ、Agent の再ビルドのみで完結
- **マシン共通配置の活用**: スキルは `~/.claude/skills/` に置かれマシン単位で共有されるため、同一マシン上の全 Flutter プロジェクトのセッションから利用可能（プロジェクトごとの登録不要）
- **iOS = macOS のみ / Android = 全 OS**: `targetPlatform` が `ios` かつ `uname != Darwin` ならエラー終了。Android は Windows/macOS/Linux で `flutter build apk` → `flutter install`
- **非対話ビルド**: `flutter run`（対話型で終了しない）は使わず `flutter build ios|apk` → `flutter install -d <id>`。`--flavor`/`--dart-define` は build にパススルー、install は flavor のみ渡す（install は dart-define を受け付けないため）
- **デバイス解決**: `flutter devices --machine` の JSON を jq でパースし、`emulator == false` かつ `targetPlatform ^(ios|android)` の実機のみ対象。`--device` は name/id への大文字小文字無視の部分一致（se3 → iPhoneSE3）。0件 → USB 接続ガイダンス、複数 → 候補列挙
- **bash 3.2（macOS 標準）互換**: 空配列 + `set -u` で `${arr[@]}` が unbound エラーになる問題を空安全イディオム `${arr[@]+"${arr[@]}"}` で回避。TS テンプレートリテラル内は `\${` エスケープが必要
- **Windows は linux 版で自動カバー**: Windows CLI 機は `agents/linux` を実行しているため linux 版 skill-manager に入れれば自動配布される（Git Bash で .sh 実行）。Electron GUI 版 `agents/windows` は skill-manager が存在せず対象外
- **対象ファイル**: `agents/{linux,macos}/src/services/skill-manager.ts` の 2 ファイルのみ（定数 + `generateFlutterDeploySkillMd()` + `generateFlutterDeployScript()` + `ensureSkillFiles()` への writeFile 追加）

## エンタープライズ統制 v2 — manager ロール + コマンド発行ゲート（#268）

#264（Organization v1: admin/member 2ロール）の上に統制を追加。admin/manager/member の3ロールと「担当マネージャー未割当の member はコマンド発行不可」という deny-by-default の統制を実装。

### 設計判断
- **単一チョークポイントでゲート**: 全プラットフォーム（Discord/Telegram/WebUI）のコマンドは `command-handler.ts` の `executeCommand()` を必ず通るため、その冒頭に `checkCommandPermission(userId)` を1箇所置くだけで統制が効く。MCP のみ別経路なので `mcp/tools.ts` の書き込み系ツール（`submit_instruction`/`approve_implementation`）にも同じゲートを追加
- **ゲートロジック（`services/org-control.ts`）**: 組織未所属＝許可 / admin・manager＝許可 / member＝`ManagerAssignment.count({memberUserId})≥1` で許可、0 なら理由付き deny。**admin は暗黙的に全 member を監督するがゲート判定には数えない** — 「必ず明示的に manager を割り当てる」統制を厳密に守るため。緩めたい場合はここで admin も許可条件に含める
- **未リンクユーザーは統制対象外**: Discord/Telegram で PlatformLink 未リンクのユーザーは User.id を特定できないため従来どおり素通し。統制は WebUI ログインユーザー（User.id 解決可能）基準
- **担当割当は admin のみ編集**: manager の自己割当は不可（統制の実効性維持）。`PUT /org/members/:userId/managers` は全置換で、候補が同組織の manager/admin であることを検証
- **role 変更時の割当掃除**: manager→他ロールでその人の担当割当を削除、member→他ロールでその人が担当される側だった割当を削除（無効な割当を残さない）
- **会話履歴は既存流用**: `GET /api/conversations` に `?userId=` を追加し、本人/同組織admin/担当manager のみ許可（他は 403）。manager は ConversationsPage のドロップダウンで担当ユーザーを切替
- **可視化**: admin のメンバー表で未割当 member に ⚠️ バッジ（＝コマンド発行不可状態）を表示し、監督者の付け忘れに気づけるようにする
- **DB DDL の適用**: shadow DB 破損で `prisma migrate dev` 不可 → psql 直実行で `ManagerAssignment` を CREATE + FK + index、information_schema で検証（`prisma db execute` は heredoc の DDL が反映されないケースがあり psql が確実）
- **対象ファイル**: server=`schema.prisma`/`services/org-control.ts`(新)/`services/command-handler.ts`/`mcp/tools.ts`/`routes/organization.ts`/`routes/api.ts`、web=`lib/api.ts`/`pages/SettingsPage.tsx`/`pages/ConversationsPage.tsx`（計9ファイル）。Agent/shared/Discord/Telegram 変更なし
- **v2 対象外**: ツール承認の manager 代行、コマンド事前承認フロー、監査ログ export、manager 階層（manager の manager）

## WebUI ローカライズと Settings ナビゲーション (#312, #313)

- **言語設定**: WebUI は `LanguageContext` を唯一の表示言語ソースとし、`en`（既定）/`ja` のみを受け付ける。`localStorage` の `devrelay-language` は初期表示のちらつき防止キャッシュ、`UserSettings.language` はサインイン済みアカウント間で同期する正本。未設定・不正値は必ず `en` にフォールバックする
- **文言と日時**: UI固定文言は `apps/web/src/i18n/messages.ts` に置き、表示側は `useLanguage().t()` を使用する。プロジェクト名・会話本文・API/Agentが返す生データは翻訳しない。日時・数値は選択言語のロケールを明示して整形する
- **Settingsタブ**: `general` / `ai` / `agent` / `integrations` / `organization` / `system` の6分類を `SettingsPage` の固定タブ定義に集約する。選択値は `?tab=` に反映し、`general` は既定としてクエリを省略する。不正値はGeneralとして扱う
- **状態保持**: Settingsのカテゴリ切替は条件レンダリングでアンマウントせず、`hidden` による表示切替にする。これによりAgreement、Allowed Tools、APIトークン発行直後の一時表示などをタブ移動で失わない。タブUIは `tablist` / `tab` / `tabpanel` と左右矢印・Home・End操作を維持する

## `w` コマンド（ラップアップ）の設計 (#288, #293, #304, #314)

`w` は「ドキュメント更新＋コミット/プッシュ」のワンショット exec。プロンプト実体は
`apps/server/src/services/command-parser.ts` の `export const W_COMMAND_PROMPT` 定数 1 箇所で、
`parseCommand()` Step 0.6 と `parseShortcut()` の `case 'w'` の両経路が参照する。

- **空振りガード (#288)**: 変更ゼロの作業ツリーでは「存在しないプランを推測せず『コミット対象の変更はありません』とだけ報告して終了」させる。これが無いと「プランをください」ループに陥る
- **非 git 対応 (#293)**: 冒頭で `git rev-parse --is-inside-work-tree` を判定して 2 分岐。非 git ではコミット/プッシュを行わず、会話履歴とディレクトリ内容から作業内容を把握して README.md / MEMORY.md を更新（無ければ新規作成）。他の .md は既存時のみ更新
- **設計判断**: 新規作成は README.md と MEMORY.md のみ（changelog.md・CLAUDE.md まで自動生成すると試用ディレクトリにノイズが増える）。git 側の文面は変更せず挙動不変。**どちらの分岐にも「対象が無ければ推測せず終了」のガードを置く**
- **`x` の実行済み判定は W_COMMAND_PROMPT から派生させる (#304)**: `command-handler.ts` の `handleClear()` は BuildLog.prompt の前方一致で「セッション内で `w` を実行したか」を判定し、未実行なら `x` 時に警告を出す。この判定プレフィックスを独自にハードコードすると `W_COMMAND_PROMPT` の書き換え時に追従し忘れて誤警告になる事故が **2 度**発生した（#86→#90、#293→#304）。そのため `command-handler.ts` は `command-parser.ts` から `W_COMMAND_PROMPT` を import し、`W_PROMPT_PREFIX = W_COMMAND_PROMPT.slice(0, 30)` の**派生**で判定する。`W_COMMAND_PROMPT` の冒頭を変える場合、この判定は自動追従するため個別修正は不要
- **Codex のみ danger-full-access (#314)**: Codex CLI の `workspace-write` サンドボックスは `.git/` をハードコードで read-only にするため、`w` の `git commit`/`git push` が `Unable to create '.git/index.lock': Read-only file system` で失敗する。`--add-dir` は `codex exec`（新規セッション）にのみ存在し `codex exec resume` には無いため resume 経由の `w` では使えない。対策として、サーバーが `customPrompt` を `W_PROMPT_PREFIX` 前方一致（同じ派生元）で判定し `isWCommand` フラグを `execConversation()` → Agent へ伝搬、Agent 側の Codex exec 分岐のみ `sandbox_mode="danger-full-access"` に切り替える（`w` 以外の通常 Codex exec は従来どおり `workspace-write`）。`w` のプロンプトはサーバー制御の固定文面（ユーザー入力ではない）であることを根拠に許容。SSH push のネットワークサンドボックス問題も `danger-full-access` で併せて解消される

## Agent 自動更新（サーバー主導）(#296)

Agent の更新を、手動 `u` と**同じプロトコル**（`server:agent:version-check` → `server:agent:update`）で
サーバーが自動的に叩く。実体は `apps/server/src/services/auto-updater.ts`。

- **Agent 側は変更しない**。これが設計の要。Agent 内にスケジューラを置くと「その仕組みを配るために全台へ手動 `u`」が必要になり、
  自動更新を入れる目的と矛盾する。既存プロトコルで足りる限り**サーバー側だけで完結させる**
- **トリガー**: Agent 接続時（30〜120 秒のランダム遅延）＋ 6 時間ごとのスイープ。オフライン機は次の接続時に拾われる
- **ゲート**（`evaluateAutoUpdateGates()` は I/O なしの純粋関数。単体検証できるよう分離してある）:
  グローバル kill switch → マシン単位 `autoUpdate` → 開発リポ除外 → 更新の有無 → 試行上限 → クールダウン 30 分 →
  bake time 120 分 → 作業中 → 同時実行 3 台。**skip 時は必ず理由をログに出す**
- **`isDevRepo` が未定義の古い Agent は「開発リポ扱い」に倒す**（誤って開発機を更新するより手動 `u` に委ねる方が安全）
- **失敗したら自分で止まる**: 同一コミットで 2 回失敗したら `autoUpdate=false` + `lastAutoUpdateStatus='failed:stale-dist'`。
  #256 の stale dist（git reset は成功するが dist が古いまま）で無限に再起動し続けるのを防ぐ。
  WebUI から再有効化すると試行カウンタもリセットされる
- **bake time の意図**: 壊れたコミットを push しても、2 時間以内に直せば艦隊には配られない
- **運用スイッチ（env）**: `DEVRELAY_AUTO_UPDATE_DRY_RUN=1` / `DEVRELAY_AUTO_UPDATE_ONLY=<machineId>` /
  `DEVRELAY_AUTO_UPDATE_DISABLED=1` / `DEVRELAY_AUTO_UPDATE_BAKE_MIN` / `DEVRELAY_AUTO_UPDATE_SWEEP_MIN` /
  `DEVRELAY_AUTO_UPDATE_INITIAL_SWEEP_MIN`

### ロールアウト停滞の教訓 (#297)

- **安全ゲート（bake time）とリトライ間隔（sweep）は必ずセットで設計する**。bake 120 分に対して
  sweep が 360 分だと、デプロイ直後の Agent 再接続バースト（connect トリガー）は bake 内で全 skip され、
  bake が明けた頃には接続済み Agent への再トリガーが無く、次の sweep（最大 6 時間後）まで沈黙する。
  → **初回 sweep をサーバー起動 5 分後に実行**（`startAutoUpdateSweep` の `setTimeout`）＋ **sweep を 30 分間隔**に短縮
  （bake より十分短くする）。sweep 終了時は `update/disable/skip` の内訳サマリを 1 行で出す
- **pending の滞留を可視化**: `reconcileLastAttempt` で 2 時間以上 pending のままなら `timeout:<detail>` に落とす
  （試行回数は変えない = #256 の暴走抑止はそのまま）

### バージョン更新状態の表示 (#299)

- version-check の結果（`localCommit/localDate/remoteCommit/remoteDate`）は、接続時・sweep・手動 `u` の
  **全経路が `handleVersionInfo()` に集約**される。ここは従来 promise を resolve するだけだったので、
  **`persistVersionInfo()` を 1 箇所足すだけで全経路の結果を `Machine` に永続化**できる（`Machine.localCommit`
  ほか 5 カラム）。`/api/machines` が派生値 `upToDate`（`local === remote`）を返し、Agents ページが色分け表示する
- **切り詰めと同じ発想**: DB へ書く前の変換（git `%ai` → DateTime のパース、通知本文のサロゲート除去）は
  **1 つの関数に集約**して二重処理・分断事故を防ぐ。通知は `packages/shared` の `truncateSafe()` を使う（#297）

### 二重起動と stale dist の実地教訓 (2026-08-14)

障害レポート: `doc/agent_noresponse_20260814.md`

- **自己更新機構のバグは、自己更新では直せない**。更新スクリプトを生成するのは Agent 自身なので、
  スクリプトの欠陥（kill 漏れ）を直しても、その Agent が**新しい dist で再起動するまで永久に旧スクリプトが使われる**。
  今回はビルドが 5 ヶ月失敗し続けていたため、`3d6a6ee`（#297）の修正が一度も適用されなかった。
  → **更新機構に触る修正は、対象機で dist が実際に更新されたかまで確認して初めて「入った」と見なす**
- **kill は `&&` の後ろに置かない**。`build && kill; sleep 1; nohup 起動 &` の形だと、
  ビルド失敗時に `&&` の短絡で **kill だけがスキップされ、起動は必ず走る** = 更新のたびに Agent が 1 つ増える。
  kill と起動は同じ区切り（`;`）で並べる
- **二重起動の症状は「重複メッセージ」ではなく「無応答」として出る**。サーバーは新接続時に旧 WebSocket を切断する
  （`agent-manager.ts:316`）ため、同一 machineId の 2 プロセスは約 1Hz で相互キックし続ける。
  この状態ではトラッカーを持つ接続と現在の接続がずれ、`sendToAgent FAILED (readyState=3)` と
  `No tracker found for session` で **AI 出力が黙って捨てられる**。
  ログにこの 2 つが並んで出ていたら真っ先に二重起動を疑う
- **`runningCodeStale` は「送られてこない」ケースを考慮する**。`auto-updater.ts` の
  `localCommit === lastAttemptCommit && !runningCodeStale` は、古い Agent が当該フィールドを送らないと
  `undefined` → `!undefined` が真になり **stale dist を「成功」と誤判定する**。
  任意フィールドで安全側に倒すなら `undefined` は `unknown` として別扱いにする（`isDevRepo` と同じ発想）
  → **#302 で対処済み**。`reconcileLastAttempt` を三値化（`false`=success / `true`=pending継続 / `undefined`=
  `success:unverified` で確定させず記録）。旧 Agent は commit が進んでも「未検証」のまま可視化される
- **git rev だけでは「動いているコード」を表せない**。version-check は `runningCodeMtime` も送っているので、
  `localCommit` と実行中コードのビルド時刻の乖離を可視化しないと、
  「サーバー上は最新なのに 5 ヶ月前のコードが動いている」状態を検知できない
  → **#302 で対処済み**。`Machine.runningCodeMtime`/`runningCodeStale` を新設し `persistVersionInfo()` で永続化、
  `/api/machines` で返却、Agents ページ Version 列に赤「⚠ 再ビルド漏れ」/ グレー「ⓘ ビルド状態不明（旧Agent）」バッジ表示
- **Agent の起動方式は機体ごとに 1 つに固定する**。この機体は crontab `@reboot` の nohup 起動が正で、
  pm2 に登録してよいのは `devrelay-server` のみ（`CLAUDE.md` に明記済み）

### `u` 自己更新が無音で失敗し stale dist を自己増殖させる罠 (#351, 2026-09-01)

- **PowerShell はコマンドが見つからないとき `$LASTEXITCODE` を更新しない**。直前に成功したコマンドの
  `0` がそのまま残り「exit=0」と誤記録される。ネイティブコマンドの実行前に必ず
  `$global:LASTEXITCODE = 0` でリセットしてから判定すること（`install-agent.ps1` は #328 で既に
  対応済みだったが、`u`（自己更新）フロー側の `connection.ts` には移植されておらず**非対称**になっていた
  ——同種の安全対策を入れた箇所は、兄弟プロセス（インストーラー vs 自己更新）にも横展開されているか
  必ず確認する）
- **コンソール無しプロセス（`wscript.exe`経由）は、失敗の出力先が無いので沈黙する**。
  `CommandNotFoundException` の stderr は誰にも読まれず消える。ログを `Out-File -Append` で
  取っていても、パイプに到達する前に例外で止まれば記録されない
- **「exit=0」の噓 × 存在チェックのみの成果物ゲート（#329）が組み合わさると自己増殖ループになる**:
  古い dist で動く Agent が `u` を実行 → 壊れた `update.ps1`（古い dist が生成）→ 依存コマンドが
  見つからない → 嘘の exit=0 → 存在チェックだけのゲートを素通り → 旧 Agent を kill → 同じ古い dist で
  再起動 → 次の `u` でも同じ壊れたスクリプトが再生成される。**`pm2 restart` を何度実行しても直らない**
  （サーバー側の変更は対象端末の dist に一切影響しないため）。この手のループを断つには
  「成果物が存在するか」ではなく「ビルド開始時刻より後に実際に書き換わったか」（`LastWriteTime` 比較）
  まで見る必要がある
- **`reconcileLastAttempt` の早期 return（`status !== 'pending'`）が回復不能なステータス残留を生む**。
  一度 `timeout:...` に落ちると、その後どれだけ健全な状態（`runningCodeStale=false` かつ
  `localCommit===lastAttemptCommit`）になっても照合が走らず `lastAutoUpdateStatus` が永久に残る。
  `MAX_ATTEMPTS_PER_COMMIT` の disable ゲートに近づいたまま放置されるため実害がある。
  → **#351 で対処済み**。`decideReconcileOutcome()`（外部 import ゼロの純関数）に判定を切り出し、
  `status` を条件にせず「成功の証拠（commit一致+stale=false）が揃っているか」だけで success を確定
  できるようにした（旧 Agent の `stale=undefined` ケースは従来どおり `status==='pending'` 限定の
  fail-safe を維持）

### トークン高止まり警告 (#300 / #321、#330 で廃止)

- **`w` と `x` の役割は別物**（今後も有効な運用知識）: `w`（wrap up）は exec マーカー＋ドキュメント更新・commit/push のみで、
  Claude SDK の resume セッション（`claudeResumeSessionId`）は**継続する** = cache_read（累積コンテキスト）は下がらない。
  実際にコンテキストを消して token を下げるのは **`x`（clear）**（`clearClaudeSessionId` で次回新規セッション化）
- 「応答が遅い」という体感の原因切り分けは、まず **DevRelay 側の指標（サーバー負荷・イベントループ・エラーログ・
  Agent 二重起動・レート制限）を先に全部シロにしてから**、AI ターン自体の指標（`Message.usageData` の
  `durationMs`/`usage.output_tokens`）を見る順序が有効（#321 の調査手順）
- 警告文のような sessionId しか持たない呼び出し元での言語解決は、既存の `resolveSessionLanguage(sessionId)`
  （#319）をそのまま流用する。「sessionId しか無いから新ヘルパーが要る」わけではなく、**既存ヘルパーが
  sessionId 引数を受けるなら常にそれを優先し、新設は本当に情報源が異なる場合
  （#320 の `pendingUpdateNotify` 等）に限る**
- ログのノイズ削減（`server:pong` の抑制）は実装コストがほぼゼロな割に、次の障害調査を大きく楽にする。
  「44% がハートビート応答」のような比率は `pm2 logs` を grep -c で数えるだけで分かるので、
  調査の一環として毎回チェックする価値がある
- **#330 で警告表示自体は廃止**（ユーザーが「効果が確認できない」と判断）。判定ロジック
  （`token-usage-warning.ts`・純関数 `evaluateTokenBloat`）と `DEVRELAY_TOKEN_WARN_*` env は削除済み。
  再導入する場合は git 履歴から `token-usage-warning.ts` を復元し、`agent-manager.ts` の
  `handleAiOutput`（isComplete 時）に呼び出しを 2 行戻すだけで元に戻せる

### MCP plan の skipPermissions 強制ON解消 (#332)

- **`forceNewSession` は resume 抑止のみを意味する**。権限（ツール自動承認の可否）は別フィールド
  `permissionPolicy`（`'interactive'` | `'strictReadonly'` | `'skip'`、enum不使用・String + JSDoc）で決める。
  #246 で「MCP submit はチャット参加者がいないので聞くな」という意図が「何でも許可しろ」に癒着し、
  `forceNewSession=true` → `skipPermissions=true` の連鎖ができていたのが根本原因（1 つのフラグに
  複数の意味を持たせると、後から見て意図が分からなくなり、想定外の副作用が生まれる典型例）
- **plan モードの実効的な抑止は `canUseTool` で行う。SDK の `permissionMode:'plan'` は write を止めない**。
  `sdk.d.ts` 上は "Planning mode, no execution of tools" と書かれるが、`allowedTools` は
  「auto-allowed without prompting」という許可ルールに過ぎず制限ではない（"To restrict which tools are
  available, use the `tools` option instead" と明記）。cli.js を機械的に走査しても `mode==="plan"` が
  `behavior:"deny"`/`"ask"` と同一分岐に現れる箇所は 0 件で、write 系の権限判定は plan 用の特別分岐を
  持たず通常どおり `canUseTool` の `"ask"` に落ちる。つまり **plan モードの実際の抑止は、SDK が生成する
  「書き込みしないでください」というプロンプト文への"お願い"のみ**であり、`canUseTool` 側で明示的に
  deny しない限りモデルは書き込みツールを呼べてしまう。`#303`（ExitPlanMode 自己解除）と同種の、
  「プロンプトで抑止しているつもりが実は callback 側の穴だった」パターン
- **strictReadonly の判定は allowlist 方式（deny-by-default）**: `PLAN_READONLY_TOOLS`（非 Bash の読み取り系、
  `packages/shared/src/constants.ts`）または `allowedTools`（Bash パターン、`Bash(cmd)`/`Bash(cmd *)`）に
  一致しないツールは、`skipPermissions` の値に関係なく聞かずに deny する。読み取り専用か判断に迷うツール
  （`Task`/`ToolSearch`/`TaskOutput`/`TaskStop`/`TodoWrite`/`WebFetch`/`WebSearch` 等）は deny ではなく
  **allow 側に倒す**方針（人間の承認判断）。判定の純関数（`matchesToolRule`/`isAllowedByRules`/
  `decidePlanPermission`）は `agents/linux/src/services/plan-permission.ts` に集約し、`ai-runner.ts` の
  重複実装を排除。**macOS は同一ロジックを別ファイルにローカルコピーで維持**（Agent の OS 別自己完結
  方針により、linux から import しない）
- **exec モードの権限挙動は一切変更しない**（人間が承認済みでフル権限が仕様）。修正時は
  `git diff` で exec モード `canUseTool` ブロックの diff が 0 行であることを毎回確認すること
- **サーバー側の permissionPolicy 組み立ては 1 箇所に集約**: `apps/server/src/services/permission-policy.ts`
  の `resolvePermissionPolicy(source)`（`'mcp'|'chat'|'exec'`）を `mcp/tools.ts`・`command-handler.ts`・
  `agent-manager.ts` の3箇所が呼ぶ。リテラル文字列を各呼び出し箇所に直書きすると将来の食い違いの元になる
  （#86→#90, #293→#304, #305→#306 と同種の分散同期漏れパターンの再発防止）
- **旧 Agent との互換性は fail-open**: `permissionPolicy` 未対応の旧 Agent は無視して従来どおり
  （`forceNewSession` ベースの skipPermissions 強制ON）動作する。fail-closed にするとサーバー更新直後に
  MCP plan が全滅するため、互換優先とした。**全マシンの `u` が完了するまでは MCP plan の実効的な
  読み取り専用強制は機体ごとにバラつく**ことを運用上認識しておくこと
- **Windows（Electron GUI）Agent は対象外**: CLI 引数方式で SDK の `canUseTool` を使わないため、
  そもそも本問題の影響を受けない（`u` も不要）

### plan strictReadonly のグロブ false positive 修正 (#333)

- **グロブはコマンド文字列の判定に一切使わない**。deny の原因は「グロブ文字そのもの」ではなく、
  (1) Claude Code ハーネスが未クォートのシェルメタ文字（`*` 等）を含むコマンドを自動承認せず
  `canUseTool` に落とすこと、(2) 落ちてきた後の旧判定（`matchesToolRule`）が「コマンド文字列全体の
  前方一致」であり、引数にパスやグロブが混じると `allowedTools` のプレフィックスと一致しなくなること、
  の2段階だった。修正は判定軸を「セグメント分割（`;`/`&&`/`||`/`|`/改行、クォート考慮）＋セグメントごとの
  先頭実行ファイル名（argv0）判定」に変更し、グロブそのものは deny 理由に一切しない
- **strictReadonly の allow 判定は「ユーザーカスタム `allowedTools` ∪ `DEFAULT_ALLOWED_TOOLS`（対象OS）の
  読み取り系ルール」の和集合で行う**（人間承認時の必須要件）。カスタムリストが default より緩い方向の
  差分はそのまま尊重するが、default にあってカスタムに無い読み取り系ルールを欠落扱いにしない。和集合は
  `decidePlanPermission` 内部で毎回動的に計算し、渡された `options.allowedTools` 自体は書き換えない。
  この方針は **strictReadonly（plan）専用**であり、interactive / exec の `allowedTools` 解決には適用しない
- **複合コマンド（`;`/`&&`/`||`/`|`）は全セグメントが allow の場合のみ allow**。1つでも deny なセグメントが
  あれば reason を `planPolicy:compoundCommand` に丸める。`$(...)`/バッククォート/`<(...)` のコマンド置換は
  中身を検査できないため常に deny（`planPolicy:compoundCommand`）
- **書き込みリダイレクト検出は fd 複製（`2>&1`）を誤検知しないこと**。`>` の直後が `&` なら書き込みとは
  みなさない。この区別を忘れると `ls -la doc 2>&1` のような無害な読み取りコマンドまで deny してしまう
- **旧実装の抜け穴（前方一致による書き込み許可）を回帰テストで固定**: `git log --oneline > /tmp/x` は旧
  `matchesToolRule`（`Bash(git log *)` の前方一致）では allow されてしまっていた。新判定ではリダイレクト
  検出が argv0 判定より先に走るため deny になる。`agents/linux/tests/plan-permission.test.mjs` に
  この具体的な旧脆弱性の回帰テストとして残してある
- **`ToolApproval.reason`・deny メッセージには具体的な判定根拠を必ず載せる**（`planPolicy:notInAllowlist` /
  `planPolicy:writeTool` / `planPolicy:compoundCommand` の3分類 + 日本語 `detail`）。`'planPolicy'` の一語
  だけでは deny 原因の切り分けに実機ログ調査が必要になり運用コストが高い（本サイクルの発端そのもの）
- **副次発見1（`UserSettings.allowed_tools_*` にカスタム保存があると `DEFAULT_ALLOWED_TOOLS_*` への追加が
  一切効かない問題）の一般解は未実装**。本サイクルは strictReadonly 判定側で和集合を取ることで症状を
  回避したが、カスタム保存自体（WebUI Settings 経由の `allowed_tools_linux`/`allowed_tools_windows`）を
  diff ベースで更新する等の恒久対応は別サイクルで検討する

### Devin ATIF パーサ: 「構造化データ抽出」と「表示文言組み立て」をファイルで分離 (#361, 2026-09-05)

- **`devin-atif.ts`（純関数、`tChat()` を呼ばない）と `ai-runner.ts`（表示整形、`tChat()`/`console.*`/`log.*`
  を呼ぶ）を分離**したことで、3 OS で `devin-atif.ts` を byte-for-byte 同一にできた。従来
  `summarizeAtifEntry()` は `ai-runner.ts` 内のローカル関数だったため OS ごとの `console.*` vs `log.*` の
  流儀差が混入し、3 OS 同一化ができていなかった。**「ロジックと表示を同じファイルに書かない」は、複数 OS
  でコードを複製する必要があるこのリポジトリ特有の設計指針として今後も踏襲する**
- **ATIF-v1.7 の実キーは `steps`（`messages` ではない）**。`tool_calls[].function_name` +
  `arguments.command` を抽出対象とし、レガシー形（`tool_name`/`tool`/`name`）にもフォールバックする。
  `observation.results[].content` は **絶対に読まない**（AI の内部観測ログをチャットに漏らさない方針、
  漏洩ガードテストで担保）
- **ATIF は「ターン終了時に一括書き出し」される仕様**であるため、ライブポーラーは ATIF が出現するまで常に
  parse 失敗し続ける。つまり `maxSteps` コストガード（#277）は **ATIF 経由では原理的に機能しない**。
  「誤カウントの是正」と「ガードの復活」は別物であることを混同しないこと（起動時1回だけ console 警告で
  ユーザーに `maxRuntimeMinutes` の利用を促すのみ）
- **`contextWindow` は意図的にカタログへ追加しない**。Codex はハードコード `200000` を持つが、Devin の
  実際のコンテキスト長は ATIF から取得できず、消費者（`apps/server`/`apps/web`）も存在しないため、嘘の
  値を書かない方針を優先した
- **`AiUsageData.usage?: Record<string, number>` への代入は fresh object literal でなければならない**。
  named interface（index signature 無し）由来の値をプロパティアクセス経由でそのまま代入すると TS2322
  になる（fresh object literal には暗黙の index signature が合成されるが、変数経由の値には合成されない
  という TypeScript の仕様）。`{ ...source }` のスプレッドで fresh literal 化すれば解消する

### Devin プランモードの「無言で途中終了」と `.svn` 洪水の解消 (#362, 2026-09-05)

- **DevRelay の調査系スキル（`devrelay-list-inventory` 等）はすべて bash スクリプトであり、
  プランモードの `Exec(**)` 一括 deny は「書き込み阻止」ではなく「DevRelay 自身のスキルを丸ごと殺す」**
  という副作用を持つ。プランモードの権限は「ツール種別（Exec/Write）」ではなく「そのコマンドが
  読み取り専用かどうか」で判定すべきだった。#333（Claude 側 `decidePlanPermission`）は最初からコマンド
  単位で判定していたのに対し、Devin だけ `--config` の `permissions.deny` が `Exec(**)` 一括だったのが
  食い違いの原因。今回は `deny` から `Exec(**)` を外し `--permission-mode auto`（Devin 自身の
  「安全と判断したツールのみ自動承認」判定）と併用する多層防御に変更、`Write(**)` の deny は維持したまま。
  **`--config` と `--permission-mode` の併用セマンティクスは実機未計測**のため、キルスイッチ
  `DEVRELAY_DEVIN_PLAN_EXEC_DENY=1` で即座に旧動作（Exec 全 deny）へ戻せるようにしてある
  - **【#363 で訂正】上記の記述は不正確だった**。`Exec(**)` は元々一度も機能していなかった
    （`Exec()` はプレフィックス一致で `Exec(**)` は無効なルールと公式ドキュメントに明記されており、
    「deny から `Exec(**)` を外した」こと自体は何も変えていなかった）。また `--permission-mode auto` の
    「安全と判断したツールのみ自動承認」という説明も誤りで、正しくは**読み取り専用ツールのみ自動承認**
    （シェル実行=Exec は対象外）。したがって #362 時点では allow にも deny にも一致する Exec ルールが
    一つも無く、DevRelay 自身のスキル呼び出しは相変わらず「ルール不一致→承認待ち→非対話モードで無言終了」
    のままだった。#363 で `devin-plan-config.ts` により明示的な Exec allow/deny プレフィックス一覧を
    導入し、かつ対応していれば `auto` ではなく `smart`（安全性を自動判定して実行）を優先するよう修正した。
    詳細は下記「Devin プランモード『ツールが許可されず返事が返ってこない』の根治 (#363)」節を参照
- **Devin の非対話 deny は拒否テキストを一切出さず exit 0 で終わる**（#347 Phase0 実測）。この性質により
  「ツール呼び出しで deny されて終わった」ターンは、既存の空応答検知（`devinPlanToolRejected`、
  `fullOutput.trim().length===0` が発火条件）を素通りする——deny される**前**に前置き1文を出しているため
  `fullOutput` が非空になり、既存の自動リトライ条件に一度も一致しない。これは #347 の設計上の穴であり、
  今回追加した `endedWithoutAnswer(steps)`（`devin-atif.ts`、最後のステップが `tool !== null` で終わって
  いるか＝そのあとの AI テキスト応答が存在しないか）は**この穴を検知するだけ**の別軸のチェックとして
  追加した。**既存の `devinPlanToolRejected` の判定ブロックは 1 バイトも変更していない**
  （`git diff` で当該ブロックの `[+-]` 行が 0 であることを毎回確認すること）。自動リトライはしない
  （config を外すと読み取り専用保証が緩むため、#347 の設計意図に反する）方針も維持
- **`fs.watch` の除外リストはディレクトリ名ベースであり VCS の種類を網羅する必要がある**。既存の
  `.git|node_modules|...` に `.svn`/`.hg`/`.bzr`/`CVS` を追加しただけで、SVN 作業コピー
  （`.svn/pristine/**` に数百ファイルが分散する構造）のような「同一ファイルの更新ではなく大量の異なる
  ファイルが短時間に更新される」パターンには**既存の「同一ファイル 10 秒スロットル」は無力**。
  今回追加したターンあたりの通知上限（既定 20、`DEVRELAY_DEVIN_FILEWATCH_MAX` で上書き可）は
  スロットルとは独立した別の防御層として設計した。上限到達時は「黙って打ち切る」のではなく
  `devin.fileWatchTruncated` を1回だけ出す（#325 静かなフォールバック禁止）
- **`isNoisyChangedPath()` は `(^|\/)(...)(\/|$)` の境界アンカーを持つため `.gitignore`/`.hgignore`
  のような「ディレクトリ名と同じ接頭辞を持つファイル」を誤って除外しない**。VCS 系の除外パターンを
  追加・変更する際は、この境界ケースを回帰テストに必ず含めること（`devin-file-watch.test.mjs`）

### Devin プランモード「ツールが許可されず返事が返ってこない」の根治 (#363, 2026-09-05)

- **#362 は方向としては正しかったが不完全だった**。`Exec(**)` は元々一度も機能していなかった（`Exec()`
  はプレフィックス一致で `Exec(**)` は無効なルールと公式ドキュメントに明記）ため、#362 の「deny から
  `Exec(**)` を外す」は実質何も変えておらず、かつ「`--permission-mode auto` は安全と判断したツールを
  自動承認する」という説明も誤りだった。実際は **`auto` は読み取り専用ツールのみを自動承認し、シェル実行
  （Exec）は対象外**（`devin --help` 逐語実測）。この二重の誤解により、DevRelay 自身の調査系スキル
  （`devrelay-list-inventory` 等、実体は bash スクリプト）は allow にも deny にも一致するルールが無いまま
  「承認待ち→非対話モードでは無言終了」を #260 から #362 まで通して踏み続けていた
- **新設計**: 新規純関数モジュール `devin-plan-config.ts`（`agents/{linux,macos,windows}/src/services/`、
  3 OS byte-for-byte 同一・外部 import ゼロ、`devin-file-watch.ts`/`devin-atif.ts` と同じ流儀）に
  `buildDevinPlanConfig(opts)` と `resolveDevinPlanPermissionMode(caps, opts)` の2純関数を集約。
  `buildDevinPlanConfig()` は `strictExec=false`（既定）のとき `allow=['Read(**)', ...Exec 許可
  プレフィックス]`（`PLAN_READONLY_BASH_COMMANDS` 由来の読み取り専用コマンド + `git log`/`git status`/
  `git diff`/`git show`/`git branch`〔`git` 単体は許可しない、`git push` を巻き込まないため〕+
  DevRelay スキルディレクトリ配下の bash 実行を通す4パターンのプレフィックス〔クォート有無・POSIX/Windows
  パス区切りの揺れに対応〕）、`deny=['Write(**)', ...Exec 拒否プレフィックス]`（`PLAN_WRITE_BASH_COMMANDS`
  由来の書き込みコマンド + `sudo`）を生成する。`strictExec=true`（キルスイッチ）のときは
  `allow=['Read(**)']`/`deny=['Write(**)']` のみで `Exec(**)` という無効な文字列は**二度と出力しない**
  （回帰テストで担保）
- **`resolveDevinPlanPermissionMode()`**: `--permission-mode` 自体が非対応なら `null`（引数を付けない）、
  対応していれば既定で `smart`（ルールが決めていない場合のみ安全性を自動判定して実行、`--permission-mode`
  の選択肢に `"smart"` が現れるかを `probeDevinCapabilities()` の `permissionModeSmart` フィールドで
  probe）、`smart` 非対応または `strictExec=true` のときは `auto` にフォールバック。
  `DEVRELAY_DEVIN_PLAN_PERMISSION_MODE=auto|smart` で明示上書き可能（envOverride は strictExec/smart
  判定より優先）
- **`probeDevinCapabilities()` のキャッシュ変数の型注釈を追従させ忘れる罠（#347 で3 OS全滅を起こした既知の
  罠）に今回も要注意**——`permissionModeSmart: boolean` を戻り値型に追加する際は、関数自身の返り値型注釈
  だけでなく**モジュールレベルのキャッシュ変数 `devinCapabilitiesCache` の型注釈にも必ず追従させる**こと
- **キルスイッチの整理**: `DEVRELAY_DEVIN_PLAN_EXEC_DENY=1`（`strictExec`）は Exec 許可/拒否リストを
  一切生成せず `--permission-mode auto` のみを使う、#260〜#362 の壊れていた挙動と等価な状態に戻す。
  `devinPlanToolRejected`（#274/#329/#344 の空応答自動リトライ）と `endedWithoutAnswer()`（#362 の無言
  途中終了検知）は本サイクルで**1 バイトも変更していない**——真因を直せば発火不要になるだけで、トリガ拡張
  は Devin の二重課金リスクがあるため意図的にスコープ外とした
