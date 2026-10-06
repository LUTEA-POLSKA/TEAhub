import type { RuleEvaluator, RuleContext, RuleResult, PolicyDecisionAudit, PolicyDecisionMatch, RuleCategory } from './types';
import { RULE_CATEGORIES, RULE_CATEGORY_PRIORITY } from './types';
import { createAuthorityRule } from './authority';
import { createCommandSafetyRule } from './command_safety';
import { createFinancialRule } from './financial';
import { createPathProtectionRule } from './path_protection';
import { createRateLimitRule } from './rate_limits';
import { createValidationRule } from './validation';

/**
 * Rule Engine — evaluates all rules in priority order with full audit trail.
 *
 * The 6 rule categories are evaluated in priority order:
 * 1. authority (10) - trust tiers, hierarchy
 * 2. command_safety (20) - forbidden commands, rate limits
 * 3. financial (30) - payment limits, budgets
 * 4. path_protection (40) - protected/sensitive paths
 * 5. rate_limits (50) - rate limits per turn/minute/hour
 * 6. validation (60) - input validation (URLs, paths, commands, etc.)
 *
 * Rules are evaluated in priority order. First `deny` wins.
 * If a rule returns `require_human`, evaluation continues but final verdict is `require_human`.
 */

export interface RuleEngineDeps {
  auditSink: any;
  config: any;
  rateWindow: any;
  db: any;
}

export interface RuleEngine {
  evaluate(context: {
    permission: { kind: string; resource?: string };
    tier: string;
    agentId?: string;
    source: 'agent' | 'manifest' | 'human' | 'system';
    metadata?: Record<string, unknown>;
  }): Promise<{
    verdict: 'allow' | 'require_human' | 'deny';
    reason: string;
    matchedRuleId?: string;
    matchedRuleCategory?: string;
    audit: {
      id: string;
      timestamp: number;
      permission: { kind: string; resource?: string };
      tier: string;
      source: string;
      agentId?: string;
      verdict: 'allow' | 'require_human' | 'deny';
      matchedRuleId?: string;
      matchedRuleCategory?: string;
      reason: string;
      allMatchedRules: {
        ruleId: string;
        category: string;
        priority: number;
        verdict: 'allow' | 'require_human' | 'deny';
        reason: string;
        matched: boolean;
      }[];
    };
  }>;
}

export function createRuleEngine(deps: { config: any; auditSink: any; rateWindow: any; db: any }) {
  const evaluators = buildRuleEvaluators(deps.config);

  return {
    async evaluate(context: {
      permission: { kind: string; resource?: string };
      tier: string;
      agentId?: string;
      source: 'agent' | 'manifest' | 'human' | 'system';
      metadata?: Record<string, unknown>;
    }) {
      const ruleContext = {
        permission: { kind: context.permission.kind, resource: context.permission.resource },
        tier: context.tier,
        agentId: context.agentId,
        source: context.source,
        metadata: context.metadata,
        evaluators: buildRuleEvaluators(deps.config),
        allMatches: [] as any[],
      };

      const evaluators = buildRuleEvaluators(deps.config);

      const sortedEvaluators = Object.entries(evaluators)
        .map(([id, evaluatorObj]) => ({ id, evaluator: evaluatorObj.evaluator, priority: evaluatorObj.priority }))
        .sort((a, b) => a.priority - b.priority);

      const allMatches: { ruleId: string; category: string; priority: number; verdict: 'allow' | 'require_human' | 'deny'; reason: string; matched: boolean }[] = [];
      let finalVerdict: 'allow' | 'require_human' | 'deny' = 'deny';
      let finalReason = 'no rule matched, default deny';
      let matchedRuleId: string | undefined;
      let matchedRuleCategory: string | undefined;

      for (const { id, evaluator } of sortedEvaluators) {
        const result = await evaluator({
          permission: { kind: context.permission.kind, resource: context.permission.resource },
          tier: context.tier,
          agentId: context.agentId,
          source: context.source,
          metadata: context.metadata,
        });
        if (result) {
          const match = {
            ruleId: result.ruleId,
            category: result.category,
priority: RULE_CATEGORY_PRIORITY[result.category as RuleCategory] ?? 999,
            verdict: result.verdict,
            reason: result.reason,
            matched: true,
          };
          allMatches.push(match);

          if (result.verdict === 'deny') {
            const audit = buildAudit({
              id: crypto.randomUUID(),
              timestamp: Date.now(),
              permission: { kind: context.permission.kind, resource: context.permission.resource },
              tier: context.tier,
              source: context.source,
              agentId: context.agentId,
              verdict: 'deny',
              matchedRuleId: result.ruleId,
              matchedRuleCategory: result.category,
              reason: result.reason,
              allMatchedRules: [...allMatches, { ruleId: result.ruleId, category: result.category, priority: RULE_CATEGORY_PRIORITY[result.category as RuleCategory] ?? 999, verdict: result.verdict, reason: result.reason, matched: true }],
            });
            return { verdict: 'deny', reason: result.reason, matchedRuleId: result.ruleId, matchedRuleCategory: result.category, audit };
          }

          if (result.verdict === 'require_human' && finalVerdict !== 'deny') {
            finalVerdict = 'require_human';
            finalReason = result.reason;
            matchedRuleId = result.ruleId;
            matchedRuleCategory = result.category;
          }

          if (result.verdict === 'allow' && finalVerdict === 'deny') {
            finalVerdict = 'allow';
            finalReason = result.reason;
            matchedRuleId = result.ruleId;
            matchedRuleCategory = result.category;
          }
        } else {
          allMatches.push({
            ruleId: 'unknown',
            category: 'unknown',
            priority: 999,
            verdict: 'deny',
            reason: 'Rule did not match',
            matched: false,
          });
        }
      }

      const audit = buildAudit({
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        permission: { kind: context.permission.kind, resource: context.permission.resource },
        tier: context.tier,
        source: context.source,
        agentId: context.agentId,
        verdict: finalVerdict,
        matchedRuleId,
        matchedRuleCategory,
        reason: finalReason,
        allMatchedRules: allMatches,
      });

      return { verdict: finalVerdict, reason: finalReason, matchedRuleId, matchedRuleCategory, audit };
    },

    buildRuleEvaluators(config: any) {
      return buildRuleEvaluators(config);
    },
  };
}

