# DevRelay プロジェクト固有ルール

> このファイルには、DevRelay の開発時に守るべき設計判断・注意事項を記載する。
> 変更履歴は `doc/changelog.md` に記載すること。

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
- 実行（plan）: `devin [-r <session-id>] -p --agent-config <tmpConfig> --prompt-file <tmp>`
- 実行（exec）: `devin -p --permission-mode dangerous --prompt-file <tmp>`
- プロンプト: `--prompt-file` 一時ファイル経由（stdin パイプは panic するため使用不可）
- セッション継続: `-r <session-id>` で明示的に resume（`devin list --format json` で取得・`.devrelay/devin-session-id` に保存）
- パーミッション（plan）: `--agent-config` で `Read(**)` のみ allow、`Write(**)` + `Exec(**)` を deny。`--permission-mode auto` は「安全と判断したツールを自動承認」するだけで厳密な読み取り専用ではないため、agent-config で明示的に強制する（#260）
- パーミッション（exec）: `--permission-mode dangerous`（全ツール自動承認）
- **`-r` resume は plan モード時のみ**: Devin の resume は元セッションの permission-mode を保持して CLI の `--permission-mode dangerous` を上書きしない仕様。exec モードでは新規セッションを起動して dangerous を確実に効かせる（#231 で判明）。session continuity は plan 中のみ。plan→exec は元々文脈リセット点なので問題なし
- 会話履歴: 非 Claude ツールでは常にプロンプトに会話履歴を含める（`isClaudeSdk` 判定で Claude は従来通り SDK --resume）。Devin が exec で `-r` を使わなくても、この履歴注入で文脈は維持される
- PATH: コマンドのディレクトリを自動追加（サービス実行時の PATH 不足を回避）
- 有効化: Agent 起動時に自動検出（`detectAndUpdateAiTools()`）、または手動設定
- Server / WebUI / DB は変更不要（`Session.aiTool` は String 型、`AI_TOOL_NAMES` で動的表示）
- Cloud API (v3 REST) は将来対応（ローカル CLI 優先）

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

## Claude モデル選択（`l` コマンド + Settings 共有）(#251-#253)

Claude SDK モードで使うモデルを Plan/Exec 別に選択する仕組み。

