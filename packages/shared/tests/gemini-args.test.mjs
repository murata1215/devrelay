// `gemini-args.ts` の単体テスト。
//
// 2026-10-27: Gemini CLI の gemini 分岐が probe 結果を無視して plan ターンでも
// `--approval-mode auto_edit` をハードコードしていたため、`--approval-mode` 自体に
// 非対応の旧 CLI では `Unknown arguments: approval-mode, approvalMode` で会話が
// 一度も成立しなかった（gemini-user 機体）。決定表を fixture ベースで固定する。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseGeminiCapabilities,
  buildGeminiApprovalArgs,
  GEMINI_CAPABILITIES_NONE,
} from '../dist/gemini-args.js';

// fixture A: この母艦で実際に確認した gemini 0.65.0 の --help 抜粋
// （--approval-mode が choices: default/auto_edit/yolo/plan を持つ現行版）
const HELP_CURRENT = `
Options:
  -d, --debug                     Run in debug mode (open debug console with F12)  [boolean] [default: false]
  -m, --model                     Model  [string]
  -p, --prompt                    Run in non-interactive (headless) mode with the given prompt. Appended to input on stdin (if any).  [string]
  -y, --yolo                      Automatically accept all actions (aka YOLO mode, see https://www.youtube.com/watch?v=xvFZjo5PgG0 for more details)?  [boolean] [default: false]
      --approval-mode             Set the approval mode: default (prompt for approval), auto_edit (auto-approve edit tools), yolo (auto-approve all tools), plan (read-only mode)  [string] [choices: "default", "auto_edit", "yolo", "plan"]
      --policy                    Additional policy files or directories to load (comma-separated or multiple --policy)  [array]
  -v, --version                   Show version number  [boolean]
  -h, --help                      Show help  [boolean]
`;

// fixture B: `--approval-mode` 自体が存在しない旧 CLI（gemini-user 機体相当）。
// `-y, --yolo` は残っている想定。
const HELP_OLD_YOLO_ONLY = `
Options:
  -m, --model      Model  [string]
  -p, --prompt     Run in non-interactive (headless) mode with the given prompt.  [string]
  -y, --yolo       Automatically accept all actions (aka YOLO mode)?  [boolean] [default: false]
  -v, --version    Show version number  [boolean]
  -h, --help       Show help  [boolean]
`;

// fixture C: --approval-mode も --yolo も無い、さらに旧い CLI
const HELP_VERY_OLD = `
Options:
  -p, --prompt     Run in non-interactive (headless) mode with the given prompt.  [string]
  -v, --version    Show version number  [boolean]
  -h, --help       Show help  [boolean]
`;

test('parseGeminiCapabilities: 現行版は model/approvalMode/autoEdit/yolo/yoloFlag 全て true', () => {
  const caps = parseGeminiCapabilities(HELP_CURRENT);
  assert.deepEqual(caps, {
    model: true,
    approvalMode: true,
    approvalModeAutoEdit: true,
    approvalModeYolo: true,
    yoloFlag: true,
  });
});

test('parseGeminiCapabilities: --approval-mode 非対応の旧 CLI は approvalMode 系が全て false', () => {
  const caps = parseGeminiCapabilities(HELP_OLD_YOLO_ONLY);
  assert.deepEqual(caps, {
    model: true,
    approvalMode: false,
    approvalModeAutoEdit: false,
    approvalModeYolo: false,
    yoloFlag: true,
  });
});

test('parseGeminiCapabilities: --yolo も無い最旧 CLI は yoloFlag も false', () => {
  const caps = parseGeminiCapabilities(HELP_VERY_OLD);
  assert.equal(caps.yoloFlag, false);
  assert.equal(caps.approvalMode, false);
  assert.equal(caps.model, false);
});

// ---- buildGeminiApprovalArgs: 決定表 ----

test('現行版 + exec ターン: --approval-mode yolo', () => {
  const caps = parseGeminiCapabilities(HELP_CURRENT);
  const result = buildGeminiApprovalArgs(caps, { usePlanMode: false, yoloEnabled: true });
  assert.deepEqual(result, { args: ['--approval-mode', 'yolo'], degraded: 'none' });
});

