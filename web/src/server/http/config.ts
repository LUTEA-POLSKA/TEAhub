/**
 * Configuration, loaded once and validated once.
 *
 * Two properties matter more than convenience here:
 *
 *  * **No default for a secret.** A missing provider key is a startup error, not
 *    an empty string that later becomes an unauthenticated request. Every other
 *    layer in TEAhub is fail-closed; a config that defaults a secret would be the
 *    one place that is not.
 *  * **No default for the network origin.** The CSRF check compares against it,
 *    so a guessed or defaulted value would either refuse everything or, worse,
 *    accept an attacker's origin as correct.
 */

export interface Config {
  port: number;
  /** The browser-visible origin. Also the CSRF reference. */
  publicOrigin: string;
  databaseUrl: string;
  workspaceRoots: string[];
  allowedFetchHosts: string[];
  /** Provider candidates, in no particular order — the router ranks them. */
  providers: ProviderConfig[];
  policyPath: string;
  sessionTtlMs: number;
}

export interface ProviderConfig {
  id: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
  price?: { inputPerM: number; outputPerM: number };
  contextTokens: number;
  supportsTools: boolean;
  supportsVision: boolean;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (value === undefined || value.trim() === '') {
    throw new ConfigError(
      `${key} is not set. Refusing to start rather than continue with a default.`,
    );
  }
  return value.trim();
}

function int(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new ConfigError(`${key} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

/** Split a comma-separated list, dropping blanks. */
function list(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Providers are declared in `TEAHUB_PROVIDERS` and their details come from
 * per-provider environment variables. An OpenAI-compatible endpoint needs a base
 * URL and a key, and nothing else — which is the whole reason ModelMesh needs no
 * TEAhub code of its own once it exposes `/v1`.
 */
function providers(env: NodeJS.ProcessEnv): ProviderConfig[] {
  const ids = list(env.TEAHUB_PROVIDERS);
  const out: ProviderConfig[] = [];

  for (const id of ids) {
    const baseUrl = env[`${id.toUpperCase()}_BASE_URL`]?.trim();
    if (!baseUrl) {
      throw new ConfigError(
        `provider ${id} is listed in TEAHUB_PROVIDERS but ${id.toUpperCase()}_BASE_URL is not set`,
      );
    }
    // A local endpoint legitimately has no key, so its absence is not an error —
    // an empty string in place of one would be.
    const apiKey = env[`${id.toUpperCase()}_API_KEY`]?.trim();

    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new ConfigError(`provider ${id}: scheme ${url.protocol} is not http or https`);
    }

    out.push({
      id,
      baseUrl: baseUrl.replace(/\/+$/, ''),
      apiKey,
      model: env[`${id.toUpperCase()}_MODEL`]?.trim() ?? 'default',
      price: parsePrice(env[`${id.toUpperCase()}_PRICE`]),
      contextTokens: int(env, `${id.toUpperCase()}_CONTEXT`, 128_000),
      supportsTools: (env[`${id.toUpperCase()}_TOOLS`] ?? 'true').trim() !== 'false',
      supportsVision: (env[`${id.toUpperCase()}_VISION`] ?? 'false').trim() === 'true',
    });
  }

  return out;
}

function parsePrice(raw: string | undefined): { inputPerM: number; outputPerM: number } | undefined {
  if (!raw || !raw.trim()) return undefined;
  const parts = raw.split('/').map((s) => s.trim());
  const input = Number.parseFloat(parts[0] ?? '');
  const output = Number.parseFloat(parts[1] ?? '');
  if (Number.isNaN(input) || Number.isNaN(output) || input < 0 || output < 0) {
    throw new ConfigError(
      `price must look like INPUT/OUTPUT in USD per million tokens, got ${JSON.stringify(raw)}`,
    );
  }
  return { inputPerM: input, outputPerM: output };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const publicOrigin = required(env, 'TEAHUB_PUBLIC_ORIGIN').replace(/\/+$/, '');

  const parsed = new URL(publicOrigin);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConfigError(`TEAHUB_PUBLIC_ORIGIN must be http or https, got ${parsed.protocol}`);
  }

  return {
    port: int(env, 'TEAHUB_PORT', 3000),
    publicOrigin,
    databaseUrl: required(env, 'DATABASE_URL'),
    workspaceRoots: list(env.TEAHUB_WORKSPACE_ROOTS),
    allowedFetchHosts: list(env.TEAHUB_FETCH_HOSTS),
    providers: providers(env),
    policyPath: env.TEAHUB_POLICY_PATH?.trim() || 'policy.json',
    sessionTtlMs: int(env, 'TEAHUB_SESSION_TTL_MS', 1000 * 60 * 60 * 12),
  };
}

/**
 * Whether the browser may talk to TEAhub at all.
 *
 * Secure cookies are the point of the `__Host-` prefix, and a browser will not
 * store one over plain http. A configuration that permits it would produce an app
 * that appears to have session cookies and has none.
 */
export function assertUsable(config: Config): void {
  const parsed = new URL(config.publicOrigin);
  if (parsed.protocol === 'http:') {
    // Exact hostname match only. 'evil-localhost.test' is NOT localhost.
    const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    if (!isLocal) {
      throw new ConfigError(
        `${config.publicOrigin} is plain http and not a loopback address. ` +
          `Session cookies are Secure-only, so the browser would drop them and the ` +
          `app would look authenticated while holding no session.`,
      );
    }
  }
}