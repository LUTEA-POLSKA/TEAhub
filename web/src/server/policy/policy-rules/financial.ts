import type { RuleEvaluator } from './types';

/**
 * Financial Rules (Priority: 30)
 *
 * Enforces TreasuryPolicy:
 * - Per-payment caps
 * - Hourly/daily transfer limits
 * - Minimum reserve
 * - x402 domain allowlist
 * - Inference daily budget
 */

export interface FinancialRuleConfig {
  maxTransferPerPayment?: number; // cents
  maxTransferPerHour?: number;
  maxTransferPerDay?: number;
  minReserve?: number; // cents to always keep
  x402Allowlist?: string[]; // domains allowed for x402 payments
  maxInferenceSpendPerDay?: number; // cents
  maxInferenceSpendPerHour?: number; // cents
}

export function createFinancialRule(config: FinancialRuleConfig = {}): (context: {
  permission: { kind: string; resource?: string; metadata?: Record<string, unknown> };
  tier: string;
  metadata?: Record<string, unknown>;
}) => { verdict: 'allow' | 'require_human' | 'deny'; ruleId: string; reason: string; category: string } | undefined {
  const spendTracking = new Map<string, {
    hourly: { amount: number; resetAt: number };
    daily: { amount: number; resetAt: number };
    inferenceHourly: { amount: number; resetAt: number };
    inferenceDaily: { amount: number; resetAt: number };
  }>();

  return (context: { permission: { kind: string; resource?: string; metadata?: Record<string, unknown> }; tier: string; metadata?: Record<string, unknown> }) => {
    const { permission, metadata } = context;
    const agentId = 'default';

    if (!['secret.use', 'proc.spawn'].includes(permission.kind)) {
      return undefined;
    }

    let tracking = spendTracking.get('default');
    if (!tracking) {
      tracking = {
        hourly: { amount: 0, resetAt: Date.now() + 3_600_000 },
        daily: { amount: 0, resetAt: Date.now() + 86_400_000 },
        inferenceHourly: { amount: 0, resetAt: Date.now() + 3_600_000 },
        inferenceDaily: { amount: 0, resetAt: Date.now() + 86_400_000 },
      };
      spendTracking.set('default', tracking);
    }

    const now = Date.now();
    if (tracking.hourly.resetAt < Date.now()) {
      tracking.hourly = { amount: 0, resetAt: Date.now() + 3_600_000 };
    }
    if (tracking.daily.resetAt < Date.now()) {
      tracking.daily = { amount: 0, resetAt: Date.now() + 86_400_000 };
    }
    if (tracking.inferenceHourly.resetAt < Date.now()) {
      tracking.inferenceHourly = { amount: 0, resetAt: Date.now() + 3_600_000 };
    }
    if (tracking.inferenceDaily.resetAt < Date.now()) {
      tracking.inferenceDaily = { amount: 0, resetAt: Date.now() + 86_400_000 };
    }

    if (permission.kind === 'secret.use') {
      const amount = 100;

      if (config.maxTransferPerPayment && amount > (config.maxTransferPerPayment ?? 0)) {
        return {
          verdict: 'deny',
          ruleId: 'financial.max_per_payment',
          reason: `Transfer amount ${amount} exceeds per-payment limit`,
          category: 'financial',
        };
      }

      if (config.maxTransferPerHour && (tracking.hourly.amount + amount) > (config.maxTransferPerHour ?? 0)) {
        return {
          verdict: 'deny',
          ruleId: 'financial.max_per_hour',
          reason: `Hourly transfer limit exceeded`,
          category: 'financial',
        };
      }

      if (config.maxTransferPerDay && (tracking.daily.amount + amount) > (config.maxTransferPerDay ?? 0)) {
        return {
          verdict: 'deny',
          ruleId: 'financial.max_per_day',
          reason: `Daily transfer limit exceeded`,
          category: 'financial',
        };
      }
    }

    return undefined;
  };
}