test('現行版 + plan ターン: --approval-mode auto_edit（従来どおり）', () => {
  const caps = parseGeminiCapabilities(HELP_CURRENT);
  const result = buildGeminiApprovalArgs(caps, { usePlanMode: true, yoloEnabled: true });
  assert.deepEqual(result, { args: ['--approval-mode', 'auto_edit'], degraded: 'none' });
});

test('旧版（--approval-mode 非対応, --yolo あり) + exec ターン: --yolo に劣化（警告不要）', () => {
  const caps = parseGeminiCapabilities(HELP_OLD_YOLO_ONLY);
  const result = buildGeminiApprovalArgs(caps, { usePlanMode: false, yoloEnabled: true });
  assert.deepEqual(result, { args: ['--yolo'], degraded: 'execYoloFlag' });
});

test('旧版（--approval-mode 非対応) + plan ターン: フラグ無し + planNoFlag（今回の事故ケースの修正）', () => {
  const caps = parseGeminiCapabilities(HELP_OLD_YOLO_ONLY);
  const result = buildGeminiApprovalArgs(caps, { usePlanMode: true, yoloEnabled: true });
  assert.deepEqual(result, { args: [], degraded: 'planNoFlag' });
});

test('最旧版（--approval-mode も --yolo も無し) + exec ターン: フラグ無し + execNoFlag', () => {
  const caps = parseGeminiCapabilities(HELP_VERY_OLD);
  const result = buildGeminiApprovalArgs(caps, { usePlanMode: false, yoloEnabled: true });
  assert.deepEqual(result, { args: [], degraded: 'execNoFlag' });
});

test('最旧版 + plan ターン: フラグ無し + planNoFlag', () => {
  const caps = parseGeminiCapabilities(HELP_VERY_OLD);
  const result = buildGeminiApprovalArgs(caps, { usePlanMode: true, yoloEnabled: true });
  assert.deepEqual(result, { args: [], degraded: 'planNoFlag' });
});

test('DEVRELAY_GEMINI_YOLO=0（yoloEnabled:false）相当: exec でも plan と同じ auto_edit 経路', () => {
  const caps = parseGeminiCapabilities(HELP_CURRENT);
  const result = buildGeminiApprovalArgs(caps, { usePlanMode: false, yoloEnabled: false });
  assert.deepEqual(result, { args: ['--approval-mode', 'auto_edit'], degraded: 'none' });
});

test('probe 失敗時（GEMINI_CAPABILITIES_NONE）: plan/exec とも常にフラグ無し', () => {
  const planResult = buildGeminiApprovalArgs(GEMINI_CAPABILITIES_NONE, { usePlanMode: true, yoloEnabled: true });
  assert.deepEqual(planResult, { args: [], degraded: 'planNoFlag' });
  const execResult = buildGeminiApprovalArgs(GEMINI_CAPABILITIES_NONE, { usePlanMode: false, yoloEnabled: true });
  assert.deepEqual(execResult, { args: [], degraded: 'execNoFlag' });
});

// ---- Phase 2: droppedFlags（実行時リトライ安全網）----

test('droppedFlags に --approval-mode が入ると、対応していても --yolo にフォールバックする', () => {
  const caps = parseGeminiCapabilities(HELP_CURRENT);
  const result = buildGeminiApprovalArgs(caps, {
    usePlanMode: false,
    yoloEnabled: true,
    droppedFlags: ['--approval-mode'],
  });
  assert.deepEqual(result, { args: ['--yolo'], degraded: 'execYoloFlag' });
});

test('droppedFlags に --yolo も --approval-mode も入ると exec でもフラグ無しになる', () => {
  const caps = parseGeminiCapabilities(HELP_CURRENT);
  const result = buildGeminiApprovalArgs(caps, {
    usePlanMode: false,
    yoloEnabled: true,
    droppedFlags: ['--approval-mode', '--yolo'],
  });
  assert.deepEqual(result, { args: [], degraded: 'execNoFlag' });
});

test('droppedFlags に --approval-mode が入ると plan ターンはフラグ無しになる', () => {
  const caps = parseGeminiCapabilities(HELP_CURRENT);
  const result = buildGeminiApprovalArgs(caps, {
    usePlanMode: true,
    yoloEnabled: true,
    droppedFlags: ['--approval-mode'],
  });
  assert.deepEqual(result, { args: [], degraded: 'planNoFlag' });
});