function buildAudit(params: {
  id: string;
  timestamp: number;
  permission: { kind: string; resource?: string };
  tier: string;
  source: string;
  agentId?: string;
  verdict: 'allow' | 'require_human' | 'deny';
  matchedRuleId?: string;
  matchedRuleCategory?: string;
  reason: string;
  allMatchedRules: { ruleId: string; category: string; priority: number; verdict: 'allow' | 'require_human' | 'deny'; reason: string; matched: boolean }[];
}) {
  return {
    id: params.id,
    timestamp: params.timestamp,
    permission: params.permission,
    tier: params.tier,
    source: params.source,
    agentId: params.agentId,
    verdict: params.verdict,
    matchedRuleId: params.matchedRuleId,
    matchedRuleCategory: params.matchedRuleCategory,
    reason: params.reason,
    allMatchedRules: params.allMatchedRules,
  };
}

function buildRuleEvaluators(config: any) {
  const evaluators: Record<string, { evaluator: any; priority: number; category: string }> = {};

  if (config.rules?.some((r: any) => r.category === 'authority' && r.enabled !== false)) {
    evaluators['authority.min_tier'] = {
      evaluator: createAuthorityRule({}),
      priority: 10,
      category: 'authority',
    };
  }

  if (config.rules?.some((r: any) => r.category === 'command_safety' && r.enabled !== false)) {
    evaluators['command_safety.forbidden'] = {
      evaluator: createCommandSafetyRule({}),
      priority: 20,
      category: 'command_safety',
    };
  }

  if (config.rules?.some((r: any) => r.category === 'financial' && r.enabled !== false)) {
    evaluators['financial.limits'] = {
      evaluator: createFinancialRule({}),
      priority: 30,
      category: 'financial',
    };
  }

  if (config.rules?.some((r: any) => r.category === 'path_protection' && r.enabled !== false)) {
    evaluators['path_protection.protected'] = {
      evaluator: createPathProtectionRule({}),
      priority: 40,
      category: 'path_protection',
    };
  }

  if (config.rules?.some((r: any) => r.category === 'rate_limits' && r.enabled !== false)) {
    evaluators['rate_limits.limits'] = {
      evaluator: createRateLimitRule({}),
      priority: 50,
      category: 'rate_limits',
    };
  }

  if (config.rules?.some((r: any) => r.category === 'validation' && r.enabled !== false)) {
    evaluators['validation.inputs'] = {
      evaluator: createValidationRule({}),
      priority: 60,
      category: 'validation',
    };
  }

  return evaluators;
}

export function createPolicyEvaluator(config: any) {
  return {
    evaluators: buildRuleEvaluators(config),
  };
}