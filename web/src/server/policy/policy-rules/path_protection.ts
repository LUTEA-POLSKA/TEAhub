import type { RuleEvaluator } from './types';

/**
 * Path Protection Rules (Priority: 40)
 *
 * Blocks writes to protected files and reads of sensitive files.
 *
 * Protected files (cannot be written):
 * - Constitution, wallet, DB, config, SOUL.md
 * - Policy files, audit logs
 *
 * Sensitive files (cannot be read):
 * - Private keys, API keys, .env files
 * - Wallet files, session tokens
 */

export function createPathProtectionRule(config: {
  protectedPaths?: string[];
  sensitivePaths?: string[];
  allowOverrides?: string[];
} = {}): (context: { permission: { kind: string; resource?: string }; metadata?: Record<string, unknown> }) => { verdict: 'allow' | 'require_human' | 'deny'; ruleId: string; reason: string; category: string } | undefined {
  const protectedPaths = new Set([
    'automaton.json',
    'wallet.json',
    'state.db',
    'policy.json',
    'SOUL.md',
    'audit.log',
    'heartbeat.yml',
    'private.key',
    'private_key.pem',
    'api-key',
    'api_key',
    '.env',
    '.env.local',
    '.env.production',
    'id_rsa',
    'id_ed25519',
    'wallet.json',
    'session',
    ...(config.protectedPaths ?? []),
  ].filter(p => !config.allowOverrides?.includes(p)));

  const sensitivePaths = new Set([
    'wallet.json',
    'private.key',
    'private_key.pem',
    'api-key',
    'api_key',
    '.env',
    '.env.local',
    '.env.production',
    'id_rsa',
    'id_ed25519',
    'wallet.json',
    'session',
    ...(config.sensitivePaths ?? []),
  ]);

  const isProtected = (path: string): boolean => {
    const normalized = path.replace(/\\/g, '/').replace(/^\//, '');
    for (const protectedPath of protectedPaths) {
      if (normalized === protectedPath || normalized.startsWith(protectedPath + '/')) {
        return true;
      }
    }
    return false;
  };

  const isSensitive = (path: string): boolean => {
    const normalized = path.replace(/\\/g, '/').replace(/^\//, '');
    for (const sensitivePath of sensitivePaths) {
      if (normalized.includes(sensitivePath)) {
        return true;
      }
    }
    return false;
  };

  return (context: { permission: { kind: string; resource?: string }; metadata?: Record<string, unknown> }) => {
    const { permission } = context;
    const resource = permission.resource ?? '';

    if (!resource) return undefined;

    if (permission.kind === 'fs.write' && isProtected(resource)) {
      return {
        verdict: 'deny',
        ruleId: 'path_protection.protected_write',
        reason: `Path ${resource} is protected from writes`,
        category: 'path_protection',
      };
    }

    if (permission.kind === 'fs.read' && isSensitive(resource)) {
      return {
        verdict: 'deny',
        ruleId: 'path_protection.sensitive_read',
        reason: `Path ${resource} contains sensitive data and cannot be read`,
        category: 'path_protection',
      };
    }

    return undefined;
  };
}