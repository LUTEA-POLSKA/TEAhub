import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { PgAuditSink } from '../db/audit-sink';
import { PgTaskStore } from '../db/task-store';
import { SESSION_COOKIE, createSession, hashPassword } from '../auth/auth';
import type { Config } from './config';
import { loadConfig, assertUsable, ConfigError } from './config';
import type { GuardDeps } from './guard';
import { rateWindow } from './routes/state';
import { loginRoute, serializeSessionCookie } from './routes/auth';
import { cancelTaskRoute, createTaskRoute, listTasksRoute } from './routes/tasks';
import { decideApprovalRoute, listApprovalsRoute } from './routes/approvals';

const ORIGIN = 'https://teahub.example';

type Db = ReturnType<typeof drizzle<typeof schema>>;

function config(): Config {
  return {
    port: 3000,
    publicOrigin: ORIGIN,
    databaseUrl: 'postgres://x',
    workspaceRoots: [],
    allowedFetchHosts: [],
    providers: [],
    policyPath: 'policy.json',
    sessionTtlMs: 1000 * 60 * 60 * 12,
  };
}

describe('config', () => {
  it('refuses to start without a public origin', () => {
    expect(() => loadConfig({ DATABASE_URL: 'postgres://x' })).toThrow(ConfigError);
  });

  it('refuses to start without a database url', () => {
    expect(() => loadConfig({ TEAHUB_PUBLIC_ORIGIN: ORIGIN })).toThrow(/DATABASE_URL is not set/);
  });

  it('never defaults a secret to an empty string', () => {
    // An empty provider key would later become an unauthenticated request. Every
    // other layer is fail-closed; this is the one place that must not default.
    const cfg = loadConfig({
      TEAHUB_PUBLIC_ORIGIN: ORIGIN,
      DATABASE_URL: 'postgres://x',
      TEAHUB_PROVIDERS: 'openrouter',
      OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
    });
    expect(cfg.providers[0]!.apiKey).toBeUndefined();
  });

  it('refuses a provider listed without a base url', () => {
    expect(() =>
      loadConfig({
        TEAHUB_PUBLIC_ORIGIN: ORIGIN,
        DATABASE_URL: 'postgres://x',
        TEAHUB_PROVIDERS: 'openrouter',
      }),
    ).toThrow(/OPENROUTER_BASE_URL is not set/);
  });

  it('refuses a provider whose scheme is not http', () => {
    expect(() =>
      loadConfig({
        TEAHUB_PUBLIC_ORIGIN: ORIGIN,
        DATABASE_URL: 'postgres://x',
        TEAHUB_PROVIDERS: 'bad',
        BAD_BASE_URL: 'ftp://example.com/v1',
      }),
    ).toThrow(/not http or https/);
  });

  it('leaves the price undefined rather than defaulting it to zero', () => {
    const cfg = loadConfig({
      TEAHUB_PUBLIC_ORIGIN: ORIGIN,
      DATABASE_URL: 'postgres://x',
      TEAHUB_PROVIDERS: 'p',
      P_BASE_URL: 'https://p.test/v1',
    });
    expect(cfg.providers[0]!.price).toBeUndefined();
  });

  it('refuses to claim an https deployment on plain http', () => {
    // Secure cookies are the point of the __Host- prefix. Over plain http the
    // browser drops them and the app looks authenticated while holding nothing.
    const overHttp = { ...config(), publicOrigin: 'http://teahub.example' };
    expect(() => assertUsable(overHttp)).toThrow(/Secure-only/);
  });

  it('allows plain http on loopback, for development', () => {
    // Localhost is the one case where the browser will hold a Secure cookie over
    // http, because it is treated as a secure context.
    expect(() => assertUsable({ ...config(), publicOrigin: 'http://localhost:3000' })).not.toThrow();
    expect(() => assertUsable({ ...config(), publicOrigin: 'http://127.0.0.1:3000' })).not.toThrow();
  });

  it('does not treat a lookalike host as loopback', () => {
    // `evil-localhost.test` contains the substring but is not loopback.
    expect(() => assertUsable({ ...config(), publicOrigin: 'http://evil-localhost.test' })).toThrow();
  });
});

