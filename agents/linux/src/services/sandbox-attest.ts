/**
 * Sandbox Host の身元・プローブ結果の真正性を ECDSA（P-256 / SHA-256）署名で検証する。
 *
 * 改訂版 Plan の致命的指摘1（名前付きパイプの先取りで自己申告の身元検証が無意味になる）への対策。
 * 秘密鍵は管理者用インストールスクリプトが生成し、仮想アカウント（`NT SERVICE\devrelay-sandbox`）
 * のみが読める DACL を付ける（開発者自身には読む権利を与えない）。公開鍵は誰でも読める。
 * Agent は nonce を送り、Sandbox Host は「nonce + 自分の身元 + プローブ結果」に署名して返す。
 * **署名が公開鍵で検証できた場合のみ、ホストの報告内容を信用してよい**（検証できない限り、
 * 身元・プローブ結果は証拠にならない自己申告のままとして扱うこと＝呼び出し側の責務）。
 *
 * **アルゴリズムについて（Plan からの変更点。実装時に判明した制約への対応）**:
 * 承認された Plan は ed25519 を前提にしていたが、Sandbox Host（`agents/sandbox-host/SandboxHost.cs`）は
 * 「管理者権限なしの in-box `csc.exe`（.NET Framework 相当、NuGet 不可）でビルドする」という
 * 要件5（管理者操作の分離）・設計の制約がある。.NET Framework の `System.Security.Cryptography` には
 * Ed25519 が存在せず、外部パッケージ（NuGet）を使わずに Ed25519 を実装する手段がない。
 * 一方 **ECDSA（NIST P-256）+ SHA-256 は Node.js 標準 `node:crypto` と .NET Framework 標準
 * （`System.Security.Cryptography.ECDsaCng`、CNG 経由、追加パッケージ不要）の両方がネイティブに
 * サポートしている**ため、両言語間の相互運用を追加依存ゼロで実現できる唯一の現実的な選択肢として
 * ECDSA P-256 に変更した。署名の安全性（秘密鍵を持たない限り偽造不能・公開鍵で検証可能）という
 * セキュリティ特性は ed25519 と同等であり、Plan が要求した「身元・プローブ結果を署名で裏付ける」
 * という目的は変わらず満たされる。
 *
 * 署名形式は **IEEE P1363（r||s の連結、DER ではない）**で固定する。.NET の `ECDsa.SignData`/
 * `VerifyData` は既定でこの形式を使うため、Node 側も `dsaEncoding: 'ieee-p1363'` を明示して
 * 合わせる（Node の既定は DER であり、明示しないと相互運用できない）。
 */

import { sign as cryptoSign, verify as cryptoVerify, randomBytes } from 'node:crypto';

/** 署名ダイジェスト（SHA-256 固定） */
const SIGNATURE_DIGEST = 'sha256';

export interface SandboxAttestationFields {
  nonce: string;
  serviceName: string;
  sid: string;
  protocolVersion: number;
  /** ハンドシェイク要求で指定した claude 実行ファイルのパス（署名にバインドし、別パスへの
   *  回答の付け替え・リプレイを防ぐ） */
  claudeExecutablePath: string;
  /** ハンドシェイク要求で指定したプロジェクトパス（同上） */
  projectPath: string;
  /** 陽性対照（許可リストの実ホストへの直結）が遮断された（＝ファイアウォールが効いている） */
  positiveControlBlocked: boolean;
  /** Agent の loopback 中継プロキシへの接続確認が成功した（＝プローブが実際に実行された証拠） */
  loopbackReachable: boolean;
  /** ホストが `claudeExecutablePath` を実際に open できる */
  claudeExecutableReadable: boolean;
  /** ホストが `projectPath` に書き込める */
  projectFolderWritable: boolean;
}

/**
 * 署名対象の正規化バイト列を組み立てる（フィールド順を固定し、改竄検知の対象を明確にする）。
 * フィールドを増やす場合はここに追記し、既存フィールドの順序は変えないこと（互換性のため）。
 */
export function buildSandboxAttestationMessage(fields: SandboxAttestationFields): Buffer {
  const canonical = [
    `nonce=${fields.nonce}`,
    `serviceName=${fields.serviceName}`,
    `sid=${fields.sid}`,
    `protocolVersion=${fields.protocolVersion}`,
    `claudeExecutablePath=${fields.claudeExecutablePath}`,
    `projectPath=${fields.projectPath}`,
    `positiveControlBlocked=${fields.positiveControlBlocked}`,
    `loopbackReachable=${fields.loopbackReachable}`,
    `claudeExecutableReadable=${fields.claudeExecutableReadable}`,
    `projectFolderWritable=${fields.projectFolderWritable}`,
  ].join('\n');
  return Buffer.from(canonical, 'utf-8');
}

/** nonce を生成する（既定は `crypto.randomBytes`。テストでは注入可能） */
export function generateSandboxNonce(randomBytesFn: (size: number) => Buffer = randomBytes): string {
  return randomBytesFn(32).toString('hex');
}

/**
 * ECDSA（P-256 / SHA-256, IEEE P1363 形式）署名を検証する。鍵不正・署名不正・例外時は
 * **すべて false** を返す（例外を投げない＝呼び出し側は必ず fail-closed で扱える）。
 */
export function verifySandboxAttestationSignature(
  publicKeyPem: string,
  message: Buffer,
  signatureBase64: string,
): boolean {
  try {
    const signature = Buffer.from(signatureBase64, 'base64');
    if (signature.length === 0) return false;
    return cryptoVerify(SIGNATURE_DIGEST, message, { key: publicKeyPem, dsaEncoding: 'ieee-p1363' }, signature);
  } catch {
    return false;
  }
}

/**
 * ECDSA（P-256 / SHA-256, IEEE P1363 形式）署名を作成する（Sandbox Host 本体は .NET 側の
 * `ECDsaCng.SignData()` で署名するため、この関数は Agent 側のテスト・将来の Node 実装用）。
 */
export function signSandboxAttestationMessage(privateKeyPem: string, message: Buffer): string {
  const signature = cryptoSign(SIGNATURE_DIGEST, message, { key: privateKeyPem, dsaEncoding: 'ieee-p1363' });
  return signature.toString('base64');
}

/**
 * 公開鍵 PEM からキャッシュキー用の簡易指紋を作る（暗号的な一意性はファイル全体の内容比較に
 * 依存しており、ここでは衝突耐性は不要。識別のみ）。
 */
export function fingerprintSandboxPublicKey(publicKeyPem: string): string {
  let hash = 0;
  for (let i = 0; i < publicKeyPem.length; i++) {
    hash = (hash * 31 + publicKeyPem.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16);
}
