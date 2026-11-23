# サイクル SB-2.0: Sandbox の許可リスト（テスト DB 向け、PC 単位）設計調査

- 本サイクルは read-only 調査のみ。コード変更・コミットなし（本ファイル自体はドキュメント追加のみ）。
- 各結論に根拠の種類を付す: **[コード]**=このリポジトリのコードで確定 / **[公式]**=Microsoft 公式ドキュメントが根拠 / **[実機]**=Windows 実機確認が必要。
- 調査時点の HEAD: `caad8a1`（SB-1.9）。
- 末尾の「決定事項（2026-11-23 けいすけ）」が本文の記述と食い違う箇所は決定事項を正とする。
  食い違う箇所には本文側にも注記を入れた（E-1・E-2・E-3・F）。

---

## Context（なぜやるのか）

SB-1 で Sandbox（仮想アカウント `NT SERVICE\devrelay-sandbox`）からの外向き通信は
「127.0.0.0/8 以外すべて遮断」になった（`scripts/install-sandbox-host.ps1:298-313`）。
AI API へは Agent 内の中継プロキシ（127.0.0.1:48711）＋ドメイン許可リストで出ている。
一方で**テスト DB のような「IP とポート」宛の直接通信は一切できない**。
開発者が自分の PC で「このテスト DB だけは通す」と指定できる仕組みを足す。
指定していない宛先（本番 DB 等）は今までどおり止まる。

---

## A. 現状

### A-1. 管理者用スクリプトが作るもの — `scripts/install-sandbox-host.ps1`（370 行）**[コード]**

| 種別 | 実体 |
|---|---|
| サービス | `:166` `sc.exe create devrelay-sandbox binPath= "C:\ProgramData\devrelay\sandbox\SandboxHost.exe" obj= "NT SERVICE\devrelay-sandbox" start= auto DisplayName= "DevRelay Sandbox Host"` |
| 置くファイル | すべて `C:\ProgramData\devrelay\sandbox\`（`:63-68`）: `SandboxHost.exe`（`csc.exe` で `:143-156` ビルド）、`host-key.priv.blob`、`host-key.pub`、`host.json`（`{serviceName, sid, protocolVersion:1}`、`:268-274`）、`home\` |
| ACL | `:261-264` 秘密鍵: `icacls /inheritance:r` → サービス SID に `(R)` のみ、`Users`/`Administrators` を明示除去。`:278` `home\` にサービス SID `(OI)(CI)(M)`。**それ以外のファイルと `sandbox\` ディレクトリ自体は ACL 未設定＝`C:\ProgramData` からの継承のまま**（Users 読み取り、Administrators Full） |
| FW ルール | `:296-313` 3 本。すべて `-Direction Outbound -LocalUser "D:(A;;CC;;;<ServiceSid>)"`。**`-Group` も `-Name` も付けていない**（自動生成 GUID 名）ので `uninstall-sandbox-host.ps1:34-40` は DisplayName ワイルドカード `"DevRelay Sandbox*"` で消している |
| 冪等性 | `:84-116` サービス停止→削除→exe ロック待ち→`:291-294` FW ルールをワイルドカード削除して再作成→`:195-201` **鍵ペアは毎回再生成**（SID 安定性の論点は F 末尾・追加3 を参照） |

FW ルール（逐語、`:298-313`）:

```powershell
New-NetFirewallRule -DisplayName "DevRelay Sandbox - Block IPv4 (except loopback)" `
    -Direction Outbound -LocalUser $LocalUserSddl -Action Block -Protocol Any `
    -RemoteAddress "0.0.0.0-126.255.255.255","128.0.0.0-255.255.255.255" | Out-Null
New-NetFirewallRule -DisplayName "DevRelay Sandbox - Block IPv6 (all)" `
    -Direction Outbound -LocalUser $LocalUserSddl -Action Block -Protocol Any `
    -RemoteAddress "::/1","8000::/1" | Out-Null
New-NetFirewallRule -DisplayName "DevRelay Sandbox - Allow loopback" `
    -Direction Outbound -LocalUser $LocalUserSddl -Action Allow -Protocol Any `
    -RemoteAddress "127.0.0.0/8" | Out-Null
