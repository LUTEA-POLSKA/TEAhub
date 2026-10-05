import { runAgent } from '../agent/runtime';
import { PgAuditSink, redactDetail } from '../db/audit-sink';
import { PgTaskStore } from '../db/task-store';
import type { Db } from '../db/task-store';
import * as schema from '../db/schema';
import { eq } from 'drizzle-orm';
import type { ModelClient } from '../agent/types';
import type { Policy } from '../policy/policy';
import { createReadTool, createWriteTool } from '../tools/filesystem';
import { createFetchTool } from '../tools/web-fetch';
import { ToolRunner } from '../tools/runner';
import { ProviderUnavailableError } from '../ai/router';

/**
 * The worker: one tick of "take a task, run it, record what happened".
 *
 * Split into `tick()` rather than only an endless loop so the behaviour can be
 * tested without waiting for wall-clock time. The loop is `while (running)
 * await tick()`. Nothing else.
 *
 * A separate process because a human gate can stay open for days. If the loop ran
 * inside a route handler, the decision to wait would be a decision to hold a
 * request open for days.
 */

export interface WorkerDeps {
  db: Db;
  store: PgTaskStore;
  audit: PgAuditSink;
  policy: Policy;
  /** The workspace roots tools are confined to. */
  roots: string[];
  allowedFetchHosts: string[];
  maxBytes: number;
  budgets: Map<string, { maxSteps: number; maxOutputTokens: number; maxCostUsd?: number }>;
  systemPrompt: (agent: { systemPrompt: string; systemPromptVersion: string }) => string;
  modelFor?: (agentId: string, model: string) => ModelClient;
}

export type TickResult =
  | { kind: 'idle' }
  | { kind: 'ran'; taskId: string; status: string }
  | { kind: 'skipped'; taskId: string; reason: string }
  | { kind: 'error'; taskId: string; error: string };

export class Worker {
  constructor(private readonly deps: WorkerDeps) {}

  async tick(): Promise<TickResult> {
    const { store, audit, db } = this.deps;

    const claimed = await store.claimNextQueued();
    if (!claimed) return { kind: 'idle' };

    const taskId = claimed.id;

    // Cancellation is checked before anything expensive happens, not after.
    if (await store.isCancelRequested(taskId)) {
      await store.markCancelled(taskId);
      await audit.record({
        actorType: 'system',
        taskId,
        action: 'task.cancelled',
        outcome: 'allowed',
        detail: { reason: 'cancel was already pending when the task was claimed' },
      });
      return { kind: 'ran', taskId, status: 'cancelled' };
    }

    const [task] = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId))
      .limit(1);
    if (!task) return { kind: 'skipped', taskId, reason: 'task disappeared' };

    const [agent] = await db
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.id, claimed.agentId!))
      .limit(1);
    if (!agent) return { kind: 'skipped', taskId, reason: 'agent not found' };

    if (!agent.enabled) {
      await store.markFailed(taskId, `agent ${agent.name} is disabled`);
      return { kind: 'skipped', taskId, reason: 'agent is disabled' };
    }

    const [permission] = await db
      .select()
      .from(schema.agentPermissions)
      .where(eq(schema.agentPermissions.agentId, agent.id))
      .limit(1);

    const runner = new ToolRunner({ policy: this.deps.policy, audit });
    runner.register(createReadTool({ roots: this.deps.roots, limits: { maxBytes: this.deps.maxBytes } }));
    runner.register(createWriteTool({ roots: this.deps.roots, limits: { maxBytes: this.deps.maxBytes } }));
    runner.register(
      createFetchTool({
        limits: { maxBytes: this.deps.maxBytes, timeoutMs: 15_000, maxRedirects: 3 },
        allowedHosts: this.deps.allowedFetchHosts,
      }),
    );

    const model = this.deps.modelFor?.(agent.id, '');
    if (!model) {
      await store.markFailed(taskId, 'no model provider is configured');
      return { kind: 'error', taskId, error: 'no model provider is configured' };
    }

    const identity = {
      id: agent.id,
      name: agent.name,
      tier: agent.tier,
      grantedTools: permission?.tools ?? [],
      toolConstraints: (permission?.toolConstraints ?? {}) as Record<string, Record<string, unknown>>,
    };

    const toolSpecs = [
      { name: 'filesystem.read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
      { name: 'filesystem.write', description: 'Write a file', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
      { name: 'web.fetch', description: 'Fetch a URL', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
    ];

    let result;
    try {
      result = await runAgent(
        {
          model,
          store,
          audit,
          tools: toolSpecs,
          system: this.deps.systemPrompt(agent),
          budget: this.deps.budgets.get(agent.id) ?? { maxSteps: 8, maxOutputTokens: 20_000 },
          callTool: (p) =>
            runner.run({
              agent: identity,
              toolName: p.toolName,
              args: p.args,
              taskId: p.taskId,
              stepIndex: p.stepIndex,
              signal: p.signal,
            }),
        },
        {
          taskId,
          agentId: agent.id,
          prompt: String(task.input.goal ?? task.title),
        },
      );
    } catch (error) {
      // A provider outage is not a task failure. Recorded as such, because
      // conflating the two is how "the agent is broken" gets reported for a
      // network problem.
      if (error instanceof ProviderUnavailableError) {
        await store.markFailed(taskId, `provider unavailable: ${error.message}`);
        await audit.record({
          actorType: 'system',
          taskId,
          action: 'provider.unavailable',
          outcome: 'error',
          detail: redactDetail({ reason: error.message }),
        });
        return { kind: 'error', taskId, error: error.message };
      }
      throw error;
    }

    switch (result.status) {
      case 'completed':
        await store.markCompleted(taskId, { text: result.text, usage: result.usage });
        break;
      case 'waiting_approval':
        // The store's status change to `waiting_approval` already happened in
        // `markWaitingApproval`. The approval row itself is what an operator
        // answers, so it is recorded here rather than inside the loop.
        break;
      case 'cancelled':
        await store.markCancelled(taskId);
        break;
      case 'failed':
      case 'blocked':
      case 'budget_exhausted':
      case 'incomplete':
        await store.markFailed(taskId, describe(result));
        break;
    }

    await audit.record({
      actorType: 'system',
      taskId,
      action: `task.${result.status}`,
      outcome: result.status === 'completed' ? 'allowed' : 'error',
      detail: redactDetail({ usage: result.usage, detail: describe(result) }),
    });

    return { kind: 'ran', taskId, status: result.status };
  }
}

function describe(result: { status: string; [k: string]: unknown }): string {
  switch (result.status) {
    case 'failed':
      return String(result.error ?? 'failed');
    case 'blocked':
      return String(result.reason ?? 'blocked');
    case 'budget_exhausted':
      return String(result.why ?? 'budget exhausted');
    case 'incomplete':
      return String(result.why ?? 'incomplete');
    default:
      return result.status;
  }
}