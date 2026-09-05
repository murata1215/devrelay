// 本サイクル（Devin プランモードの「ツールが許可されず返事が返ってこない」根治）:
// buildDevinPlanConfig()/resolveDevinPlanPermissionMode() の単体テスト。
// 外部 import ゼロの純粋関数（agents/linux/src/services/devin-plan-config.ts）を
// コンパイル済み dist から直接 import する（devin-file-watch.test.mjs と同じ流儀）。
//
// #364 1-B: skillsDir(文字列) から Devin allow ルールを直接生成する旧方式は、
// パス途中で切れた壊れたプレフィックス（例: `Exec(bash "C:/Users/lfuser/.claude/skills)`、
// スクリプト名も閉じ括弧もない）を生成しており、Exec() のトークン単位前方一致に
// 原理的に一致しない欠陥があった（真因A）。本ファイルは `skillExecCommands`
// （呼び出し側が `skill-manager.ts` の `buildSkillInvocationCommands()` で
// 組み立てた完成形コマンド文字列の配列）を受け取る新方式に合わせて更新。
// 本ファイル自体は skill-manager.ts を import せず、リテラルの配列フィクスチャを使う
// （devin-plan-config.ts が skill-manager.ts に依存しないという設計を維持するため）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDevinPlanConfig, resolveDevinPlanPermissionMode } from '../dist/services/devin-plan-config.js';

const READONLY = ['ls', 'cat', 'grep'];
const WRITE = ['rm', 'git push'];

test('buildDevinPlanConfig: strictExec=true は allow=[Read(**)] / deny=[Write(**)] のみ（Exec(**) は出ない、今日の（壊れている）挙動と等価）', () => {
  const config = buildDevinPlanConfig({
    strictExec: true,
    skillExecCommands: ['bash ~/.claude/skills/devrelay-list-inventory/scripts/list.sh'],
    readonlyBashCommands: READONLY,
    writeBashCommands: WRITE,
  });
  assert.deepEqual(config.permissions.allow, ['Read(**)']);
  assert.deepEqual(config.permissions.deny, ['Write(**)']);
});

test('buildDevinPlanConfig: strictExec=false でも Read(**)/Write(**) は保持される', () => {
  const config = buildDevinPlanConfig({
    strictExec: false,
    skillExecCommands: ['bash ~/.claude/skills/devrelay-list-inventory/scripts/list.sh'],
    readonlyBashCommands: READONLY,
    writeBashCommands: WRITE,
  });
  assert.ok(config.permissions.allow.includes('Read(**)'));
  assert.ok(config.permissions.deny.includes('Write(**)'));
});

test('buildDevinPlanConfig: strictExec=false で readonlyBashCommands が Exec() allow に入る', () => {
  const config = buildDevinPlanConfig({
    strictExec: false,
    skillExecCommands: [],
    readonlyBashCommands: READONLY,
    writeBashCommands: WRITE,
  });
  assert.ok(config.permissions.allow.includes('Exec(ls)'));
  assert.ok(config.permissions.allow.includes('Exec(cat)'));
  assert.ok(config.permissions.allow.includes('Exec(grep)'));
});

test('buildDevinPlanConfig: strictExec=false で writeBashCommands が Exec() deny に入り、allow には入らない', () => {
  const config = buildDevinPlanConfig({
    strictExec: false,
    skillExecCommands: [],
    readonlyBashCommands: READONLY,
    writeBashCommands: WRITE,
  });
  assert.ok(config.permissions.deny.includes('Exec(rm)'));
  assert.ok(config.permissions.deny.includes('Exec(git push)'));
  assert.ok(!config.permissions.allow.includes('Exec(git push)'));
  assert.ok(!config.permissions.allow.includes('Exec(rm)'));
});

test('buildDevinPlanConfig: git 読み取り系サブコマンド（git log/status/diff/show/branch）は allow に入り git push は入らない', () => {
  const config = buildDevinPlanConfig({
    strictExec: false,
    skillExecCommands: [],
    readonlyBashCommands: READONLY,
    writeBashCommands: WRITE,
  });
  for (const cmd of ['git log', 'git status', 'git diff', 'git show', 'git branch']) {
    assert.ok(config.permissions.allow.includes(`Exec(${cmd})`), `Exec(${cmd}) が allow に無い`);
  }
  assert.ok(!config.permissions.allow.includes('Exec(git push)'));
});

test('buildDevinPlanConfig: sudo は Devin 専用の追加 deny prefix として入る', () => {
  const config = buildDevinPlanConfig({
    strictExec: false,
    skillExecCommands: [],
    readonlyBashCommands: READONLY,
    writeBashCommands: WRITE,
  });
  assert.ok(config.permissions.deny.includes('Exec(sudo)'));
});

test('buildDevinPlanConfig: Exec(**) という文字列は strictExec の真偽どちらでも一切生成物に現れない（回帰テスト）', () => {
  for (const strictExec of [true, false]) {
    const config = buildDevinPlanConfig({
      strictExec,
      skillExecCommands: ['bash ~/.claude/skills/devrelay-list-inventory/scripts/list.sh'],
      readonlyBashCommands: READONLY,
      writeBashCommands: WRITE,
    });
    const serialized = JSON.stringify(config);
    assert.ok(!serialized.includes('Exec(**)'), `strictExec=${strictExec} で Exec(**) が混入`);
  }
});

