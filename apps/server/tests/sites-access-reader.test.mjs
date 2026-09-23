// DevRelay Sites Phase 1-B: access-log-reader.ts の単体テスト（修正1 の要求を全て含む）。
// 実ファイルシステム（一時ディレクトリ）を使い、cold scan / fd 保持 tail / rotation 検出 /
// gz 二重計上防止 / partial line 保持 / gap 検出 / truncate / byte budget を検証する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, appendFile, rename, truncate as fsTruncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { coldScan, tailTick, closeState, classifyLogFiles, splitLines, extractRotationTimestamp } from '../dist/services/sites/access-log-reader.js';

const CURRENT = 'sites.access.log';
const TODAY = '2026-09-22';

/** Caddy JSON access log の 1 行を組み立てる（`format filter` 適用後を模した最小フィールド）。 */
function buildLine({ host = 'dangou-card-viewer.devrelay.io', method = 'GET', path = '/', status = 200, ua = 'Mozilla/5.0', referer, ip = '203.0.113.5', tsSeconds = Date.now() / 1000 }) {
  const headers = {};
  if (ua !== null) headers['User-Agent'] = [ua];
  if (referer) headers['Referer'] = [referer];
  const obj = {
    level: 'info',
    ts: tsSeconds,
    msg: 'handled request',
    request: { remote_ip: ip, method, host, uri: path, headers },
    status,
  };
  return `${JSON.stringify(obj)}\n`;
}

function isoToTsSeconds(iso) {
  return Date.parse(iso) / 1000;
}

/** rotated ファイル名（現行の current 名 `sites.access.log` に対応する形式）を組み立てる。 */
function rotatedName(date, gz) {
  const ts = date.toISOString().replace(/:/g, '-').replace('Z', '');
  return `sites.access-${ts}-size.log${gz ? '.gz' : ''}`;
}

async function mkTmpDir() {
  return mkdtemp(join(tmpdir(), 'devrelay-access-log-'));
}

const DEFAULT_LIMITS = { windowDays: 30, byteBudget: 10 * 1024 * 1024, today: TODAY };

test('classifyLogFiles: current / rotated を分類し、rotated はタイムスタンプ降順', () => {
  const files = [
    CURRENT,
    rotatedName(new Date('2026-09-20T00:00:00.000Z'), false),
    rotatedName(new Date('2026-09-21T00:00:00.000Z'), true),
    '00-snippets',
  ];
  const { current, rotated } = classifyLogFiles(files, CURRENT);
  assert.equal(current, CURRENT);
  assert.equal(rotated.length, 2);
  assert.equal(rotated[0], rotatedName(new Date('2026-09-21T00:00:00.000Z'), true)); // 新しい順
});

test('extractRotationTimestamp: 実例ファイル名からタイムスタンプを取り出す', () => {
  const ts = extractRotationTimestamp('pixblog.access-2026-09-10T03-37-01.822-size.log.gz');
  assert.equal(ts, '2026-09-10T03-37-01.822');
});

test('splitLines: 末尾未完行は partial として保持し、完成行のみ返す', () => {
  const { lines, partial } = splitLines('{"a":1}\n{"a":2', '');
  assert.deepEqual(lines, ['{"a":1}']);
  assert.equal(partial, '{"a":2');
});