describe('HTTP guard', () => {
  let harness!: Awaited<ReturnType<typeof bootstrap>>;
  let db: Db;
  let deps: GuardDeps;
  let adminToken: string;
  let userToken: string;

  beforeEach(async () => {
    harness = await bootstrap();
    db = harness.db as Db;
    deps = { db, audit: new PgAuditSink(db), config: config() };

    const [admin] = await db
      .insert(schema.users)
      .values({
        email: 'admin@example.org',
        name: 'Admin',
        role: 'admin',
        passwordHash: await hashPassword('admin-password'),
      })
      .returning();
    const [plain] = await db
      .insert(schema.users)
      .values({
        email: 'user@example.org',
        name: 'User',
        role: 'user',
        passwordHash: await hashPassword('user-password'),
      })
      .returning();

    adminToken = (await createSession(db, admin!.id)).token;
    userToken = (await createSession(db, plain!.id)).token;

    const [agent] = await db
      .insert(schema.agents)
      .values({
        name: 'reader',
        systemPromptVersion: 'v1',
        systemPrompt: 'x',
        enabled: true,
      })
      .returning();
    await db
      .insert(schema.agentPermissions)
      .values({ agentId: agent!.id, tools: ['filesystem.read'] });
  });

  afterEach(async () => {
    await harness.client.close();
  });

  /** A same-origin request with a valid session cookie. */
  function authed(token: string, method = 'POST', path = '/api/tasks'): Request {
    return new Request(`https://teahub.example${path}`, {
      method,
      headers: {
        origin: ORIGIN,
        'sec-fetch-site': 'same-origin',
        cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
        'content-type': 'application/json',
      },
      body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify({}),
    });
  }

  /** The same request, forged from another site, still holding a real cookie. */
  function forged(token: string, path = '/api/tasks'): Request {
    return new Request(`https://teahub.example${path}`, {
      method: 'POST',
      headers: {
        origin: 'https://evil.test',
        'sec-fetch-site': 'cross-site',
        cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
  }

  it('refuses a forged cross-origin request even with a valid session', async () => {
    const route = createTaskRoute(deps, () => 'sha256:v1');
    const res = await route(forged(adminToken));

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('csrf_rejected');

    // And nothing was created.
    const tasks = await db.select().from(schema.tasks);
    expect(tasks).toHaveLength(0);
  });

  it('checks CSRF before it looks at the session', async () => {
    // A forged request with no cookie at all must still answer 403, not 401. If
    // it answered 401 the handler would have been reached with a session check
    // done first, which is the ordering this guard exists to prevent.
    const route = createTaskRoute(deps, () => 'sha256:v1');
    const req = new Request('https://teahub.example/api/tasks', {
      method: 'POST',
      headers: { origin: 'https://evil.test', 'sec-fetch-site': 'cross-site' },
      body: '{}',
    });
    expect((await route(req)).status).toBe(403);
  });

  it('refuses without a session', async () => {
    const route = createTaskRoute(deps, () => 'sha256:v1');
    const req = new Request('https://teahub.example/api/tasks', {
      method: 'POST',
      headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin' },
      body: '{}',
    });
    expect((await route(req)).status).toBe(401);
  });

  it('gives one answer for a missing and a stale session', async () => {
    const route = listTasksRoute(deps);
    const missing = await route(authed('', 'GET', '/api/tasks'));
    const bogus = await route(authed('not-a-real-token', 'GET', '/api/tasks'));
    // Distinguishing them would tell an attacker which guess was once right.
    expect(missing.status).toBe(401);
    expect(bogus.status).toBe(401);
    expect(await missing.json()).toEqual(await bogus.json());
  });

  it('never returns a cookie value or an internal message in an error', async () => {
    const route = loginRoute(deps);
    const req = new Request('https://teahub.example/api/auth/login', {
      method: 'POST',
      headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ email: 'nobody@example.org', password: 'guess' }),
    });
    const res = await route(req);
    const text = await res.text();
    expect(res.status).toBe(401);
    expect(text).not.toContain('scrypt');
    expect(text).not.toContain(adminToken);
  });
});

describe('login', () => {
  let harness!: Awaited<ReturnType<typeof bootstrap>>;
  let db: Db;
  let deps: GuardDeps;

  beforeEach(async () => {
    harness = await bootstrap();
    db = harness.db as Db;
    deps = { db, audit: new PgAuditSink(db), config: config() };
    await db.insert(schema.users).values({
      email: 'owner@example.org',
      name: 'Owner',
      role: 'admin',
      passwordHash: await hashPassword('the-password'),
    });
  });
  afterEach(async () => {
    await harness.client.close();
  });

  const post = (body: unknown) =>
    new Request('https://teahub.example/api/auth/login', {
      method: 'POST',
      headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('issues a session and a hardened cookie', async () => {
    const res = await loginRoute(deps)(post({ email: 'owner@example.org', password: 'the-password' }));
    expect(res.status).toBe(200);

    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('__Host-teahub_session=');
  });

  it('gives the same answer for a wrong password and an unknown account', async () => {
    const route = loginRoute(deps);
    const wrong = await route(post({ email: 'owner@example.org', password: 'nope' }));
    const unknown = await route(post({ email: 'ghost@example.org', password: 'nope' }));
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await wrong.text()).toBe(await unknown.text());
  });

  it('rate limits after repeated failures', async () => {
    const route = loginRoute(deps);
    for (let i = 0; i < 5; i += 1) {
      await route(post({ email: 'owner@example.org', password: 'wrong' }));
    }
    const res = await route(post({ email: 'owner@example.org', password: 'the-password' }));
    // Even the *correct* password is refused, which is the point of a lockout.
    expect(res.status).toBe(429);
  });

  it('refuses a forged login attempt', async () => {
    const req = new Request('https://teahub.example/api/auth/login', {
      method: 'POST',
      headers: { origin: 'https://evil.test', 'sec-fetch-site': 'cross-site' },
      body: JSON.stringify({ email: 'owner@example.org', password: 'the-password' }),
    });
    expect((await loginRoute(deps)(req)).status).toBe(403);
  });

  it('serialises the cookie with an expiry', () => {
    const cookie = serializeSessionCookie('abc', new Date(Date.now() + 60_000));
    expect(cookie).toMatch(/Expires=\w{3}, \d{2} \w{3} \d{4}/);
  });
});

describe('tasks over HTTP', () => {
  let harness!: Awaited<ReturnType<typeof bootstrap>>;
  let db: Db;
  let deps: GuardDeps;
  let adminToken: string;
  let userToken: string;
  let otherToken: string;

  beforeEach(async () => {
    harness = await bootstrap();
    db = harness.db as Db;
    deps = { db, audit: new PgAuditSink(db), config: config() };

    const mk = async (email: string, role: 'admin' | 'user') => {
      const [u] = await db
        .insert(schema.users)
        .values({ email, name: email, role, passwordHash: await hashPassword('pw') })
        .returning();
      return (await createSession(db, u!.id)).token;
    };
    adminToken = await mk('admin@e.org', 'admin');
    userToken = await mk('user@e.org', 'user');
    otherToken = await mk('other@e.org', 'user');

    const [agent] = await db
      .insert(schema.agents)
      .values({ name: 'reader', systemPromptVersion: 'v1', systemPrompt: 'x', enabled: true })
      .returning();
    await db.insert(schema.agentPermissions).values({ agentId: agent!.id, tools: [] });
  });
  afterEach(async () => {
    await harness.client.close();
  });

  const post = (token: string, body: unknown, path = '/api/tasks') =>
    new Request(`https://teahub.example${path}`, {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        'sec-fetch-site': 'same-origin',
        cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

  it('creates a task with the flow hash recorded at creation', async () => {
    const res = await createTaskRoute(deps, () => 'sha256:v1')(
      post(userToken, { title: 'read a file', goal: 'read note.txt' }),
    );
    expect(res.status).toBe(201);

    const body = (await res.json()) as { taskId: string };
    const [row] = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, body.taskId));
    // Fixed at creation, not computed at resume — otherwise a definition change
    // mid-flight lets a task continue under rules nobody approved.
    expect(row!.flowHash).toBe('sha256:v1');
  });

  it('refuses a task with no goal', async () => {
    expect((await createTaskRoute(deps, () => 'h')(post(userToken, { title: 'x' }))).status).toBe(400);
  });

  it('refuses when no agent is enabled', async () => {
    await db.update(schema.agents).set({ enabled: false });
    const res = await createTaskRoute(deps, () => 'h')(
      post(userToken, { title: 'x', goal: 'y' }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe('no_agent');
  });

  it('shows a user only their own tasks', async () => {
    const route = createTaskRoute(deps, () => 'h');
    await route(post(userToken, { title: 'mine', goal: 'y' }));
    await route(post(otherToken, { title: 'theirs', goal: 'y' }));

    const list = listTasksRoute(deps);
    const mine = (await (
      await list(
        new Request('https://teahub.example/api/tasks', {
          headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(userToken)}` },
        }),
      )
    ).json()) as { tasks: Array<{ title: string }> };

    expect(mine.tasks.map((t) => t.title)).toEqual(['mine']);
  });

  it('shows an admin every task', async () => {
    const route = createTaskRoute(deps, () => 'h');
    await route(post(userToken, { title: 'mine', goal: 'y' }));
    await route(post(otherToken, { title: 'theirs', goal: 'y' }));

    const all = (await (
      await listTasksRoute(deps)(
        new Request('https://teahub.example/api/tasks', {
          headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(adminToken)}` },
        }),
      )
    ).json()) as { tasks: Array<{ title: string }> };

    expect(all.tasks).toHaveLength(2);
  });

  it('sets a cancel flag without declaring the task cancelled', async () => {
    const create = await createTaskRoute(deps, () => 'h')(
      post(userToken, { title: 'x', goal: 'y' }),
    );
    const { taskId } = (await create.json()) as { taskId: string };

    await cancelTaskRoute(deps)(post(userToken, {}, `/api/tasks/${taskId}/cancel`), { id: taskId });

    const [row] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId));
    // The flag is set. The status is not touched, because a running agent is
    // still running and declaring it cancelled would be a lie about work in flight.
    expect(row!.cancelRequestedAt).not.toBeNull();
    expect(row!.status).toBe('queued');
  });

  it('will not let a user cancel somebody elses task', async () => {
    const create = await createTaskRoute(deps, () => 'h')(
      post(userToken, { title: 'x', goal: 'y' }),
    );
    const { taskId } = (await create.json()) as { taskId: string };

    const res = await cancelTaskRoute(deps)(
      post(otherToken, {}, `/api/tasks/${taskId}/cancel`),
      { id: taskId },
    );
    expect(res.status).toBe(403);
  });

  it('refuses to cancel a task that already finished', async () => {
    const create = await createTaskRoute(deps, () => 'h')(
      post(userToken, { title: 'x', goal: 'y' }),
    );
    const { taskId } = (await create.json()) as { taskId: string };
    await db.update(schema.tasks).set({ status: 'completed' }).where(eq(schema.tasks.id, taskId));

    const res = await cancelTaskRoute(deps)(post(userToken, {}, '/api/tasks/x/cancel'), {
      id: taskId,
    });
    expect(res.status).toBe(409);
  });
});

