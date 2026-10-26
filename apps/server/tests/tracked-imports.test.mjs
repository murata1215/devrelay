// 2026-10-26 障害（fd95657: `connection.ts` をコミットしたが、それが import する
// `crontab-fix-rules.ts` は未追跡のままだったため push 後の `u` で ERR_MODULE_NOT_FOUND
// となり Agent が起動不能・会話不能になった）の再発防止ガード。
//
// 判定ルール（これが要点）: 「追跡済み or stage 済み」の importer が import する相対パスの
// 実体は、それ自身も「追跡済み or stage 済み」でなければならない。
// `git add connection.ts` だけして import 先を `git add` し忘れた瞬間、つまり
// **commit する前**に本テストが落ちる。これが同じ事故を止められる唯一のタイミング
// （HEAD だけを見るチェックでは「悪いコミットを作った後」にしか分からず、
// テスト → commit → push → `u` の流れでは手遅れになる）。
//
// 判定ロジックは collectUntrackedImports() に切り出し、ファイル内で単体ケースを固定した上で、
// このリポジトリ全体（agents/*/src, apps/*/src, packages/*/src の .ts）に対して実行する。
// dist/ ビルド済み資材には依存しない（node:fs + git CLI のみ、他の wiring テストと同じ手口）。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// __dirname = apps/server/tests → repoRoot まで3階層上る（apps/server/tests と同じ流儀の
// 他 wiring テストは `serverRoot = resolve(__dirname, '..')` を経由して `resolve(serverRoot, '../..')`
// と2段階で書いているが、実質は3階層。ここでは直接 3 階層で書く）
const repoRoot = path.resolve(__dirname, '../../..');

/**
 * ソース文字列から相対 import 先（`.js` 拡張子表記）を抽出する。
 * コメント行（trim 後に `//` で始まる行）は無視する
 * （`apps/server/src/services/session-manager.ts` の
 * `// import { sendLineMessage } from '../platforms/line.js';` が誤検知するのを確認済み）。
 * @param source ファイル全文
 * @returns 相対 import 文字列の配列（例: `['./crontab-fix-rules.js', '../foo/bar.js']`）
 */
