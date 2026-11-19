// 2026-09-30: getHelpText() の `k`（停止コマンド）が「その他/Other」の最下部に埋没せず、
// 上部の専用ブロックに昇格していることを固定する回帰テスト
// （停止手段の発見可能性改善サイクル、command-parser.ts）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getHelpText } from '../dist/services/command-parser.js';

test('getHelpText: ja/en 双方に `k` が含まれる', () => {
  const ja = getHelpText('ja');
  const en = getHelpText('en');
  assert.match(ja, /`k`/);
  assert.match(en, /`k`/);
});

test('getHelpText: `k` の出現位置が「その他」/「Other」見出しより前（埋没への回帰防止）', () => {
  const ja = getHelpText('ja');
  const en = getHelpText('en');

  const jaKillIndex = ja.indexOf('`k`');
  const jaOtherIndex = ja.indexOf('**その他**');
  assert.ok(jaKillIndex >= 0, 'ja: `k` が見つかること');
  assert.ok(jaOtherIndex >= 0, 'ja: 「その他」見出しが見つかること');
  assert.ok(jaKillIndex < jaOtherIndex, 'ja: `k` が「その他」より前にあること');

  const enKillIndex = en.indexOf('`k`');
  const enOtherIndex = en.indexOf('**Other**');
  assert.ok(enKillIndex >= 0, 'en: `k` が見つかること');
  assert.ok(enOtherIndex >= 0, 'en: 「Other」見出しが見つかること');
  assert.ok(enKillIndex < enOtherIndex, 'en: `k` が「Other」より前にあること');
});

// 2026-10-31: コマンドマニュアル作成サイクル。ヘルプがパーサの実装に追随していることを固定する。
import { AGREEMENT_VERSION } from '../dist/services/agreement-template.js';

test('getHelpText: ja/en 双方に teamexec・d・u force・login cancel・testflight cp が載っている', () => {
  const saved = process.env.DEVRELAY_TESTFLIGHT;
  delete process.env.DEVRELAY_TESTFLIGHT;
  try {
  for (const lang of ['ja', 'en']) {
    const t = getHelpText(lang);
    for (const s of ['`teamexec ', '`d`', '`u force`', '`login cancel`', '`testflight cp ']) {
      assert.ok(t.includes(s), `${lang}: ${s} が含まれること`);
    }
  }
  } finally {
    if (saved === undefined) delete process.env.DEVRELAY_TESTFLIGHT; else process.env.DEVRELAY_TESTFLIGHT = saved;
  }
});

test('getHelpText: Agreement の版数が AGREEMENT_VERSION と一致（ハードコード v4 への回帰防止）', () => {
  for (const lang of ['ja', 'en']) {
    const t = getHelpText(lang);
    assert.ok(t.includes(`Agreement ${AGREEMENT_VERSION}`), `${lang}: Agreement ${AGREEMENT_VERSION}`);
    assert.ok(!t.includes('Agreement v4'), `${lang}: v4 が残っていないこと`);
  }
});

// 2026-11-18: ヘルプの環境別出し分け（会社 devrelay は testflight 無効・WebUI のみ）。
function withEnv(name, value, fn) {
  const saved = process.env[name];
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
  try { return fn(); } finally {
    if (saved === undefined) delete process.env[name]; else process.env[name] = saved;
  }
}

test('getHelpText: DEVRELAY_TESTFLIGHT=0 ならテストフライト節を出さない', () => {
  for (const lang of ['ja', 'en']) {
    withEnv('DEVRELAY_TESTFLIGHT', '0', () => {
      const t = getHelpText(lang);
      assert.ok(!/testflight/i.test(t), `${lang}: testflight が出ないこと`);
      assert.ok(!t.includes('テストフライト'), `${lang}: テストフライト見出しが出ないこと`);
    });
    withEnv('DEVRELAY_TESTFLIGHT', undefined, () => {
      assert.ok(getHelpText(lang).includes('`testflight cp '), `${lang}: 未設定なら出ること`);
    });
  }
});

test('getHelpText: DEVRELAY_THREAD_HANDOVER=0 ならスレッド引継ぎ節を出さない', () => {
  for (const lang of ['ja', 'en']) {
    withEnv('DEVRELAY_THREAD_HANDOVER', '0', () => {
      assert.ok(!getHelpText(lang).includes('`n make`'), `${lang}: n make が出ないこと`);
    });
    withEnv('DEVRELAY_THREAD_HANDOVER', undefined, () => {
      assert.ok(getHelpText(lang).includes('`n make`'), `${lang}: 未設定なら出ること`);
    });
  }
});

test('getHelpText: web では link を出さず login を出す / discord・telegram ではその逆', () => {
  for (const lang of ['ja', 'en']) {
    const web = getHelpText(lang, { platform: 'web' });
    assert.ok(!web.includes('`link`'), `${lang}/web: link が出ないこと`);
    assert.ok(web.includes('`login cancel`'), `${lang}/web: login が出ること`);
    for (const platform of ['discord', 'telegram']) {
      const t = getHelpText(lang, { platform });
      assert.ok(t.includes('`link`'), `${lang}/${platform}: link が出ること`);
      assert.ok(!t.includes('`login'), `${lang}/${platform}: login が出ないこと`);
    }
  }
});

test('getHelpText: 未実装の sum を載せない・空行が二重にならない', () => {
  for (const lang of ['ja', 'en']) {
    for (const platform of [undefined, 'web', 'discord']) {
      withEnv('DEVRELAY_TESTFLIGHT', '0', () => {
        const t = getHelpText(lang, { platform });
        assert.ok(!t.includes('`sum`'), `${lang}: sum が出ないこと`);
        assert.ok(!t.includes('\n\n\n'), `${lang}: 空行が二重にならないこと`);
      });
    }
  }
});