describe('approvals over HTTP', () => {
  let harness!: Awaited<ReturnType<typeof bootstrap>>;
  let db: Db;
  let deps: GuardDeps;
  let adminToken: string;
  let userToken: string;

  beforeEach(async () => {
    harness = await bootstrap();
    db = harness.db as Db;
    deps = { db, audit: new PgAuditSink(db), config: config() };

    const mk = async (email: string, role: 'admin' | 'user') => {
      const [u] = await db
        .insert(schema.users)
        .values({ email, name: email, role, passwordHash: await hashPassword('pw') })
        .returning();
      return (await createSession(db, u!.id)).token;
    };
    adminToken = await mk('admin@e.org', 'admin');
    userToken = await mk('user@e.org', 'user');
  });
  afterEach(async () => {
    await harness.client.close();
  });

  async function seedGated() {
    const store = new PgTaskStore(db);
    const [user] = await db.select().from(schema.users).limit(1);
    const [agent] = await db
      .insert(schema.agents)
      .values({ name: 'gated', systemPromptVersion: 'v1', systemPrompt: 'x', enabled: true })
      .returning();
    const taskId = await store.createTask({
      title: 'gated',
      requestedBy: user!.id,
      agentId: agent!.id,
      input: {},
      flowHash: 'sha256:v1',
    });
    const [step] = await db
      .insert(schema.taskSteps)
      .values({ taskId, stepNo: 0, stepIndex: 0, kind: 'gate', state: 'running' })
      .returning();
    const approvalId = await store.recordApproval({
      taskId,
      stepId: step!.id,
      toolName: 'filesystem.write',
      arguments: { path: 'a.txt' },
    });
    await db.update(schema.tasks).set({ status: 'waiting_approval' }).where(eq(schema.tasks.id, taskId));
    return { taskId, approvalId };
  }

  const post = (token: string, path: string, body: unknown) =>
    new Request(`https://teahub.example${path}`, {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        'sec-fetch-site': 'same-origin',
        cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

  it('stops a plain user from deciding an approval', async () => {
    const { taskId, approvalId } = await seedGated();
    const res = await decideApprovalRoute(deps, () => 'sha256:v1')(
      post(userToken, `/api/approvals/${approvalId}`, { decision: 'approved', taskId }),
      { id: approvalId },
    );
    // The most consequential action in the product, admin-only.
    expect(res.status).toBe(403);
  });

  it('lets an admin approve and requeues the task', async () => {
    const { taskId, approvalId } = await seedGated();
    const res = await decideApprovalRoute(deps, () => 'sha256:v1')(
      post(adminToken, `/api/approvals/${approvalId}`, { decision: 'approved', taskId }),
      { id: approvalId },
    );
    expect(res.status).toBe(200);

    const [row] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId));
    expect(row!.status).toBe('queued');
  });

  it('refuses when the flow definition changed, and consumes nothing', async () => {
    const { taskId, approvalId } = await seedGated();
    const res = await decideApprovalRoute(deps, () => 'sha256:v2')(
      post(adminToken, `/api/approvals/${approvalId}`, { decision: 'approved', taskId }),
      { id: approvalId },
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error.detail).toContain('refusing to resume');

    // The approval is still open: a refusal must not have spent it.
    const pending = (await (
      await listApprovalsRoute(deps)(
        new Request('https://teahub.example/api/approvals', {
          headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(adminToken)}` },
        }),
      )
    ).json()) as { approvals: Array<{ id: string }> };
    expect(pending.approvals.map((a) => a.id)).toContain(approvalId);
  });

  it('fails the task when a human denies', async () => {
    const { taskId, approvalId } = await seedGated();
    await decideApprovalRoute(deps, () => 'sha256:v1')(
      post(adminToken, `/api/approvals/${approvalId}`, { decision: 'denied', taskId }),
      { id: approvalId },
    );
    const [row] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId));
    expect(row!.status).toBe('failed');
  });

  it('refuses a decision on a task that is not waiting', async () => {
    const { taskId, approvalId } = await seedGated();
    await db.update(schema.tasks).set({ status: 'running' }).where(eq(schema.tasks.id, taskId));
    const res = await decideApprovalRoute(deps, () => 'sha256:v1')(
      post(adminToken, `/api/approvals/${approvalId}`, { decision: 'approved', taskId }),
      { id: approvalId },
    );
    expect(res.status).toBe(409);
  });

  it('refuses a forged approval decision even with an admin cookie', async () => {
    const { taskId, approvalId } = await seedGated();
    const req = new Request(`https://teahub.example/api/approvals/${approvalId}`, {
      method: 'POST',
      headers: {
        origin: 'https://evil.test',
        'sec-fetch-site': 'cross-site',
        cookie: `${SESSION_COOKIE}=${encodeURIComponent(adminToken)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ decision: 'approved', taskId }),
    });
    expect((await decideApprovalRoute(deps, () => 'sha256:v1')(req, { id: approvalId })).status).toBe(403);
  });

  it('refuses a decision value that is neither approved nor denied', async () => {
    const { taskId, approvalId } = await seedGated();
    const res = await decideApprovalRoute(deps, () => 'sha256:v1')(
      post(adminToken, `/api/approvals/${approvalId}`, { decision: 'maybe', taskId }),
      { id: approvalId },
    );
    expect(res.status).toBe(400);
  });
});

async function bootstrap() {
  const client = new PGlite();
  await client.exec(
    readFileSync(join(process.cwd(), 'drizzle', '0000_vertical_slice.sql'), 'utf8'),
  );
  return { client, db: drizzle(client, { schema }) };
}