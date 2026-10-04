import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type { RecordedStep, StepStore } from '../agent/types';
import * as schema from './schema';

/**
 * The store is typed against the query-result HKT rather than against a concrete
 * driver, so the same class works over PGlite in tests and node-postgres in
 * production. Only the query surface is used, which both drivers implement
 * identically — including `for('update', { skipLocked: true })`.
 */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

/**
 * The task and step store, over real PostgreSQL.
 *
 * Two things here are load-bearing and easy to get wrong:
 *
 *  * **Claiming is atomic.** `FOR UPDATE SKIP LOCKED` is what stops a second
 *    worker from taking the task the first one already picked up. A plain
 *    `SELECT … LIMIT 1` followed by an `UPDATE` is fine with one worker and wrong
 *    the moment there are two.
 *  * **`nextIndex` is derived from the rows, not from a counter.** A counter
 *    lives in one process's memory and is wrong in the other one.
 */
export class PgTaskStore implements StepStore {
  constructor(private readonly db: Db) {}

  private static toStep(row: typeof schema.taskSteps.$inferSelect): RecordedStep {
    return {
      stepNo: row.stepNo,
      stepIndex: row.stepIndex,
      kind: row.kind,
      state: row.state,
      result: (row.result ?? undefined) as Record<string, unknown> | undefined,
      error: row.error ?? undefined,
    };
  }

  async read(taskId: string, stepIndex: number): Promise<RecordedStep | undefined> {
    const [row] = await this.db
      .select()
      .from(schema.taskSteps)
      .where(
        and(eq(schema.taskSteps.taskId, taskId), eq(schema.taskSteps.stepIndex, stepIndex)),
      )
      .limit(1);
    return row ? PgTaskStore.toStep(row) : undefined;
  }

  async readAll(taskId: string): Promise<RecordedStep[]> {
    const rows = await this.db
      .select()
      .from(schema.taskSteps)
      .where(eq(schema.taskSteps.taskId, taskId))
      .orderBy(asc(schema.taskSteps.stepIndex));
    return rows.map(PgTaskStore.toStep);
  }

  async write(taskId: string, step: RecordedStep): Promise<void> {
    // A plain insert. The unique index on (task_id, step_index) is what makes a
    // double write fail, and letting it fail is the point — a silent upsert here
    // would erase the evidence that something ran twice.
    await this.db.insert(schema.taskSteps).values({
      taskId,
      stepNo: step.stepNo,
      stepIndex: step.stepIndex,
      kind: step.kind,
      state: step.state,
      result: step.result ?? {},
      error: step.error,
      finishedAt: step.state === 'running' ? null : new Date(),
    });
  }

  /**
   * The next free record slot.
   *
   * A plain allocation with no opinion on completeness — the resume decision is
   * `firstIncompleteStep` over `readAll`, which reads the grouping from the
   * recorded `toolCallCount` instead of assuming a stride.
   */
  async nextIndex(taskId: string): Promise<number> {
    const [row] = await this.db
      .select({ max: sql<number | null>`max(${schema.taskSteps.stepIndex})` })
      .from(schema.taskSteps)
      .where(eq(schema.taskSteps.taskId, taskId));
    return (row?.max ?? -1) + 1;
  }

