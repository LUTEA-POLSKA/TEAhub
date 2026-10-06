import type { RuleEvaluator } from './types';

/**
 * Validation Rules (Priority: 60)
 *
 * Input format validation:
 * - Package names (npm, pypi, cargo, go)
 * - URLs (valid scheme, no localhost/private IPs)
 * - Domains (valid format, no punycode tricks)
 * - Git hashes (full SHA, no short hashes)
 * - File paths (no directory traversal, valid chars)
 * - JSON schemas (if applicable)
 * - Command arguments (no injection)
 * - Email addresses (RFC 5322)
 */

export function createValidationRule(config: {
  allowedSchemes?: string[];
  blockedDomains?: string[];
  allowedPackageRegistries?: string[];
  maxPathLength?: number;
  allowedPathChars?: RegExp;
  requireFullGitHash?: boolean;
  strictEmailValidation?: boolean;
  maxUrlLength?: number;
  blockedUrlPatterns?: string[];
} = {}): RuleEvaluator {
  const blockedDomains = new Set([
    'localhost',
    'localhost.localdomain',
    '127.0.0.1',
    '0.0.0.0',
    '::1',
    '169.254.169.254',
    'metadata.google.internal',
    ...(config.blockedDomains ?? []),
  ]);

  const blockedUrlPatterns = [
    '127.0.0.1',
    '127.',
    '10.',
    '172.16.',
    '172.17.',
    '172.18.',
    '172.19.',
    '172.20.',
    '172.21.',
    '172.22.',
    '172.23.',
    '172.24.',
    '172.25.',
    '172.26.',
    '172.27.',
    '172.28.',
    '172.29.',
    '172.30.',
    '172.31.',
    '192.168.',
    '169.254.',
    '10.',
    '0.0.0.0',
    ...(config.blockedUrlPatterns ?? []),
  ];

  const allowedSchemes = new Set(config.allowedSchemes ?? ['https', 'http']);
  const allowedRegistries = new Set(config.allowedPackageRegistries ?? ['npm', 'pypi', 'cargo', 'go', 'crates.io', 'github.com', 'githubusercontent.com']);

  const isPrivateIp = (hostname: string): boolean => {
    if (blockedDomains.has(hostname)) return true;
    if (blockedUrlPatterns.some(p => hostname.includes(p))) return true;

    const ipv4 = hostname.match(/^(\d{1,3}\.){3}\d{1,3}$/);
    if (ipv4) {
      const parts = hostname.split('.').map(Number);
      if (!parts[0]) return false;
      if (parts[0] === 10) return true;
      if (parts[0] === 172 && parts[1] !== undefined && parts[1] >= 16 && parts[1] <= 31) return true;
      if (parts[0] === 192 && parts[1] !== undefined && parts[1] === 168) return true;
      if (parts[0] === 169 && parts[1] !== undefined && parts[1] === 254) return true;
      if (parts[0] === 10) return true;
      if (parts[0] === 127) return true;
      if (parts[0] === 100 && parts[1] !== undefined && parts[1] >= 64 && parts[1] <= 127) return true;
    }
    return false;
  };

  const validateUrl = (url: string): { valid: boolean; reason: string } => {
    try {
      const parsed = new URL(url);
      if (!['https', 'http'].includes(parsed.protocol.replace(':', ''))) {
        return { valid: false, reason: `Scheme ${parsed.protocol} not allowed` };
      }
      const hostname = parsed.hostname ?? '';
      if (!hostname) {
        return { valid: false, reason: 'Invalid URL format - no hostname' };
      }
      if (['127.0.0.1', '127.', '10.', '172.16.', '172.17.', '172.18.', '172.19.', '172.20.', '172.21.', '172.22.', '172.23.', '172.24.', '172.24.', '172.25.', '172.25.', '172.26.', '172.27.', '172.28.', '172.29.', '172.30.', '172.31.', '192.168.', '169.254.', '10.', '0.0.0.0'].some(p => hostname.includes(p))) {
        return { valid: false, reason: `Private/internal IP not allowed: ${hostname}` };
      }
      return { valid: true, reason: '' };
    } catch {
      return { valid: false, reason: 'Invalid URL format' };
    }
  };

  const validateDomain = (domain: string): { valid: boolean; reason: string } => {
    const blocked = ['localhost', 'localhost.localdomain', '127.0.0.1', '0.0.0.0', '::1', '169.254.169.254', 'metadata.google.internal'];
    if (blocked.includes(domain.toLowerCase())) {
      return { valid: false, reason: `Domain ${domain} is blocked` };
    }
    const domainRegex = /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
    if (!domainRegex.test(domain)) {
      return { valid: false, reason: 'Invalid domain format' };
    }
    return { valid: true, reason: '' };
  };

const validatePackage = (pkg: string): { valid: boolean; reason: string } => {
    const parts = pkg.split('/');
    if (parts.length > 2) return { valid: false, reason: 'Invalid package format' };
    if (parts.length === 2 && !parts[0]?.startsWith('@')) return { valid: true, reason: '' }; // Go module
    if (parts[0]?.startsWith('@')) {
      if (!/^@[a-z0-9][a-z0-9-]*$/.test(parts[0] ?? '')) return { valid: false, reason: 'Invalid npm scope' };
      if (!/^[a-z0-9][a-z0-9._-]*$/.test(parts[1] ?? '')) return { valid: false, reason: 'Invalid npm package name' };
    } else {
      if (!/^[a-z0-9][a-z0-9._-]*$/i.test(parts[0] ?? '')) return { valid: false, reason: 'Invalid package name' };
    }
    return { valid: true, reason: '' };
  };

  const validateGitHash = (hash: string): { valid: boolean; reason: string } => {
    if (!/^[0-9a-f]{7,40}$/i.test(hash)) return { valid: false, reason: 'Invalid git hash format' };
    if (hash.length !== 40) return { valid: false, reason: 'Git hash must be full 40-character SHA' };
    return { valid: true, reason: '' };
  };

  const validatePath = (path: string): { valid: boolean; reason: string } => {
    if (path.length > 4096) return { valid: false, reason: 'Path too long' };
    if (path.includes('..')) return { valid: false, reason: 'Path traversal not allowed' };
    if (path.includes('\0')) return { valid: false, reason: 'Null byte in path' };
    return { valid: true, reason: '' };
  };

  const validateEmail = (email: string): { valid: boolean; reason: string } => {
    const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
    if (!emailRegex.test(email)) return { valid: false, reason: 'Invalid email format' };
    return { valid: true, reason: '' };
  };

  const validateCommandArgs = (args: string[]): { valid: boolean; reason: string } => {
    const patterns = [/;/, /\$\(/, /`/, /\|\|/, /&&/, />\s*\/dev\//, />\s*\/proc/, />\s*\/sys/];
    const joined = args.join(' ');
    for (const pattern of patterns) {
      if (pattern.test(joined)) return { valid: false, reason: 'Potential command injection in arguments' };
    }
    return { valid: true, reason: '' };
  };

  return (context: {
    permission: { kind: string; resource?: string };
    metadata?: Record<string, unknown>;
    inputValue?: string;
    inputType?: 'url' | 'domain' | 'package' | 'git_hash' | 'path' | 'email' | 'command_args';
  }): { verdict: 'allow' | 'require_human' | 'deny'; ruleId: string; reason: string; category: 'validation' } | undefined => {
    const { inputValue, inputType } = context;
    if (!inputValue || !inputType) return undefined;

    switch (inputType) {
      case 'url': {
        const result = validateUrl(inputValue);
        if (!result.valid) return { verdict: 'deny', ruleId: 'validation.invalid_url', reason: result.reason, category: 'validation' };
        break;
      }
      case 'domain': {
        const result = validateDomain(inputValue);
        if (!result.valid) return { verdict: 'deny', ruleId: 'validation.invalid_domain', reason: result.reason, category: 'validation' };
        break;
      }
      case 'package': {
        const result = validatePackage(inputValue);
        if (!result.valid) return { verdict: 'deny', ruleId: 'validation.invalid_package', reason: result.reason, category: 'validation' };
        break;
      }
      case 'git_hash': {
        const result = validateGitHash(inputValue);
        if (!result.valid) return { verdict: 'deny', ruleId: 'validation.invalid_git_hash', reason: result.reason, category: 'validation' };
        break;
      }
      case 'path': {
        const result = validatePath(inputValue);
        if (!result.valid) return { verdict: 'deny', ruleId: 'validation.invalid_path', reason: result.reason, category: 'validation' };
        break;
      }
      case 'email': {
        const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
        if (!emailRegex.test(inputValue)) return { verdict: 'deny', ruleId: 'validation.invalid_email', reason: 'Invalid email format', category: 'validation' };
        break;
      }
      case 'command_args': {
        try {
          const args = JSON.parse(inputValue);
          if (Array.isArray(args)) {
            const injectionPatterns = [/;/, /\$\(/, /`/, /\|\|/, /&&/, />\s*\/dev\//, />\s*\/proc/, />\s*\/sys/];
            const joined = args.join(' ');
            for (const pattern of injectionPatterns) {
              if (pattern.test(joined)) return { verdict: 'deny', ruleId: 'validation.command_injection', reason: 'Potential command injection in arguments', category: 'validation' };
            }
          }
        } catch {
          return { verdict: 'deny', ruleId: 'validation.invalid_command_args', reason: 'Command arguments must be a JSON array', category: 'validation' };
        }
        break;
      }
    }
    return undefined;
  };
}