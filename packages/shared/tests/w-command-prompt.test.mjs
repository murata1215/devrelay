// #372: `w` コマンドプロンプト（i18n.ts の W_COMMAND_PROMPT_JA / _EN）の回帰テスト。
// コンパイル済み dist を直接 import する（i18n.test.mjs と同じ流儀）。
//
// 背景: 従来の `w` は「MEMORY.md があれば更新してください」としか指示しておらず、書式も分量も
// 対象パスも指定していなかった。その結果 Claude Code の自動メモリ索引
// `~/.claude/projects/<slug>/memory/MEMORY.md` に本文が積み上がり、-opt-devrelay で 330KB /
// 約 118,000 トークンまで肥大して exec が機能しなくなった。exec モードの【記憶の引き継ぎ】と
// 同じ「1 行索引だけ・本文は archive_worklog_YYYY-MM.md へ」ルールをここでも強制する。

import test from 'node:test';
import assert from 'node:assert/strict';
import { getWCommandPrompt, W_COMMAND_PROMPT_PREFIXES } from '../dist/i18n.js';

const LANGS = ['ja', 'en'];

test('#372: 両言語の w プロンプトが MEMORY.md の 1 行索引ルールを含む', () => {
  for (const lang of LANGS) {
    const p = getWCommandPrompt(lang);
    assert.ok(p.includes('MEMORY.md'), `${lang}: MEMORY.md への言及が無い`);
    assert.ok(
      p.includes('archive_worklog_YYYY-MM.md'),
      `${lang}: 本文の退避先 archive_worklog_YYYY-MM.md が指示されていない`
    );
    assert.ok(
      p.includes('~/.claude/projects/'),
      `${lang}: 対象パス（Claude Code の自動メモリ索引）が明示されていない`
    );
  }
});

test('#372: git リポジトリ / 非リポジトリの両分岐でルールが効く', () => {
  // ルール本文にだけ現れる目印。片方の分岐にしか入れていない同期漏れを検出する。
  const sentinel = {
    ja: '毎セッション全文がコンテキストに載る索引ファイル',
    en: 'whose full contents are loaded into context every session',
  };
  for (const lang of LANGS) {
    const p = getWCommandPrompt(lang);
    const occurrences = p.split(sentinel[lang]).length - 1;
    assert.equal(occurrences, 2, `${lang}: ルールが両分岐に入っていない (${occurrences} 箇所)`);
  }
});

test('#372: 「日付つきで作業メモを追記」型の旧文言が復活していない', () => {
  const ja = getWCommandPrompt('ja');
  const en = getWCommandPrompt('en');
  assert.ok(!ja.includes('MEMORY.md があれば更新してください'), 'JA: 書式指定の無い旧文言が残っている');
  assert.ok(!ja.includes('日付つきで作業メモ・決定事項・次回への引き継ぎを追記'), 'JA: 本文追記を促す旧文言が残っている');
  assert.ok(!en.includes('Update MEMORY.md if it exists.'), 'EN: 書式指定の無い旧文言が残っている');
  assert.ok(!en.includes('with dated notes on work done'), 'EN: 本文追記を促す旧文言が残っている');
});

test('#304 非退行: 実行判定プレフィックスが変わっていない', () => {
  // command-handler.ts は W_COMMAND_PROMPT_PREFIXES で過去の `w` 実行を判定する。
  // プロンプト冒頭を書き換えると過去ログの判定が壊れるため、先頭は固定する。
  assert.equal(W_COMMAND_PROMPT_PREFIXES[0], 'まず `git rev-parse --is-inside-');
  assert.equal(W_COMMAND_PROMPT_PREFIXES[1], 'First run `git rev-parse --is-');
  for (const [i, lang] of LANGS.entries()) {
    assert.ok(
      getWCommandPrompt(lang).startsWith(W_COMMAND_PROMPT_PREFIXES[i]),
      `${lang}: プロンプト本文とプレフィックスが乖離している`
    );
  }
});
