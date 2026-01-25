import fs from 'fs/promises';
import path from 'path';
import { existsSync } from 'fs';
import type { AiTool } from '@devrelay/shared';

// Windows: %APPDATA%\devrelay\state.json
const CONFIG_DIR = path.join(process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming'), 'devrelay');
const STATE_FILE = path.join(CONFIG_DIR, 'state.json');

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
    // Ensure config directory exists
    if (!existsSync(CONFIG_DIR)) {
      await fs.mkdir(CONFIG_DIR, { recursive: true });
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
