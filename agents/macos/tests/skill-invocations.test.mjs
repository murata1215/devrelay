// #364 1-B: SKILL_INVOCATIONS（単一情報源）の整合性テスト。
// SKILL.md 本文と Devin Exec() allow ルールが同じ情報源から導出されていることを
// 正規表現スキャンで検証する。linux/macos は byte-for-byte 同一内容（対象スキル数が
// 異なるだけでロジックは同一、SKILL_INVOCATIONS.length を使うことで両OSに対応）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SKILL_INVOCATIONS,
  buildSkillInvocationCommands,
  getSkillMarkdownBodies,
} from '../dist/services/skill-manager.js';
import { toWslPath, toGitBashPath } from '../dist/services/windows-skill-path.js';

/** 正規表現の特殊文字をエスケープ（動的生成した呼び出しコマンドを安全にパターン化するため）。 */
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** スキル名→チルダ形呼び出しコマンドの対応表を作る（テスト内で繰り返し使うため）。 */
function tildeCommandFor(inv) {
  return `bash ~/.claude/skills/${inv.name}/${inv.script}`;
}

test('SKILL_INVOCATIONS: 1件以上のスキルが定義されている', () => {
  assert.ok(Array.isArray(SKILL_INVOCATIONS));
  assert.ok(SKILL_INVOCATIONS.length > 0);
  for (const inv of SKILL_INVOCATIONS) {
    assert.equal(typeof inv.name, 'string');
    assert.equal(typeof inv.script, 'string');
    assert.equal(typeof inv.readonly, 'boolean');
    assert.ok(inv.name.length > 0);
    assert.ok(inv.script.length > 0);
  }
});

test('T1: 各スキルの SKILL.md 本文に、対応するチルダ形の呼び出しコマンドが実在する（正方向チェック）', () => {
  const bodies = getSkillMarkdownBodies();
  for (const inv of SKILL_INVOCATIONS) {
    const body = bodies[inv.name];
    assert.ok(typeof body === 'string' && body.length > 0, `${inv.name} の SKILL.md 本文が見つからない`);
    const expected = tildeCommandFor(inv);
    const pattern = new RegExp(escapeRegExp(expected));
    assert.ok(
      pattern.test(body),
      `${inv.name} の SKILL.md 本文にチルダ形コマンド "${expected}" が見つからない`,
    );
  }
});

test('T2: buildSkillInvocationCommands() が返すチルダ形コマンド全てが、対応する SKILL.md 本文に実在する（逆方向チェック）', () => {
  const bodies = getSkillMarkdownBodies();
  const commands = buildSkillInvocationCommands();
  for (const cmd of commands) {
    // チルダ形はどのスキルの呼び出しか名前で特定できる（bash ~/.claude/skills/<name>/...）。
    const match = /^bash ~\/\.claude\/skills\/([^/]+)\//.exec(cmd);
    assert.ok(match, `想定外の形式のコマンド: ${cmd}`);
    const name = match[1];
    const body = bodies[name];
    assert.ok(typeof body === 'string' && body.length > 0, `${name} の SKILL.md 本文が見つからない`);
    const pattern = new RegExp(escapeRegExp(cmd));
    assert.ok(pattern.test(body), `SKILL.md(${name}) にコマンド "${cmd}" が見つからない`);
  }
});

test('T3（必須のゼロヒットガード）: 正規表現スキャン自体が「何もマッチしないまま素通り」していないことを保証する', () => {
  const bodies = getSkillMarkdownBodies();
  const commands = buildSkillInvocationCommands();
  assert.ok(commands.length > 0, 'buildSkillInvocationCommands() が空を返している');
  let totalHits = 0;
  for (const cmd of commands) {
    const pattern = new RegExp(escapeRegExp(cmd));
    for (const body of Object.values(bodies)) {
      if (pattern.test(body)) totalHits += 1;
    }
  }
  assert.ok(
    totalHits >= SKILL_INVOCATIONS.length,
    `ヒット数が想定より少ない(${totalHits})。SKILL.md がエスケープされたフェンス等で` +
      'スキャン対象から漏れていないか確認すること（#364 既知の別問題、本テストはそれを検知するためのガード）',
  );
});