```

### A-2. ブロック範囲の計算場所と DevRelay サーバーの扱い **[コード]**

- 計算場所は**この 3 本のリテラルだけ**。`0.0.0.0-126.255.255.255` + `128.0.0.0-255.255.255.255` は `127.0.0.0/8` の IPv4 補集合のハードコード。理由はコメント `:281-284`「Windows Firewall は Block を Allow より先に適用するため、Allow を足すのではなく Block 自身の範囲から外す」。
- `"::/0"` は `New-NetFirewallRule` が拒否する（HRESULT 0x80070057、`:302-303`）ため IPv6 は `"::/1","8000::/1"` の 2 本立て。**結果として `::1` も遮断**。だから中継プロキシは `127.0.0.1` リテラル固定（`sandbox-proxy.ts:84`、`sandbox-env.ts:28`）。
- **DevRelay サーバーの IP は FW ルールに入っていない。** SB-0 の設計文（`doc/sandbox/SB-0_investigation.md:146`）は「127.0.0.0/8 と DevRelay サーバー以外 Block」と書いているが、実装は loopback だけを外している。Sandbox の子は DevRelay サーバーと直接話さず Agent（開発者身元・無制限）がパイプ経由で中継するため、これで正しい。
- `api.anthropic.com` も FW ルールには無い。到達経路は中継プロキシ 1 本のみで、許可リストは `agents/linux/src/services/sandbox-allowlist.ts:14-18`（`api.anthropic.com:443` / `claude.ai:443` / `downloads.claude.ai:443`）。同じ `api.anthropic.com:443` が**陽性対照**（直結が失敗することの確認先）にも使われている（`SandboxHost.cs:77-78`）。

### A-3. 非管理者の Agent がサービスを**起動**できる仕組み → **存在しない** **[コード]**

- リポジトリ全体で `sc.exe` の用途は `create`（install `:166`）と `delete`（install `:90` / uninstall `:28`）のみ。`sdset` / `SERVICE_START` / `Set-Service` の付与コードは皆無。
- 実際は `start= auto`（`:166`）＋ インストール時の `Start-Service`（`:318`）で動かしており、Agent は**既に動いているサービスの名前付きパイプに繋ぐだけ**。落ちていれば起動せず fail-closed（`sandbox-readiness.ts:97` `pipe_unreachable`、文言 `:132`）。
- 非管理者側のアクセス権はパイプ ACL だけ（`SandboxHost.cs:774-794`）。`BUILTIN\Users` に ReadWrite|Synchronize、サービス自身の SID に `CreateNewInstance` のみ。
  - ⚠ **既存の疑義**: 仮想アカウントが `BUILTIN\Users` のメンバーなら、その ACE によって Sandbox の子プロセス自身もパイプにクライアントとして繋げる（`:770` のコメントの意図「繋げない」が不成立）。同一身元なので権限昇格ではないが設計意図とずれる。公式ドキュメントでは仮想アカウントが `NT SERVICE\ALL SERVICES` に入ることは明記されているが `BUILTIN\Users` 所属は明記が見つからなかった **[実機]**（`whoami /groups` をホスト経由で 1 回実行すれば確定。実機確認項目 9。SB-2.1 の対象外、別課題として記録）。
- 既存のタスクスケジューラ登録は Agent 本体側のみ: `scripts/install-agent.ps1:1449-1451` と `agents/linux/src/cli/commands/setup.ts:222` の `schtasks /Create /TN "DevRelay Agent" /TR "wscript.exe \"<vbs>\"" /SC ONLOGON /F /RL LIMITED`（**非管理者**）。削除は `uninstall.ts:72` / `uninstall-agent.ps1:315`、照会は `status.ts:23`。**管理者権限のタスクはリポジトリに 1 つも無い**。

### A-4. status / selftest / 実行前チェックが見ているもの **[コード]**

- 実行前チェックの芯は純関数 `decideSandboxPreflight()`（`agents/linux/src/services/sandbox-readiness.ts:83-114`）。21 項目を順に見て既定は拒否。FW については **ルールを列挙していない**（列挙には管理者権限が必要）。代わりに「実際に効くか」を 2 つの実測で見る: `blockProbePositiveControlBlocked`（`api.anthropic.com:443` への直結が失敗する）と `blockProbeLoopbackReachable`（中継プロキシに届く）。プローブはホスト内で実行（`SandboxHost.cs:365-366`、`:400-447`）。
- `agents/linux/src` 全体で `netsh` / `firewall` / `NetFirewall` の参照は **0 件**。
- `sandbox status`（`cli/commands/sandbox.ts:114-151`）は 13 項目を ✅/❌ で並べるだけ。**許可リストの内容・プロキシポート・`sandbox.projects` に入っているか・トークン有無は出していない**（一部は `selftest` のみ `:385-386`）。
- TTL キャッシュの純関数は**存在するが未配線**（`sandbox-readiness.ts:245/256`、`SANDBOX_PROBE_CACHE_TTL_MS = 10 分` `sandbox-protocol.ts:70`、利用者はテストのみ）。今は毎ターン全ハンドシェイク＋プローブを払っている。
- 拒否時はチャットに 1 行出して**ターンを終了**する（制限なしでの実行経路は無い）: `ai-runner.ts:2420-2434`、`sandbox-preflight.ts:200-202`、文言表 `sandbox-readiness.ts:123-145`。
- 単一判定点は `ai-runner.ts:2391-2437`（毎ターンの `loadConfig` `:2400` → `decideSandboxTarget` `:2401-2407` → `decideSandboxTurnEligibility` `:2409-2423` → `prepareSandboxLaunch` `:2424-2435` → `sdkOptions.spawnClaudeCodeProcess` `:1198-1206`）。静的ガード `tests/sandbox-ai-runner-wiring.test.mjs` が「呼び出しは 1 箇所」「順序」「`connection.ts` に判定を漏らさない」を機械的に守っている。
- サーバー側: `Project.sandboxEnabled`（`schema.prisma:205`、DB 変更 `0036`）、`GET/PUT /api/projects/:id/sandbox`（`routes/api.ts:785-838`）、`decideSandboxDispatch()`（`services/sandbox-dispatch-rules.ts`、呼び出しは `agent-manager.ts:1559`/`2373`）、文言 `packages/shared/src/i18n.ts:204-209`。**Agent からサーバーへ Sandbox の状態を上げる経路は今は無い**（capability の有無だけ）。

---

## B. 「IP とポート」のルール表現

### B-1. 前提の確認 **[公式]**

- 評価順は「`Allow if Secure`+Block Override → **Block** → Allow → 既定動作」。つまり **Block は Allow に勝つ**。IPsec 認証を伴う `Allow if Secure` は実用外。→ **許可したい宛先は Block ルール自身の範囲から外す（補集合を作る）しかない。** 今のスクリプトの方法が正しい。
- `-RemotePort` は TCP/UDP のときのみ有効で、単一ポート・範囲（`5000-5020`）・配列/カンマ区切りの併記ができる。
- `-Protocol` に否定は無い（「TCP 以外」を 1 本では書けない）。
- `-RemoteAddress` は複数指定可（配列）。`-Group` は任意文字列を付けられ、`Get/Remove-NetFirewallRule -Group` で一括操作できる。
- 非管理者が FW ルールを変える方法は無い（MpsSvc / FirewallRules は管理者専用）。
- 生ソケット（任意 IP プロトコルの送信）は管理者権限が必要。

### B-2. 推奨するルールの組み方（決定1により確定: TCP の許可ポート以外・UDP・ping を塞ぐ）

許可エントリ集合 E = {(ip, tcpPort)}、A = E に現れる IP の集合、P(ip) = その IP の許可ポート集合。

| # | ルール | 内容 |
|---|---|---|
| 1 | Block / Protocol **Any** / IPv4 | RemoteAddress = `127.0.0.0/8 ∪ A` の**補集合**（区間列）。今の 2 区間を A のぶんだけ分割 |
| 2 | Block / Protocol Any / IPv6 | `"::/1","8000::/1"`（**変更なし**） |
| 3 | Allow / Protocol Any | `127.0.0.0/8`（**変更なし**） |
| 4 | Block / **TCP** | RemoteAddress = 同じ P をもつ IP 群、RemotePort = **P の補集合**（例 `1521` 許可 → `"1-1520,1522-65535"`） |
| 5 | Block / **UDP** | RemoteAddress = A（全ポート） |
| 6 | Block / **ICMPv4**（ping） | RemoteAddress = A |

実効: `127.0.0.0/8` 全部 ＋ 各 (ip, 許可 TCP ポート) のみ通る。それ以外は従来どおり遮断。GRE・ESP 等の他 IP プロトコルは生ソケット＝管理者権限が必要なためこの身元からは到達できず（**[公式]**）、個別の Block は置かない（決定1は TCP 以外・UDP・ping のみを対象にしており、ここで言う範囲と一致）。

- 例（`10.1.200.1:1521` を許可）: ルール 1 の範囲は `0.0.0.0-10.1.200.0`, `10.1.200.2-126.255.255.255`, `128.0.0.0-255.255.255.255` の 3 区間になる。
- ルール数（許可 10 件）: 基本 3 本 ＋ ポート集合の種類ぶんの TCP Block（通常 1〜3、最悪 10）＋ UDP 1 ＋ ICMPv4 1 → **概ね 8〜15 本**。
- ポート補集合の文字列は 1 IP あたり数十文字（10 ポートでも 150 文字程度）。`-RemotePort "0-1520"` のように 0 を含められるかは **[実機]** 未確認（含められないなら `1-1520` から。宛先ポート 0 は実害なし）。

### B-3. 切替の順序（緩む瞬間を作らない）

正規化した許可リストから digest `D` を作り、**全ルールの `-Name` に `D` を含める**（`DevRelay-Sandbox-<D>-<n>`、DisplayName は従来の `DevRelay Sandbox - …` 接頭辞を維持、全ルールに `-Group "DevRelay Sandbox"`）。適用手順:

1. `D` のルールを**全部作る**（既に同名があればスキップ＝無変更時は何もしない＝冪等）
2. グループ内で `D` 以外の Name のルールを**全部消す**

この順だと重なっている間の実効は「新 ∪ 旧」＝すべて Block なので**常に目標以上に厳しい**。緩む瞬間は構造的に発生しない（新しい許可が効き始めるのが数百ミリ秒遅れるだけ）。許可を削るときも同じ手順で安全側。

### B-4. 区間計算の安全装置

IPv4 補集合の区間計算は（D のとおり特権スクリプトが自分で計算する必要があるため）PowerShell 側に書くしかないが、Linux の CI でテストできない。→ **スクリプト内に自己検査を入れる**: 計算した区間列について (a) 区間 ∪ `127.0.0.0/8` ∪ A が IPv4 全空間に一致、(b) どの区間も A と loopback を含まない、を数値で検証し、失敗したら**何も変更せず中止**する。前例: 既存スクリプトは公開鍵 blob の長さ 72 と magic `"ECS1"` を適用前に検証して異常なら `exit 1`（`install-sandbox-host.ps1:206-222`）。**[コード]**

---

## C. タスクの設計

### C-1. 実行アカウントと起動方法（決定5・追加2により確定: インストール時の引数で指定した開発者 1 人のみ）

- 実行アカウント: **`NT AUTHORITY\SYSTEM`**（Highest privileges）。FW ルール変更には管理者か SYSTEM が必要 **[公式]**。
- 起動方法: Agent（非管理者）から `schtasks /Run /TN "\DevRelay\apply-sandbox-allowlist"`。既定ではタスクの SD は非管理者に実行権を与えないので、**インストール時に指定した開発者アカウント（引数、例 `-DeveloperAccount "DESKTOP\fwjg2"`）に対して `Schedule.Service` COM の `IRegisteredTask::SetSecurityDescriptor` で読み取り+実行の ACE を 1 本足す**（その SID を SDDL に埋め込む。`BUILTIN\Users` 全体には許可しない）。Task Scheduler の MMC/PowerShell モジュールにこの機能は無く COM 経由が公式の方法 **[公式]** / 実効果は **[実機]**。
- **引数は構造的に渡せない**: `schtasks /Run` に引数渡しの機能は無い。`IRegisteredTask::Run` は渡せるが、タスクのアクションに `$(Arg0)` 等が書かれている場合のみ置換される。→ **設計規則: タスクのアクションに `$(ArgN)` を一切書かない。** **[公式]**
- 起動方法の比較（決定6により確定: PC 起動時のトリガ＋Sandbox 実行開始時の Agent 突き合わせのみ。定期実行・常時監視は置かない）:

| 方式 | 採否 |
|---|---|
| **`schtasks /Run`（即時起動トリガ） + `ONSTART`（PC 起動時トリガ）** | **採用**。即時反映のための起動トリガと、再起動後のずれ修復のための起動時トリガを両方登録する |
| 定期トリガ（1〜5 分ごと） | **不採用**（決定6） |
| 管理者権限の常駐サービス | **不採用**（ユーザー指示） |
| 反映のたびに管理者がスクリプトを再実行 | **不採用**（ユーザー指示） |
| SandboxHost サービス自身が反映 | **不採用**。仮想アカウントは非管理者なので不可。LocalSystem 化は SB-0 F-4 の身元検証と矛盾 **[コード]** |

### C-2. スクリプトの置き場所と権限

- リポジトリに `scripts/apply-sandbox-allowlist.ps1`（版管理の正）、**インストール時に `C:\ProgramData\devrelay\sandbox\apply-allowlist.ps1` へコピー**してタスクはコピー側を指す。
- **重要**: タスクが `%APPDATA%\devrelay\agent\scripts\…`（Agent のチェックアウト）を直接実行してはいけない。そこは開発者が書けるので「開発者が SYSTEM で任意コードを実行できる」経路になる **[コード]**。
- コピー先の ACL: `icacls /inheritance:r` → `SYSTEM:(F)` `Administrators:(F)` `<開発者アカウント>:(RX)` のみ。サービス SID には ACE を与えない。

### C-3. `u`（Agent 更新）との関係

- `u` は git 更新なので**リポジトリ側のスクリプトは更新されるが ProgramData のコピーは更新されない**。スクリプトを直したサイクルでは**管理者が `install-sandbox-host.ps1` を 1 回再実行**する必要がある。
- 版のずれ検知: `host.json` に `reconcilerVersion` を足す（今は `{serviceName, sid, protocolVersion:1}`）。Agent 側は `sandbox-protocol.ts` の定数と突き合わせ `sandbox status` に出す。
- 併せて**要求ファイルに `version` を持たせ、スクリプトは理解できない版の要求を拒否**して結果ファイルにそう書く（特権側 fail-closed）。古いスクリプトが新形式を取り違えて適用することがなくなる。

---

## D. 入力の検証（権限昇格を作らない）

前提: タスクが読む要求ファイルは**開発者が書き換えられる**。これは意図どおり（許可先を決めるのは開発者本人、決定0）。守るべき境界は**Sandbox の身元（AI）がそのファイルに触れないこと**。

### D-1. ファイルの分離（追加1により確定）

要求ファイルと結果ファイルは**別フォルダ**に分ける（ACL の意味が逆なので同一フォルダに置くと誤って緩い ACL を継承しやすいため）。

| フォルダ | 役割 | ACL |
|---|---|---|
| `C:\ProgramData\devrelay\sandbox\allowlist-request\` | `request.json`（開発者が書く） | `/inheritance:r` → `SYSTEM:(F)` `Administrators:(F)` `<開発者アカウント>:(M)`。**サービス SID には ACE を与えない** |
| `C:\ProgramData\devrelay\sandbox\allowlist-result\` | `state.json`（SYSTEM が書く） | `/inheritance:r` → `SYSTEM:(F)` `Administrators:(F)` `<開発者アカウント>:(R)`（読み取りのみ）。**サービス SID には ACE を与えない** |

- **要求ファイルがリンク（シンボリックリンク・ジャンクション・リパースポイント）なら読まずに拒否する。** タスクは `request.json` を開く前に `(Get-Item $path).Attributes -band [IO.FileAttributes]::ReparsePoint` 等でリパースポイント属性を確認し、真なら読み込み自体を行わず `state.json` に `reason: 'request_file_is_reparse_point'` のみを書く（内容には触れない）。開発者が書ける ACL の下でリンクを使った読み取り先の誘導（他ユーザー所有ファイルの読み込み等）を塞ぐため。
- **拒否した入力の原文は結果ファイルに書き戻さない。** `state.json.rejected` には「何番目のエントリが、どの理由で拒否されたか（固定の reason コードのみ）」だけを書く。開発者が書いた生の文字列をそのまま SYSTEM 権限のファイルに転記しない（情報の混入・ログ汚染防止）。

### D-2. 受け付ける形式（これ以外は全部拒否）

- ファイルサイズ上限 64KB、エントリ上限 **20 件**（決定7）
- `ip`: `/32` の IPv4 文字列のみ（厳格な正規表現 → さらに `[System.Net.IPAddress]::Parse()` + `GetAddressBytes()` で再解釈し、**ルールに書くのは再直列化した正規形**。入力文字列をそのままルールに渡さない）。CIDR・範囲・ホスト名・IPv6 は拒否
- `port`: 整数 1〜65535（TCP のみ。プロトコル指定は受け付けない）

### D-3. 安全床（決定0: 会社が決める上限は置かない。ただしネットワーク的に無意味・危険な宛先はスクリプト自身の安全装置として拒否する）

- 必ず拒否する宛先: `0.0.0.0/8` / `127.0.0.0/8` / `169.254.0.0/16` / `224.0.0.0/4` / `240.0.0.0/4` / `255.255.255.255`。これは「会社が決める許可範囲の上限」ではなく、許可リストという機能自体が意味を持たない・ルール計算が破綻する宛先を落とす安全装置であり、決定0と矛盾しない。
- **上位プロキシの拒否（決定4により確定）**: インストール時に管理者が `-DenyDestination "10.0.0.5:8080"` のように渡し、**管理者のみ書ける deny ファイル**（`C:\ProgramData\devrelay\sandbox\allowlist-deny\deny.json`、ACL は `SYSTEM:(F)` `Administrators:(F)` のみ＝開発者も読み取りのみ）に記録する。スクリプトは要求を検証する前にこれを読み、該当する要求エントリを拒否する。既定は空。
- 文字列をコマンドに連結しない: `netsh` / `Invoke-Expression` / `&` + 組み立て文字列は使わず、`New-NetFirewallRule` に型付きパラメータで渡す。
- タスクが触る範囲: `-Group "DevRelay Sandbox"` のルールだけ。グループ指定なしの `Remove-NetFirewallRule`、プロファイル設定・既定動作の変更、ネットワーク通信、プロセス起動は一切行わない。

---

## E. 設定の持ち方と結果の見せ方

### E-1. 置き場所（決定2により確定: config.yaml のみ、CLI は作らない）

> **本文との食い違いの注記**: 本サイクルの調査時点では「config.yaml ＋ CLI `devrelay sandbox allow …`」を推奨案としていたが、決定2により **SB-2.1 では `config.yaml` の直接編集のみ**とし、専用 CLI サブコマンドは作らない（既存の `sandbox status` に表示を追加するところまでは行うが、追加・削除・適用の専用コマンドは置かない）。

`config.yaml` の `sandbox` 配下に 1 行形式で足す（既存 `sandbox.allowlist: string[]` と同じ流儀）:

```yaml
sandbox:
  projects: [ "C:\\dev\\myrepo" ]
  allowlist: [ "api.anthropic.com:443" ]      # 既存: ドメイン（中継プロキシ）
  allowDestinations: [ "10.1.200.1:1521" ]    # 新規: 直接通信を許す IP とポート（PC 単位）