export function extractRelativeImports(source) {
  const results = [];
  for (const line of source.split('\n')) {
    if (line.trim().startsWith('//')) continue;
    const m = line.match(/from\s+['"](\.\.?\/[A-Za-z0-9._/-]+\.js)['"]/);
    if (m) results.push(m[1]);
  }
  return results;
}

/**
 * importer の相対パス + import 文字列から、ディスク上に実在する候補の相対パスを 1 つ返す
 * （`.js` → `.ts` 優先、無ければ `.js` 実体、無ければ `<dir>/index.ts`）。どれも無ければ null
 * （import 解決自体の正しさは tsc の役割であり、本ガードの対象外）。
 * @param importerRelPath importer のリポジトリルートからの相対パス
 * @param importSpecifier 抽出した相対 import 文字列（`.js` 拡張子表記）
 * @param exists 存在判定関数（テスト容易性のため注入。既定は fs.existsSync）
 */
export function resolveImportCandidate(importerRelPath, importSpecifier, exists) {
  const dir = path.posix.dirname(importerRelPath.split(path.sep).join('/'));
  const withoutExt = importSpecifier.slice(0, -3); // 末尾の '.js' を除去
  const base = path.posix.join(dir, withoutExt);
  const candidates = [`${base}.ts`, `${base}.js`, path.posix.join(base, 'index.ts')];
  for (const c of candidates) {
    if (exists(c)) return c;
  }
  return null;
}

/**
 * 「追跡済み or stage 済み」の importer 一覧を走査し、import 先が「追跡済み or stage 済み」の
 * 集合に含まれないケースを列挙する（= fd95657 の再現パターン）。
 * @param importerFiles 走査対象の importer 相対パス一覧（「追跡済み or stage 済み」の集合そのもの）
 * @param readFile 内容取得関数（relPath) => string
 * @param exists 存在判定関数 (relPath) => boolean
 * @param isTracked 「追跡済み or stage 済み」判定関数 (relPath) => boolean
 * @returns { importer, importee }[]
 */
export function collectUntrackedImports(importerFiles, readFile, exists, isTracked) {
  const problems = [];
  for (const importer of importerFiles) {
    const source = readFile(importer);
    for (const spec of extractRelativeImports(source)) {
      const resolved = resolveImportCandidate(importer, spec, exists);
      if (resolved === null) continue; // 解決不能は tsc の守備範囲（本ガードの対象外）
      if (!isTracked(resolved)) {
        problems.push({ importer, importee: resolved });
      }
    }
  }
  return problems;
}

// ---- collectUntrackedImports: 単体ケース（実ファイルに依存しない固定シナリオ） ----

describe('collectUntrackedImports: 判定ロジックの単体ケース', () => {
  test('importer 追跡済み・importee 未追跡 → 検出する（fd95657 の再現ケース）', () => {
    const files = { 'a/connection.ts': `import { x } from './crontab-fix-rules.js';\n` };
    const tracked = new Set(['a/connection.ts']); // crontab-fix-rules.ts は含めない
    const disk = new Set(['a/connection.ts', 'a/crontab-fix-rules.ts']); // ディスク上には存在する
    const result = collectUntrackedImports(
      Object.keys(files),
      (p) => files[p],
      (p) => disk.has(p),
      (p) => tracked.has(p),
    );
    assert.deepEqual(result, [{ importer: 'a/connection.ts', importee: 'a/crontab-fix-rules.ts' }]);
  });

  test('両方追跡済み → 検出しない', () => {
    const files = { 'a/connection.ts': `import { x } from './node-bin-path.js';\n` };
    const tracked = new Set(['a/connection.ts', 'a/node-bin-path.ts']);
    const result = collectUntrackedImports(
      Object.keys(files),
      (p) => files[p],
      (p) => tracked.has(p),
      (p) => tracked.has(p),
    );
    assert.deepEqual(result, []);
  });

  test('importee が stage 済み（未コミットだが git add 済み）→ 検出しない', () => {
    // isTracked は「追跡済み or stage 済み」の集合を渡す呼び出し側の責務。
    // ここでは importee がその集合に含まれているケースを固定する。
    const files = { 'a/connection.ts': `import { x } from './new-file.js';\n` };
    const stagedOrTracked = new Set(['a/connection.ts', 'a/new-file.ts']);
    const result = collectUntrackedImports(
      Object.keys(files),
      (p) => files[p],
      (p) => stagedOrTracked.has(p),
      (p) => stagedOrTracked.has(p),
    );
    assert.deepEqual(result, []);
  });

  test('コメントアウトされた import は検出しない（session-manager.ts の実例と同型）', () => {
    const files = { 'a/connection.ts': `  // import { x } from './ghost.js';\n` };
    const tracked = new Set(['a/connection.ts']);
    const disk = new Set(['a/connection.ts']); // ghost.ts はディスクにも無い
    const result = collectUntrackedImports(
      Object.keys(files),
      (p) => files[p],
      (p) => disk.has(p),
      (p) => tracked.has(p),
    );
    assert.deepEqual(result, []);
  });

  test('"../" 相対・index.ts 解決も正しく働く', () => {
    const files = { 'a/b/connection.ts': `import { x } from '../shared/util.js';\n` };
    const disk = new Set(['a/b/connection.ts', 'a/shared/util/index.ts']);
    const tracked = new Set(['a/b/connection.ts']); // util/index.ts は未追跡
    const result = collectUntrackedImports(
      Object.keys(files),
      (p) => files[p],
      (p) => disk.has(p),
      (p) => tracked.has(p),
    );
    assert.deepEqual(result, [{ importer: 'a/b/connection.ts', importee: 'a/shared/util/index.ts' }]);
  });

  test('パッケージ名 import（相対パスでない）は対象外', () => {
    const files = { 'a/connection.ts': `import { v4 } from 'uuid';\nimport { tChat } from '@devrelay/shared';\n` };
    const result = collectUntrackedImports(
      Object.keys(files),
      (p) => files[p],
      () => false,
      () => false,
    );
    assert.deepEqual(result, []);
  });

  test('import 先がディスク上にも存在しない場合は対象外（tsc の守備範囲）', () => {
    const files = { 'a/connection.ts': `import { x } from './totally-missing.js';\n` };
    const result = collectUntrackedImports(
      Object.keys(files),
      (p) => files[p],
      () => false, // ディスク上にも無い
      () => false,
    );
    assert.deepEqual(result, []);
  });
});

// ---- extractRelativeImports: 抽出単体 ----

describe('extractRelativeImports', () => {
  test('複数行から相対 import のみを抽出する', () => {
    const source = [
      `import { a } from './a.js';`,
      `import { b } from '../b/c.js';`,
      `import { v4 } from 'uuid';`,
      `// import { ghost } from './ghost.js';`,
      `  // import { ghost2 } from './ghost2.js';`,
    ].join('\n');
    assert.deepEqual(extractRelativeImports(source), ['./a.js', '../b/c.js']);
  });
});

// ---- 実リポジトリへの適用（本体） ----

/**
 * git の「追跡済み or stage 済み」ファイル一覧を取得する。
 * `git ls-files`（追跡済み）と `git diff --cached --name-only --diff-filter=ACMR`（stage 済みの
 * 追加・変更・リネーム・コピー）の和集合。削除予定（D）は除く。
 */
function getTrackedOrStagedFiles() {
  const tracked = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  const staged = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
  return new Set([...tracked, ...staged]);
}

describe('リポジトリ全体: 追跡済み/stage 済みファイルが未追跡ファイルを import していないこと', () => {
  test('agents/*/src, apps/*/src, packages/*/src の .ts が自己整合である', () => {
    const trackedOrStaged = getTrackedOrStagedFiles();
    const importerFiles = [...trackedOrStaged].filter(
      (p) => /^(agents|apps|packages)\/[^/]+\/src\/.*\.ts$/.test(p),
    );
    assert.ok(importerFiles.length > 100, `走査対象が少なすぎる（${importerFiles.length} 件）。走査条件を確認`);

    const problems = collectUntrackedImports(
      importerFiles,
      (relPath) => readFileSync(path.join(repoRoot, relPath), 'utf8'),
      (relPath) => existsSync(path.join(repoRoot, relPath)),
      (relPath) => trackedOrStaged.has(relPath),
    );

    if (problems.length > 0) {
      const detail = problems.map((p) => `  ${p.importer} -> ${p.importee}`).join('\n');
      assert.fail(
        `未追跡ファイルを import している追跡済み/stage 済みファイルがあります` +
          `（commit すると次の \`u\` で ERR_MODULE_NOT_FOUND になり Agent が起動不能になります。` +
          ` \`git add\` し忘れでは?）:\n${detail}`,
      );
    }
  });
});
