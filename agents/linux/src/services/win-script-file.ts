/**
 * Windows 用スクリプトファイル（.vbs / .cmd / .ps1）を「Windows が正しく読める文字コード」で書く小物。
 *
 * 2026-11-25: ユーザー名が日本語（C:\Users\神野嘉高）の PC で Agent が起動しなかった件の対策。
 * - wscript は BOM なしの .vbs を ANSI（CP932 等）として読むため、UTF-8 で書いた日本語パスが化けて
 *   「指定されたファイルが見つかりません (80070002)」になる → UTF-16LE + BOM で書く
 * - cmd.exe はバッチを OEM コードページで読むため、パスを %APPDATA% 等の環境変数に置き換えて
 *   ASCII だけにする（置き換えきれない非 ASCII が残るときだけ chcp 65001 + UTF-8）
 * - PowerShell 5.1 は BOM なしの .ps1 を ANSI として読む → UTF-8 + BOM で書く
 */
import { writeFileSync } from 'fs';

/** UTF-16LE（BOM 付き）のバイト列を作る（.vbs 用。wscript は BOM で Unicode と判別する） */
export function encodeVbs(content: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, 'utf16le')]);
}

/** UTF-8（BOM 付き）のバイト列を作る（Windows PowerShell 5.1 向けの .ps1 用） */
export function encodePs1(content: string): Buffer {
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(content, 'utf8')]);
}

/** .vbs を UTF-16LE + BOM で書く */
export function writeVbsFile(filePath: string, content: string): void {
  writeFileSync(filePath, encodeVbs(content));
}

/** .ps1 を UTF-8 + BOM で書く */
export function writePs1File(filePath: string, content: string): void {
  writeFileSync(filePath, encodePs1(content));
}

/** ASCII 以外の文字を含むか */
export function hasNonAscii(s: string): boolean {
  return /[^\x00-\x7f]/.test(s);
}

/**
 * バッチファイルに書くパスの先頭を環境変数（%LOCALAPPDATA% / %APPDATA% / %USERPROFILE%）に置き換える。
 * 長い（より具体的な）ものから順に試し、大文字小文字は区別しない（Windows のパスのため）。
 * 環境変数が未設定・一致しないときはそのまま返す。
 */
export function toCmdPath(p: string, env: Record<string, string | undefined> = process.env): string {
  const candidates = ['LOCALAPPDATA', 'APPDATA', 'USERPROFILE']
    .map((name) => ({ name, value: (env[name] || '').replace(/[\\/]+$/, '') }))
    .filter((c) => c.value.length > 0)
    .sort((a, b) => b.value.length - a.value.length);
  const lower = p.toLowerCase();
  for (const c of candidates) {
    const v = c.value.toLowerCase();
    if (lower === v || lower.startsWith(v + '\\') || lower.startsWith(v + '/')) {
      return `%${c.name}%` + p.slice(c.value.length);
    }
  }
  return p;
}

/**
 * バッチファイルの本文（"@echo off" を除く行の配列）から、書き込むバイト列を作る。
 * ASCII だけなら ASCII のまま。非 ASCII が残るときは chcp 65001 を先頭に入れて UTF-8（BOM なし）で書く。
 */
export function encodeCmd(lines: string[]): Buffer {
  const body = lines.join('\r\n');
  if (!hasNonAscii(body)) {
    return Buffer.from(`@echo off\r\n${body}\r\n`, 'utf8');
  }
  return Buffer.from(`@echo off\r\nchcp 65001 >nul\r\n${body}\r\n`, 'utf8');
}

/** devrelay-claude.cmd（claude を呼ぶだけのラッパー）の中身を作る */
export function buildClaudeWrapperCmd(claudePath: string, env: Record<string, string | undefined> = process.env): Buffer {
  return encodeCmd([`"${toCmdPath(claudePath, env)}" %*`]);
}

/** start-agent.cmd（node で Agent を起動しログへ追記する）の中身を作る */
export function buildStartAgentCmd(
  nodePath: string,
  agentIndex: string,
  logFile: string,
  env: Record<string, string | undefined> = process.env,
): Buffer {
  return encodeCmd([`"${toCmdPath(nodePath, env)}" "${toCmdPath(agentIndex, env)}" >> "${toCmdPath(logFile, env)}" 2>&1`]);
}
