// AI 回答契約サイクル（2026-11-23）: session-manager.ts の配線ソース静的ガード
// （node:fs、dist/ には依存しない。ask-knowledge-wiring.test.mjs と同じ手口）。
//
// これが無いと、将来のリファクタで以下が黙って崩れても気づけない:
// - push/FCM/createNotification が chatText（人間向け本文）ではなく messageToSend（詳細含む
//   全文）を使ってしまう（通知本文に技術的な詳細・進捗ノイズが混ざる）
// - web への配信が shareUrl を渡し忘れる（WebUI に詳細リンクが出なくなる）
// - discord/telegram への配信が chatText ベースでなくなる

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const source = readFileSync(path.join(serverRoot, 'src/services/session-manager.ts'), 'utf8');

describe('session-manager.ts: finalizeProgress の配線', () => {
  test('resolveLiveDeliveryContent を使っている', () => {
    assert.match(source, /resolveLiveDeliveryContent\(/);
  });

  test('push 通知（sendPushNotificationForSession）は chatText を使う（messageToSend ではない）', () => {
    assert.match(source, /sendPushNotificationForSession\(sessionId,\s*chatText\)/);
  });

  test('FCM 通知（sendFcmNotificationForSession）は chatText を使う（messageToSend ではない）', () => {
    assert.match(source, /sendFcmNotificationForSession\(sessionId,\s*chatText\)/);
  });

  test('createNotification は chatText を使う（messageToSend ではない）', () => {
    assert.match(source, /createNotification\([^)]*chatText[^)]*\)/);
  });

  test('sendWebMessage は shareUrl を渡している', () => {
    assert.match(source, /sendWebMessage\([^)]*delivery\.shareUrl[^)]*\)/);
  });

  test('sendWebMessage は webMessageToSend（markdown リンク埋め込み済み）を本文として渡す', () => {
    assert.match(source, /sendWebMessage\(chatId, webMessageToSend,/);
  });

  test('web 向け本文は markdown 形式の案内行を使う（モバイルアプリ等 shareUrl フィールドを知らないクライアントでもリンクが消えない）', () => {
    assert.match(source, /webMessageToSend\s*=\s*delivery\.shareUrl[\s\S]{0,80}buildShareSuffix\('markdown',/);
  });

  test('discord/telegram 送信は discordMessageToSend/telegramMessageToSend（chatText 由来）を使う', () => {
    assert.match(source, /editDiscordMessage\(chatId, msgInfo\.messageId as string, discordMessageToSend\)/);
    assert.match(source, /sendDiscordMessage\(chatId, discordMessageToSend, files\)/);
    assert.match(source, /editTelegramMessage\(chatId, msgInfo\.messageId as number, telegramMessageToSend\)/);
    assert.match(source, /sendTelegramMessage\(chatId, telegramMessageToSend, files\)/);
  });
});