```

- 型は `agents/linux/src/services/config.ts:45-63`、読み直しは**毎ターン**（`ai-runner.ts:2400` `loadConfig as loadAgentConfigFresh`）。`sandbox.projects` と同じ経路なので「保存したのに効かない」が起きない **[コード]**。
- 変更できるのは `%APPDATA%\devrelay\config.yaml` を書ける人＝**開発者本人のみ**。Sandbox の身元からは読めないことが hp630g9 で実測済み（`doc/sandbox/SB-1_verification.md:17`）。
- 画面（サーバー経由）は**次サイクル以降**。理由: (a) 既存の web 編集可能なマシン設定（`capabilityConfig` / `projectsDirs` / `skipPermissions` / `autoUpdate`、`MachinesPage.tsx:756-1200`）はいずれも `server:config:update` の `||` ack 連鎖（`connection.ts:661-666`）・`PendingConfigUpdate`（`agent-manager.ts:276-283`）・`pushConfigUpdate` 署名・型の 4 箇所同時編集で、`agents/macos/.../connection.ts:605` には `capabilityConfig` 分岐が無いという取りこぼしが既にある **[コード]**、(b) サーバーが他人の PC に穴を開ける経路の新設、(c) オフラインでテスト DB に繋げなくなる。
  将来画面から編集する場合も、**サーバーが送った値を Agent が `config.yaml` に書き、特権タスクは常に `config.yaml` 由来の要求ファイルだけを読む**形にする（前例: `handleProjectsDirsUpdate()` → `saveConfig()`、`connection.ts:3133-3148`）。

### E-2. 反映結果の見せ方

`state.json`（SYSTEM が書く。D-1 のとおり `allowlist-result\` に置く）:

```json
{ "reconcilerVersion": 1, "result": "ok", "appliedAt": "...", "digest": "<正規形の sha256>",
  "applied": [{"ip":"10.1.200.1","port":1521}],
  "rejectedCount": 1, "rejected": [{"index": 3, "reason": "invalid_port"}],
  "ruleNames": ["DevRelay-Sandbox-ab12cd34-1", "..."], "error": null }
