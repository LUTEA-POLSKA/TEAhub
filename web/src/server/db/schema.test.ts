import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { createTestDb, schema } from './test-harness';

let harness: Awaited<ReturnType<typeof createTestDb>>;
let db: typeof harness.db;

beforeAll(async () => {
  harness = await createTestDb();
  db = harness.db;
});

afterAll(async () => {
  await harness.close();
});

let userSeq = 0;
async function seedUser() {
  userSeq += 1;
  const [user] = await db
    .insert(schema.users)
    .values({
      email: `owner+${userSeq}@example.org`,
      name: `Owner ${userSeq}`,
      role: 'admin',
    })
    .returning();
  return user!;
}

/**
 * Drizzle wraps a Postgres failure in its own "Failed query: …" message and puts
 * the real error on `cause`. Matching the wrapper text would only prove that
 * *something* failed; reading the server error proves that the *intended*
 * constraint fired, which is the thing worth asserting.
 */
type PgError = {
  code?: string;
  /** node-postgres names this field `constraint`; there is no `constraint_name`. */
  constraint?: string;
  detail?: string;
};

async function expectPgViolation(
  promise: Promise<unknown>,
  constraint: string,
): Promise<PgError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }

  if (caught === undefined) {
    throw new Error(`expected a violation of ${constraint}, but nothing threw`);
  }

  const pg = (caught as { cause?: PgError }).cause as PgError | undefined;
  const code = pg?.code ?? '';
  const name = pg?.constraint ?? '';

  if (code !== '23505') {
    throw new Error(
      `expected unique_violation (23505), got ${code || 'no code'} — ${String(caught).slice(0, 200)}`,
    );
  }
  if (name !== constraint) {
    throw new Error(
      `expected constraint ${constraint}, got ${name || 'no constraint name'}`,
    );
  }
  return pg!;
}

async function seedTask(userId: string, flowHash = 'sha256:aaa') {
  const [task] = await db
    .insert(schema.tasks)
    .values({
      title: 'vertical slice',
      requestedBy: userId,
      flowHash,
      input: { goal: 'read a file' },
    })
    .returning();
  return task!;
}

describe('schema: the step memo', () => {
  it('refuses a second step at the same index', async () => {
    const user = await seedUser();
    const task = await seedTask(user.id);

    await db.insert(schema.taskSteps).values({
      taskId: task.id,
      stepIndex: 0,
      kind: 'model_call',
      state: 'completed',
      result: { text: 'first answer' },
    });

    // The whole durability argument rests on this failing. A worker that crashes
    // after an LLM call re-reads the memo instead of paying for the call twice.
    // This is the countermeasure to LangGraph's interrupt(), which re-executes
    // the entire node and therefore re-runs every side effect inside it.
    const err = await expectPgViolation(
      db.insert(schema.taskSteps).values({
        taskId: task.id,
        stepIndex: 0,
        kind: 'model_call',
        state: 'completed',
        result: { text: 'second, expensive answer' },
      }),
      'task_steps_task_index_idx',
    );
    // Postgres reports the offending key values, not the index name, in detail.
    // That it is (task_id, step_index) — and not something else — is the point.
    expect(err.detail).toContain('task_id');
    expect(err.detail).toContain('step_index');
    expect(err.detail).toContain(task.id);
  });

  it('allows the same index on a different task', async () => {
    const user = await seedUser();
    const a = await seedTask(user.id, 'sha256:a');
    const b = await seedTask(user.id, 'sha256:b');

    await db.insert(schema.taskSteps).values({
      taskId: a.id,
      stepIndex: 0,
      kind: 'model_call',
      state: 'completed',
    });

    const inserted = await db
      .insert(schema.taskSteps)
      .values({ taskId: b.id, stepIndex: 0, kind: 'model_call', state: 'completed' })
      .returning();

    expect(inserted).toHaveLength(1);
  });

  it('reads the memo back by task and index', async () => {
    const user = await seedUser();
    const task = await seedTask(user.id);

    await db.insert(schema.taskSteps).values({
      taskId: task.id,
      stepIndex: 0,
      kind: 'model_call',
      state: 'completed',
      result: { text: 'cached' },
      finishedAt: new Date(),
    });

    const found = await db
      .select()
      .from(schema.taskSteps)
      .where(
        and(
          eq(schema.taskSteps.taskId, task.id),
          eq(schema.taskSteps.stepIndex, 0),
        ),
      );

    expect(found).toHaveLength(1);
    expect(found[0]!.result).toEqual({ text: 'cached' });
  });
});

