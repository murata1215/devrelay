#!/usr/bin/env node

/**
 * バージョン一括更新スクリプト
 *
 * 使い方: node scripts/update-version.js 0.2.0
 *
 * 更新対象:
 * - 全 package.json
 * - CLI のハードコードされたバージョン
 */

const fs = require('fs');
const path = require('path');

const version = process.argv[2];
if (!version) {
  console.error('Usage: node scripts/update-version.js <version>');
  console.error('Example: node scripts/update-version.js 0.2.0');
  process.exit(1);
}

// セマンティックバージョニングの簡易チェック
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error(`Invalid version format: ${version}`);
  console.error('Expected format: X.Y.Z or X.Y.Z-tag');
  process.exit(1);
}

const rootDir = path.join(__dirname, '..');

const packageJsonFiles = [
  'package.json',
  'apps/server/package.json',
  'apps/web/package.json',
  'agents/linux/package.json',
  'agents/windows/package.json',
  'packages/shared/package.json',
];

console.log(`\nUpdating version to ${version}...\n`);

// 全 package.json を更新
for (const file of packageJsonFiles) {
  const filePath = path.join(rootDir, file);
  try {
    const pkg = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const oldVersion = pkg.version;
    pkg.version = version;
    fs.writeFileSync(filePath, JSON.stringify(pkg, null, 2) + '\n');
    console.log(`✅ ${file}: ${oldVersion} → ${version}`);
  } catch (err) {
    console.error(`❌ Failed to update ${file}: ${err.message}`);
  }
}

// CLI のハードコードを更新
const cliFiles = [
  'agents/linux/src/cli/index.ts',
  'agents/windows/src/cli/index.ts',
];

for (const file of cliFiles) {
  const filePath = path.join(rootDir, file);
  try {
    let content = fs.readFileSync(filePath, 'utf-8');
    const oldContent = content;
    content = content.replace(/\.version\(['"][\d.]+([-\w.]*)?['"]\)/, `.version('${version}')`);
    if (content !== oldContent) {
      fs.writeFileSync(filePath, content);
      console.log(`✅ ${file}: updated`);
    } else {
      console.log(`⚠️  ${file}: no .version() found`);
    }
  } catch (err) {
    console.error(`❌ Failed to update ${file}: ${err.message}`);
  }
}

console.log(`\n✅ All files updated to version ${version}`);
console.log('\nNext steps:');
console.log('  1. pnpm build');
console.log('  2. git add -A && git commit -m "chore: bump version to ' + version + '"');
console.log('  3. git tag v' + version);
