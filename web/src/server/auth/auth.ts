import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/task-store';
import * as schema from '../db/schema';

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

/**
 * Sessions, passwords, and the two checks that make a browser app safe.
 *
 * Three decisions worth naming:
 *
 *  * **scrypt from Node, not a dependency.** The built-in is memory-hard and
 *    adequate for a single-operator installation. Argon2id is the better choice
 *    and is the thing to reach for when there is more than one user — noted
 *    rather than pretended away.
 *  * **The session token is stored hashed.** A database leak then yields no
 *    usable sessions. The cookie holds the plaintext once, at issue time.
 *  * **CSRF is checked by Origin, not by a token.** For a same-origin app the
 *    Origin header is set by the browser and cannot be forged by an attacker's
 *    page, so comparing it to the expected origin is both simpler and harder to
 *    get wrong than a double-submit token — a double-submit token is only as
 *    strong as the cookie's SameSite setting.
 */

const KEY_LENGTH = 64;
const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12 hours
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 } as const;

export interface AuthFailure {
  ok: false;
  reason: 'bad_credentials' | 'no_session' | 'expired' | 'disabled' | 'rate_limited';
}

export interface AuthSuccess {
  ok: true;
  userId: string;
  role: 'admin' | 'user';
  email: string;
  name: string;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEY_LENGTH);
  return `scrypt$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, n, r, p, saltB64, hashB64] = parts as [
    string, string, string, string, string, string,
  ];
  const salt = Buffer.from(saltB64!, 'base64');
  const expected = Buffer.from(hashB64!, 'base64');
  const derived = await scrypt(password, salt, expected.length);

  // Constant-time. A byte-by-byte comparison leaks the hash one byte at a time.
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/**
 * A single attempt ceiling.
 *
 * In-process, so it resets when the worker restarts and does not hold across
 * replicas. Enough to blunt online guessing for a single-operator installation,
 * and the comment says so rather than implying more.
 */
export class RateLimiter {
  private readonly attempts = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly maxAttempts = 5,
    private readonly windowMs = 15 * 60 * 1000,
  ) {}

  /** @returns true when the attempt is allowed. */
  allow(key: string): boolean {
    const now = Date.now();
    const entry = this.attempts.get(key);

    if (!entry || entry.resetAt <= now) {
      this.attempts.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.maxAttempts;
  }

  reset(key: string): void {
    this.attempts.delete(key);
  }

  /** Housekeeping, so the map does not grow without bound. */
  sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.attempts) {
      if (entry.resetAt <= now) this.attempts.delete(key);
    }
  }
}

export interface SessionInfo {
  id: string;
  userId: string;
}

/**
 * Store only the digest: a database leak must yield no usable cookie.
 *
 * A digest, not a random prefix. A prefix-plus-token looks like hashing and is
 * worse — it puts the usable token in the column while looking like an opaque
 * identifier, so the leak it was meant to prevent still happens and the schema
 * reassures you that it did not.
 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

export async function createSession(
  db: Db,
  userId: string,
): Promise<{ token: string; sessionId: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const sessionId = hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await db.insert(schema.sessions).values({ id: sessionId, userId, expiresAt });
  return { token, sessionId, expiresAt };
}

export async function resolveSession(db: Db, token: string): Promise<AuthResult> {
  if (!token) return { ok: false, reason: 'no_session' };

  const sessionId = hashToken(token);
  const [row] = await db
    .select({
      sessionId: schema.sessions.id,
      expiresAt: schema.sessions.expiresAt,
      userId: schema.users.id,
      role: schema.users.role,
      email: schema.users.email,
      name: schema.users.name,
    })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.sessions.userId, schema.users.id))
    .where(eq(schema.sessions.id, sessionId))
    .limit(1);

  if (!row) return { ok: false, reason: 'no_session' };
  if (row.expiresAt.getTime() <= Date.now()) {
    await db.delete(schema.sessions).where(eq(schema.sessions.id, sessionId));
    return { ok: false, reason: 'expired' };
  }

  return {
    ok: true,
    userId: row.userId,
    role: row.role,
    email: row.email,
    name: row.name,
  };
}

export async function destroySession(db: Db, token: string): Promise<void> {
  await db.delete(schema.sessions).where(eq(schema.sessions.id, hashToken(token)));
}

export async function authenticate(
  db: Db,
  email: string,
  password: string,
  limiter: RateLimiter,
): Promise<AuthResult> {
  const key = email.trim().toLowerCase();
  if (!limiter.allow(key)) return { ok: false, reason: 'rate_limited' };

  const [user] = await db
    .select({
      id: schema.users.id,
      role: schema.users.role,
      email: schema.users.email,
      name: schema.users.name,
      passwordHash: schema.users.passwordHash,
    })
    .from(schema.users)
    .where(eq(schema.users.email, key))
    .limit(1);

  // Always run scrypt, even with no matching account. Skipping it when the user
  // is absent makes the response time enumerate accounts, and account
  // enumeration on a login form is a free reconnaissance tool.
  const matches = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);

  if (!user || !matches) return { ok: false, reason: 'bad_credentials' };

  limiter.reset(key);
  return { ok: true, userId: user.id, role: user.role, email: user.email, name: user.name };
}

export type AuthResult = AuthSuccess | AuthFailure;

/**
 * A hash of a value nobody has. Comparing against it costs the same scrypt work
 * as comparing against a real one, which is the point.
 */
const DUMMY_HASH = `scrypt$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(KEY_LENGTH).toString('base64')}`;

// --- CSRF ---------------------------------------------------------------

export interface CsrfResult {
  ok: boolean;
  reason?: string;
}

/**
 * Origin-checked CSRF protection.
 *
 * Every state-changing request must carry an `Origin` equal to the expected one.
 * A browser sets `Origin` on cross-origin requests and cannot be talked out of it
 * by an attacker's page, so a cross-site form post is refused before it reaches
 * any handler. `Sec-Fetch-Site` is checked too where the browser sends it, since
 * it is unforgeable by design and available in every current browser.
 *
 * Same-origin GETs are exempt: they must not change state anyway, and that is
 * enforced separately by routing.
 */
export function checkCsrf(params: {
  method: string;
  origin: string | null;
  secFetchSite: string | null;
  expectedOrigin: string;
}): CsrfResult {
  const safe = new Set(['GET', 'HEAD', 'OPTIONS']);
  if (safe.has(params.method.toUpperCase())) return { ok: true };

  if (params.secFetchSite === 'same-origin') return { ok: true };

  // `Sec-Fetch-Site` is unforgeable by design. A cross-site value with a
  // matching Origin is a combination a browser does not produce, so something is
  // constructing requests deliberately — and the Origin check alone is then not
  // something to reason about.
  if (params.secFetchSite === 'cross-site' || params.secFetchSite === 'same-site') {
    return { ok: false, reason: `Sec-Fetch-Site is ${params.secFetchSite}` };
  }

  if (params.origin === null) {
    // A state-changing request with no Origin at all is not a browser fetch from
    // our own page. Refused rather than assumed benign.
    return { ok: false, reason: 'state-changing request without an Origin header' };
  }
  if (params.origin !== params.expectedOrigin) {
    return { ok: false, reason: `origin ${params.origin} is not ${params.expectedOrigin}` };
  }
  return { ok: true };
}

// --- authorization ------------------------------------------------------

/**
 * Two roles, and every critical action checked here on the server.
 *
 * A browser is not an authorisation boundary. This function is called from route
 * handlers and never from a component: a check that only runs in the UI is a
 * suggestion.
 */
export function authorize(
  session: AuthResult,
  action: string,
): { ok: boolean; reason?: string } {
  if (!session.ok) return { ok: false, reason: `not authenticated for ${action}` };

  const adminOnly: ReadonlySet<string> = new Set([
    'agent.create',
    'agent.update',
    'agent.delete',
    'agent.enable',
    'permission.update',
    'approval.decide',
    'user.create',
    'task.cancel.others',
  ]);

  if (adminOnly.has(action) && session.role !== 'admin') {
    return { ok: false, reason: `${action} requires the admin role` };
  }
  return { ok: true };
}

/** Cookies for the session. `HttpOnly` keeps it out of script; `Strict` stops CSRF outright. */
export const SESSION_COOKIE = '__Host-teahub_session';
export const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'strict',
  secure: true,
  path: '/',
} as const;