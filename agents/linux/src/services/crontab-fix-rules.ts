/**
 * `u` 自己更新で crontab の `@reboot` 行を書き換える sed パイプラインを純粋関数として切り出したもの。
 *
 * 背景（2026-10-18 障害の真因）: 旧実装の2本目の sed は `s/export PATH=\([^ ]*\) cd/export PATH=\1; cd/`
 * で、`[^ ]*`（空白以外の連続）が既に挿入済みのセミコロンも貪欲に飲み込んでしまい、**冪等でなかった**。
 * `u` を実行するたびに `export PATH=...;` の末尾にセミコロンが1個増え続け（`export PATH=...;;`
 * → `;;;` → ...）、数回の `u` で crontab の行がシェル構文エラー（`;;` は bash の syntax error）に
 * なり、`@reboot` が発火しても何も実行されなくなっていた（x220-158-18-103 の 10 台で発生、
 * 現在のセミコロン数＝そのユーザーの `u` 実行回数と一致していた）。
 *
 * 修正: キャプチャを `[^ ;]*`（空白とセミコロンの両方を除外）にする。これにより
 * 「まだ `; cd` を含まない行」にしか一致しなくなり、一度修正された行は二度と変更されない
 * （下記テストで「何度適用しても結果が変わらない」ことを保証している）。
 *
 * このファイルは Linux 専用（`agents/macos` / `agents/windows` にはこの sed 自体が存在しないため
 * 複製不要）。
 */

import { execFileSync } from 'child_process';

/** 1本目の sed: 旧形式（`export` が無い）を新形式に変換する。既に新形式の行には一致しない（冪等） */
export const CRONTAB_FIX_SED_1 = 's/^@reboot PATH=/@reboot export PATH=/';

/**
 * 2本目の sed: `export PATH=<値> cd ...` の直後にセミコロンを挿入する。
 * `[^ ;]*` にしたことで、既に `; cd` になっている行には一致しない（＝冪等）。
 */
export const CRONTAB_FIX_SED_2 = 's/export PATH=\\([^ ;]*\\) cd/export PATH=\\1; cd/';

/**
 * `u` 自己更新スクリプト（`connection.ts` の `buildSteps`）に埋め込む実際のシェルコマンドを返す。
 * crontab 全体を読み込み、2本の sed を通して書き戻す（devrelay 以外の既存 cron ジョブはそのまま）。
 */
export function buildFixCrontabCommand(): string {
  return `crontab -l 2>/dev/null | sed '${CRONTAB_FIX_SED_1}' | sed '${CRONTAB_FIX_SED_2}' | crontab -`;
}

/**
 * 1 行の crontab エントリに上記 2 本の sed を適用した結果を返す（テスト用）。
 * 実際の `crontab -l` / `crontab -` は呼ばず、`sed` 自体だけをサブプロセスで実行して
 * 本番と同一の正規表現エンジン（GNU sed）で検証する。
 */
export function applyCrontabFixSed(line: string): string {
  const result = execFileSync(
    'sh',
    ['-c', `sed '${CRONTAB_FIX_SED_1}' | sed '${CRONTAB_FIX_SED_2}'`],
    { input: line, encoding: 'utf-8' },
  );
  return result.replace(/\n$/, '');
}
