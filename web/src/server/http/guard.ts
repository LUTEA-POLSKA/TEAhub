import { type AuthResult, type AuthSuccess, SESSION_COOKIE, authorize, checkCsrf, resolveSession } from '../auth/auth';
import type { Db } from '../db/task-store';
import { PgAuditSink } from '../db/audit-sink';
import type { Config } from './config';

/**
 * The one door every request comes through.
 *
 * The order is the design and must not be rearranged:
 *
 *   1. **CSRF first.** A cross-origin request is refused before its cookie is
 *      even looked at. Checking the session first would mean a forged request
 *      carries a valid session into the handler before anything objects.
 *   2. **Session second.** No session, no handler.
 *   3. **Authorisation third**, against an explicit action name.
 *
 * Handlers receive a typed session or nothing at all. There is no path into a
 * handler that skips step 1, because the handler *is* the wrapper's callback —
 * a handler that wants to run declares the action it performs.
 */

export interface RequestContext {
  session: AuthSuccess;
  action: string;
  request: Request;
  params?: Record<string, string>;
}

export type Handler = (ctx: RequestContext) => Promise<Response>;

export interface GuardDeps {
  db: Db;
  audit: PgAuditSink;
  config: Config;
  /** Limits state-changing requests per session, on top of the login limiter. */
  writeLimiter?: RateWindow;
}

/** A small fixed-window counter for write endpoints. */
export class RateWindow {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max = 60,
    private readonly windowMs = 60_000,
  ) {}

  allow(key: string): boolean {
    const now = Date.now();
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.max;
  }

  /** Clears one key, so a fresh sign-in does not inherit a previous burst. */
  resetFor(key: string): void {
    this.hits.delete(key);
  }
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // An API response must never be cached by a shared proxy.
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

/**
 * Errors are reported as a code plus a human sentence, never as a stack or an
 * internal message. A leaked provider URL or a Postgres fragment in a response
 * body is reconnaissance for free.
 */
export function problem(status: number, code: string, detail: string): Response {
  return json({ error: { code, detail } }, status);
}

export function withGuard(
  deps: GuardDeps,
  action: string,
  handler: Handler,
  options: { csrf?: boolean; write?: boolean } = {},
): (request: Request, params?: Record<string, string>) => Promise<Response> {
  const csrf = options.csrf ?? true;
  const write = options.write ?? true;

  return async (request, params) => {
    // 1. CSRF, before the cookie is read.
    if (csrf) {
      const verdict = checkCsrf({
        method: request.method,
        origin: request.headers.get('origin'),
        secFetchSite: request.headers.get('sec-fetch-site'),
        expectedOrigin: deps.config.publicOrigin,
      });
      if (!verdict.ok) {
        await deps.audit.record({
          actorType: 'system',
          action: 'request.rejected',
          outcome: 'blocked',
          detail: { reason: 'csrf', detail: verdict.reason, path: new URL(request.url).pathname },
        });
        return problem(403, 'csrf_rejected', 'Cross-site request refused.');
      }
    }

    // 2. Session.
    const token = readCookie(request, SESSION_COOKIE);
    const session: AuthResult = await resolveSession(deps.db, token ?? '');

    if (!session.ok) {
      await deps.audit.record({
        actorType: 'system',
        action: 'request.rejected',
        outcome: 'blocked',
        detail: { reason: session.reason, path: new URL(request.url).pathname },
      });
      // One answer for "no cookie" and "stale cookie": telling them apart tells an
      // attacker which of their guesses was once right.
      return problem(401, 'unauthenticated', 'Sign in to continue.');
    }

    // 3. Rate limit on writes, per session.
    if (write) {
      const limiter = deps.writeLimiter;
      if (limiter && !limiter.allow(session.userId)) {
        await deps.audit.record({
          actorType: 'user',
          actorId: session.userId,
          action: 'request.rejected',
          outcome: 'blocked',
          detail: { reason: 'rate limit', path: new URL(request.url).pathname },
        });
        return problem(429, 'rate_limited', 'Too many requests. Slow down.');
      }
    }

    // 4. Authorisation, against the declared action.
    const verdict = authorize(session, action);
    if (!verdict.ok) {
      await deps.audit.record({
        actorType: 'user',
        actorId: session.userId,
        action: 'request.rejected',
        outcome: 'blocked',
        detail: { reason: verdict.reason, path: new URL(request.url).pathname },
      });
      return problem(403, 'forbidden', 'You may not do that.');
    }

    return handler({ session, action, request, params });
  };
}

/** The same guard, for the two endpoints that cannot require a session. */
export function withPublicGuard(
  deps: Pick<GuardDeps, 'audit' | 'config'>,
  handler: Handler,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const verdict = checkCsrf({
      method: request.method,
      origin: request.headers.get('origin'),
      secFetchSite: request.headers.get('sec-fetch-site'),
      expectedOrigin: deps.config.publicOrigin,
    });
    if (!verdict.ok) {
      await deps.audit.record({
        actorType: 'system',
        action: 'request.rejected',
        outcome: 'blocked',
        detail: { reason: 'csrf', detail: verdict.reason },
      });
      return problem(403, 'csrf_rejected', 'Cross-site request refused.');
    }
    return handler({
      session: { ok: true, userId: 'anonymous', role: 'user', email: '', name: '' },
      action: 'public',
      request,
    });
  };
}