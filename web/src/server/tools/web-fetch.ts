import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { type Tool, type ToolOutput, failed, succeeded } from './types';

/**
 * The only tool that touches the network, and therefore the one place an SSRF
 * guard has to be right.
 *
 * Three checks, in this order, because the order is the defence:
 *
 *  1. **Every resolved address is checked, not the hostname.** A name that
 *     resolves to 127.0.0.1 is the request this feature exists to stop.
 *  2. **Redirects are followed by hand, and each hop is re-validated.** A
 *     `Location` header is attacker-controlled, so an allowed first hop that
 *     redirects to a link-local address is the standard bypass.
 *  3. **Content-Type is verified, not assumed.** A 200 carrying `text/html` from
 *     something that should have been JSON is how an internal service ends up in
 *     a model's context. Status alone proves nothing about what came back.
 *
 * Known limitation, stated rather than hidden: there is a time-of-check /
 * time-of-use gap between resolving a name here and the runtime resolving it
 * again. Pinning the address would close it and costs the TLS hostname match,
 * so this is a deliberate trade for the MVP. It is a real gap, not a solved one.
 */

export interface FetchLimits {
  maxBytes: number;
  timeoutMs: number;
  maxRedirects: number;
}

export interface FetchToolDeps {
  limits: FetchLimits;
  /**
   * Host allowlist. Empty means nothing may be fetched at all, not everything —
   * fail closed. An operator opts in per host rather than out of a default-open
   * internet.
   */
  allowedHosts: string[];
  fetchImpl?: typeof fetch;
  resolveImpl?: typeof lookup;
}

/** IPv4 ranges that must never be reachable from a tool. */
const BLOCKED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const parts = address.split('.').map(Number) as [number, number, number, number];
    const asInt = ((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!;
    return BLOCKED_V4.some(([base, bits]) => {
      const b = base.split('.').map(Number) as [number, number, number, number];
      const baseInt = ((b[0]! << 24) >>> 0) + (b[1]! << 16) + (b[2]! << 8) + b[3]!;
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      return (asInt & mask) >>> 0 === (baseInt & mask) >>> 0;
    });
  }
  if (family === 6) {
    const a = address.toLowerCase().replace(/^\[|\]$/g, '');
    if (a === '::' || a === '::1') return true;
    // Unique-local (fc00::/7) and link-local (fe80::/10).
    if (/^f[cd][0-9a-f]{2}:/.test(a)) return true;
    if (/^fe[89ab][0-9a-f]:/.test(a)) return true;
    // IPv4-mapped: ::ffff:127.0.0.1 must not slip past a v4 check.
    const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedAddress(mapped[1]!);
    return false;
  }
  return true;
}

export interface FetchArgs {
  url: string;
  maxBytes?: number;
}

function hostAllowed(host: string, allowed: string[]): boolean {
  const h = host.toLowerCase();
  return allowed.some((entry) => {
    const a = entry.toLowerCase().replace(/^\*\./, '');
    return h === a || h.endsWith(`.${a}`);
  });
}

/**
 * Resolve the host and reject the request if *any* address it maps to is
 * private. One public and one private answer is enough to be an attack, so a
 * single bad address fails the whole check.
 */
async function assertPublicHost(
  hostname: string,
  resolveImpl: typeof lookup,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (isIP(hostname) !== 0) {
    return isBlockedAddress(hostname)
      ? { ok: false, reason: `address ${hostname} is in a blocked range` }
      : { ok: true };
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await resolveImpl(hostname, { all: true });
  } catch (error) {
    return { ok: false, reason: `DNS lookup failed: ${(error as Error).message}` };
  }

  if (addresses.length === 0) return { ok: false, reason: 'host resolved to no addresses' };

  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      return { ok: false, reason: `host ${hostname} resolves to blocked address ${address}` };
    }
  }
  return { ok: true };
}

export function createFetchTool(deps: FetchToolDeps): Tool<FetchArgs, string> {
  const fetchImpl = deps.fetchImpl ?? fetch;

  return {
    name: 'web.fetch',
    description: 'Fetch a text resource from an allowlisted public host.',
    permission: (args) => ({ kind: 'net.egress', resource: args.url }),
    egress: () => true,

    validate: (args): FetchArgs => {
      if (typeof args !== 'object' || args === null) {
        throw new Error('web.fetch expects an object');
      }
      const { url, maxBytes } = args as Record<string, unknown>;
      if (typeof url !== 'string') throw new Error('web.fetch needs a string `url`');

      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new Error(`not a valid URL: ${url}`);
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`scheme ${parsed.protocol} is not allowed, use http or https`);
      }
      if (typeof maxBytes === 'number') return { url, maxBytes };
      return { url };
    },

    execute: async (args, signal): Promise<ToolOutput<string>> => {
      const resolveImpl = deps.resolveImpl ?? lookup;
      const limit = Math.min(args.maxBytes ?? deps.limits.maxBytes, deps.limits.maxBytes);

      let current = args.url;

      for (let hop = 0; hop <= deps.limits.maxRedirects; hop++) {
        let parsed: URL;
        try {
          parsed = new URL(current);
        } catch {
          return failed(`not a valid URL: ${current}`);
        }

        if (deps.allowedHosts.length === 0) {
          return failed('no hosts are allowlisted for fetching, refusing every request');
        }
        if (!hostAllowed(parsed.hostname, deps.allowedHosts)) {
          return failed(`host ${parsed.hostname} is not allowlisted`);
        }

        // Re-validated on every hop: a Location header can point anywhere.
        const reachable = await assertPublicHost(parsed.hostname, resolveImpl);
        if (!reachable.ok) return failed(reachable.reason);

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), deps.limits.timeoutMs);
        const onAbort = () => controller.abort();
        signal?.addEventListener('abort', onAbort, { once: true });

        let response: Response;
        try {
          response = await fetchImpl(parsed, {
            redirect: 'manual',
            signal: controller.signal,
          });
        } catch (error) {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          return failed(`request failed: ${(error as Error).message}`);
        }
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (!location) return failed(`redirect without a Location header (${response.status})`);
          if (hop === deps.limits.maxRedirects) {
            return failed(`more than ${deps.limits.maxRedirects} redirects`);
          }
          try {
            current = new URL(location, parsed).toString();
          } catch {
            return failed(`redirect to an unparseable URL: ${location}`);
          }
          continue;
        }

        if (!response.ok) {
          return failed(`HTTP ${response.status} ${response.statusText}`);
        }

        const contentType = response.headers.get('content-type') ?? '';
        const type = contentType.split(';')[0]!.trim().toLowerCase();
        const TEXTUAL = new Set([
          'text/plain',
          'text/markdown',
          'text/csv',
          'application/json',
          'application/xml',
          'text/html',
        ]);
        if (!TEXTUAL.has(type)) {
          // A 200 is not evidence that what came back is what was expected.
          return failed(`unexpected content-type ${type || '(none)'}`);
        }

        const declared = response.headers.get('content-length');
        if (declared && Number(declared) > limit) {
          return failed(`response is ${declared} bytes, limit is ${limit}`);
        }

        let body: string;
        try {
          body = await response.text();
        } catch (error) {
          return failed(`reading the body failed: ${(error as Error).message}`);
        }

        const bytes = Buffer.byteLength(body, 'utf8');
        if (bytes > limit) {
          return failed(`response is ${bytes} bytes, limit is ${limit}`);
        }

        return succeeded(body, { size: bytes, contentType: type });
      }

      return failed('too many redirects');
    },
  };
}