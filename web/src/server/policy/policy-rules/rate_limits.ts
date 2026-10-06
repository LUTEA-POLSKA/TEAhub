import type { RuleEvaluator } from './types';

/**
 * Rate Limits Rules (Priority: 50)
 *
 * Per-turn and per-session caps on expensive operations:
 * - Tool calls per turn
 * - Model calls per minute/hour
 * - Token usage per turn/minute/hour
 * - API calls to external services
 * - Self-modification operations
 */

export interface RateLimitConfig {
  maxToolCallsPerTurn?: number;
  maxModelCallsPerMinute?: number;
  maxModelCallsPerHour?: number;
  maxTokensPerTurn?: number;
  maxTokensPerMinute?: number;
  maxTokensPerHour?: number;
  maxApiCallsPerMinute?: number;
  maxSelfModificationsPerHour?: number;
  maxSelfModificationsPerDay?: number;
}

const DEFAULT_LIMITS = {
  maxToolCallsPerTurn: 10,
  maxModelCallsPerMinute: 20,
  maxModelCallsPerHour: 200,
  maxTokensPerTurn: 8000,
  maxTokensPerMinute: 50000,
  maxTokensPerHour: 500_000,
  maxApiCallsPerMinute: 60,
  maxSelfModificationsPerHour: 10,
  maxSelfModificationsPerDay: 50,
};

