#!/usr/bin/env node
// raw-codex-runner.test.mjs 用の偽 codex CLI。
// `codex exec --help` と `codex exec [...] -` の最小限の挙動をシミュレートする。
//
// stdin の内容（末尾の制御行）で挙動を切り替える:
//   - 先頭行が `__FAKE_CODEX_SLEEP__<ms>` → その ms だけ待ってから通常応答する（timeout 検証用）
//   - 先頭行が `__FAKE_CODEX_EXEC_TOOL__` → agent_message の代わりに command_execution アイテムを出す
//   - 先頭行が `__FAKE_CODEX_FAIL_TURN__` → turn.failed を出す
//   - 先頭行が `__FAKE_CODEX_EXIT_NONZERO__` → turn.completed を出さずに exit code 1 で終了する
//   - 先頭行が `__FAKE_CODEX_BAD_JSON__` → 壊れた JSON 行を1行混ぜる
//   - それ以外 → stdin 全文を agent_message として echo する
//
// 受け取った argv は `--record-args` フラグが渡されていれば stderr に `ARGV_JSON:<json>` として出力する
// （`runRawCodex()` が組み立てた実際の引数列をテストから検証するため）。

import { readFileSync } from 'fs';

const args = process.argv.slice(2);

if (args.includes('--help')) {
  // probeRawCodexSupport() が正規表現で拾うキーワードを含める
  process.stdout.write('Usage: codex exec [OPTIONS] [PROMPT]\n  --json    Print events to stdout as JSONL\n  --ephemeral    Run without persisting session files to disk\n');
  process.exit(0);
}

// 引数列を可観測にする（デバッグ・テスト検証用）
process.stderr.write(`ARGV_JSON:${JSON.stringify(args)}\n`);
process.stderr.write(`ENV_PATH:${process.env.PATH ?? ''}\n`);

let stdin = '';
try {
  stdin = readFileSync(0, 'utf-8');
} catch {
  stdin = '';
}

const lines = stdin.split('\n');
const control = lines[0] ?? '';
const rest = lines.slice(control.startsWith('__FAKE_CODEX_') ? 1 : 0).join('\n');

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function main() {
  emit({ type: 'thread.started', thread_id: 'th_fake_001' });

  if (control.startsWith('__FAKE_CODEX_SLEEP__')) {
    const ms = parseInt(control.slice('__FAKE_CODEX_SLEEP__'.length), 10) || 0;
    await new Promise((resolve) => setTimeout(resolve, ms));
    emit({ type: 'item.completed', item: { type: 'agent_message', text: rest || 'slept' } });
    emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0 } });
    return;
  }

  if (control === '__FAKE_CODEX_EXEC_TOOL__') {
    emit({ type: 'item.completed', item: { type: 'command_execution', command: 'cat /etc/passwd' } });
    emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0 } });
    return;
  }

  if (control === '__FAKE_CODEX_FAIL_TURN__') {
    emit({ type: 'turn.failed', error: { message: 'simulated turn failure' } });
    return;
  }

  if (control === '__FAKE_CODEX_EXIT_NONZERO__') {
    process.stderr.write('fatal: simulated crash\n');
    process.exit(1);
  }

  if (control === '__FAKE_CODEX_BAD_JSON__') {
    process.stdout.write('this is not json {{{\n');
    emit({ type: 'item.completed', item: { type: 'agent_message', text: rest || 'recovered' } });
    emit({ type: 'turn.completed', usage: { input_tokens: 2, output_tokens: 2, cached_input_tokens: 0, cache_write_input_tokens: 0 } });
    return;
  }

  emit({ type: 'item.completed', item: { type: 'agent_message', text: stdin } });
  emit({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 3, cache_write_input_tokens: 1 } });
}

main();
