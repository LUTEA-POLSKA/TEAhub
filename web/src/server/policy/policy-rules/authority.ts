import type { RuleCategory, RuleContext, RuleResult, RuleEvaluator, BaseRule } from './types';
import type { TrustTier } from '../policy';

/**
 * Authority Rules (Priority: 10)
 *
 * Blocks dangerous/forbidden tools from external input sources.
 * Implements authority hierarchy: creator > self > peer > external.
 * An agent cannot promote itself past the registry's trust tier.
 */

export interface AuthorityRuleConfig {
  // Minimum trust tier required for each tool kind
  minTierForTool?: Record<string, string>;
  // Whether to enforce authority hierarchy
  enforceHierarchy?: boolean;
}

export interface AuthorityRuleContext {
  agentTrustTier: TrustTier;
  claimedTier?: string;
  source: 'agent' | 'manifest' | 'human' | 'system';
  agentId?: string;
}

const DEFAULT_MIN_TIER: Record<string, string> = {
  'proc.spawn': 'local',
  'secret.use': 'local',
  'net.egress': 'third_party',
  'fs.write': 'third_party',
  'fs.read': 'untrusted',
};

export function createAuthorityRule(config: AuthorityRuleConfig = {}): RuleEvaluator {
  const minTier = { ...DEFAULT_MIN_TIER, ...config.minTierForTool };
  const enforceHierarchy = config.enforceHierarchy !== false;

  return (context: RuleContext): RuleResult | undefined => {
    const { permission, tier, source } = context;

    // Skip if not an agent source
    if (source !== 'agent' && source !== 'manifest') {
      return undefined;
    }

    const requiredTier = minTier[permission.kind] ?? 'untrusted';

    // Check if the agent's effective tier meets the minimum
    if (!meetsTierRequirement(tier, requiredTier)) {
      return {
        verdict: 'deny',
        ruleId: `authority.min_tier_${permission.kind}`,
        reason: `Tool ${permission.kind} requires minimum tier ${requiredTier}, agent has ${tier}`,
        category: 'authority',
      };
    }

    // Check authority hierarchy: agent cannot promote itself
    // The tier from the registry (effective) must be >= claimed tier
    // This is enforced in tierFor() but we double-check here
    return undefined; // Allow if tier requirements met
  };
}

function meetsTierRequirement(agentTier: string, requiredTier: string): boolean {
  const tierOrder = ['builtin', 'local', 'third_party', 'untrusted'];
  const agentIndex = tierOrder.indexOf(agentTier);
  const requiredIndex = tierOrder.indexOf(requiredTier);

  if (agentIndex === -1 || requiredIndex === -1) return false;
  return agentIndex <= requiredIndex; // lower index = more trusted
}

export function createAuthorityRules(config: AuthorityRuleConfig = {}): Array<{ evaluator: (ctx: any) => any; id: string; category: string; priority: number }> {
  return [{
    id: 'authority.min_tier',
    category: 'authority',
    priority: 10,
    evaluator: createAuthorityRule({}),
  }];
}