describe('schema: gates are their own query', () => {
  it('finds only undecided approvals', async () => {
    const user = await seedUser();
    const task = await seedTask(user.id);

    const [waitingStep] = await db
      .insert(schema.taskSteps)
      .values({ taskId: task.id, stepIndex: 0, kind: 'gate', state: 'running' })
      .returning();
    const [doneStep] = await db
      .insert(schema.taskSteps)
      .values({ taskId: task.id, stepIndex: 1, kind: 'gate', state: 'completed' })
      .returning();

    await db.insert(schema.approvals).values([
      {
        taskId: task.id,
        stepId: waitingStep!.id,
        toolName: 'filesystem.write',
        arguments: { path: 'notes.md' },
      },
      {
        taskId: task.id,
        stepId: doneStep!.id,
        toolName: 'filesystem.write',
        arguments: { path: 'final.md' },
        decision: 'approved',
        decidedBy: user.id,
        decidedAt: new Date(),
      },
    ]);

    const pending = await db
      .select()
      .from(schema.approvals)
      .where(isNull(schema.approvals.decision));

    expect(pending).toHaveLength(1);
    expect(pending[0]!.toolName).toBe('filesystem.write');
    expect(pending[0]!.arguments).toEqual({ path: 'notes.md' });
  });
});

describe('schema: trust and roles', () => {
  it('defaults a new agent to third_party and disabled', async () => {
    const [agent] = await db
      .insert(schema.agents)
      .values({
        name: 'reader',
        systemPromptVersion: 'v1',
        systemPrompt: 'You read files.',
      })
      .returning();

    // third_party, not untrusted: an agent that declares nothing is third-party
    // code until the operator says otherwise. The policy's default_tier is what
    // decides, not the schema default.
    expect(agent!.tier).toBe('third_party');
    expect(agent!.enabled).toBe(false);
    expect(agent!.trustScore).toBe(0);
  });

  it('requires a prompt version, because old steps recorded under v1 cannot be resumed against v2', async () => {
    let code: string | undefined;
    try {
      await db
        .insert(schema.agents)
        .values({ name: 'no-version', systemPrompt: 'x' } as never);
    } catch (error) {
      code = (error as { cause?: { code?: string } }).cause?.code;
    }
    // not_null_violation, not a default we could quietly fill in.
    expect(code).toBe('23502');
  });

  it('treats email uniqueness case-insensitively', async () => {
    await db.insert(schema.users).values({ email: 'Mixed@Example.org', name: 'M' });

    await expectPgViolation(
      db.insert(schema.users).values({ email: 'mixed@example.ORG', name: 'M2' }),
      'users_email_idx',
    );
  });
});

describe('schema: audit is append-only by shape', () => {
  it('records an event with no updated_at to mutate', async () => {
    const user = await seedUser();
    const [event] = await db
      .insert(schema.auditEvents)
      .values({
        actorType: 'user',
        actorId: user.id,
        action: 'tool.call',
        target: 'filesystem.read',
        outcome: 'allowed',
        detail: { provided_by: 'openrouter', costUsd: 0.0002, ttftMs: 310 },
      })
      .returning();

    expect(event!.at).toBeInstanceOf(Date);
    expect(Object.keys(event!).sort()).toEqual([
      'action',
      'actorId',
      'actorType',
      'agentId',
      'at',
      'detail',
      'id',
      'outcome',
      'stepIndex',
      'target',
      'taskId',
    ]);
    // No updated_at exists, so there is no column through which a rewrite could
    // happen. The delete path is prevented by grants, not by schema.
    expect('updatedAt' in event!).toBe(false);
  });
});