test('shape: buildSkillInvocationCommands() の戻り値は string[] で重複がない', () => {
  const commands = buildSkillInvocationCommands();
  assert.ok(Array.isArray(commands));
  for (const cmd of commands) {
    assert.equal(typeof cmd, 'string');
    assert.ok(cmd.startsWith('bash '));
  }
  assert.equal(new Set(commands).size, commands.length);
});

test('shape: skillsDir 省略時はチルダ形のみが SKILL_INVOCATIONS.length 件返る', () => {
  const commands = buildSkillInvocationCommands();
  assert.equal(commands.length, SKILL_INVOCATIONS.length);
  for (const inv of SKILL_INVOCATIONS) {
    assert.ok(commands.includes(tildeCommandFor(inv)));
  }
});

test('shape: skillsDir 指定時は POSIX 絶対パス形（引用符あり/なし）がチルダ形に追加される', () => {
  const skillsDir = '/home/testuser/.claude/skills';
  const commands = buildSkillInvocationCommands({ skillsDir });
  for (const inv of SKILL_INVOCATIONS) {
    assert.ok(commands.includes(tildeCommandFor(inv)));
    assert.ok(commands.includes(`bash ${skillsDir}/${inv.name}/${inv.script}`));
    assert.ok(commands.includes(`bash "${skillsDir}/${inv.name}/${inv.script}"`));
  }
  // win32 を指定していないためバックスラッシュ形は含まれない
  assert.ok(!commands.some((c) => c.includes('\\')));
});

