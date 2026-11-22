# DevRelay Sandbox Host（サイクル SB-1a-1）

Windows サービス。仮想アカウント `NT SERVICE\devrelay-sandbox` の身元でプロセスを起動し、
stdin/stdout/stderr を Agent（開発者の身元・常駐）との名前付きパイプ経由で中継するだけの
小さなプログラム。Plan/Exec ゲート（PreToolUse / canUseTool / disallowedTools /
permissionMode / strictReadonly）は Agent プロセスに残る。本サービスはツール許可の判断を
一切持たない（詳細 `doc/sandbox/SB-0_investigation.md` §2）。

## ビルド

`scripts/install-sandbox-host.ps1`（管理者権限必須）が in-box の `csc.exe`
（.NET Framework、NuGet 不要）でビルドする。手動でビルドする場合:

```powershell
$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
& $csc /nologo /target:winexe /out:SandboxHost.exe `
  /r:System.ServiceProcess.dll /r:System.Web.Extensions.dll /r:System.Core.dll `
  SandboxHost.cs
```

C# 5 相当の構文のみを使用する（文字列補間・式形式メンバ・null 条件演算子は使わない）。
JSON は NuGet 無しで使える `System.Web.Script.Serialization.JavaScriptSerializer` を使う。

## プロトコル

Agent 側 `agents/linux/src/services/sandbox-{protocol,frames,attest}.ts` と対になる実装。
値を変更する場合は両方を同時に変更すること。

- フレーム: `[1 byte type][4 bytes length (big-endian)][payload...]`
- 署名: ECDSA（P-256 / SHA-256, IEEE P1363 形式）。Ed25519 は .NET Framework に無く
  NuGet 無しでは実装できないため採用しなかった（詳細は `sandbox-attest.ts` のコメント、
  Plan からの変更点として devlog にも記録している）。

## 署名鍵

`scripts/install-sandbox-host.ps1` が ECDSA P-256 鍵対を生成し:

- 秘密鍵: `C:\ProgramData\devrelay\sandbox\host-key.priv.blob`（CNG `EccPrivateBlob` 形式の
  raw バイト列。サービス SID のみ読める ACL）
- 公開鍵: `C:\ProgramData\devrelay\sandbox\host-key.pub`（X.509 SubjectPublicKeyInfo PEM。
  誰でも読める。Node.js `crypto.createPublicKey()` がそのまま読める標準形式）

## 既知の未検証事項（Windows 実機でのみ確認可能）

- in-box `csc.exe` でのビルド成功（アセンブリ参照の正確性）
- `NT SERVICE\devrelay-sandbox` の SID 解決・サービス作成
- `New-NetFirewallRule -Service <name>` が実際にサービスの通信を対象にするか
- ファイアウォールの Outbound Block 時に Node 側で観測される実際のソケットエラー
  （想定は `WSAEACCES`/10013。`agents/linux/src/services/sandbox-readiness.ts` の
  `SANDBOX_BLOCK_ERROR_CODES` を参照、実測値が異なれば更新すること）
- Job Object（kill-on-job-close）によるプロセスツリーの確実な終了
- 名前付きパイプの ACL（`PipeAccessRule`）が意図通りに機能するか