export function createRateLimitRule(config: {
  maxToolCallsPerTurn?: number;
  maxModelCallsPerMinute?: number;
  maxModelCallsPerHour?: number;
  maxTokensPerTurn?: number;
  maxTokensPerMinute?: number;
  maxTokensPerHour?: number;
  maxApiCallsPerMinute?: number;
  maxSelfModificationsPerHour?: number;
  maxSelfModificationsPerDay?: number;
} = {}): (context: {
  permission: { kind: string; resource?: string };
  metadata?: Record<string, unknown>;
  turnNumber?: number;
  tokenUsage?: { inputTokens: number; outputTokens: number };
  isSelfModification?: boolean;
}) => { verdict: 'allow' | 'require_human' | 'deny'; ruleId: string; reason: string; category: string } | undefined {
  const limits = { ...DEFAULT_LIMITS, ...config };
  const state: Record<string, any> = {};

  function getState(agentId: string) {
    if (!state[agentId]) {
      state[agentId] = {
        toolCallsThisTurn: 0,
        minuteModelCalls: 0,
        hourModelCalls: 0,
        turnTokens: 0,
        minuteTokens: 0,
        hourTokens: 0,
        minuteApiCalls: 0,
        hourSelfMods: 0,
        daySelfMods: 0,
        lastTurnReset: Date.now(),
        lastMinuteReset: Date.now(),
        lastHourReset: Date.now(),
        lastDayReset: Date.now(),
      };
    }
    return state[agentId];
  }

  return (context: {
    permission: { kind: string; resource?: string };
    metadata?: Record<string, unknown>;
    turnNumber?: number;
    tokenUsage?: { inputTokens: number; outputTokens: number };
    isSelfModification?: boolean;
  }) => {
    const agentId = 'default';
    const state = getState(agentId);
    const now = Date.now();

    // Reset windows
    if (now - state.lastTurnReset > 60_000) {
      state.toolCallsThisTurn = 0;
      state.turnTokens = 0;
      state.lastTurnReset = now;
    }
    if (now - state.lastMinuteReset > 60_000) {
      state.minuteModelCalls = 0;
      state.minuteTokens = 0;
      state.minuteApiCalls = 0;
      state.lastMinuteReset = now;
    }
    if (now - state.lastHourReset > 3_600_000) {
      state.hourModelCalls = 0;
      state.hourTokens = 0;
      state.hourSelfMods = 0;
      state.lastHourReset = now;
    }
    if (now - state.lastDayReset > 86_400_000) {
      state.daySelfMods = 0;
      state.lastDayReset = now;
    }

    const limits = { ...DEFAULT_LIMITS, ...config };
    const currentTurn = context.metadata?.turnNumber ?? 0;

    // Reset turn counter if new turn
    if (context.metadata?.turnNumber !== undefined && context.metadata.turnNumber !== state.lastTurnNumber) {
      state.toolCallsThisTurn = 0;
      state.turnTokens = 0;
      state.lastTurnNumber = context.metadata.turnNumber;
    }

    // Check tool calls per turn
    if (state.toolCallsThisTurn >= (config.maxToolCallsPerTurn ?? 10)) {
      return {
        verdict: 'deny',
        ruleId: 'rate_limits.max_tool_calls_per_turn',
        reason: `Tool calls per turn limit exceeded (max ${config.maxToolCallsPerTurn ?? 10})`,
        category: 'rate_limits',
      };
    }

    // Check tokens per turn
    if (context.tokenUsage) {
      const turnTokens = state.turnTokens + context.tokenUsage.inputTokens + context.tokenUsage.outputTokens;
      if (turnTokens > (config.maxTokensPerTurn ?? 8000)) {
        return {
          verdict: 'deny',
          ruleId: 'rate_limits.max_tokens_per_turn',
          reason: `Tokens per turn limit exceeded (max ${config.maxTokensPerTurn ?? 8000})`,
          category: 'rate_limits',
        };
      }
    }

    // Check model calls per minute
    if (state.minuteModelCalls >= (config.maxModelCallsPerMinute ?? 20)) {
      return {
        verdict: 'deny',
        ruleId: 'rate_limits.max_model_calls_per_minute',
        reason: `Model calls per minute limit exceeded (max ${config.maxModelCallsPerMinute ?? 20})`,
        category: 'rate_limits',
      };
    }

    // Check model calls per hour
    if (state.hourModelCalls >= (config.maxModelCallsPerHour ?? 200)) {
      return {
        verdict: 'deny',
        ruleId: 'rate_limits.max_model_calls_per_hour',
        reason: `Model calls per hour limit exceeded (max ${config.maxModelCallsPerHour ?? 200})`,
        category: 'rate_limits',
      };
    }

    // Check tokens per minute
    if (context.tokenUsage) {
      const minuteTokens = (state.minuteTokens ?? 0) + context.tokenUsage.inputTokens + context.tokenUsage.outputTokens;
      if (minuteTokens > (config.maxTokensPerMinute ?? 50000)) {
        return {
          verdict: 'deny',
          ruleId: 'rate_limits.max_tokens_per_minute',
          reason: `Tokens per minute limit exceeded (max ${config.maxTokensPerMinute ?? 50000})`,
          category: 'rate_limits',
        };
      }
    }

    // Check tokens per hour
    if (context.tokenUsage) {
      const hourTokens = (state.hourTokens ?? 0) + context.tokenUsage.inputTokens + context.tokenUsage.outputTokens;
      if (hourTokens > (config.maxTokensPerHour ?? 500_000)) {
        return {
          verdict: 'deny',
          ruleId: 'rate_limits.max_tokens_per_hour',
          reason: `Tokens per hour limit exceeded (max ${config.maxTokensPerHour ?? 500_000})`,
          category: 'rate_limits',
        };
      }
    }

    // Check self-modification rate limits
    if (context.metadata?.isSelfModification) {
      if (state.hourSelfMods >= (config.maxSelfModificationsPerHour ?? 10)) {
        return {
          verdict: 'deny',
          ruleId: 'rate_limits.max_self_mods_per_hour',
          reason: `Self-modifications per hour limit exceeded (max ${config.maxSelfModificationsPerHour ?? 10})`,
          category: 'rate_limits',
        };
      }
      if (state.daySelfMods >= (config.maxSelfModificationsPerDay ?? 50)) {
        return {
          verdict: 'deny',
          ruleId: 'rate_limits.max_self_mods_per_day',
          reason: `Self-modifications per day limit exceeded (max ${config.maxSelfModificationsPerDay ?? 50})`,
          category: 'rate_limits',
        };
      }
    }

    // Increment counters (actual increment would happen after successful execution)
    return undefined;
  };
}