import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideSandboxPreflight,
  buildSandboxDenialMessage,
  interpretSandboxBlockProbe,
  buildSandboxCacheKey,
  isSandboxProbeCacheFresh,
  SANDBOX_BLOCK_ERROR_CODES,
  decideSandboxTurnEligibility,
} from '../dist/services/sandbox-readiness.js';

/** 全項目を満たした基準入力（表駆動テストの出発点） */
function baseInput(overrides = {}) {
  return {
    disabledBySwitch: false,
    platform: 'win32',
    effectiveAiTool: 'claude',
    terminalMode: false,
    projectPathUnderUserProfile: false,
    capabilityDeclared: true,
    claudeExecutableFallbackActive: false,
    allowlistValid: true,
    pipeConnected: true,
    protocolVersionMatch: true,
    signatureValid: true,
    identityServiceNameMatches: true,
    identitySidHasServicePrefix: true,
    identitySidDiffersFromAgent: true,
    identitySidNotKnownPrivileged: true,
    blockProbePositiveControlBlocked: true,
    blockProbeLoopbackReachable: true,
    hostCanReadClaudeExecutable: true,
    hostCanWriteProjectFolder: true,
    ...overrides,
  };
}

describe('sandbox-readiness: decideSandboxPreflight（表駆動 fail-closed）', () => {
  test('全項目 OK なら許可する', () => {
    assert.deepEqual(decideSandboxPreflight(baseInput()), { allowed: true });
  });

  const cases = [
    [{ disabledBySwitch: true }, 'disabled_by_switch'],
    [{ platform: 'linux' }, 'unsupported_platform'],
    [{ platform: 'darwin' }, 'unsupported_platform'],
    [{ effectiveAiTool: 'devin' }, 'unsupported_ai_tool'],
    [{ effectiveAiTool: 'gemini' }, 'unsupported_ai_tool'],
    [{ terminalMode: true }, 'terminal_mode_unsupported'],
    [{ projectPathUnderUserProfile: true }, 'project_path_under_user_profile'],
    [{ capabilityDeclared: false }, 'capability_not_declared'],
    [{ claudeExecutableFallbackActive: true }, 'claude_executable_fallback_active'],
    [{ allowlistValid: false }, 'allowlist_invalid'],
    [{ pipeConnected: false }, 'pipe_unreachable'],
    [{ protocolVersionMatch: false }, 'protocol_version_mismatch'],
    [{ signatureValid: false }, 'signature_invalid'],
    [{ identityServiceNameMatches: false }, 'identity_mismatch'],
    [{ identitySidHasServicePrefix: false }, 'identity_mismatch'],
    [{ identitySidDiffersFromAgent: false }, 'identity_mismatch'],
    [{ identitySidNotKnownPrivileged: false }, 'identity_mismatch'],
    [{ blockProbePositiveControlBlocked: false }, 'block_probe_failed'],
    [{ blockProbeLoopbackReachable: false }, 'loopback_probe_failed'],
    [{ hostCanReadClaudeExecutable: false }, 'claude_executable_unreadable'],
    [{ hostCanWriteProjectFolder: false }, 'project_folder_not_writable'],
  ];

  for (const [overrides, expectedReason] of cases) {
    test(`1項目のみ NG: ${JSON.stringify(overrides)} → ${expectedReason}`, () => {
      const decision = decideSandboxPreflight(baseInput(overrides));
      assert.deepEqual(decision, { allowed: false, reason: expectedReason });
    });
  }

  test('署名が無効なら、身元申告が一致していても拒否する（自己申告を証拠にしない）', () => {
    const decision = decideSandboxPreflight(
      baseInput({
        signatureValid: false,
        identityServiceNameMatches: true,
        identitySidHasServicePrefix: true,
        identitySidDiffersFromAgent: true,
        identitySidNotKnownPrivileged: true,
      }),
    );
    assert.deepEqual(decision, { allowed: false, reason: 'signature_invalid' });
  });

  test('複数項目が同時に NG でも最初に当たった理由（判定順序どおり）を返す', () => {
    const decision = decideSandboxPreflight(baseInput({ platform: 'linux', pipeConnected: false }));
    assert.deepEqual(decision, { allowed: false, reason: 'unsupported_platform' });
  });

  test('全ての SandboxDenyReason に対応するメッセージが存在し、空文字でない', () => {
    for (const [, reason] of cases) {
      const message = buildSandboxDenialMessage(reason);
      assert.equal(typeof message, 'string');
      assert.ok(message.length > 0);
    }
  });

  test('拒否文言は resume 失敗 retry の誤判定トリガー文字列を含まない（ai-runner.ts:1987-1995 対策）', () => {
    for (const [, reason] of cases) {
      const message = buildSandboxDenialMessage(reason);
      assert.equal(message.includes('session'), false, `reason=${reason}`);
      assert.equal(message.includes('resume'), false, `reason=${reason}`);
      assert.equal(message.includes('Prompt is too long'), false, `reason=${reason}`);
    }
  });
});

describe('sandbox-readiness: interpretSandboxBlockProbe（陽性対照・fail-closed）', () => {
  test('connected=true は reachable', () => {
    assert.equal(interpretSandboxBlockProbe({ connected: true, timedOut: false }), 'reachable');
  });

  test('EACCES / WSAEACCES は blocked', () => {
    for (const code of SANDBOX_BLOCK_ERROR_CODES) {
      assert.equal(interpretSandboxBlockProbe({ connected: false, timedOut: false, errorCode: code }), 'blocked');
    }
  });

  test('タイムアウトは inconclusive（fail-closed、blocked ではない）', () => {
    assert.equal(interpretSandboxBlockProbe({ connected: false, timedOut: true }), 'inconclusive');
  });

  test('未知のエラーコードは inconclusive（fail-closed）', () => {
    assert.equal(interpretSandboxBlockProbe({ connected: false, timedOut: false, errorCode: 'ECONNRESET' }), 'inconclusive');
  });

  test('エラーコード無し・タイムアウトでもない場合も inconclusive', () => {
    assert.equal(interpretSandboxBlockProbe({ connected: false, timedOut: false }), 'inconclusive');
  });
});

