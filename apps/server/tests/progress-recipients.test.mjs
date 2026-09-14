import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { resolveProgressRecipients } from '../dist/services/progress-recipients.js';

/**
 * サイクルS1（C4）: `web:progress` の配信先を送信時 live 評価に揃えるための
 * `resolveProgressRecipients()` の単体テストと、呼び出し側（session-manager.ts）が
 * 旧スナップショット走査に戻っていないことを固定する静的ガード。
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');

function readServerSource(relPath) {
  return readFileSync(path.join(serverRoot, relPath), 'utf8');
}

describe('resolveProgressRecipients: 非退行（従来のスナップショット走査と同一の入力）', () => {
  test('ターン開始時と同じ参加者のみ（web/discord/telegram 混在）は従来と同じ結果になる', () => {
    const result = resolveProgressRecipients({
      liveParticipants: [
        { platform: 'web', chatId: 'web:u1:tab1' },
        { platform: 'discord', chatId: 'discord-chat-1' },
        { platform: 'telegram', chatId: 'telegram-chat-1' },
      ],
      trackerMessages: [
        ['web:u1:tab1', { messageId: 'webmsg_abc', platform: 'web' }],
        ['discord-chat-1', { messageId: 'discordmsg_1', platform: 'discord' }],
        ['telegram-chat-1', { messageId: 111, platform: 'telegram' }],
      ],
    });
    assert.deepEqual(result, [
      { platform: 'web', chatId: 'web:u1:tab1', messageId: 'webmsg_abc' },
      { platform: 'discord', chatId: 'discord-chat-1', messageId: 'discordmsg_1' },
      { platform: 'telegram', chatId: 'telegram-chat-1', messageId: 111 },
    ]);
  });

  test('空 participants / 空 tracker なら空配列（例外にならない）', () => {
    assert.deepEqual(resolveProgressRecipients({ liveParticipants: [], trackerMessages: [] }), []);
  });
});

describe('resolveProgressRecipients: ターン開始後に参加した web タブ（C4 本体）', () => {
  test('tracker に記録が無い web チャットでも live participant なら含まれる（messageId: null）', () => {
    const result = resolveProgressRecipients({
      liveParticipants: [
        { platform: 'web', chatId: 'web:u1:tab1' },
        { platform: 'web', chatId: 'web:u1:tab2-joined-mid-turn' },
      ],
      trackerMessages: [
        ['web:u1:tab1', { messageId: 'webmsg_abc', platform: 'web' }],
        // tab2 は tracker に無い（ターン開始時に WS 非 OPEN だった、または後から switch で参加した）
      ],
    });
    assert.deepEqual(result, [
      { platform: 'web', chatId: 'web:u1:tab1', messageId: 'webmsg_abc' },
      { platform: 'web', chatId: 'web:u1:tab2-joined-mid-turn', messageId: null },
    ]);
  });

  test('ターン開始時に tracker が完全に空でも、live participant の web は含まれる', () => {
    const result = resolveProgressRecipients({
      liveParticipants: [{ platform: 'web', chatId: 'web:u1:tab-only-mid-turn' }],
      trackerMessages: [],
    });
    assert.deepEqual(result, [{ platform: 'web', chatId: 'web:u1:tab-only-mid-turn', messageId: null }]);
  });
});

describe('resolveProgressRecipients: セッション参加を外れたタブ', () => {
  test('tracker に残っていても live participants に無ければ含まれない', () => {
    const result = resolveProgressRecipients({
      liveParticipants: [{ platform: 'web', chatId: 'web:u1:tab-still-here' }],
      trackerMessages: [
        ['web:u1:tab-still-here', { messageId: 'webmsg_1', platform: 'web' }],
        ['web:u1:tab-left-mid-turn', { messageId: 'webmsg_2', platform: 'web' }],
      ],
    });
    assert.deepEqual(result, [{ platform: 'web', chatId: 'web:u1:tab-still-here', messageId: 'webmsg_1' }]);
  });
});

describe('resolveProgressRecipients: discord/telegram は tracker に記録が無ければ新規投稿しない', () => {
  test('discord: tracker に messageId が無いチャットは live participant でも除外する', () => {
    const result = resolveProgressRecipients({
      liveParticipants: [{ platform: 'discord', chatId: 'discord-chat-mid-turn' }],
      trackerMessages: [],
    });
    assert.deepEqual(result, []);
  });

  test('telegram: tracker に messageId が無いチャットは live participant でも除外する', () => {
    const result = resolveProgressRecipients({
      liveParticipants: [{ platform: 'telegram', chatId: 'telegram-chat-mid-turn' }],
      trackerMessages: [],
    });
    assert.deepEqual(result, []);
  });

  test('discord: tracker に messageId があれば messageId がそのまま引き継がれる', () => {
    const result = resolveProgressRecipients({
      liveParticipants: [{ platform: 'discord', chatId: 'discord-chat-1' }],
      trackerMessages: [['discord-chat-1', { messageId: 'discordmsg_xyz', platform: 'discord' }]],
    });
    assert.deepEqual(result, [{ platform: 'discord', chatId: 'discord-chat-1', messageId: 'discordmsg_xyz' }]);
  });
});

describe('resolveProgressRecipients: 重複排除・順序保存', () => {
  test('liveParticipants に同一 platform+chatId の重複があっても初出のみ含む', () => {
    const result = resolveProgressRecipients({
      liveParticipants: [
        { platform: 'web', chatId: 'web:u1:tab1' },
        { platform: 'web', chatId: 'web:u1:tab1' },
      ],
      trackerMessages: [['web:u1:tab1', { messageId: 'webmsg_abc', platform: 'web' }]],
    });
    assert.deepEqual(result, [{ platform: 'web', chatId: 'web:u1:tab1', messageId: 'webmsg_abc' }]);
  });

  test('liveParticipants の順序をそのまま保つ', () => {
    const result = resolveProgressRecipients({
      liveParticipants: [
        { platform: 'web', chatId: 'c' },
        { platform: 'web', chatId: 'a' },
        { platform: 'web', chatId: 'b' },
      ],
      trackerMessages: [],
    });
    assert.deepEqual(result.map((r) => r.chatId), ['c', 'a', 'b']);
  });
});

describe('静的ガード: session-manager.ts の updateProgressMessages が live 評価に置き換わっている', () => {
  const source = readServerSource('src/services/session-manager.ts');

  test('updateProgressMessages が resolveProgressRecipients( を呼んでいる', () => {
    assert.match(source, /async function updateProgressMessages[\s\S]{0,800}resolveProgressRecipients\(/);
  });

  test('updateProgressMessages 内に旧スナップショット走査（for (const [chatId, ...] of tracker.messages)）が残っていない', () => {
    const idx = source.indexOf('async function updateProgressMessages');
    assert.notEqual(idx, -1);
    const nextFnIdx = source.indexOf('\nfunction ', idx + 1);
    const nextExportIdx = source.indexOf('\nexport ', idx + 1);
    const boundaries = [nextFnIdx, nextExportIdx].filter((n) => n !== -1);
    const end = boundaries.length > 0 ? Math.min(...boundaries) : source.length;
    const body = source.slice(idx, end);
    assert.doesNotMatch(body, /for \(const \[chatId, \{ messageId, platform \}\] of tracker\.messages\)/);
  });

  test('progress-recipients.js からの import が存在する', () => {
    assert.match(source, /from '\.\/progress-recipients\.js'/);
  });
});

describe('静的ガード: progress-recipients.ts は外部ランタイム import を持たない（純関数モジュール規約）', () => {
  test('import 文は型 import（import type）のみ', () => {
    const source = readServerSource('src/services/progress-recipients.ts');
    const importLines = source
      .split('\n')
      .filter((line) => /^\s*import\b/.test(line));
    const offenders = importLines.filter((line) => !/^\s*import type\b/.test(line));
    assert.deepEqual(offenders, [], `型 import 以外の import が見つかった: ${JSON.stringify(offenders)}`);
  });
});
