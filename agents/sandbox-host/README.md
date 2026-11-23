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

`scripts/install-sandbox-host.ps1` が `New-Object System.Security.Cryptography.ECDsaCng(256)`
（キーサイズ指定の .ctor。`ECCurve` を渡す .ctor は Windows PowerShell 5.1 では別オーバーロードに
解決され P-256 にならないため使わない。SB-1a-1.1 で判明）で ECDSA P-256 鍵対を生成し:

- 秘密鍵: `C:\ProgramData\devrelay\sandbox\host-key.priv.blob`（CNG `EccPrivateBlob` 形式の
  raw バイト列。サービス SID のみ読める ACL）
- 公開鍵: `C:\ProgramData\devrelay\sandbox\host-key.pub`（X.509 SubjectPublicKeyInfo PEM。
  誰でも読める。Node.js `crypto.createPublicKey()` がそのまま読める標準形式）

公開鍵 blob は生成直後に長さ（72 バイト = 8 ヘッダ + X32 + Y32）と magic（`ECS1` =
`BCRYPT_ECDSA_PUBLIC_P256_MAGIC`）を検査し、不正ならインストールを中止する。

## hp630g9（Windows 11 / Windows PowerShell 5.1 / Node 24.12.0）実機確認済み（2026-11-23）

- in-box `csc.exe` でのビルド成功
- `sc.exe create obj="NT SERVICE\devrelay-sandbox"`（`password=` 指定なし）でのサービス作成。
  解決された SID の例: `S-1-5-80-155625040-3701452770-3529234849-117044284-2303438102`
- `New-NetFirewallRule -LocalUser "D:(A;;CC;;;<サービス SID>)"` が子・孫プロセスまで含めて
  実際に通信を遮断する（`-Service` 形式は未検証のため使っていない）
- `ECDsaCng(256)` で生成した鍵が Node の `crypto.createPublicKey()` で読め、署名検証が通る
- `status` コマンドで 14 項目すべて OK（署名検証・陽性対照の遮断・ホストからの読み書きを含む）

## 既知の未検証事項（Windows 実機でのみ確認可能、SB-1a-1.1 時点）

- `-LocalUser` 形式の Allow loopback ルール単体の効果（Block 2 本は確認済み）
- `selftest --claude-roundtrip` が cli.js 形式（0.2 系 SDK）のとき `node.exe` をサービス身元が
  読めるか
- `selftest --bits-probe` を Sandbox home 配下へ出力した場合の BITS の挙動
- Job Object（kill-on-job-close）による孫プロセスの確実な終了（`selftest --spawn` は 1 階層の
  プロセスしか起動しないため未検証）
- 名前付きパイプの ACL（`PipeAccessRule`）が意図通りに機能するか
- `uninstall-sandbox-host.ps1` の ACL 戻し後の完全削除