test('cold scan → rotate（未読なし）→ gzip 後も二重加算しない', async () => {
  const dir = await mkTmpDir();
  try {
    const l1 = buildLine({ path: '/', tsSeconds: isoToTsSeconds('2026-09-22T01:00:00.000Z') });
    const l2 = buildLine({ path: '/watch', tsSeconds: isoToTsSeconds('2026-09-22T02:00:00.000Z') });
    await writeFile(join(dir, CURRENT), l1 + l2);

    const collected = [];
    const { state, outcome } = await coldScan(dir, CURRENT, (p) => collected.push(p), DEFAULT_LIMITS);
    assert.equal(collected.length, 2);
    assert.equal(outcome.truncated, false);

    // rotate: current → rotated（未読分なし。fd はまだ古いファイルを指す）
    const rotated = rotatedName(new Date('2026-09-22T03:00:00.000Z'), false);
    await rename(join(dir, CURRENT), join(dir, rotated));
    await writeFile(join(dir, CURRENT), '');

    const tick1 = await tailTick(dir, CURRENT, state, (p) => collected.push(p));
    assert.equal(tick1.rotated, true);
    assert.equal(collected.length, 2, 'rotation 直後、未読分が無ければ新規カウントは増えない');

    // rotated ファイルを gzip 化（Caddy の rotate 後圧縮を模す）してから元ファイルを削除
    const raw = await (await import('node:fs/promises')).readFile(join(dir, rotated));
    const gz = gzipSync(raw);
    const gzName = rotatedName(new Date('2026-09-22T03:00:00.000Z'), true);
    await writeFile(join(dir, gzName), gz);
    await rm(join(dir, rotated));

    const tick2 = await tailTick(dir, CURRENT, state, (p) => collected.push(p));
    assert.equal(tick2.gapDetected, false, 'plain→gz の置き換えは rotated 件数が変わらないため gap ではない');
    assert.equal(collected.length, 2, 'gz 化後も runtime は rotated/gz を読まないため二重加算しない');

    await closeState(state);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('restart 時の cold scan は tail 経由の累積と同値になるよう再構築する', async () => {
  const dir = await mkTmpDir();
  try {
    const l1 = buildLine({ path: '/', tsSeconds: isoToTsSeconds('2026-09-22T01:00:00.000Z') });
    await writeFile(join(dir, CURRENT), l1);

    const collectedBeforeRestart = [];
    const { state } = await coldScan(dir, CURRENT, (p) => collectedBeforeRestart.push(p), DEFAULT_LIMITS);
    assert.equal(collectedBeforeRestart.length, 1);

    const l2 = buildLine({ path: '/watch', tsSeconds: isoToTsSeconds('2026-09-22T02:00:00.000Z') });
    await appendFile(join(dir, CURRENT), l2);
    const tick = await tailTick(dir, CURRENT, state, (p) => collectedBeforeRestart.push(p));
    assert.equal(tick.rotated, false);
    assert.equal(collectedBeforeRestart.length, 2, 'tail 経由で追記分が読める');
    await closeState(state);

    // 「restart」= 新しい state で cold scan をやり直す（プロセス再起動を模す）
    const collectedAfterRestart = [];
    const restart = await coldScan(dir, CURRENT, (p) => collectedAfterRestart.push(p), DEFAULT_LIMITS);
    assert.equal(collectedAfterRestart.length, 2, 'restart 後の cold scan は tail 経由の累積と同値に再構築される');
    await closeState(restart.state);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('partial line 保持: チャンク境界で割れた行は完成するまで計上しない', async () => {
  const dir = await mkTmpDir();
  try {
    const full = buildLine({ path: '/', tsSeconds: isoToTsSeconds('2026-09-22T01:00:00.000Z') });
    const second = buildLine({ path: '/watch', tsSeconds: isoToTsSeconds('2026-09-22T02:00:00.000Z') });
    const secondNoNewline = second.slice(0, -1); // 末尾の \n を落として「まだ書き込み中」を模す
    const cutPoint = Math.floor(secondNoNewline.length / 2);
    const secondPart1 = secondNoNewline.slice(0, cutPoint);
    const secondPart2 = secondNoNewline.slice(cutPoint);

    await writeFile(join(dir, CURRENT), full + secondPart1);

    const collected = [];
    const { state } = await coldScan(dir, CURRENT, (p) => collected.push(p), DEFAULT_LIMITS);
    assert.equal(collected.length, 1, '完成した 1 行目のみ計上される');
    assert.ok(state.partial.length > 0, '割れた 2 行目は partial として保持される');

    // 残り半分 + 改行を追記 → 行が完成する
    await appendFile(join(dir, CURRENT), secondPart2 + '\n');
    const tick = await tailTick(dir, CURRENT, state, (p) => collected.push(p));
    assert.equal(tick.rotated, false);
    assert.equal(collected.length, 2, '完成後は 2 行目としてちょうど 1 回だけ計上される');
    assert.equal(state.partial, '');

    await closeState(state);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rotate 直前の未読末尾を失わない（旧 fd から EOF まで読み切ってから切り替える）', async () => {
  const dir = await mkTmpDir();
  try {
    const l1 = buildLine({ path: '/', tsSeconds: isoToTsSeconds('2026-09-22T01:00:00.000Z') });
    await writeFile(join(dir, CURRENT), l1);

    const collected = [];
    const { state } = await coldScan(dir, CURRENT, (p) => collected.push(p), DEFAULT_LIMITS);
    assert.equal(collected.length, 1);

    // rotate 直前: 旧ファイル（まだ 'sites.access.log' という名前）に未読の 1 行を追記してから rename する
    const l2 = buildLine({ path: '/watch', tsSeconds: isoToTsSeconds('2026-09-22T01:30:00.000Z') });
    await appendFile(join(dir, CURRENT), l2);
    const rotated = rotatedName(new Date('2026-09-22T02:00:00.000Z'), false);
    await rename(join(dir, CURRENT), join(dir, rotated));
    await writeFile(join(dir, CURRENT), '');

    const tick = await tailTick(dir, CURRENT, state, (p) => collected.push(p));
    assert.equal(tick.rotated, true);
    assert.equal(collected.length, 2, 'rotate 直前に追記された未読末尾（2 行目）を失わずに読む');
    assert.equal(state.droppedPartialAtRotation, 0);

    await closeState(state);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runtime 中に出現した gz を再集計しない（tail は rotated/gz を一切読まない）', async () => {
  const dir = await mkTmpDir();
  try {
    const l1 = buildLine({ path: '/', tsSeconds: isoToTsSeconds('2026-09-22T01:00:00.000Z') });
    await writeFile(join(dir, CURRENT), l1);

    const collected = [];
    const { state } = await coldScan(dir, CURRENT, (p) => collected.push(p), DEFAULT_LIMITS);
    assert.equal(collected.length, 1);

    // runtime 中に突然 gz ファイルが出現する（例えば手動 rotate 等）。中身は未読の別データ。
    const strayContent = buildLine({ path: '/never-seen', tsSeconds: isoToTsSeconds('2026-09-21T00:00:00.000Z') });
    const gzName = rotatedName(new Date('2026-09-21T00:00:00.000Z'), true);
    await writeFile(join(dir, gzName), gzipSync(Buffer.from(strayContent)));

    const tick = await tailTick(dir, CURRENT, state, (p) => collected.push(p));
    assert.equal(tick.gapDetected, false, 'rotated 件数の増分が 1 件（0→1）は gap 閾値（2 件以上）未満');
    assert.equal(collected.length, 1, 'gz の内容は一切読まれず PV には反映されない');

    await closeState(state);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rotated が tick 間に 2 個以上増えたら gapDetected', async () => {
  const dir = await mkTmpDir();
  try {
    await writeFile(join(dir, CURRENT), '');
    const collected = [];
    const { state } = await coldScan(dir, CURRENT, (p) => collected.push(p), DEFAULT_LIMITS);
    assert.equal(state.lastKnownRotatedCount, 0);

    // tick の間に（取りこぼして）2 個の rotated ファイルが一気に増えたことを模す
    await writeFile(join(dir, rotatedName(new Date('2026-09-20T00:00:00.000Z'), false)), buildLine({ tsSeconds: isoToTsSeconds('2026-09-20T00:00:00.000Z') }));
    await writeFile(join(dir, rotatedName(new Date('2026-09-21T00:00:00.000Z'), false)), buildLine({ tsSeconds: isoToTsSeconds('2026-09-21T00:00:00.000Z') }));

    const tick = await tailTick(dir, CURRENT, state, (p) => collected.push(p));
    assert.equal(tick.gapDetected, true);
    assert.equal(state.gapDetected, true);

    await closeState(state);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('truncate（size < offset）で offset をリセットして全読みする', async () => {
  const dir = await mkTmpDir();
  try {
    const l1 = buildLine({ path: '/', tsSeconds: isoToTsSeconds('2026-09-22T01:00:00.000Z') });
    const l2 = buildLine({ path: '/watch', tsSeconds: isoToTsSeconds('2026-09-22T02:00:00.000Z') });
    await writeFile(join(dir, CURRENT), l1 + l2);

    const collected = [];
    const { state } = await coldScan(dir, CURRENT, (p) => collected.push(p), DEFAULT_LIMITS);
    assert.equal(collected.length, 2);
    const offsetBeforeTruncate = state.offset;
    assert.ok(offsetBeforeTruncate > 0);

    // 同一 inode のまま内容を短く上書き（truncate 相当。inode は変わらない）
    const l3 = buildLine({ path: '/short', tsSeconds: isoToTsSeconds('2026-09-22T03:00:00.000Z') });
    assert.ok(l3.length < offsetBeforeTruncate, 'テスト前提: 新内容は truncate 前より短い');
    await fsTruncate(join(dir, CURRENT), 0);
    await writeFile(join(dir, CURRENT), l3);

    const tick = await tailTick(dir, CURRENT, state, (p) => collected.push(p));
    assert.equal(tick.truncatedInPlace, true);
    assert.equal(collected.length, 3, 'truncate 後の新内容を offset=0 から全読みする');

    await closeState(state);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('読み取りバイト上限で truncated:true ＋ oldestCoveredDate が window 先頭より新しくなる', async () => {
  const dir = await mkTmpDir();
  try {
    await writeFile(join(dir, CURRENT), '');

    // 40 日分の rotated ファイル（1 日 1 ファイル、新しい順に読まれる）を作る
    const DAYS = 40;
    for (let i = 0; i < DAYS; i++) {
      const date = new Date(`2026-09-22T00:00:00.000Z`);
      date.setUTCDate(date.getUTCDate() - i);
      const content = buildLine({ tsSeconds: date.getTime() / 1000, path: '/' });
      await writeFile(join(dir, rotatedName(date, false)), content);
    }

    // 5 ファイル分程度しか読めない小さい予算にする
    const oneFileSize = Buffer.byteLength(buildLine({ path: '/' }), 'utf8');
    const limits = { windowDays: 30, byteBudget: oneFileSize * 5, today: TODAY };

    const collected = [];
    const { outcome } = await coldScan(dir, CURRENT, (p) => collected.push(p), limits);

    assert.equal(outcome.truncated, true);
    assert.equal(outcome.truncatedReason, 'byte_budget');
    assert.ok(outcome.oldestDateSeen !== null);
    // window 先頭（today - 29日 = '2026-08-24'）より新しい日付までしか遡れていないこと
    const windowStart = '2026-08-24';
    assert.ok(outcome.oldestDateSeen > windowStart, `oldestDateSeen(${outcome.oldestDateSeen}) は window 先頭(${windowStart})より新しいはず`);
    // 予算的に 40 日全部は読めていない（最古の 2026-08-14 には到達しない）
    assert.notEqual(outcome.oldestDateSeen, '2026-08-14');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// B2-0 修正1: self-heal（起動時に log file が無く、後から作られた場合の自動検知）
// ---------------------------------------------------------------------------

test('self-heal: 起動時に log file なし → 後から作成 → tailTick で自動検知（reopened: true）', async () => {
  const dir = await mkTmpDir();
  try {
    // current が存在しないまま cold scan を終える（B1 導入直後・Caddy 未 reload 相当）
    const { state, outcome } = await coldScan(dir, CURRENT, () => {}, DEFAULT_LIMITS);
    assert.equal(state.handle, null, 'current が無いので handle は null のまま');
    assert.equal(outcome.oldestDateSeen, null);

    // 何もしないまま 1 tick（ファイルはまだ無い）
    const collected = [];
    const tickBefore = await tailTick(dir, CURRENT, state, (p) => collected.push(p));
    assert.equal(tickBefore.reopened, false);
    assert.equal(state.handle, null);

    // Caddy が後から current を作成（2 行）
    const l1 = buildLine({ path: '/', tsSeconds: isoToTsSeconds('2026-09-22T01:00:00.000Z') });
    const l2 = buildLine({ path: '/watch', tsSeconds: isoToTsSeconds('2026-09-22T02:00:00.000Z') });
    await writeFile(join(dir, CURRENT), l1 + l2);

    const tick = await tailTick(dir, CURRENT, state, (p) => collected.push(p));
    assert.equal(tick.reopened, true, 'self-heal: handle === null から再 open に成功');
    assert.equal(collected.length, 2, '先頭から全読みして 2 行とも集計される');
    assert.equal(state.reopenCount, 1);
    assert.notEqual(state.handle, null, '成功後は fd を保持する');

    await closeState(state);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('self-heal: 二重集計しない（追記なしの再 tick は 0 件、1 行 append で +1 のみ）', async () => {
  const dir = await mkTmpDir();
  try {
    const { state } = await coldScan(dir, CURRENT, () => {}, DEFAULT_LIMITS);
    assert.equal(state.handle, null);

    const l1 = buildLine({ path: '/', tsSeconds: isoToTsSeconds('2026-09-22T01:00:00.000Z') });
    const l2 = buildLine({ path: '/watch', tsSeconds: isoToTsSeconds('2026-09-22T02:00:00.000Z') });
    await writeFile(join(dir, CURRENT), l1 + l2);

    const collected = [];
    const tick1 = await tailTick(dir, CURRENT, state, (p) => collected.push(p));
    assert.equal(tick1.reopened, true);
    assert.equal(collected.length, 2);

    // 追記なしでもう 1 回 tick → 追加行 0
    const tick2 = await tailTick(dir, CURRENT, state, (p) => collected.push(p));
    assert.equal(tick2.reopened, false, 'すでに handle を保持しているので self-heal 分岐には入らない');
    assert.equal(collected.length, 2, '二重集計されない');

    // さらに 1 行 append → +1 のみ（計 3 行）
    const l3 = buildLine({ path: '/short', tsSeconds: isoToTsSeconds('2026-09-22T03:00:00.000Z') });
    await appendFile(join(dir, CURRENT), l3);
    const tick3 = await tailTick(dir, CURRENT, state, (p) => collected.push(p));
    assert.equal(tick3.reopened, false);
    assert.equal(collected.length, 3, '通常の同一 inode 差分読みに合流し +1 のみ');

    await closeState(state);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('self-heal: 失敗時に壊れない（current が無いまま複数回 tick しても例外なし・再試行可能）', async () => {
  const dir = await mkTmpDir();
  try {
    const { state } = await coldScan(dir, CURRENT, () => {}, DEFAULT_LIMITS);
    assert.equal(state.handle, null);

    const collected = [];
    for (let i = 0; i < 3; i++) {
      const tick = await tailTick(dir, CURRENT, state, (p) => collected.push(p));
      assert.equal(tick.reopened, false);
    }
    assert.equal(state.handle, null, 'state は不変');
    assert.equal(state.reopenCount, 0);
    assert.equal(collected.length, 0);

    // その後ファイルを作れば通常どおり検知される（再試行可能性）
    const l1 = buildLine({ path: '/', tsSeconds: isoToTsSeconds('2026-09-22T01:00:00.000Z') });
    await writeFile(join(dir, CURRENT), l1);
    const tickAfter = await tailTick(dir, CURRENT, state, (p) => collected.push(p));
    assert.equal(tickAfter.reopened, true);
    assert.equal(collected.length, 1);

    await closeState(state);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('self-heal 後に rotation/partial 処理が矛盾しない', async () => {
  const dir = await mkTmpDir();
  try {
    const { state } = await coldScan(dir, CURRENT, () => {}, DEFAULT_LIMITS);
    assert.equal(state.handle, null);

    // self-heal で current が生成される
    const l1 = buildLine({ path: '/', tsSeconds: isoToTsSeconds('2026-09-22T01:00:00.000Z') });
    await writeFile(join(dir, CURRENT), l1);
    const collected = [];
    const heal = await tailTick(dir, CURRENT, state, (p) => collected.push(p));
    assert.equal(heal.reopened, true);
    assert.equal(collected.length, 1);

    // self-heal 後に partial 行（改行なし）を append → 未計上
    const l2 = buildLine({ path: '/watch', tsSeconds: isoToTsSeconds('2026-09-22T02:00:00.000Z') });
    const l2NoNewline = l2.slice(0, -1);
    await appendFile(join(dir, CURRENT), l2NoNewline);
    const tickPartial = await tailTick(dir, CURRENT, state, (p) => collected.push(p));
    assert.equal(tickPartial.reopened, false);
    assert.equal(collected.length, 1, '改行が来るまで未計上');
    assert.ok(state.partial.length > 0);

    // 改行が来たら計上
    await appendFile(join(dir, CURRENT), '\n');
    const tickComplete = await tailTick(dir, CURRENT, state, (p) => collected.push(p));
    assert.equal(collected.length, 2);
    assert.equal(state.partial, '');

    // さらに rename → 新 current 作成で rotation 検出が従来どおり効く
    const rotated = rotatedName(new Date('2026-09-22T03:00:00.000Z'), false);
    await rename(join(dir, CURRENT), join(dir, rotated));
    const l3 = buildLine({ path: '/short', tsSeconds: isoToTsSeconds('2026-09-22T04:00:00.000Z') });
    await writeFile(join(dir, CURRENT), l3);
    const tickRotate = await tailTick(dir, CURRENT, state, (p) => collected.push(p));
    assert.equal(tickRotate.rotated, true, 'self-heal 後も rotation 検出が従来どおり効く');
    assert.equal(collected.length, 3);

    await closeState(state);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