```

> **本文との食い違いの注記**: 当初案の `rejected: [{"raw": "...", "reason": "..."}]`（拒否エントリの原文を書き戻す形）は **追加1 により撤回**。上記のとおり `index` と固定の `reason` コードのみを書く。

- `sandbox status` に 1 節追加: 設定の件数 / 最終反映時刻 / 一致・不一致 / 拒否件数と理由コード / `reconcilerVersion` のずれ。
- **実際に効いているかの確認**はホスト経由で許可先へ TCP 接続を 1 回試す（既存 `runHostRoutedCommand()`（`cli/commands/sandbox.ts:416`）で足りる。`SandboxHost.cs` の改造は不要＝プロトコル版 1 のまま）。これは `status` / `selftest` でのみ実行し、毎ターンは digest 比較だけに留める。
- WebUI に出すなら前例は `agent:capability:sync` → `Machine.capabilitySyncStatus Json?` → `MachinesPage.tsx:1038-1090`（Agent 由来 JSON は web 側で一度正規化する決まり。`machine-display-rules.ts:6-10` の白画面事故の教訓）。本サイクルでは作らない。

### E-3. 設定と実ルールが食い違うときの実行可否（決定3により確定）

> **本文との食い違いの注記**: 当初案（「実ルールが設定より厳しい側のずれなら警告して実行、緩い側のずれなら拒否」という方向の区別）は **決定3 により撤回**。方向の区別はせず、以下に統一する。

1. `config.yaml` の `allowDestinations` が未設定/空で、かつ `state.json`（結果ファイル）が存在しない → **一致として扱う**（初回インストール直後・本機能を使っていない PC で、従来の Sandbox 実行を一切妨げない）
2. 上記以外: 設定の正規形から計算した digest と `state.json.digest` を比較
   - 一致 → そのまま実行
   - 不一致 → `schtasks /Run` でタスクを 1 回起動し、最大 10 秒待って `state.json` を再読込
     - 再読込後に一致 → 実行
     - 再読込後も不一致 → **実行を拒否**（方向を問わず拒否。既存の fail-closed 文言表 `sandbox-readiness.ts:123-145` に理由を 1 件追加）

この形は「設定は書いたがまだ一度も反映されていない PC」を壊さずに保ちつつ、ずれが解消しない場合は常に安全側（拒否）に倒す。

---

## F. 既存インストール（hp630g9）の移行とアンインストール

- **`install-sandbox-host.ps1` の再実行 1 回で足りる**（FW ルールはワイルドカード削除→再作成、サービスは停止→削除→再作成、ディレクトリは `-Force`）**[コード]**。
- 新ルールに `-Group` を足すので `uninstall-sandbox-host.ps1` の削除条件を **DisplayName ワイルドカード ∪ Group** の両方に広げる。
- アンインストールに**追加すること**: タスクの登録解除（`schtasks /Delete /TN "\DevRelay\apply-sandbox-allowlist" /F`）。`allowlist-request\` / `allowlist-result\` / `allowlist-deny\` / `apply-allowlist.ps1` は `C:\ProgramData\devrelay\sandbox` 丸ごと削除で片付くが、**タスクは消えない** **[コード]**。
- 既存の取り残し（今サイクル対象外だが記録）: `sandbox prep` がプロジェクトに付けた ACE（`.git\hooks` の deny を含む）は `sc delete` 後に解決不能 SID として残る。`uninstall-sandbox-host.ps1:74` も「Agent 側設定は消さない」と明記。

> **本文との食い違いの注記（追加3）**: 調査時点の本文（SB-0/SB-1 の記述を踏襲）は「鍵ペアとサービス SID が毎回変わるため、再インストール後は各プロジェクトで `sandbox prep` の再実行が必要」としていたが、**追加3 により要再確認**とする。
> `install-sandbox-host.ps1:176-177` の SID 解決は `(New-Object System.Security.Principal.NTAccount("NT SERVICE\devrelay-sandbox")).Translate([SecurityIdentifier])` で、仮想サービスアカウントの SID はサービス名から決まる（毎回ランダムに割り当てられるものではない）という理解がある。これが正しければ、サービス名（`devrelay-sandbox`、固定）を変えない再インストールでは SID は変わらず、`sandbox prep` の再実行は不要になるはずである。
> 鍵ペア自体は毎回再生成されるため、`host.json` の `sid` フィールドと公開鍵の更新は必要（Agent 側の検証に使うため）。SID が本当に安定しているかは SB-2.1 の実機確認で裏を取り、安定していれば移行手順から「`sandbox prep` の再実行」を削除する。不安定であれば現行の記述（再実行が必要）を維持する。

---

## G. 比較: ループバック中継案

Agent が `127.0.0.1:<port>` で受けてテスト DB へ TCP 中継する案。**長所**: 管理者権限・タスク・特権スクリプト・FW 変更が一切不要（loopback は既に許可済み）、即時反映、接続の記録を Agent 内でそのまま取れる、Windows 以外へも同じ形で広げられる。**短所**: 接続先の書き換えが必要なので「本番と同じ設定でテストする」ができない、DB 製品ごとの相性が出る（Oracle は listener が別ホスト/別ポートへリダイレクトし得るため単一ポート転送では足りない場合がある **[実機]**、SQL Server の名前付きインスタンスは UDP 1434 の browser と動的ポートに依存、TLS 証明書のホスト名検証は `127.0.0.1` 宛で失敗する）、AI が触る設定ファイルを Sandbox 用に分岐させる保守が増える。**採否**: 主方式としては採らない——「テスト対象の接続設定そのものを書き換えないと動かない」のはこの機能の目的（開発者が普段どおり作業できること）と正面から衝突し、製品ごとの相性問題を DevRelay が抱え込むことになるため。ただし管理者権限がどうしても使えない PC 向けの逃げ道として、また FW 方式が実機で詰まったときの代替として設計は残す（Agent 内の中継プロキシ `sandbox-proxy.ts` に TCP モードを足すだけで実装できる **[コード]**）。

---

## 推奨構成（全体像）

```
開発者 → config.yaml の sandbox.allowDestinations を編集
   └ Agent（非管理者）が正規化して allowlist-request\request.json を書く
        │   （ProgramData、Sandbox からは読めない ACL。リンクなら読まず拒否）
        └ schtasks /Run でタスクを起動
             └ タスク（SYSTEM・ProgramData 配下の固定スクリプト・引数なし）
                  ├ deny.json（管理者設定の拒否先）を先に適用
                  ├ 要求を厳格に検証（/32 の IP と TCP ポートのみ・20 件上限・安全床で拒否）
                  ├ 補集合を計算し自己検査（全空間一致・許可先を含まない）
                  ├ digest 付き名で全ルールを作る → グループ内の旧 digest を消す（緩む瞬間なし）
                  └ allowlist-result\state.json に結果を書く（拒否入力の原文は書かない）
        └ Agent は digest を比較し、不一致なら 1 回再反映を試み、解消しなければ実行を拒否する
          （未設定かつ結果ファイルなしは一致として扱う）