describe('sandbox-readiness: キャッシュキー・TTL', () => {
  test('buildSandboxCacheKey: 入力が同じなら同じキー', () => {
    const input = {
      hostPublicKeyFingerprint: 'abc',
      protocolVersion: 1,
      projectPathReal: 'C:\\dev\\repo',
      allowlistHash: 'hash1',
      proxyPort: 48711,
    };
    assert.equal(buildSandboxCacheKey(input), buildSandboxCacheKey({ ...input }));
  });

  test('buildSandboxCacheKey: いずれかの値が変われば異なるキーになる', () => {
    const base = {
      hostPublicKeyFingerprint: 'abc',
      protocolVersion: 1,
      projectPathReal: 'C:\\dev\\repo',
      allowlistHash: 'hash1',
      proxyPort: 48711,
    };
    const variants = [
      { ...base, hostPublicKeyFingerprint: 'xyz' },
      { ...base, projectPathReal: 'C:\\dev\\other' },
      { ...base, allowlistHash: 'hash2' },
      { ...base, proxyPort: 48712 },
    ];
    const baseKey = buildSandboxCacheKey(base);
    for (const v of variants) {
      assert.notEqual(buildSandboxCacheKey(v), baseKey);
    }
  });

  test('isSandboxProbeCacheFresh: TTL 内は true', () => {
    assert.equal(isSandboxProbeCacheFresh(1000, 1000 + 60_000, 10 * 60 * 1000), true);
  });

  test('isSandboxProbeCacheFresh: TTL 超過は false', () => {
    assert.equal(isSandboxProbeCacheFresh(1000, 1000 + 11 * 60 * 1000, 10 * 60 * 1000), false);
  });

  test('isSandboxProbeCacheFresh: ttlMs が 0 以下なら常に false（キャッシュ無効化）', () => {
    assert.equal(isSandboxProbeCacheFresh(1000, 1001, 0), false);
  });
});

// サイクル SB-1a-2: チャット経路のターン単位の拒否判定（decideSandboxTurnEligibility）
function baseEligibilityInput(overrides = {}) {
  return {
    targetUndecidable: false,
    disabledBySwitch: false,
    platform: 'win32',
    effectiveAiTool: 'claude',
    terminalMode: false,
    rawMode: false,
    isEphemeralSession: false,
    crossAskScope: false,
    handoverTurn: false,
    ...overrides,
  };
}

describe('sandbox-readiness: decideSandboxTurnEligibility（チャット経路の安いふるい）', () => {
  test('全項目 OK なら許可する', () => {
    assert.deepEqual(decideSandboxTurnEligibility(baseEligibilityInput()), { allowed: true });
  });

  const eligibilityCases = [
    [{ targetUndecidable: true }, 'target_undecidable'],
    [{ disabledBySwitch: true }, 'disabled_by_switch'],
    [{ platform: 'linux' }, 'unsupported_platform'],
    [{ effectiveAiTool: 'devin' }, 'unsupported_ai_tool'],
    [{ effectiveAiTool: 'gemini' }, 'unsupported_ai_tool'],
    [{ terminalMode: true }, 'terminal_mode_unsupported'],
    [{ rawMode: true }, 'raw_mode_unsupported'],
    [{ isEphemeralSession: true }, 'ephemeral_session_unsupported'],
    [{ crossAskScope: true }, 'ephemeral_session_unsupported'],
    [{ handoverTurn: true }, 'handover_turn_unsupported'],
  ];

  for (const [overrides, expectedReason] of eligibilityCases) {
    test(`1項目のみ NG: ${JSON.stringify(overrides)} → ${expectedReason}`, () => {
      const decision = decideSandboxTurnEligibility(baseEligibilityInput(overrides));
      assert.deepEqual(decision, { allowed: false, reason: expectedReason });
    });
  }

  test('判定不能（targetUndecidable）が最優先で、キルスイッチより先に当たる', () => {
    const decision = decideSandboxTurnEligibility(baseEligibilityInput({ targetUndecidable: true, disabledBySwitch: true }));
    assert.deepEqual(decision, { allowed: false, reason: 'target_undecidable' });
  });

  test('isEphemeralSession と crossAskScope が両方 true でも ephemeral_session_unsupported を返す', () => {
    const decision = decideSandboxTurnEligibility(baseEligibilityInput({ isEphemeralSession: true, crossAskScope: true }));
    assert.deepEqual(decision, { allowed: false, reason: 'ephemeral_session_unsupported' });
  });

  test('新しい拒否理由（SB-1a-2 追加分）の文言も resume 失敗 retry の誤判定トリガー文字列を含まない', () => {
    const newReasons = ['target_undecidable', 'raw_mode_unsupported', 'ephemeral_session_unsupported', 'handover_turn_unsupported', 'sandbox_token_missing'];
    for (const reason of newReasons) {
      const message = buildSandboxDenialMessage(reason);
      assert.equal(typeof message, 'string');
      assert.ok(message.length > 0);
      assert.equal(message.includes('session'), false, `reason=${reason}`);
      assert.equal(message.includes('resume'), false, `reason=${reason}`);
      assert.equal(message.includes('Prompt is too long'), false, `reason=${reason}`);
    }
  });
});
