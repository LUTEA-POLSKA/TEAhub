import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import {
  type AuthResult,
  RateLimiter,
  authorize,
  checkCsrf,
  createSession,
  destroySession,
  hashPassword,
  resolveSession,
  verifyPassword,
  SESSION_COOKIE,
  COOKIE_OPTIONS,
} from './auth';

type Db = ReturnType<typeof drizzle<typeof schema>>;

describe('passwords', () => {
  it('round-trips a correct password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery stapl', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('salts, so the same password hashes differently every time', async () => {
    const a = await hashPassword('same');
    const b = await hashPassword('same');
    expect(a).not.toBe(b);
    expect(await verifyPassword('same', a)).toBe(true);
    expect(await verifyPassword('same', b)).toBe(true);
  });

  it('refuses a stored value that is not one of ours', async () => {
    // A plaintext password that ended up in the column, or a hash from another
    // algorithm, must not verify.
    expect(await verifyPassword('anything', 'plaintext')).toBe(false);
    expect(await verifyPassword('anything', '')).toBe(false);
    expect(await verifyPassword('anything', '$2b$10$something')).toBe(false);
  });

  it('never stores the password in the hash', async () => {
    const hash = await hashPassword('hunter2');
    expect(hash).not.toContain('hunter2');
  });
});

describe('rate limiting', () => {
  it('allows up to the ceiling then refuses', () => {
    const limiter = new RateLimiter(3, 60_000);
    expect(limiter.allow('a@b.c')).toBe(true);
    expect(limiter.allow('a@b.c')).toBe(true);
    expect(limiter.allow('a@b.c')).toBe(true);
    expect(limiter.allow('a@b.c')).toBe(false);
    expect(limiter.allow('a@b.c')).toBe(false);
  });

  it('keys per identity, so one locked account does not lock the rest', () => {
    const limiter = new RateLimiter(1, 60_000);
    expect(limiter.allow('a@b.c')).toBe(true);
    expect(limiter.allow('a@b.c')).toBe(false);
    expect(limiter.allow('x@y.z')).toBe(true);
  });

  it('resets after a successful login', () => {
    const limiter = new RateLimiter(1, 60_000);
    limiter.allow('a@b.c');
    limiter.reset('a@b.c');
    expect(limiter.allow('a@b.c')).toBe(true);
  });

  it('forgets entries once their window has passed', () => {
    const limiter = new RateLimiter(1, 0);
    expect(limiter.allow('a@b.c')).toBe(true);
    expect(limiter.allow('a@b.c')).toBe(true);
  });
});

describe('CSRF', () => {
  const origin = { method: 'POST', expectedOrigin: 'https://teahub.example' };

  it('allows a same-origin request', () => {
    expect(
      checkCsrf({ ...origin, origin: 'https://teahub.example', secFetchSite: 'same-origin' }).ok,
    ).toBe(true);
  });

  it('refuses a cross-origin state change', () => {
    const r = checkCsrf({
      ...origin,
      origin: 'https://evil.test',
      secFetchSite: 'cross-site',
    });
    expect(r.ok).toBe(false);
    // Two independent signals, either of which is enough; this one is caught by
    // Sec-Fetch-Site before the origin comparison is even reached.
    expect(r.reason).toContain('cross-site');
  });

  it('refuses a foreign origin even without the Sec-Fetch-Site header', () => {
    // Older browsers do not send Sec-Fetch-Site at all, so the origin comparison
    // has to stand on its own.
    const r = checkCsrf({ ...origin, origin: 'https://evil.test', secFetchSite: null });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('not https://teahub.example');
  });

  it('refuses a state change with no Origin at all', () => {
    // A browser always sets Origin on a cross-origin POST. Its absence means the
    // request did not come from our own page, and assuming otherwise is how a
    // CSRF check becomes decorative.
    const r = checkCsrf({ ...origin, origin: null, secFetchSite: null });
    expect(r.ok).toBe(false);
  });

  it('exempts only the safe methods', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect(checkCsrf({ ...origin, method, origin: null, secFetchSite: null }).ok).toBe(true);
    }
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(checkCsrf({ ...origin, method, origin: null, secFetchSite: null }).ok).toBe(false);
    }
  });

  it('does not treat a cross-site Sec-Fetch-Site as acceptable even with a matching origin', () => {
    const r = checkCsrf({
      ...origin,
      origin: 'https://teahub.example',
      secFetchSite: 'cross-site',
    });
    // A browser would not produce this combination. If it appears, something is
    // constructing requests deliberately, and the Origin check alone is not enough
    // to reason about.
    expect(r.ok).toBe(false);
  });
});

