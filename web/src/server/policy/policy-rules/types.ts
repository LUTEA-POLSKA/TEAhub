import { z } from 'zod';
import type { PermissionKind, RequestedPermission, TrustTier, Verdict } from '../policy';

/**
 * Policy Rule Categories — ported from Automaton's 6 rule categories.
 *
 * Rules are evaluated in priority order (lower = higher priority).
 * Evaluation stops at the first deny.
 * Each rule category has a priority range and specific rule implementations.
 */

export const RULE_CATEGORIES = [
  'authority',
  'command_safety',
  'financial',
  'path_protection',
  'rate_limits',
  'validation',
] as const;

export type RuleCategory = (typeof RULE_CATEGORIES)[number];

export const RULE_CATEGORY_PRIORITY: Record<RuleCategory, number> = {
  authority: 10,
  command_safety: 20,
  financial: 30,
  path_protection: 40,
  rate_limits: 50,
  validation: 60,
} as const;

/**
 * Base rule interface — all rules share this structure.
 */
export interface BaseRule {
  id: string;
  category: RuleCategory;
  priority: number;
  description: string;
  enabled: boolean;
}

/**
 * Rule that evaluates a permission request.
 * Returns a verdict if the rule applies, undefined otherwise.
 */
export interface RuleEvaluator {
  (context: RuleContext): RuleResult | undefined;
}

export interface RuleContext {
  permission: import('../policy').RequestedPermission;
  tier: import('../policy').TrustTier;
  agentId?: string;
  source: 'agent' | 'manifest' | 'human' | 'system';
  metadata?: Record<string, unknown>;
}

export interface RuleResult {
  verdict: 'allow' | 'require_human' | 'deny';
  ruleId: string;
  reason: string;
  category: RuleCategory;
}

/**
 * Audit entry for a policy decision.
 * Every policy decision is recorded for audit and debugging.
 */
export interface PolicyDecisionAudit {
  id: string;
  timestamp: number;
  permission: import('../policy').RequestedPermission;
  tier: import('../policy').TrustTier;
  source: 'agent' | 'manifest' | 'human' | 'system';
  agentId?: string;
  verdict: 'allow' | 'require_human' | 'deny';
  matchedRuleId?: string;
  matchedRuleCategory?: string;
  reason: string;
  allMatchedRules: PolicyDecisionMatch[];
}

export interface PolicyDecisionMatch {
  ruleId: string;
  category: RuleCategory;
  priority: number;
  verdict: 'allow' | 'require_human' | 'deny';
  reason: string;
  matched: boolean;
}

/**
 * Schema for rule configuration.
 * Operators configure rules via JSON policy files.
 */
export const ruleConfigSchema = z.object({
  id: z.string(),
  category: z.enum(RULE_CATEGORIES),
  priority: z.number().int().optional(),
  description: z.string().optional(),
  enabled: z.boolean().default(true),
  config: z.record(z.string(), z.unknown()).nullable(),
});

export type RuleConfig = z.infer<typeof ruleConfigSchema>;

/**
 * Complete policy configuration including tier policies and rules.
 */
export const fullPolicySchema = z.object({
  defaultTier: z.enum(['builtin', 'local', 'third_party', 'untrusted']).default('third_party'),
  tiers: z.record(z.enum(['builtin', 'local', 'third_party', 'untrusted']), z.object({
    allow: z.array(z.string()),
    requireHuman: z.array(z.string()),
    deny: z.array(z.string()),
  })).nullable(),
  rules: z.array(z.object({
    id: z.string(),
    category: z.enum(['authority', 'command_safety', 'financial', 'path_protection', 'rate_limits', 'validation']),
    priority: z.number().int().optional(),
    enabled: z.boolean().default(true),
    config: z.record(z.string(), z.unknown()).optional(),
  })).nullable(),
});

export type FullPolicyConfig = z.infer<typeof fullPolicySchema>;