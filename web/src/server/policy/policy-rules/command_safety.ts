import { matches } from '../policy';
import type { RuleEvaluator, RuleContext, RuleResult } from './types';

export interface CommandSafetyRuleConfig {
  forbiddenPatterns?: string[];
  customPatterns?: string[];
  maxSelfModificationsPerHour?: number;
  maxSelfModificationsPerDay?: number;
}

const DEFAULT_FORBIDDEN_PATTERNS = [
  'rm -rf /',
  'rm -rf /*',
  '> /dev/sda',
  '> /dev/nvme',
  'dd if=/dev/zero',
  'mkfs.',
  'fdisk /dev/',
  'parted /dev/',
  'kill -9 -1',
  'pkill -9',
  'killall -9',
  'DROP TABLE',
  'DROP DATABASE',
  'DROP SCHEMA',
  'TRUNCATE TABLE',
  'iptables -F',
  'iptables -X',
  'ufw disable',
  'firewall-cmd --disable',
  'systemctl stop firewalld',
  'sudo su',
  'su -',
  'chmod 777 /',
  'chmod 777 /*',
  'chown root:root /',
  'chown -R root:root /',
];

export function createCommandSafetyRule(config: CommandSafetyRuleConfig = {}): RuleEvaluator {
  const forbiddenPatterns = [
    ...DEFAULT_FORBIDDEN_PATTERNS,
    ...(config.customPatterns ?? []),
  ].filter(p => !config.forbiddenPatterns?.includes(p));

  // Track rate limits per agent (in-memory, resets on restart)
  const hourlyCounts = new Map<string, { count: number; resetAt: number }>();
  const dailyCounts = new Map<string, { count: number; resetAt: number }>();

  return (context: RuleContext): RuleResult | undefined => {
    const { permission, metadata } = context;

    // Only apply to proc.spawn (shell commands)
    if (permission.kind !== 'proc.spawn') {
      return undefined;
    }

    const command = (metadata?.command as string) ?? permission.resource ?? '';
    const agentId = context.agentId ?? 'unknown';

    // Check forbidden patterns
    for (const pattern of forbiddenPatterns) {
      if (command.includes(pattern)) {
        return {
          verdict: 'deny',
          ruleId: 'command_safety.forbidden_pattern',
          reason: `Command contains forbidden pattern: ${pattern}`,
          category: 'command_safety',
        };
      }
    }

    // Rate limiting for self-modification tools
    if (['self_mod', 'git'].some(cat => permission.kind.startsWith(cat))) {
      const now = Date.now();
      const hourAgo = Date.now() - 3_600_000;
      const dayAgo = Date.now() - 86_400_000;

      // Clean old entries
      // (simplified - in production would use proper cleanup)
      const hourly = { count: 0, resetAt: Date.now() + 3_600_000 };
      const daily = { count: 0, resetAt: Date.now() + 86_400_000 };

      if (hourly.count >= 10) {
        return {
          verdict: 'deny',
          ruleId: 'command_safety.rate_limit_hourly',
          reason: 'Hourly self-modification limit exceeded (max 10/hour)',
          category: 'command_safety',
        };
      }
      if (daily.count >= 50) {
        return {
          verdict: 'deny',
          ruleId: 'command_safety.rate_limit_daily',
          reason: 'Daily self-modification limit exceeded (max 50/day)',
          category: 'command_safety',
        };
      }
    }

    return undefined;
  };
}