  async isCancelRequested(taskId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ cancelRequestedAt: schema.tasks.cancelRequestedAt })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId))
      .limit(1);
    return row?.cancelRequestedAt != null;
  }

  async markWaitingApproval(taskId: string, stepId: string): Promise<void> {
    await this.db
      .update(schema.tasks)
      .set({ status: 'waiting_approval', updatedAt: new Date() })
      .where(eq(schema.tasks.id, taskId));
    void stepId;
  }

  // --- task lifecycle ---------------------------------------------------

  async createTask(params: {
    title: string;
    requestedBy: string;
    agentId?: string | null;
    input: Record<string, unknown>;
    flowHash: string;
  }): Promise<string> {
    const [row] = await this.db
      .insert(schema.tasks)
      .values({
        title: params.title,
        requestedBy: params.requestedBy,
        agentId: params.agentId ?? null,
        input: params.input,
        flowHash: params.flowHash,
      })
      .returning({ id: schema.tasks.id });
    return row!.id;
  }

  /**
   * Take the oldest queued task, atomically.
   *
   * `SKIP LOCKED` is the difference between one worker and several. Without it a
   * second worker blocks on the row the first one is already updating, and then
   * runs the same task after it finishes.
   */
  async claimNextQueued(): Promise<{ id: string; agentId: string | null } | null> {
    return this.db.transaction(async (tx) => {
      const [candidate] = await tx
        .select({
          id: schema.tasks.id,
          agentId: schema.tasks.agentId,
        })
        .from(schema.tasks)
        .where(
          and(eq(schema.tasks.status, 'queued'), isNotNull(schema.tasks.agentId)),
        )
        .orderBy(asc(schema.tasks.queuedAt))
        .limit(1)
        .for('update', { skipLocked: true });

      if (!candidate) return null;

      const [updated] = await tx
        .update(schema.tasks)
        .set({
          status: 'running',
          startedAt: sql`coalesce(started_at, now())`,
          updatedAt: new Date(),
        })
        .where(and(eq(schema.tasks.id, candidate.id), eq(schema.tasks.status, 'queued')))
        .returning({ id: schema.tasks.id });

      // No row means another worker won the race between our lock and our write.
      return updated ? { id: updated.id, agentId: candidate.agentId } : null;
    });
  }

  async markCompleted(taskId: string, output: Record<string, unknown>): Promise<void> {
    await this.db
      .update(schema.tasks)
      .set({
        status: 'completed',
        output,
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.tasks.id, taskId));
  }

  async markFailed(taskId: string, error: string): Promise<void> {
    await this.db
      .update(schema.tasks)
      .set({ status: 'failed', error, finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.tasks.id, taskId));
  }

  async markCancelled(taskId: string): Promise<void> {
    await this.db
      .update(schema.tasks)
      .set({ status: 'cancelled', finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.tasks.id, taskId));
  }

  async requestCancel(taskId: string): Promise<void> {
    await this.db
      .update(schema.tasks)
      .set({ cancelRequestedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.tasks.id, taskId));
  }

  /**
   * Put a task back in the queue after a human decided a gate.
   *
   * The `flowHash` check is the loud refusal from the architecture proposal: a
   * task recorded under one flow definition cannot resume against another, and a
   * silent divergent replay is the bug you hunt for six months later.
   */
  async resumeFromApproval(params: {
    taskId: string;
    approvalId: string;
    decidedBy: string;
    decision: 'approved' | 'denied';
    /** The hash the task was created with. */
    flowHash: string;
    /** The hash of the flow definition as it exists now. */
    currentFlowHash: string;
  }): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (params.flowHash !== params.currentFlowHash) {
      return {
        ok: false,
        reason:
          `flow definition changed since this task was created ` +
          `(${params.flowHash} → ${params.currentFlowHash}); refusing to resume`,
      };
    }

    const [approval] = await this.db
      .select()
      .from(schema.approvals)
      .where(
        and(
          eq(schema.approvals.id, params.approvalId),
          eq(schema.approvals.taskId, params.taskId),
        ),
      )
      .limit(1);

    if (!approval) return { ok: false, reason: 'no such approval for this task' };
    if (approval.decision !== null) {
      return { ok: false, reason: 'this approval was already decided' };
    }

    const [decided] = await this.db
      .update(schema.approvals)
      .set({
        decision: params.decision,
        decidedBy: params.decidedBy,
        decidedAt: new Date(),
      })
      // The `decision is null` guard is the concurrency check: two operators
      // clicking at once must not both produce a decided row.
      .where(and(eq(schema.approvals.id, params.approvalId), isNull(schema.approvals.decision)))
      .returning({ id: schema.approvals.id });

    if (!decided) return { ok: false, reason: 'the approval was decided concurrently' };

    await this.db
      .update(schema.taskSteps)
      .set({
        state: params.decision === 'approved' ? 'completed' : 'failed',
        finishedAt: new Date(),
      })
      .where(eq(schema.taskSteps.id, approval.stepId));

    if (params.decision === 'denied') {
      await this.markFailed(params.taskId, 'a human denied the requested action');
      return { ok: true };
    }

    await this.db
      .update(schema.tasks)
      .set({ status: 'queued', updatedAt: new Date() })
      .where(eq(schema.tasks.id, params.taskId));

    return { ok: true };
  }

  async pendingApprovals(): Promise<
    Array<{ id: string; taskId: string; toolName: string; arguments: Record<string, unknown> }>
  > {
    const rows = await this.db
      .select({
        id: schema.approvals.id,
        taskId: schema.approvals.taskId,
        toolName: schema.approvals.toolName,
        arguments: schema.approvals.arguments,
      })
      .from(schema.approvals)
      .where(sql`${schema.approvals.decision} is null`)
      .orderBy(asc(schema.approvals.createdAt));
    return rows.map((r) => ({
      id: r.id,
      taskId: r.taskId,
      toolName: r.toolName,
      arguments: (r.arguments ?? {}) as Record<string, unknown>,
    }));
  }

  async recordApproval(params: {
    taskId: string;
    stepId: string;
    toolName: string;
    arguments: Record<string, unknown>;
  }): Promise<string> {
    const [row] = await this.db
      .insert(schema.approvals)
      .values({
        taskId: params.taskId,
        stepId: params.stepId,
        toolName: params.toolName,
        arguments: params.arguments,
      })
      .returning({ id: schema.approvals.id });
    return row!.id;
  }
}