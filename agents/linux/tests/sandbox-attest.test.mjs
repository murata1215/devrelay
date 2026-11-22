import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  buildSandboxAttestationMessage,
  generateSandboxNonce,
  verifySandboxAttestationSignature,
  signSandboxAttestationMessage,
  fingerprintSandboxPublicKey,
} from '../dist/services/sandbox-attest.js';

function baseFields(overrides = {}) {
  return {
    nonce: 'abc123',
    serviceName: 'NT SERVICE\\devrelay-sandbox',
    sid: 'S-1-5-80-1111111111-2222222222-3333333333-4444444444',
    protocolVersion: 1,
    claudeExecutablePath: 'C:\\dev\\agent\\node_modules\\.pnpm\\claude.exe',
    projectPath: 'C:\\dev\\repo',
    positiveControlBlocked: true,
    loopbackReachable: true,
    claudeExecutableReadable: true,
    projectFolderWritable: true,
    ...overrides,
  };
}

describe('sandbox-attest', () => {
  // ECDSA P-256（.NET Framework の ECDsaCng がネイティブに対応する唯一の曲線。
  // Ed25519 は .NET Framework に無く NuGet 無しでは実装できないため採用しなかった）
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  test('正しい署名は検証に通る', () => {
    const message = buildSandboxAttestationMessage(baseFields());
    const signature = signSandboxAttestationMessage(privateKeyPem, message);
    assert.equal(verifySandboxAttestationSignature(publicKeyPem, message, signature), true);
  });

  test('改竄された nonce（メッセージ内容の変更）は署名検証で拒否される', () => {
    const message = buildSandboxAttestationMessage(baseFields());
    const signature = signSandboxAttestationMessage(privateKeyPem, message);
    const tamperedMessage = buildSandboxAttestationMessage(baseFields({ nonce: 'different-nonce' }));
    assert.equal(verifySandboxAttestationSignature(publicKeyPem, tamperedMessage, signature), false);
  });

  test('別のパス（claudeExecutablePath/projectPath）への回答流用は署名検証で拒否される', () => {
    const message = buildSandboxAttestationMessage(baseFields());
    const signature = signSandboxAttestationMessage(privateKeyPem, message);
    const otherProjectMessage = buildSandboxAttestationMessage(baseFields({ projectPath: 'C:\\dev\\other-repo' }));
    assert.equal(verifySandboxAttestationSignature(publicKeyPem, otherProjectMessage, signature), false);
  });

  test('別の鍵で署名されたメッセージは拒否される', () => {
    const other = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const otherPrivatePem = other.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const message = buildSandboxAttestationMessage(baseFields());
    const signature = signSandboxAttestationMessage(otherPrivatePem, message);
    assert.equal(verifySandboxAttestationSignature(publicKeyPem, message, signature), false);
  });

  test('署名が空文字列の場合は拒否される（例外を投げない）', () => {
    const message = buildSandboxAttestationMessage(baseFields());
    assert.equal(verifySandboxAttestationSignature(publicKeyPem, message, ''), false);
  });

  test('不正な base64 / 不正な PEM でも例外を投げず false を返す', () => {
    const message = buildSandboxAttestationMessage(baseFields());
    assert.equal(verifySandboxAttestationSignature('not a pem', message, 'not-base64!!'), false);
    assert.equal(verifySandboxAttestationSignature(publicKeyPem, message, '###'), false);
  });

  test('generateSandboxNonce: 既定は crypto.randomBytes で毎回異なる値を生成する', () => {
    const a = generateSandboxNonce();
    const b = generateSandboxNonce();
    assert.notEqual(a, b);
    assert.equal(a.length, 64); // 32 bytes → hex で 64 文字
  });

  test('generateSandboxNonce: 乱数生成を注入できる（テスト容易性）', () => {
    const fixed = generateSandboxNonce(() => Buffer.from('00112233445566778899aabbccddeeff00112233445566778899aabbccddee', 'hex'));
    assert.equal(fixed, '00112233445566778899aabbccddeeff00112233445566778899aabbccddee');
  });

  test('fingerprintSandboxPublicKey: 同じ鍵なら同じ指紋、異なる鍵なら異なる指紋', () => {
    const fp1 = fingerprintSandboxPublicKey(publicKeyPem);
    const fp2 = fingerprintSandboxPublicKey(publicKeyPem);
    assert.equal(fp1, fp2);
    const other = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const otherPem = other.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    assert.notEqual(fp1, fingerprintSandboxPublicKey(otherPem));
  });
});