test('buildDevinPlanConfig: skillExecCommands の各文字列がそのまま完全な形で Exec() allow に入る（#364 1-B 本題、真因A修正の直接テスト）', () => {
  const commands = [
    'bash ~/.claude/skills/devrelay-list-inventory/scripts/list.sh',
    'bash "C:/Users/lfuser/.claude/skills/devrelay-list-inventory/scripts/list.sh"',
    'bash C:\\Users\\lfuser\\.claude\\skills\\devrelay-list-inventory\\scripts\\list.sh',
  ];
  const config = buildDevinPlanConfig({
    strictExec: false,
    skillExecCommands: commands,
    readonlyBashCommands: [],
    writeBashCommands: [],
  });
  const { allow } = config.permissions;
  for (const cmd of commands) {
    assert.ok(allow.includes(`Exec(${cmd})`), `Exec(${cmd}) が allow に無い`);
  }
});

test('buildDevinPlanConfig: 回帰テスト——skillExecCommands から生成される Exec() ルールがパス途中で切れた壊れた断片にならない（旧 buildSkillExecPrefixes() の欠陥の再発防止）', () => {
  const commands = ['bash "C:/Users/lfuser/.claude/skills/devrelay-list-inventory/scripts/list.sh"'];
  const config = buildDevinPlanConfig({
    strictExec: false,
    skillExecCommands: commands,
    readonlyBashCommands: [],
    writeBashCommands: [],
  });
  const { allow } = config.permissions;
  assert.ok(!allow.some((rule) => rule.includes('.claude/skills)')), 'ディレクトリ名で終わる壊れた断片が混入している');
  assert.ok(!allow.some((rule) => rule.includes('.claude\\skills)')), 'ディレクトリ名で終わる壊れた断片が混入している(Windows区切り)');
  assert.ok(allow.includes(`Exec(${commands[0]})`));
  assert.ok(allow.some((rule) => rule.endsWith('list.sh")')), 'スクリプトファイル名で終わっていない（途中で切れている疑い）');
});

test('buildDevinPlanConfig: skillExecCommands が空配列なら skill 用 prefix は一切追加されない', () => {
  const config = buildDevinPlanConfig({
    strictExec: false,
    skillExecCommands: [],
    readonlyBashCommands: [],
    writeBashCommands: [],
  });
  assert.ok(!config.permissions.allow.some((rule) => rule.includes('bash')));
});

test('buildDevinPlanConfig: strictExec=true では skillExecCommands を渡しても Exec allow は一切追加されない', () => {
  const config = buildDevinPlanConfig({
    strictExec: true,
    skillExecCommands: ['bash ~/.claude/skills/devrelay-list-inventory/scripts/list.sh'],
    readonlyBashCommands: READONLY,
    writeBashCommands: WRITE,
  });
  assert.equal(config.permissions.allow.length, 1);
  assert.equal(config.permissions.deny.length, 1);
});

test('buildDevinPlanConfig: 戻り値は JSON.stringify 可能で version/shell.setup_complete を保持する', () => {
  const config = buildDevinPlanConfig({
    strictExec: false,
    skillExecCommands: ['bash ~/.claude/skills/devrelay-list-inventory/scripts/list.sh'],
    readonlyBashCommands: READONLY,
    writeBashCommands: WRITE,
  });
  assert.equal(config.version, 1);
  assert.equal(config.shell.setup_complete, true);
  const serialized = JSON.stringify(config);
  const parsed = JSON.parse(serialized);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.shell.setup_complete, true);
  assert.deepEqual(parsed.permissions.allow, config.permissions.allow);
  assert.deepEqual(parsed.permissions.deny, config.permissions.deny);
});

test('resolveDevinPlanPermissionMode: --permission-mode 自体が非対応なら null（strictExec/envOverride に関わらず）', () => {
  const caps = { permissionMode: false, permissionModeSmart: true };
  assert.equal(resolveDevinPlanPermissionMode(caps, { strictExec: false }), null);
  assert.equal(resolveDevinPlanPermissionMode(caps, { strictExec: true }), null);
  assert.equal(resolveDevinPlanPermissionMode(caps, { strictExec: false, envOverride: 'smart' }), null);
});

test('resolveDevinPlanPermissionMode: permissionModeSmart=true でも既定は auto（#364 Phase1 回帰テスト、smart はサーバー側都合で使えないことがあるため既定に採用しない）', () => {
  const caps = { permissionMode: true, permissionModeSmart: true };
  assert.equal(resolveDevinPlanPermissionMode(caps, { strictExec: false }), 'auto');
});

test('resolveDevinPlanPermissionMode: smart 非対応なら auto', () => {
  const caps = { permissionMode: true, permissionModeSmart: false };
  assert.equal(resolveDevinPlanPermissionMode(caps, { strictExec: false }), 'auto');
});

test('resolveDevinPlanPermissionMode: strictExec=true は smart 対応でも常に auto', () => {
  const caps = { permissionMode: true, permissionModeSmart: true };
  assert.equal(resolveDevinPlanPermissionMode(caps, { strictExec: true }), 'auto');
});

test('resolveDevinPlanPermissionMode: envOverride が strictExec/smart判定より優先される', () => {
  const caps = { permissionMode: true, permissionModeSmart: false };
  assert.equal(resolveDevinPlanPermissionMode(caps, { strictExec: false, envOverride: 'smart' }), 'smart');
  const caps2 = { permissionMode: true, permissionModeSmart: true };
  assert.equal(resolveDevinPlanPermissionMode(caps2, { strictExec: true, envOverride: 'auto' }), 'auto');
});

test('resolveDevinPlanPermissionMode: envOverride が無効な文字列なら無視され既定の auto になる', () => {
  const caps = { permissionMode: true, permissionModeSmart: true };
  assert.equal(resolveDevinPlanPermissionMode(caps, { strictExec: false, envOverride: 'bogus' }), 'auto');
  assert.equal(resolveDevinPlanPermissionMode(caps, { strictExec: false, envOverride: undefined }), 'auto');
  assert.equal(resolveDevinPlanPermissionMode(caps, { strictExec: false, envOverride: null }), 'auto');
});
