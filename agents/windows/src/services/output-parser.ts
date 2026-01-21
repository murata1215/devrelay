/**
 * Parser for Claude Code stream-json output
 * Extracts session ID and context usage information
 */

export interface ContextUsage {
  used: number;
  total: number;
  percentage: number;
}

export interface ParsedResult {
  sessionId?: string;
  contextUsage?: ContextUsage;
}

/**
 * Parse a JSON line from Claude Code stream-json output
 * Returns extracted session ID and context usage if found
 */
export function parseStreamJsonLine(line: string): ParsedResult {
  const result: ParsedResult = {};

  try {
    const json = JSON.parse(line);

    // Extract session ID from result message
    // result type message contains session_id
    if (json.type === 'result' && json.session_id) {
      result.sessionId = json.session_id;
    }

    // Extract context usage from system message or result
    // Claude Code may report context usage in different places
    if (json.type === 'system' && json.message?.includes('context')) {
      const usage = extractContextFromSystemMessage(json.message);
      if (usage) {
        result.contextUsage = usage;
      }
    }

    // Extract context usage from result message
    // Actual format from Claude Code:
    // {
    //   "type": "result",
    //   "usage": { "input_tokens": 2, "cache_read_input_tokens": 18162, ... },
    //   "modelUsage": { "claude-opus-4-5-20251101": { "contextWindow": 200000, ... } }
    // }
    // Note: modelUsage contains session totals (accumulates), usage contains current request info
    if (json.type === 'result') {
      // Get context window size from modelUsage
      let contextWindow = 200000;
      if (json.modelUsage) {
        const modelInfo = Object.values(json.modelUsage)[0] as any;
        if (modelInfo?.contextWindow) {
          contextWindow = modelInfo.contextWindow;
        }
      }

      // Get current context usage from usage field
      // cache_read_input_tokens = tokens currently in context window (from cache)
      if (json.usage) {
        const cacheReadTokens = json.usage.cache_read_input_tokens || 0;
        // Use cache_read only - this represents the actual context window usage
        const usedTokens = cacheReadTokens;

        result.contextUsage = {
          used: usedTokens,
          total: contextWindow,
          percentage: Math.round((usedTokens / contextWindow) * 100)
        };
      }
    }

  } catch {
    // Not valid JSON, ignore
  }

  return result;
}

/**
 * Extract context usage from a system message
 * Example: "Context usage: 50,000 / 200,000 tokens (25%)"
 */
function extractContextFromSystemMessage(message: string): ContextUsage | null {
  // Try to match patterns like "X / Y tokens" or "X% context"
  const tokenMatch = message.match(/(\d[\d,]*)\s*\/\s*(\d[\d,]*)\s*tokens/i);
  if (tokenMatch) {
    const used = parseInt(tokenMatch[1].replace(/,/g, ''), 10);
    const total = parseInt(tokenMatch[2].replace(/,/g, ''), 10);
    return {
      used,
      total,
      percentage: Math.round((used / total) * 100)
    };
  }

  const percentMatch = message.match(/(\d+)%\s*context/i);
  if (percentMatch) {
    const percentage = parseInt(percentMatch[1], 10);
    // Estimate tokens based on 200K context window
    const total = 200000;
    const used = Math.round((percentage / 100) * total);
    return {
      used,
      total,
      percentage
    };
  }

  return null;
}

/**
 * Format context usage for display
 */
export function formatContextUsage(usage: ContextUsage): string {
  const usedK = Math.round(usage.used / 1000);
  const totalK = Math.round(usage.total / 1000);
  return `Context: ${usedK}K / ${totalK}K tokens (${usage.percentage}%)`;
}

/**
 * Check if context usage exceeds warning threshold
 */
export function isContextWarning(usage: ContextUsage, warningThreshold: number = 70): boolean {
  return usage.percentage >= warningThreshold;
}

/**
 * Generate warning message for high context usage
 */
export function getContextWarningMessage(usage: ContextUsage): string {
  return `Warning: Context usage is at ${usage.percentage}%.
Consider recording your work status in CLAUDE.md and clearing history with the \`x\` command.`;
}
