import fs from 'fs/promises';
import path from 'path';
import { existsSync } from 'fs';
import type { AiTool } from '@devrelay/shared';
import { getConfigDir } from './config.js';

/** Agent 状態ファイル（最後に使用した AI ツールなどを保存） */
const STATE_FILE = path.join(getConfigDir(), 'state.json');

interface AgentState {
  lastAiTool?: AiTool;
  lastUpdated: string;
}

/**
 * Load the last selected AI tool from agent state
 */
export async function loadLastAiTool(): Promise<AiTool | undefined> {
  try {
    if (!existsSync(STATE_FILE)) {
      return undefined;
    }

    const content = await fs.readFile(STATE_FILE, 'utf-8');
    const state: AgentState = JSON.parse(content);

    if (state.lastAiTool) {
      console.log(`🤖 Loaded last AI tool from state: ${state.lastAiTool}`);
    }
    return state.lastAiTool;
  } catch (err) {
    console.warn(`⚠️ Could not load agent state:`, (err as Error).message);
    return undefined;
  }
}

/**
 * Save the selected AI tool to agent state
 */
export async function saveLastAiTool(aiTool: AiTool): Promise<void> {
  try {
    // 設定ディレクトリが存在しない場合は作成
    const configDir = getConfigDir();
    if (!existsSync(configDir)) {
      await fs.mkdir(configDir, { recursive: true });
    }

    // Load existing state or create new
    let state: AgentState = {
      lastUpdated: new Date().toISOString()
    };

    if (existsSync(STATE_FILE)) {
      try {
        const content = await fs.readFile(STATE_FILE, 'utf-8');
        state = JSON.parse(content);
      } catch {
        // Ignore parse errors, use default state
      }
    }

    // Update state
    state.lastAiTool = aiTool;
    state.lastUpdated = new Date().toISOString();

    await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
    console.log(`💾 Saved AI tool to state: ${aiTool}`);
  } catch (err) {
    console.error(`❌ Could not save agent state:`, (err as Error).message);
  }
}
