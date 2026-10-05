import { RateLimiter, SESSION_COOKIE, COOKIE_OPTIONS, authenticate, createSession, destroySession, resolveSession } from '../../auth/auth';
import { json, problem, withPublicGuard } from '../guard';
import type { GuardDeps } from '../guard';
import { rateWindow } from './state';

/**
 * Sign in.
 *
 * The one endpoint that cannot require a session, so it carries its own guard and
 * its own rate limiter. Both exist because this is the only place an attacker can
 * guess without holding anything.
 */
export function loginRoute(deps: GuardDeps) {
  const limiter = new RateLimiter(5, 15 * 60 * 1000);

  const handler = withPublicGuard(deps, async (ctx) => {
    let body: { email?: unknown; password?: unknown };
    try {
      body = (await ctx.request.json()) as typeof body;
    } catch {
      return problem(400, 'bad_request', 'Expected a JSON body.');
    }

    if (typeof body.email !== 'string' || typeof body.password !== 'string') {
      return problem(400, 'bad_request', 'email and password are required.');
    }
    if (body.password.length > 512 || body.email.length > 320) {
      // Refuse absurd input before it reaches scrypt, which is deliberately slow.
      return problem(400, 'bad_request', 'That is longer than any credential here.');
    }

    const result = await authenticate(deps.db, body.email, body.password, limiter);
    if (!result.ok) {
      await deps.audit.record({
        actorType: 'user',
        actorId: undefined,
        action: 'auth.login',
        outcome: 'blocked',
        // The reason is recorded; the response is not allowed to distinguish the
        // cases, or the endpoint becomes an account-enumeration oracle.
        detail: { reason: result.reason, emailLength: body.email.length },
      });

      if (result.reason === 'rate_limited') {
        return problem(429, 'rate_limited', 'Too many attempts. Try again later.');
      }
      return problem(401, 'bad_credentials', 'That email and password do not match.');
    }

    const { token, expiresAt } = await createSession(deps.db, result.userId);
    limiter.reset(body.email.trim().toLowerCase());
    rateWindow(deps.db).resetFor(result.userId);

    await deps.audit.record({
      actorType: 'user',
      actorId: result.userId,
      action: 'auth.login',
      outcome: 'allowed',
      detail: { role: result.role },
    });

    return json(
      { user: { id: result.userId, role: result.role, name: result.name, email: result.email } },
      200,
      {
        'set-cookie': serializeSessionCookie(token, expiresAt),
      },
    );
  });

  return handler;
}

export function serializeSessionCookie(token: string, expiresAt: Date): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Secure',
    `Expires=${expiresAt.toUTCString()}`,
  ].join('; ');
}

export function logoutRoute(deps: GuardDeps) {
  return withPublicGuard(deps, async (ctx) => {
    const { destroySession, resolveSession } = await import('../../auth/auth');
    const header = ctx.request.headers.get('cookie') ?? '';
    const token = /__Host-teahub_session=([^;]+)/.exec(header)?.[1] ?? '';
    if (token) {
      const session = await resolveSession(deps.db, decodeURIComponent(token));
      await destroySession(deps.db, decodeURIComponent(token));
      await deps.audit.record({
        actorType: 'user',
        actorId: session.ok ? session.userId : undefined,
        action: 'auth.logout',
        outcome: 'allowed',
      });
    }
    return json({ ok: true }, 200, {
      'set-cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=0`,
    });
  });
}