test('win32: platform=win32 かつ skillsDir 指定時はバックスラッシュ区切り形（引用符あり/なし）も追加される', () => {
  const skillsDir = 'C:/Users/testuser/.claude/skills';
  const commands = buildSkillInvocationCommands({ skillsDir, platform: 'win32' });
  for (const inv of SKILL_INVOCATIONS) {
    const winDir = skillsDir.replace(/\//g, '\\');
    const winScript = inv.script.replace(/\//g, '\\');
    assert.ok(commands.includes(`bash ${winDir}\\${inv.name}\\${winScript}`));
    assert.ok(commands.includes(`bash "${winDir}\\${inv.name}\\${winScript}"`));
  }
});

test('win32以外の platform 指定時はバックスラッシュ形が追加されない', () => {
  const skillsDir = '/home/testuser/.claude/skills';
  const commands = buildSkillInvocationCommands({ skillsDir, platform: 'darwin' });
  assert.ok(!commands.some((c) => c.includes('\\')));
});

test('全生成コマンドが完全な形（末尾がスクリプトファイル名で終わる、パス途中で切れていない）', () => {
  const skillsDir = '/home/testuser/.claude/skills';
  const commands = buildSkillInvocationCommands({ skillsDir, platform: 'win32' });
  for (const inv of SKILL_INVOCATIONS) {
    for (const cmd of commands.filter((c) => c.includes(inv.name))) {
      const scriptBase = inv.script.split('/').pop();
      // 末尾が閉じ引用符 or スクリプトファイル名そのもので終わっていること（途中で切れていないこと）
      const trimmed = cmd.endsWith('"') ? cmd.slice(0, -1) : cmd;
      assert.ok(
        trimmed.endsWith(scriptBase) || trimmed.endsWith(scriptBase.replace(/\//g, '\\')),
        `コマンドがスクリプトファイル名で終わっていない（途中で切れている疑い）: ${cmd}`,
      );
    }
  }
});

// #364 1-C: 真因B（Windows の bash 解決）修正の単一情報源保証テスト（T7〜T9）。
// linux/macos は byte-for-byte 同一内容（macOS には devrelay-list-inventory が存在しないため
// T8 は該当スキルが無い場合スキップする形で両OSに対応）。

test('T7: platform=win32 の SKILL.md 本文に、buildSkillInvocationCommands() が返す WSL 形・Git bash 形コマンドが両方実在する（真因B の単一情報源保証）', () => {
  const skillsDir = 'C:\\Users\\testuser\\.claude\\skills';
  const bodies = getSkillMarkdownBodies({ platform: 'win32', skillsDir });
  const commands = buildSkillInvocationCommands({ skillsDir, platform: 'win32' });
  for (const inv of SKILL_INVOCATIONS) {
    const body = bodies[inv.name];
    assert.ok(typeof body === 'string' && body.length > 0, `${inv.name} の SKILL.md 本文が見つからない`);
    const winSkillDir = `${skillsDir}\\${inv.name}`;
    const wslSkillDir = toWslPath(winSkillDir);
    const gitBashSkillDir = toGitBashPath(winSkillDir);
    assert.ok(wslSkillDir, `${inv.name} の WSL 形パス変換に失敗した（テスト前提が崩れている）`);
    assert.ok(gitBashSkillDir, `${inv.name} の Git bash 形パス変換に失敗した（テスト前提が崩れている）`);
    const wslCommand = `bash ${wslSkillDir}/${inv.script}`;
    const gitBashCommand = `bash ${gitBashSkillDir}/${inv.script}`;
    // buildSkillInvocationCommands() 自身の生成物（Exec() allow 側）に両形式が含まれていること
    assert.ok(
      commands.includes(wslCommand),
      `${inv.name} 用の WSL 形コマンドが buildSkillInvocationCommands() の戻り値に含まれない: ${wslCommand}`,
    );
    assert.ok(
      commands.includes(gitBashCommand),
      `${inv.name} 用の Git bash 形コマンドが buildSkillInvocationCommands() の戻り値に含まれない: ${gitBashCommand}`,
    );
    // SKILL.md 本文（AI への指示）側にも同じ文字列が実在すること
    assert.ok(body.includes(wslCommand), `${inv.name} の SKILL.md 本文に WSL 形コマンドが実在しない: ${wslCommand}`);
    assert.ok(
      body.includes(gitBashCommand),
      `${inv.name} の SKILL.md 本文に Git bash 形コマンドが実在しない: ${gitBashCommand}`,
    );
  }
});

test('T8: 実機実測で成功した2文字列が、skillsDir=lfuser 環境の生成物に完全一致で含まれる（実測アンカー）', (t) => {
  const inv = SKILL_INVOCATIONS.find((i) => i.name === 'devrelay-list-inventory');
  if (!inv) {
    t.skip(
      'このOSには devrelay-list-inventory スキルが存在しないためスキップ（実測対象は Windows CLI Agent = agents/linux のみ）',
    );
    return;
  }
  const skillsDir = 'C:\\Users\\lfuser\\.claude\\skills';
  const commands = buildSkillInvocationCommands({ skillsDir, platform: 'win32' });
  assert.ok(
    commands.includes('bash /mnt/c/Users/lfuser/.claude/skills/devrelay-list-inventory/scripts/list.sh'),
    '9/6 devin 実測で成功した WSL 形コマンドが生成物に含まれていない',
  );
  assert.ok(
    commands.includes('bash /c/Users/lfuser/.claude/skills/devrelay-list-inventory/scripts/list.sh'),
    '9/6 追加実測 #5 で成功した Git bash 形コマンドが生成物に含まれていない',
  );
});

test('T9: 非win32（platform=linux）の SKILL.md 本文は opts 省略時と完全同一（/mnt/c・/c/ を含まない、非退行ガード）', () => {
  const bodiesDefault = getSkillMarkdownBodies();
  const bodiesLinux = getSkillMarkdownBodies({ platform: 'linux', skillsDir: '/home/testuser/.claude/skills' });
  for (const inv of SKILL_INVOCATIONS) {
    const before = bodiesDefault[inv.name];
    const linuxBody = bodiesLinux[inv.name];
    assert.equal(linuxBody, before, `${inv.name} の SKILL.md 本文が opts 省略時と異なる（意図しない変化の疑い）`);
    assert.ok(!linuxBody.includes('/mnt/c'), `${inv.name} の SKILL.md 本文に /mnt/c が混入している`);
    assert.ok(
      !linuxBody.includes('Windows でのコマンド形式'),
      `${inv.name} の SKILL.md 本文に Windows 向け案内見出しが混入している`,
    );
  }
});