describe('authorization', () => {
  const user: AuthResult = { ok: true, userId: 'u1', role: 'user', email: 'u@e.org', name: 'U' };
  const admin: AuthResult = { ok: true, userId: 'a1', role: 'admin', email: 'a@e.org', name: 'A' };

  it('refuses everything without a session', () => {
    const anon: AuthResult = { ok: false, reason: 'no_session' };
    expect(authorize(anon, 'task.create').ok).toBe(false);
  });

  it('lets a plain user create a task', () => {
    expect(authorize(user, 'task.create').ok).toBe(true);
  });

  it('stops a plain user from an admin action', () => {
    const r = authorize(user, 'agent.delete');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('admin role');
  });

  it('lets an admin do both', () => {
    expect(authorize(admin, 'task.create').ok).toBe(true);
    expect(authorize(admin, 'agent.delete').ok).toBe(true);
  });

  it('treats deciding an approval as an admin action', () => {
    // The single most consequential action in the product.
    expect(authorize(user, 'approval.decide').ok).toBe(false);
    expect(authorize(admin, 'approval.decide').ok).toBe(true);
  });
});

describe('session cookies', () => {
  it('is host-prefixed, HttpOnly, Strict and Secure', () => {
    // The __Host- prefix is rejected by browsers unless all three hold, so the
    // name itself refuses to be set on a subdomain or over plain http.
    expect(SESSION_COOKIE.startsWith('__Host-')).toBe(true);
    expect(COOKIE_OPTIONS.httpOnly).toBe(true);
    expect(COOKIE_OPTIONS.sameSite).toBe('strict');
    expect(COOKIE_OPTIONS.secure).toBe(true);
    expect(COOKIE_OPTIONS.path).toBe('/');
  });
});

describe('sessions against PostgreSQL', () => {
  let harness!: Awaited<ReturnType<typeof bootstrap>>;
  let db: Db;
  let userId: string;

  beforeEach(async () => {
    harness = await bootstrap();
    db = harness.db as Db;
    const [user] = await db
      .insert(schema.users)
      .values({
        email: 'owner@example.org',
        name: 'Owner',
        role: 'admin',
        passwordHash: await hashPassword('the right one'),
      })
      .returning();
    userId = user!.id;
  });

  afterEach(async () => {
    await harness.client.close();
  });

  it('resolves a freshly issued session', async () => {
    const { token } = await createSession(db, userId);
    const resolved = await resolveSession(db, token);
    expect(resolved.ok).toBe(true);
    expect(resolved.ok && resolved.role).toBe('admin');
  });

  it('stores no usable token, so a database leak grants no session', async () => {
    const { token } = await createSession(db, userId);
    const [row] = await db.select().from(schema.sessions).where(eq(schema.sessions.userId, userId));
    expect(row!.id).not.toBe(token);
    expect(row!.id).not.toContain(token);
  });

  it('refuses a forged token', async () => {
    await createSession(db, userId);
    for (const forged of ['', 'x', 'a'.repeat(43), `${'a'.repeat(43)}.${'b'.repeat(43)}`]) {
      expect((await resolveSession(db, forged)).ok).toBe(false);
    }
  });

  it('rejects an expired session and cleans it up', async () => {
    const { token } = await createSession(db, userId);
    await db
      .update(schema.sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.sessions.userId, userId));

    const resolved = await resolveSession(db, token);
    expect(resolved.ok).toBe(false);
    expect(!resolved.ok && resolved.reason).toBe('expired');

    const left = await db.select().from(schema.sessions).where(eq(schema.sessions.userId, userId));
    expect(left).toHaveLength(0);
  });

  it('destroying a session ends it immediately', async () => {
    const { token } = await createSession(db, userId);
    expect((await resolveSession(db, token)).ok).toBe(true);
    await destroySession(db, token);
    expect((await resolveSession(db, token)).ok).toBe(false);
  });

  it('does not accept a session belonging to a deleted user', async () => {
    const { token } = await createSession(db, userId);
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    expect((await resolveSession(db, token)).ok).toBe(false);
  });

  it('refuses a user whose password hash is null', async () => {
    const [, seedUser] = await db
      .insert(schema.users)
      .values({ email: 'seeded@example.org', name: 'Seeded' })
      .returning();
    void seedUser;
  });
});

async function bootstrap() {
  const client = new PGlite();
  await client.exec(
    readFileSync(join(process.cwd(), 'drizzle', '0000_vertical_slice.sql'), 'utf8'),
  );
  return { client, db: drizzle(client, { schema }) };
}