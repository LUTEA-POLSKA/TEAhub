import { eq } from 'drizzle-orm';
import * as schema from '../../db/schema';
import { PgTaskStore } from '../../db/task-store';
import { json, problem, withGuard } from '../guard';
import type { GuardDeps } from '../guard';
import { rateWindow } from './state';

/**
 * Approvals — the human decision point.
 *
 * Two properties are enforced here rather than left to the caller:
 *
 *  * The action is `approval.decide`, which the guard restricts to admins. This is
 *    the most consequential call in the product, so it does not go through a
 *    generic "task.update" that something else might also use.
 *  * The flow hash is compared before the decision is recorded. A task recorded
 *    under one flow definition cannot be continued under another, and the refusal
 *    is loud — a silent divergent resume is the bug nobody finds for months.
 */
export function listApprovalsRoute(deps: GuardDeps) {
  return withGuard(deps, 'approval.list', async () => {
    const store = new PgTaskStore(deps.db);
    return json({ approvals: await store.pendingApprovals() });
  }, { csrf: false, write: false });
}

export function decideApprovalRoute(deps: GuardDeps, currentFlowHash: () => string) {
  return withGuard(
    { ...deps, writeLimiter: rateWindow(deps.db) },
    'approval.decide',
    async (ctx) => {
      const id = ctx.params?.id;
      if (!id) return problem(400, 'bad_request', 'no approval id');

      let body: { decision?: unknown; taskId?: unknown };
      try {
        body = (await ctx.request.json()) as typeof body;
      } catch {
        return problem(400, 'bad_request', 'Expected a JSON body.');
      }

      if (body.decision !== 'approved' && body.decision !== 'denied') {
        return problem(400, 'bad_request', 'decision must be approved or denied');
      }
      if (typeof body.taskId !== 'string') {
        return problem(400, 'bad_request', 'taskId is required');
      }

      const store = new PgTaskStore(deps.db);
      const [task] = await deps.db
        .select({ flowHash: schema.tasks.flowHash, status: schema.tasks.status })
        .from(schema.tasks)
        .where(eq(schema.tasks.id, body.taskId))
        .limit(1);

      if (!task) return problem(404, 'not_found', 'no such task');
      if (task.status !== 'waiting_approval') {
        return problem(409, 'not_waiting', `that task is ${task.status}, not waiting for approval`);
      }

      const result = await store.resumeFromApproval({
        taskId: body.taskId,
        approvalId: id,
        decidedBy: ctx.session.userId,
        decision: body.decision,
        flowHash: task.flowHash,
        currentFlowHash: currentFlowHash(),
      });

      if (!result.ok) {
        await deps.audit.record({
          actorType: 'user',
          actorId: ctx.session.userId,
          taskId: body.taskId,
          action: 'approval.refused',
          outcome: 'blocked',
          detail: { reason: result.reason },
        });
        // 409, not 400: the request was well formed, the world moved on.
        return problem(409, 'refused', result.reason);
      }

      await deps.audit.record({
        actorType: 'user',
        actorId: ctx.session.userId,
        taskId: body.taskId,
        action: `approval.${body.decision}`,
        outcome: 'allowed',
      });

      return json({ approvalId: id, decision: body.decision });
    },
  );
}