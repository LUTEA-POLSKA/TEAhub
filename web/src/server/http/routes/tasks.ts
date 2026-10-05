import { desc, eq, sql } from 'drizzle-orm';
import * as schema from '../../db/schema';
import { PgTaskStore } from '../../db/task-store';
import { json, problem, withGuard } from '../guard';
import type { GuardDeps } from '../guard';
import { rateWindow } from './state';

/**
 * Creating a task and cancelling one.
 *
 * Creating a task writes the flow hash at creation, because that is the value a
 * later approval is checked against. Computing it at resume time instead would
 * let a definition change mid-flight and resume a task against rules nobody
 * approved.
 */

export function createTaskRoute(deps: GuardDeps, flowHashOf: () => string) {
  return withGuard(
    { ...deps, writeLimiter: rateWindow(deps.db) },
    'task.create',
    async (ctx) => {
      let body: { title?: unknown; goal?: unknown; agentId?: unknown };
      try {
        body = (await ctx.request.json()) as typeof body;
      } catch {
        return problem(400, 'bad_request', 'Expected a JSON body.');
      }

      const title = typeof body.title === 'string' ? body.title.trim() : '';
      const goal = typeof body.goal === 'string' ? body.goal.trim() : '';

      if (title.length === 0 || title.length > 200) {
        return problem(400, 'bad_request', 'title is required and must be under 200 characters.');
      }
      if (goal.length === 0 || goal.length > 20_000) {
        return problem(400, 'bad_request', 'goal is required and must be under 20000 characters.');
      }

      let agentId: string | null = null;
      if (typeof body.agentId === 'string') {
        const [agent] = await deps.db
          .select()
          .from(schema.agents)
          .where(eq(schema.agents.id, body.agentId))
          .limit(1);
        if (!agent) return problem(400, 'bad_request', 'no such agent');
        if (!agent.enabled) return problem(400, 'bad_agent', 'that agent is disabled');
        agentId = agent.id;
      } else {
        // Without an explicit agent, use the single enabled one. Ambiguity is an
        // error rather than a silent pick, because "which agent ran this" is a
        // question the audit log has to answer correctly.
        const enabled = await deps.db
          .select({ id: schema.agents.id })
          .from(schema.agents)
          .where(eq(schema.agents.enabled, true));
        if (enabled.length !== 1) {
          return problem(
            400,
            'no_agent',
            enabled.length === 0
              ? 'no agent is enabled'
              : 'several agents are enabled, name one explicitly',
          );
        }
        agentId = enabled[0]!.id;
      }

      const store = new PgTaskStore(deps.db);
      const taskId = await store.createTask({
        title,
        requestedBy: ctx.session.userId,
        agentId,
        input: { goal },
        flowHash: flowHashOf(),
      });

      await deps.audit.record({
        actorType: 'user',
        actorId: ctx.session.userId,
        taskId,
        action: 'task.create',
        outcome: 'allowed',
        detail: { agentId, title },
      });

      return json({ taskId, status: 'queued' }, 201);
    },
  );
}

export function listTasksRoute(deps: GuardDeps) {
  return withGuard(deps, 'task.list', async (ctx) => {
    const rows = await deps.db
      .select({
        id: schema.tasks.id,
        title: schema.tasks.title,
        status: schema.tasks.status,
        queuedAt: schema.tasks.queuedAt,
        finishedAt: schema.tasks.finishedAt,
      })
      .from(schema.tasks)
      // A user sees their own tasks; an admin sees all of them. The distinction
      // is in the query rather than in the response, so there is no list to leak.
      .where(ctx.session.role === 'admin' ? sql`true` : eq(schema.tasks.requestedBy, ctx.session.userId))
      .orderBy(desc(schema.tasks.queuedAt))
      .limit(100);

    return json({ tasks: rows });
  }, { csrf: false, write: false });
}

export function cancelTaskRoute(deps: GuardDeps) {
  return withGuard(
    { ...deps, writeLimiter: rateWindow(deps.db) },
    'task.cancel',
    async (ctx) => {
      const id = ctx.params?.id;
      if (!id) return problem(400, 'bad_request', 'no task id');

      const [task] = await deps.db
        .select({ id: schema.tasks.id, requestedBy: schema.tasks.requestedBy, status: schema.tasks.status })
        .from(schema.tasks)
        .where(eq(schema.tasks.id, id))
        .limit(1);

      if (!task) return problem(404, 'not_found', 'no such task');

      // Ownership is checked here, not in the guard: the guard knows the action,
      // this knows whose task it is.
      if (task.requestedBy !== ctx.session.userId && ctx.session.role !== 'admin') {
        return problem(403, 'forbidden', 'That is not your task.');
      }
      if (['completed', 'failed', 'cancelled'].includes(task.status)) {
        return problem(409, 'already_finished', `that task is already ${task.status}`);
      }

      const store = new PgTaskStore(deps.db);
      // Sets the flag, not the status. A running agent notices it at its next
      // check; declaring the task cancelled here would be a lie about work that
      // is still in flight.
      await store.requestCancel(id);

      await deps.audit.record({
        actorType: 'user',
        actorId: ctx.session.userId,
        taskId: id,
        action: 'task.cancel',
        outcome: 'allowed',
      });

      return json({ taskId: id, cancelRequested: true });
    },
  );
}