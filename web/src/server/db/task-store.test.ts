import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import * as schema from './schema';
import { PgTaskStore } from './task-store';
import { PgAuditSink, redactSecrets } from './audit-sink';
import { firstIncompleteStep } from '../agent/types';

describe('PgTaskStore against a real PostgreSQL', () => {
  let harness!: Awaited<ReturnType<typeof bootstrap>>;

  // A fresh database per test. The store holds shared state â€” queued tasks,
  // recorded steps â€” so a suite-wide instance would let one test's task be
  // claimed by the next test's assertion.
  beforeEach(async () => {
    harness = await bootstrap();
  });

  afterEach(async () => {
    await harness.client.close();
  });

  let seq = 0;
  async function seedAgent(userId: string) {
    seq += 1;
    const [agent] = await harness.db
      .insert(schema.agents)
      .values({
        name: `agent-${seq}`,
        systemPromptVersion: 'v1',
        systemPrompt: 'x',
        tier: 'third_party',
      })
      .returning();
    const [perm] = await harness.db
      .insert(schema.agentPermissions)
      .values({ agentId: agent!.id, tools: ['filesystem.read'] })
      .returning();
    void perm;
    void userId;
    return agent!;
  }

  async function seedUser() {
    seq += 1;
    const [user] = await harness.db
      .insert(schema.users)
      .values({ email: `u${seq}@example.org`, name: `U${seq}` })
      .returning();
    return user!;
  }

  describe('claiming', () => {
    it('takes the oldest queued task and marks it running', async () => {
      const user = await seedUser();
      const agent = await seedAgent(user.id);
      const store = new PgTaskStore(harness.db);

      await store.createTask({
        title: 'first',
        requestedBy: user.id,
        agentId: agent.id,
        input: {},
        flowHash: 'sha256:a',
      });

      const claimed = await store.claimNextQueued();
      expect(claimed?.id).toBeDefined();

      const [row] = await harness.db
        .select({ status: schema.tasks.status })
        .from(schema.tasks)
        .where(eq(schema.tasks.id, claimed!.id));
      expect(row!.status).toBe('running');
    });

    it('returns null when nothing is queued', async () => {
      const store = new PgTaskStore(harness.db);
      const user = await seedUser();
      const agent = await seedAgent(user.id);
      await store.createTask({
        title: 'x',
        requestedBy: user.id,
        agentId: agent.id,
        input: {},
        flowHash: 'h',
      });
      await store.claimNextQueued();

      // The one task is running now.
      expect(await store.claimNextQueued()).toBeNull();
    });

    it('never hands the same task to a second claim', async () => {
      const user = await seedUser();
      const agent = await seedAgent(user.id);
      const store = new PgTaskStore(harness.db);
      for (let i = 0; i < 3; i += 1) {
        await store.createTask({
          title: `t${i}`,
          requestedBy: user.id,
          agentId: agent.id,
          input: {},
          flowHash: 'h',
        });
      }

      const first = await store.claimNextQueued();
      const second = await store.claimNextQueued();
      expect(first!.id).not.toBe(second!.id);
    });

    it('skips a task with no agent rather than failing on it', async () => {
      const store = new PgTaskStore(harness.db);
      const user = await seedUser();
      await store.createTask({
        title: 'no agent',
        requestedBy: user.id,
        agentId: null,
        input: {},
        flowHash: 'h',
      });
      expect(await store.claimNextQueued()).toBeNull();
    });
  });

  describe('steps', () => {
    it('reads back a step for the right task only', async () => {
      const store = new PgTaskStore(harness.db);
      const user = await seedUser();
      const agent = await seedAgent(user.id);
      const a = await store.createTask({
        title: 'a',
        requestedBy: user.id,
        agentId: agent.id,
        input: {},
        flowHash: 'h',
      });
      const b = await store.createTask({
        title: 'b',
        requestedBy: user.id,
        agentId: agent.id,
        input: {},
        flowHash: 'h',
      });

await store.write(a, { stepNo: 0, stepIndex: 0, kind: 'model_call', state: 'completed', result: { a: 1 } });
      await store.write(b, { stepNo: 0, stepIndex: 0, kind: 'model_call', state: 'completed', result: { b: 1 } });

      // The step index 0 exists for both tasks; reading task b must not return
      // task a's row. This is the bug a stepIndex-only query would hide.
      expect((await store.read(a, 0))!.result).toEqual({ a: 1 });
      expect((await store.read(b, 0))!.result).toEqual({ b: 1 });
    });

    it('refuses a duplicate step index rather than overwriting it', async () => {
      const store = new PgTaskStore(harness.db);
      const user = await seedUser();
      const agent = await seedAgent(user.id);
      const task = await store.createTask({
        title: 't',
        requestedBy: user.id,
        agentId: agent.id,
        input: {},
        flowHash: 'h',
      });

await store.write(task, {
        stepNo: 0,
        stepIndex: 0,
        kind: 'model_call',
        state: 'completed',
        result: {},
      });
      await expect(
        store.write(task, {
          stepNo: 0,
          stepIndex: 0,
          kind: 'model_call',
          state: 'completed',
          result: {},
        }),
      ).rejects.toThrow();
    });

    it('nextIndex allocates a fresh slot after the highest recorded one', async () => {
      const store = new PgTaskStore(harness.db);
      const user = await seedUser();
      const agent = await seedAgent(user.id);
      const task = await store.createTask({
        title: 't',
        requestedBy: user.id,
        agentId: agent.id,
        input: {},
        flowHash: 'h',
      });

      expect(await store.nextIndex(task)).toBe(0);
      await store.write(task, {
        stepNo: 0,
        stepIndex: 0,
        kind: 'model_call',
        state: 'completed',
        result: { toolCallCount: 2 },
      });
      expect(await store.nextIndex(task)).toBe(1);
      await store.write(task, { stepNo: 0, stepIndex: 1, kind: 'tool_call', state: 'completed', result: {} });
      await store.write(task, { stepNo: 0, stepIndex: 2, kind: 'tool_call', state: 'completed', result: {} });
      expect(await store.nextIndex(task)).toBe(3);
    });

    it('resumes at the first step that is not fully recorded', async () => {
      const store = new PgTaskStore(harness.db);
      const user = await seedUser();
      const agent = await seedAgent(user.id);
      const task = await store.createTask({
        title: 't',
        requestedBy: user.id,
        agentId: agent.id,
        input: {},
        flowHash: 'h',
      });

      // Step 0 announced one tool call; the tool never recorded. Incomplete.
      await store.write(task, {
        stepNo: 0,
        stepIndex: 0,
        kind: 'model_call',
        state: 'completed',
        result: { toolCallCount: 1 },
      });
      expect(firstIncompleteStep(await store.readAll(task))).toBe(0);

      await store.write(task, { stepNo: 0, stepIndex: 1, kind: 'tool_call', state: 'completed', result: {} });
      expect(firstIncompleteStep(await store.readAll(task))).toBe(1);
    });

    it('treats a failed tool step as unfinished', async () => {
      const store = new PgTaskStore(harness.db);
      const user = await seedUser();
      const agent = await seedAgent(user.id);
      const task = await store.createTask({
        title: 't',
        requestedBy: user.id,
        agentId: agent.id,
        input: {},
        flowHash: 'h',
      });

      await store.write(task, {
        stepNo: 0,
        stepIndex: 0,
        kind: 'model_call',
        state: 'completed',
        result: { toolCallCount: 1 },
      });
      await store.write(task, {
        stepNo: 0,
        stepIndex: 1,
        kind: 'tool_call',
        state: 'failed',
        error: 'boom',
      });

      // A failed step is not a finished step. Resuming must return to it.
      expect(firstIncompleteStep(await store.readAll(task))).toBe(0);
    });

    it('handles a step with several tool calls without colliding with the next step', async () => {
      const store = new PgTaskStore(harness.db);
      const user = await seedUser();
      const agent = await seedAgent(user.id);
      const task = await store.createTask({
        title: 't',
        requestedBy: user.id,
        agentId: agent.id,
        input: {},
        flowHash: 'h',
      });

      await store.write(task, {
        stepNo: 0,
        stepIndex: 0,
        kind: 'model_call',
        state: 'completed',
        result: { toolCallCount: 3 },
      });
      expect(firstIncompleteStep(await store.readAll(task))).toBe(0);

      await store.write(task, { stepNo: 0, stepIndex: 1, kind: 'tool_call', state: 'completed', result: {} });
      await store.write(task, { stepNo: 0, stepIndex: 2, kind: 'tool_call', state: 'completed', result: {} });
      expect(firstIncompleteStep(await store.readAll(task))).toBe(0);

      // Third tool lands. With a fixed 2n stride this index would have been
      // mistaken for step 1's model memo.
      await store.write(task, { stepNo: 0, stepIndex: 3, kind: 'tool_call', state: 'completed', result: {} });
      expect(firstIncompleteStep(await store.readAll(task))).toBe(1);
    });
  });

  describe('cancellation', () => {
    it('sees a cancel requested from outside the process', async () => {
      const store = new PgTaskStore(harness.db);
      const user = await seedUser();
      const agent = await seedAgent(user.id);
      const task = await store.createTask({
        title: 't',
        requestedBy: user.id,
        agentId: agent.id,
        input: {},
        flowHash: 'h',
      });

      expect(await store.isCancelRequested(task)).toBe(false);
      await store.requestCancel(task);
      // The flag lives in the database, so it survives the process that set it.
      expect(await store.isCancelRequested(task)).toBe(true);
    });
  });

  describe('approvals', () => {
    async function seedGatedTask() {
      const store = new PgTaskStore(harness.db);
      const user = await seedUser();
      const agent = await seedAgent(user.id);
      const task = await store.createTask({
        title: 'gated',
        requestedBy: user.id,
        agentId: agent.id,
        input: {},
        flowHash: 'sha256:v1',
      });
      const [step] = await harness.db
        .insert(schema.taskSteps)
        .values({ taskId: task, stepIndex: 0, kind: 'gate', state: 'running' })
        .returning();
      const approvalId = await store.recordApproval({
        taskId: task,
        stepId: step!.id,
        toolName: 'filesystem.write',
        arguments: { path: 'a.txt' },
      });
      return { store, user, agent, task, approvalId, stepId: step!.id };
    }

    it('lists only undecided approvals', async () => {
      const { store, task, approvalId, user } = await seedGatedTask();
      const pending = await store.pendingApprovals();
      expect(pending.some((p) => p.id === approvalId)).toBe(true);

      await store.resumeFromApproval({
        taskId: task,
        approvalId,
        decidedBy: user.id,
        decision: 'denied',
        flowHash: 'sha256:v1',
        currentFlowHash: 'sha256:v1',
      });

      const after = await store.pendingApprovals();
      expect(after.some((p) => p.id === approvalId)).toBe(false);
    });

    it('refuses to resume against a changed flow definition', async () => {
      const { store, task, approvalId, user } = await seedGatedTask();

      const result = await store.resumeFromApproval({
        taskId: task,
        approvalId,
        decidedBy: user.id,
        decision: 'approved',
        flowHash: 'sha256:v1',
        currentFlowHash: 'sha256:v2',
      });

      expect(result.ok).toBe(false);
      // Loudly, not silently. A divergent replay is the bug you find six months later.
      expect((result as { reason: string }).reason).toContain('refusing to resume');

      // And the approval is still pending: nothing was consumed by the refusal.
      const pending = await store.pendingApprovals();
      expect(pending.some((p) => p.id === approvalId)).toBe(true);
    });

    it('refuses to decide the same approval twice', async () => {
      const { store, task, approvalId, user } = await seedGatedTask();
      const first = await store.resumeFromApproval({
        taskId: task,
        approvalId,
        decidedBy: user.id,
        decision: 'approved',
        flowHash: 'sha256:v1',
        currentFlowHash: 'sha256:v1',
      });
      expect(first.ok).toBe(true);

      const second = await store.resumeFromApproval({
        taskId: task,
        approvalId,
        decidedBy: user.id,
        decision: 'denied',
        flowHash: 'sha256:v1',
        currentFlowHash: 'sha256:v1',
      });
      expect(second.ok).toBe(false);
      expect((second as { reason: string }).reason).toContain('already decided');
    });

    it('requeues the task on approval', async () => {
      const { store, task, approvalId, user, stepId } = await seedGatedTask();
      await store.markWaitingApproval(task, stepId);

      await store.resumeFromApproval({
        taskId: task,
        approvalId,
        decidedBy: user.id,
        decision: 'approved',
        flowHash: 'sha256:v1',
        currentFlowHash: 'sha256:v1',
      });

      const [row] = await harness.db
        .select({ status: schema.tasks.status })
        .from(schema.tasks)
        .where(eq(schema.tasks.id, task));
      expect(row!.status).toBe('queued');
    });

    it('fails the task on denial rather than requeueing it', async () => {
      const { store, task, approvalId, user, stepId } = await seedGatedTask();
      await store.markWaitingApproval(task, stepId);

      await store.resumeFromApproval({
        taskId: task,
        approvalId,
        decidedBy: user.id,
        decision: 'denied',
        flowHash: 'sha256:v1',
        currentFlowHash: 'sha256:v1',
      });

      const [row] = await harness.db
        .select({ status: schema.tasks.status, error: schema.tasks.error })
        .from(schema.tasks)
        .where(eq(schema.tasks.id, task));
      expect(row!.status).toBe('failed');
      expect(row!.error).toContain('denied');
    });
  });

  describe('PgAuditSink', () => {
    it('writes an event and offers no way to change it', async () => {
      const sink = new PgAuditSink(harness.db);
      await sink.record({
        actorType: 'system',
        action: 'worker.start',
        outcome: 'allowed',
        detail: { pid: 1 },
      });

      const [row] = await harness.db
        .select()
        .from(schema.auditEvents)
        .where(eq(schema.auditEvents.action, 'worker.start'));
      expect(row!.detail).toEqual({ pid: 1 });

      // The sink's surface has no update and no delete. The capability is absent,
      // not merely unused, so an audit row cannot be rewritten by mistake.
      expect(Object.getOwnPropertyNames(PgAuditSink.prototype).sort()).toEqual([
        'constructor',
        'record',
      ]);
    });

    it('redacts credentials that look like provider keys', () => {
      expect(redactSecrets('key sk-abcdefghijklmnopqrstuvwx')).toBe('key [redacted]');
      expect(redactSecrets('Authorization: Bearer aaaaaaaaaaaaaaaaaaaaaaaa')).toContain(
        '[redacted]',
      );
      expect(redactSecrets('nothing to see')).toBe('nothing to see');
    });
  });
});

async function bootstrap() {
  const client = new PGlite();
  await client.exec(readFileSync(join(process.cwd(), 'drizzle', '0000_vertical_slice.sql'), 'utf8'));
  return { client, db: drizzle(client, { schema }) };
}