- **UserSettings キー**: `claude_model_plan` / `claude_model_exec`。プロンプト送信のたびに読み込み → WS payload `model` → Agent SDK `sdkOptions.model`
- **`l` コマンド**: `l`（一覧）、`l sonnet`（両方）、`l plan:haiku` / `l exec:opus`（個別）。端末モードは対象外（Claude CLI 自体がモデル制御）
- **設計判断（Settings と `l` の共有）**: WebUI Settings ページとチャット `l` コマンドは**同じ UserSettings キーを共有**する。専用の優先順位ロジックや新キーは作らず、last-write-wins で「後から変更した方が優先」を実現 → サーバー変更ゼロで両者が整合。Settings 画面には `l` での変更値もそのまま反映される
- **設計判断（フル ID でエイリアス解決をバイパス）**: `AVAILABLE_MODELS` / `CLAUDE_MODEL_OPTIONS` にフルモデル ID（`claude-opus-4-8`, `claude-fable-5`）を持たせる。SDK/CLI のエイリアス（`opus` → `opus-4-6`）解決は CLI バージョンに依存するため、古い CLI では新モデルに解決されない。フル ID は API に直接渡るため CLI・Node.js を更新せず最新モデルが使える（CLI 2.1.197 + Node 20.20.0 で `claude-opus-4-8` / `claude-fable-5` 動作確認済み）
- **`l` のコマンド判定バグ (#252)**: `isTraditionalCommand()` に `'l'` 判定を追加。未追加だとセッション接続中に `parseCommandWithNLP` が `l` を AI プロンプトとして流してしまう（`'a'` コマンドと同様の 1 文字キー特殊対応が必要）
- **macOS Agent への移植漏れ (#259)**: #251 の `model` 適用は当初 `agents/linux` にしか実装されておらず、`agents/macos` が payload の `model` を無視して CLI デフォルト（`opus-4-6[1m]`）で実行していた（Mac のプロジェクトだけモデル設定が効かない）。サーバーは全 Agent に `model` を送っているため、Agent 側が受け取って `sdkOptions.model` に適用しないと機能しない。**原則（#256 の教訓と同じ）: Agent 機能追加時は `agents/linux` と `agents/macos` の両方に実装すること**。macOS の伝搬経路は本実行 `sendOptions` / exec 転送 / resume 失敗リトライ `retryOptions` の 3 箇所
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
- モデル: gpt-4o-mini / claude-haiku-4-5-20251001 / gemini-2.0-flash
- `build-summarizer.ts`: マルチプロバイダー要約サービス（fire-and-forget パターン）

---

## インストーラーの依存関係

| ツール | Linux/macOS | Windows | 扱い |
|-------|------------|---------|------|
| git | 必須（手動インストール） | 必須（手動） | `exit 1` |
| Node.js 20+ | 自動インストール | 必須（手動） | Linux: DL、Win: `$Missing++` |
| pnpm | 自動インストール（npm→sudo） | 自動インストール（npm） | 自動 |
| AI CLI（claude/gemini/codex/aider/devin） | 任意（いずれか1つ推奨） | 任意 | 警告のみ・続行 |

- **AI CLI は任意**（#261 で Claude Code の必須要件を撤廃）。claude / gemini / codex / aider / devin のいずれか 1 つあれば動作し、1 つも無くても Agent はインストール・起動できる（起動時の `detectAndUpdateAiTools()` が後からインストールされた CLI を config に追加する）。Devin 専用マシンのオンボーディングが可能
  - 経緯: Claude Code は #112 で一度必須依存に変更されたが、Agent 本体は claude なしでも動作する（claude の spawn はセッション実行時のみ、他ツールは各自 spawn）ため #261 で任意に戻した
- **config.yaml の default 決定**: インストーラーは検出された AI CLI のみ `aiTools:` に出力し、`default:` を優先順（claude > devin > gemini > codex > aider）で最初に検出したものにする。1 つも無ければ従来どおり `claude`（起動時自動検出とサーバー側 `aiTools.default || 'claude'` fallback に整合）
- Linux/macOS: `~/.local/bin/claude` がある場合は自動 PATH 追加で救済（従来どおり）

---

## AI ツールの解決順序（セッションがどの AI で動くか）

- **セッションの AI ツールは `Project.defaultAi`（DB）で決まる**。セッション作成時に `targetProject.defaultAi` を payload に載せ、Agent がそれを spawn する（`command-handler.ts` / `agent-manager.ts`）
- `config.aiTools.default` は **payload に aiTool が無いときのフォールバック**（Agent 側 `config.aiTools.default || 'claude'`）でのみ使われる
- **プロジェクト自動検出時の defaultAi**（#262）: `scanProjects` / `autoDiscoverProjects` は新規登録するプロジェクトの `defaultAi` に `config.aiTools.default` を採用する（引数で伝搬）。これにより Devin 専用マシン（claude 未ログイン）でも自動検出プロジェクトが devin で起動する
  - 以前は `defaultAi: 'claude'` ハードコードで、Devin 専用マシンでも全プロジェクトが claude 扱いになり「Not logged in」で失敗していた（#262 で修正）
  - Agent→Server の projects sync（upsert）は毎回 `defaultAi` を上書きするため、DB だけ直しても Agent 再同期で戻る。Agent 側（config 由来）を正とする
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

## クロスプロジェクトループ防止 (#211)

同一マシンから同一ターゲットへの自己送信ループを防止。

- **検出**: `ask-member`/`teamexec-member` で同一マシン → 同一ターゲットの直近5分以内のセッション数をカウント
- **閾値**: 3回以上で HTTP 429 拒否
- **表示**: `/api/agent/members` に `isSameMachine` フラグ、ask.sh で `[自マシン]` マーク
- **設計判断**: 送信自体はブロックしない（nim → devrelay のような正当な同一マシン間通信を許可）。閾値で異常検知

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
