// 組織プロバイダー強制サイクル（2026-11-24）: AI プロバイダー設定（`*_provider` の7キー）が
// 組織 AI デフォルトの判定（resolveProviderSetting/isAiSettingLocked）を経由するようになった
// ことの配線ソース静的ガード（node:fs、dist/ には依存しない。response-split-wiring.test.mjs と
// 同じ手口）。
//
// これが無いと、将来のリファクタで以下が黙って崩れても気づけない:
// - user-settings.ts の getApiKeyFor* 7関数が getUserSetting 直読みに戻り、組織強制が効かなくなる
// - routes/api.ts の PUT/DELETE /api/settings/:key が旧 isModelSettingLocked のまま残り、
//   プロバイダーキーのロックが効かなくなる
// - routes/organization.ts の PUT /api/org/ai-defaults が、キルスイッチ OFF 時に
//   プロバイダーキーを 400 で拒否してしまい、管理者のモデル既定編集をブリックする

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const userSettingsSource = readFileSync(path.join(serverRoot, 'src/services/user-settings.ts'), 'utf8');
const apiSource = readFileSync(path.join(serverRoot, 'src/routes/api.ts'), 'utf8');
const organizationSource = readFileSync(path.join(serverRoot, 'src/routes/organization.ts'), 'utf8');
const commandHandlerSource = readFileSync(path.join(serverRoot, 'src/services/command-handler.ts'), 'utf8');

const PROVIDER_SETTING_KEYS = [
  'BUILD_SUMMARY_PROVIDER',
  'CHAT_AI_PROVIDER',
  'DEV_REPORT_PROVIDER',
  'TERMINAL_AI_PROVIDER',
  'VOICE_ASSIST_PROVIDER',
  'ORG_SUMMARY_PROVIDER',
  'REPLY_SUMMARY_PROVIDER',
];

describe('user-settings.ts: プロバイダー7関数は resolveProviderSetting 経由（getUserSetting 直読みは0箇所）', () => {
  for (const key of PROVIDER_SETTING_KEYS) {
    test(`SettingKeys.${key} は getUserSetting(...) 直読みされていない`, () => {
      const directReadPattern = new RegExp(`getUserSetting\\([^)]*SettingKeys\\.${key}\\)`);
      assert.doesNotMatch(userSettingsSource, directReadPattern);
    });
  }

  test('resolveProviderSetting が定義されている', () => {
    assert.match(userSettingsSource, /export async function resolveProviderSetting\(/);
  });

  test('resolveProviderSetting はキルスイッチ（isOrgProviderControlEnabled）を見ている', () => {
    assert.match(userSettingsSource, /isOrgProviderControlEnabled\(process\.env\.DEVRELAY_ORG_PROVIDER_DEFAULTS\)/);
  });

  for (const key of PROVIDER_SETTING_KEYS) {
    test(`SettingKeys.${key} は resolveProviderSetting を経由して読まれている`, () => {
      const wiredPattern = new RegExp(`resolveProviderSetting\\(userId,\\s*SettingKeys\\.${key}\\)`);
      assert.match(userSettingsSource, wiredPattern);
    });
  }
});

describe('routes/api.ts: PUT/DELETE /api/settings/:key は isAiSettingLocked 経由（旧 isModelSettingLocked は残っていない）', () => {
  test('isModelSettingLocked は import・呼び出しどちらにも残っていない', () => {
    assert.doesNotMatch(apiSource, /isModelSettingLocked/);
  });

  test('isAiSettingLocked が import されている', () => {
    assert.match(apiSource, /import\s*\{[^}]*isAiSettingLocked[^}]*\}\s*from\s*'\.\.\/services\/org-ai-defaults\.js'/);
  });

  test('isAiSettingLocked はキルスイッチ env を渡している', () => {
    const matches = apiSource.match(/isAiSettingLocked\(userId,\s*key,\s*process\.env\.DEVRELAY_ORG_PROVIDER_DEFAULTS\)/g) || [];
    assert.ok(matches.length >= 2, 'PUT/DELETE 両方で isAiSettingLocked(userId, key, process.env.DEVRELAY_ORG_PROVIDER_DEFAULTS) を呼んでいること');
  });

  test('PUT はプロバイダー値の enum 検証を行っている', () => {
    assert.match(apiSource, /isOrgAiProviderKey\(key\)\s*&&\s*!isValidOrgAiDefaultValue\(key,\s*value\.trim\(\)\)/);
  });
});

describe('routes/organization.ts: PUT /api/org/ai-defaults はキルスイッチ OFF 時にプロバイダーキーを400にしない', () => {
  test('isOrgAiProviderKey と providerControlEnabled のガードがある', () => {
    assert.match(organizationSource, /isOrgAiProviderKey\(key\)\s*&&\s*!providerControlEnabled/);
  });

  test('ガードの直後は 400 を返さず continue している（既存値を保持する分岐）', () => {
    const idx = organizationSource.indexOf('isOrgAiProviderKey(key) && !providerControlEnabled');
    assert.ok(idx >= 0, 'ガード自体が見つからない');
    const closeBraceIdx = organizationSource.indexOf('}', idx);
    const block = organizationSource.slice(idx, closeBraceIdx + 1);
    assert.doesNotMatch(block, /reply\.status\(400\)/);
    assert.match(block, /continue;/);
  });

  test('GET /api/org/ai-defaults は providerControlEnabled を返す', () => {
    assert.match(organizationSource, /providerControlEnabled:\s*isOrgProviderControlEnabled\(/);
  });

  test('isUnsafeModelId への依存は無い（isValidOrgAiDefaultValue に一本化済み）', () => {
    assert.doesNotMatch(organizationSource, /isUnsafeModelId/);
  });
});

describe('services/command-handler.ts: l コマンドはプロバイダー組織既定も可視化し、旧 isModelSettingLocked は残っていない', () => {
  test('isModelSettingLocked は import・呼び出しどちらにも残っていない', () => {
    assert.doesNotMatch(commandHandlerSource, /isModelSettingLocked/);
  });

  test('isAiSettingLocked が import されている', () => {
    assert.match(commandHandlerSource, /isAiSettingLocked/);
  });

  test('handleModelList は isOrgAiProviderKey で組織既定のプロバイダー一覧を出す', () => {
    assert.match(commandHandlerSource, /isOrgAiProviderKey\(key\)/);
  });
});