```

### 採らなかった案と理由
- **Allow ルールを足して許可する**: Block が Allow に勝つため構造的に効かない **[公式]**
- **許可 IP をブロック範囲から外すだけ（ポートを絞らない）**: 1 行で済むが、許可した 1 台に対して全ポート・全プロトコルが開く。「IP とポート」という要件を満たさない
- **管理者権限の常駐プロセス / 反映ごとの管理者操作**: ユーザー指示により除外
- **サーバー（画面）から許可リストを配る**: E-1 の 3 点。将来やるとしても `config.yaml` 経由に落とす
- **専用 CLI サブコマンド（`sandbox allow add/remove/list`）**: 決定2により SB-2.1 では作らない
- **ループバック中継を主方式にする**: G のとおり
- **`SandboxHost.cs` を改造してホスト側に反映機能を持たせる**: 仮想アカウントは非管理者なので不可。LocalSystem 化は身元検証の前提を壊す

---

## 実装サイクルの分け方

### SB-2.1（最初のサイクル・最小範囲）
**ゴール**: `config.yaml` に `10.1.200.1:1521` と書いて反映すると Sandbox から TCP/1521 で届き、`10.1.1.1`（指定外）と `10.1.200.1` の他ポートは止まる。

| 範囲 | 変更 |
|---|---|
| Agent（純関数・新規） | `sandbox-allow-destinations.ts`（`"ip:port"` の検証・正規化・canonical digest。外部 import ゼロ、`sandbox-allowlist.ts` と同じ流儀で fail-closed、上限 20 件）、`sandbox-allow-state.ts`（`state.json` の正規化と一致判定・決定3の再反映ロジック） |
| Agent（I/O） | `config.ts` の `sandbox` 型に `allowDestinations?: string[]`、`allowlist-request\request.json` 書き出し＋`schtasks /Run`＋`allowlist-result\state.json` 読み（新規 `sandbox-allow-apply.ts`）、`sandbox-preflight.ts` に 1 項目追加、`sandbox-readiness.ts` の拒否理由を 1 件追加、`sandbox status` に 1 節追加。**CLI 専用サブコマンドは追加しない（決定2）** |
| スクリプト（新規） | `scripts/apply-sandbox-allowlist.ps1`（ASCII のみ。deny.json 適用→検証→補集合計算→自己検査→digest 付きルール作成→旧 digest 削除→`state.json`。引数なし・`$(Arg` を含まない） |
| スクリプト（改修） | `install-sandbox-host.ps1`: 3 本のルールに `-Group` と `-Name` を付与、`-DeveloperAccount` 引数の追加（追加2）、`allowlist-request\`/`allowlist-result\`/`allowlist-deny\` の作成と ACL、`apply-allowlist.ps1` のコピーと ACL、タスク登録（`SetSecurityDescriptor` で開発者アカウントに実行権）＋`ONSTART`トリガ、`host.json` に `reconcilerVersion`。`uninstall-sandbox-host.ps1`: タスク削除、Group 併用削除 |
| テスト | 新純関数 2 本の表駆動テスト（境界値・拒否理由・digest 安定性・20 件上限）、`sandbox-scripts-guard.test.mjs` の **A4 を更新**（現状「`New-NetFirewallRule` は 3 本」を断定しているため必ず落ちる）＋新スクリプト用の静的ガード（ASCII のみ / `$(Arg` を含まない / `Remove-NetFirewallRule` は必ず `-Group` 付き / `Invoke-Expression`・`netsh` を使わない / 自己検査が存在する / 拒否エントリの原文を結果ファイルに書いていない） |
| 対象外 | WebUI、サーバー、DB（**DB 変更なし**＝`0037` は使わない）、`SandboxHost.cs`、macOS/Electron、ドメイン許可リスト、SMB、CLI 専用サブコマンド |

`pnpm build` は要。**pm2 restart は不要**。対象 Windows 機で `u` ＋ 管理者で `install-sandbox-host.ps1` 1 回（`-DeveloperAccount` 指定）。

### SB-2.2（運用の磨き）
反映結果を `agent:*` でサーバーへ上げて `MachinesPage` の Agent Settings に表示、許可リストの画面編集（`config.yaml` に落とす形）、TTL キャッシュ（既存の未配線純関数 `isSandboxProbeCacheFresh()` を使う）でターンの待ち時間を削る、許可先を AI に伝える 1 行（決定8）、複数開発者機への対応、パイプ ACL の疑義（A-3）の裏取り。

### SB-2.3（残課題）
ドメイン許可リストの編集 UI、SMB の扱い（会社ドメインでの確認結果次第）、`sandbox prep` の ACE 取り残しの掃除。

---

## 実機確認（1 巡・hp630g9）

1. 管理者で `install-sandbox-host.ps1 -DeveloperAccount "<このマシンの開発者アカウント>"` 再実行 → サービス起動 / タスクが `\DevRelay\` に `ONSTART` トリガで登録 / `host.json` に `reconcilerVersion`
2. **追加3 の確認**: 再実行前後でサービス SID（`host.json.sid`）が変わるかを比較する。変わらなければ `sandbox prep` の再実行は不要（本文 F の注記を確定させる）。変わるなら各プロジェクトで `sandbox prep` を再実行する
3. 指定した開発者アカウントのシェルで `schtasks /Run /TN "\DevRelay\apply-sandbox-allowlist"` が**成功**する（決定5・追加2 の SDDL が効いている）。**別アカウント**では失敗することも確認する
4. `config.yaml` に `allowDestinations: [ "10.1.200.1:1521" ]` → `sandbox status` が「一致」「最終反映時刻」を表示
5. Sandbox ON のチャットから `10.1.200.1:1521` へ**届く** / `10.1.200.1:1522` が**止まる**（決定1の TCP ポート外） / `10.1.1.1:1521` が**止まる** / `10.1.200.1` への ping が**止まる**（決定1） / `api.anthropic.com:443` 直結が**従来どおり止まる**
6. `config.yaml` から当該行を削除 → 反映後に `10.1.200.1:1521` が**止まる**
7. 不正な値（`10.1.200.0/24`、`10.1.200.1:0`、`example.com:443`、21 件）: Agent が受け付けない、または `state.json` の `rejected` に **index と理由コードのみ**が出て（原文は出ない）**ルールは一切変わらない**
8. 要求ファイルをリンクに差し替える（`mklink` 等）→ 読み込まれず `state.json` に専用の理由が出る（追加1）
9. ずれの扱い（決定3）: `request.json` を書いたあとタスクを動かさずにチャット実行 → 再反映が 1 回走り、それでも解消しなければ拒否される。初回（`allowDestinations` 未設定・`state.json` 無し）では**一致扱いで実行できる**ことも確認
10. 身元の確認（A-3 の疑義の裏取り、SB-2.1 対象外だが可能なら実施）: ホスト経由で `whoami /groups` を 1 回実行し `BUILTIN\Users` / `Authenticated Users` 所属を確認し、パイプ ACL の件を別課題として記録
11. アンインストール: `Get-NetFirewallRule -Group "DevRelay Sandbox"` と `schtasks /Query /TN "\DevRelay\apply-sandbox-allowlist"` が**どちらも空**
12. 退行確認: Sandbox OFF のプロジェクト、Linux の Agent、`allowDestinations` 未設定の Windows 機が**何も変わらない**

---

## 参考（公式ドキュメント）

- [Windows Firewall Rules（評価順: Allow if Secure → Block → Allow）](https://learn.microsoft.com/en-us/windows/security/operating-system-security/network-security/windows-firewall/rules)
- [New-NetFirewallRule（`-RemotePort` の範囲・配列、`-LocalUser` の SDDL、`-Group`）](https://learn.microsoft.com/en-us/powershell/module/netsecurity/new-netfirewallrule?view=windowsserver2025-ps)
- [IRegisteredTask::SetSecurityDescriptor](https://learn.microsoft.com/en-us/windows/win32/api/taskschd/nf-taskschd-iregisteredtask-setsecuritydescriptor)
- [IRegisteredTask::Run（`$(ArgN)` 置換の仕様）](https://learn.microsoft.com/en-us/windows/win32/api/taskschd/nf-taskschd-iregisteredtask-run)
- [schtasks run（引数渡しの機能が無い）](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/schtasks-run)
- [Fleex's Lab: Allowing standard users to run a privileged scheduled task](https://fleexlab.blogspot.com/2020/12/allowing-standard-users-to-run.html)

---

## 決定事項（2026-11-23 けいすけ）

上記調査結果に対する人間の決定を以下に記録する。本文と食い違う箇所は、本文側に注記を入れた
（E-1・E-2・E-3・F）うえで、この決定事項を正とする。

- **決定0**: 許可先は開発者が自由に書ける（会社が決める上限は置かない）
- **決定1**: 許可した IP 宛は、TCP の許可ポート以外・UDP・ping を塞ぐ
- **決定2**: 最初のサイクルの編集は `config.yaml` のみ。CLI（`sandbox allow …`）は作らない
- **決定3**: 設定と実ルールが不一致なら再反映を 1 回試み、解消できなければ実行を拒否する
  （厳しい側・緩い側の区別はしない）。未設定かつ結果ファイルなしは一致として扱う
- **決定4**: 上位プロキシの拒否は、インストール時に管理者が指定（既定は空）
- **決定5**: タスクを起動できるのは、インストール時に指定した開発者 1 人
- **決定6**: 確認は PC 起動時（タスクの起動時トリガ）と Sandbox 実行開始時（Agent の突き合わせ）。
  定期実行・常時監視は置かない
- **決定7**: 上限 20 件
- **決定8**: 許可先を AI に伝えるのは別サイクル
- **追加1**: 要求ファイル（開発者が書ける）と結果ファイル（SYSTEM と管理者だけが書ける）は
  フォルダを分ける。拒否した入力の原文は結果に書き戻さない。要求ファイルがリンク
  （リパースポイント）なら読まずに拒否する
- **追加2**: 開発者アカウントはインストール時の引数で明示指定する
- **追加3**: 「再インストールでサービス SID が変わるので `sandbox prep` の再実行が要る」は
  要再確認（SID はサービス名から決まるはず）。SB-2.1 で `sandbox prep` の再実行を
  不要にできるか確認する
