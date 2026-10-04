import { describe, expect, it, vi } from 'vitest';
import { type Budget, runAgent } from './runtime';
import {
  type ModelClient,
  type ModelResponse,
  type RecordedStep,
  type RunResult,
  type StepStore,
} from './types';
import type { AuditSink } from '../tools/runner';
import { createReadTool, createWriteTool } from '../tools/filesystem';
import { ToolRunner } from '../tools/runner';
import { policyFromJson } from '../policy/policy';

/** In-memory stand-in for the database. Enforces the same memo rule. */
class MemStore implements StepStore {
  readonly steps = new Map<number, RecordedStep>();
  cancel = false;
  waiting: string | null = null;
  /** Counts writes that would have violated the unique index. */
  writeAttempts = 0;

  async read(taskId: string, stepIndex: number) {
    return this.steps.get(stepIndex);
  }
  async write(taskId: string, step: RecordedStep) {
    this.writeAttempts += 1;
    if (this.steps.has(step.stepIndex)) {
      throw new Error(`duplicate step ${step.stepIndex}`);
    }
    this.steps.set(step.stepIndex, step);
  }
async nextIndex(_taskId: string) {
    // Step `n` starts at 2n. Its model memo declares how many tool calls
    // followed, occupying 2n+1 … 2n+count. A step is complete only when the memo
    // and every tool record are `completed` — a failed record means the step is
    // unfinished, which is what sends a resumed run back to it.
    for (let step = 0; ; step += 1) {
      const memo = this.steps.get(step * 2);
      if (!memo || memo.state !== 'completed') return step;

      const count = Number(memo.result?.toolCallCount ?? 0);
      let complete = true;
      for (let i = 1; i <= count; i += 1) {
        const rec = this.steps.get(step * 2 + i);
        if (!rec || rec.state !== 'completed') {
          complete = false;
          break;
        }
      }
      if (!complete) return step;
    }
  }
  async isCancelRequested() {
    return this.cancel;
  }
  async markWaitingApproval(taskId: string, stepId: string) {
    this.waiting = stepId;
  }
}

function scriptModel(turns: ModelResponse[]): ModelClient & { calls: number } {
  let i = 0;
  const client = {
    calls: 0,
    async generate(): Promise<ModelResponse> {
      const turn = turns[Math.min(i, turns.length - 1)]!;
      i += 1;
      client.calls += 1;
      return turn;
    },
  };
  return client;
}

const reply = (text: string, over: Partial<ModelResponse> = {}): ModelResponse => ({
  text,
  toolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens: 10, outputTokens: 5 },
  costUsd: 0.001,
  model: 'fake/model',
  ...over,
});

const call = (name: string, args: unknown, id = 'c1'): ModelResponse =>
  reply('', { toolCalls: [{ id, name, args }], finishReason: 'tool_calls' });

const noopAudit: AuditSink = { async record() {} };

/**
 * Narrows a RunResult so a field unique to one arm can be read. Without it,
 * `result.why` is a type error on the union and `as` would silence the very
 * mismatch a test is meant to catch.
 */
function expectStatus<K extends RunResult['status']>(
  result: RunResult,
  status: K,
): Extract<RunResult, { status: K }> {
  if (result.status !== status) {
    throw new Error(`expected status ${status}, got ${result.status}`);
  }
  return result as Extract<RunResult, { status: K }>;
}

const budget = (over: Partial<Budget> = {}): Budget => ({
  maxSteps: 5,
  maxOutputTokens: 10_000,
  ...over,
});

const neverCalled = async () => {
  throw new Error('no tool should have run');
};

describe('agent runtime: a single agent is a loop', () => {
  it('completes when the model stops calling tools', async () => {
    const store = new MemStore();
    const model = scriptModel([reply('done')]);

    const result = await runAgent(
      { model, store, audit: noopAudit, tools: [], system: 's', budget: budget(), callTool: neverCalled },
      { taskId: 't1', agentId: 'a1', prompt: 'hi' },
    );

    expect(result.status).toBe('completed');
    expect(model.calls).toBe(1);
  });

  it('runs a tool and feeds the result back for another turn', async () => {
    const store = new MemStore();
    const model = scriptModel([call('filesystem.read', { path: 'x' }), reply('read it')]);

    const callTool = vi.fn(async () => ({
      kind: 'executed' as const,
      output: { ok: true, data: 'the file contents' },
    }));

    const result = await runAgent(
      { model, store, audit: noopAudit, tools: [], system: 's', budget: budget(), callTool },
      { taskId: 't1', agentId: 'a1', prompt: 'read x' },
    );

    expect(callTool).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('completed');
    expect(model.calls).toBe(2);
  });

  it('treats a tool failure as a value so the loop can continue', async () => {
    const store = new MemStore();
    const model = scriptModel([
      call('filesystem.read', { path: 'missing' }),
      reply('that file does not exist'),
    ]);

    const callTool = vi.fn(async () => ({
      kind: 'executed' as const,
      output: { ok: false, error: 'no such file: missing' },
    }));

    const result = await runAgent(
      { model, store, audit: noopAudit, tools: [], system: 's', budget: budget(), callTool },
      { taskId: 't1', agentId: 'a1', prompt: 'read missing' },
    );

    expect(result.status).toBe('completed');
    expect(model.calls).toBe(2);
  });

  it('feeds a refusal back rather than aborting the run', async () => {
    const store = new MemStore();
    const model = scriptModel([call('secret.use', { name: 'API_KEY' }), reply('understood')]);

    const callTool = vi.fn(async () => ({
      kind: 'blocked' as const,
      reason: 'denied outright by policy',
    }));

    const result = await runAgent(
      { model, store, audit: noopAudit, tools: [], system: 's', budget: budget(), callTool },
      { taskId: 't1', agentId: 'a1', prompt: 'use the key' },
    );

    // The agent got a "refused" message and could answer it. Blocking is not the
    // same as ending the task.
    expect(result.status).toBe('completed');
    expect(model.calls).toBe(2);
  });

  it('survives a tool name it has never heard of', async () => {
    const store = new MemStore();
    const model = scriptModel([call('shell.exec', { cmd: 'rm -rf /' }), reply('I cannot')]);

    const callTool = vi.fn(async () => ({ kind: 'unknown_tool' as const, name: 'shell.exec' }));

    const result = await runAgent(
      { model, store, audit: noopAudit, tools: [], system: 's', budget: budget(), callTool },
      { taskId: 't1', agentId: 'a1', prompt: 'rm' },
    );

    expect(result.status).toBe('completed');
    expect(model.calls).toBe(2);
  });
});

describe('agent runtime: a truncated answer is not a finished answer', () => {
  it('reports finish_reason=length as incomplete', async () => {
    const store = new MemStore();
    // Text that reads like a conclusion, but the model ran out of room. Only one
    // of the thirteen runtimes surveyed checks this, and without it the task
    // would be recorded as successful.
    const model = scriptModel([
      reply('Based on my analysis, the answer is clearly', { finishReason: 'length' }),
    ]);

    const result = await runAgent(
      { model, store, audit: noopAudit, tools: [], system: 's', budget: budget(), callTool: neverCalled },
      { taskId: 't1', agentId: 'a1', prompt: 'hi' },
    );

    const narrowed = expectStatus(result, 'incomplete');
    expect(narrowed.why).toContain('truncated');
  });

  it('records the truncation as a failed step', async () => {
    const store = new MemStore();
    const model = scriptModel([reply('half an ans', { finishReason: 'length' })]);

    await runAgent(
      { model, store, audit: noopAudit, tools: [], system: 's', budget: budget(), callTool: neverCalled },
      { taskId: 't1', agentId: 'a1', prompt: 'hi' },
    );

    const failures = [...store.steps.values()].filter((s) => s.state === 'failed');
    expect(failures).toHaveLength(1);
    expect(failures[0]!.error).toContain('length');
  });

  it('treats a content filter as a failure, not a completion', async () => {
    const store = new MemStore();
    const model = scriptModel([reply('', { finishReason: 'content_filter' })]);

    const result = await runAgent(
      { model, store, audit: noopAudit, tools: [], system: 's', budget: budget(), callTool: neverCalled },
      { taskId: 't1', agentId: 'a1', prompt: 'hi' },
    );

    expect(result.status).toBe('failed');
  });
});

describe('agent runtime: the memo is read before the call, not after', () => {
it('replays a recorded model call instead of paying for it twice', async () => {
    const store = new MemStore();

    // A crash between the model call and the tool: the memo is recorded, the
    // tool step is not. Written directly, because a throwing tool would also
    // record a failure — and a failed step is deliberately not retried in place.
    const recorded = call('filesystem.read', { path: 'x' });
    await store.write('t1', {
      stepIndex: 0,
      kind: 'model_call',
      state: 'completed',
      result: { ...(recorded as unknown as Record<string, unknown>), toolCallCount: 1 },
    });

    // A fresh process with a fresh model client. The memo must stop the model
    // from being asked for step 0 a second time.
    //
    // The script holds one turn only, so the count is unambiguous: exactly one
    // model call happens, and it is the *next* step. Step 0 consumed nothing.
    const second = scriptModel([reply('read it')]);
    const callTool = vi.fn(async () => ({
      kind: 'executed' as const,
      output: { ok: true, data: 'contents' },
    }));

    const entries: Array<Record<string, unknown>> = [];
    const result = await runAgent(
      {
        model: second,
        store,
        audit: { async record(e) { entries.push(e as Record<string, unknown>); } },
        tools: [],
        system: 's',
        budget: budget(),
        callTool,
      },
      { taskId: 't1', agentId: 'a1', prompt: 'read x' },
    );

    // The tool the replayed response asked for still ran, exactly once.
    expect(callTool).toHaveBeenCalledTimes(1);
    // And the model was called once — for the step *after* the replay.
    expect(second.calls).toBe(1);
    expect(entries.some((e) => e.action === 'model.replay')).toBe(true);
    expect(result.status).toBe('completed');
  });

  it('does not retry a tool that already failed in place', async () => {
    const store = new MemStore();

    const recorded = call('filesystem.write', { path: 'a.txt', content: 'x' });
    await store.write('t1', {
      stepIndex: 0,
      kind: 'model_call',
      state: 'completed',
      result: { ...(recorded as unknown as Record<string, unknown>), toolCallCount: 1 },
    });
    await store.write('t1', {
      stepIndex: 1,
      kind: 'tool_call',
      state: 'failed',
      error: 'write failed: disk full',
    });

    const second = scriptModel([reply('never')]);
    const callTool = vi.fn(async () => ({
      kind: 'executed' as const,
      output: { ok: true, data: { bytes: 1 } },
    }));

    const result = await runAgent(
      { model: second, store, audit: noopAudit, tools: [], system: 's', budget: budget(), callTool },
      { taskId: 't1', agentId: 'a1', prompt: 'write a.txt' },
    );

    // The unique index forbids overwriting a recorded step, and that is the
    // correct constraint: a write may have applied part of its effect before
    // failing, so re-running it is not guaranteed idempotent. A new attempt is
    // the only safe retry.
    expect(callTool).not.toHaveBeenCalled();
    expect(second.calls).toBe(0);
    expect(expectStatus(result, 'failed').error).toContain('not retried in place');
  });

  it('does not run a tool twice when the model call is replayed', async () => {
    const store = new MemStore();

    // A step where both the model call and the tool completed.
    const first = scriptModel([call('filesystem.write', { path: 'a.txt', content: 'x' }), reply('done')]);
    const writeCount = vi.fn(async () => ({
      kind: 'executed' as const,
      output: { ok: true, data: { bytes: 1 } },
    }));

    await runAgent(
      { model: first, store, audit: noopAudit, tools: [], system: 's', budget: budget(), callTool: writeCount },
      { taskId: 't1', agentId: 'a1', prompt: 'write a.txt' },
    );
    expect(writeCount).toHaveBeenCalledTimes(1);

    // Resume the same task. The write already happened; repeating it is exactly
    // the class of bug the tool memo exists to prevent.
    const second = scriptModel([reply('never')]);
    const resumed = await runAgent(
      {
        model: second,
        store,
        audit: noopAudit,
        tools: [],
        system: 's',
        budget: budget(),
        callTool: writeCount,
      },
      { taskId: 't1', agentId: 'a1', prompt: 'write a.txt' },
    );

    expect(writeCount).toHaveBeenCalledTimes(1);
    expect(resumed.status).toBe('completed');
  });

  it('resumes at the unfinished step rather than one past it', async () => {
    const store = new MemStore();
    // Record only a model call at index 2 — step 1's model, no tool result.
    await store.write('t1', { stepIndex: 2, kind: 'model_call', state: 'completed', result: {} });

    // Step 0 has neither index, so it is the first incomplete step.
    expect(await store.nextIndex('t1')).toBe(0);
  });

it('logs the replay so a resumed run is visible in the audit', async () => {
    const store = new MemStore();
    const recorded = call('filesystem.read', { path: 'x' });
    await store.write('t1', {
      stepIndex: 0,
      kind: 'model_call',
      state: 'completed',
      result: { ...(recorded as unknown as Record<string, unknown>), toolCallCount: 1 },
    });

    const entries: Array<Record<string, unknown>> = [];
    const audit: AuditSink = { async record(e) { entries.push(e as Record<string, unknown>); } };

    await runAgent(
      {
        model: scriptModel([reply('never')]),
        store,
        audit,
        tools: [],
        system: 's',
        budget: budget(),
        callTool: async () => ({ kind: 'executed', output: { ok: true, data: 'c' } }),
      },
      { taskId: 't1', agentId: 'a1', prompt: 'read x' },
    );

    expect(entries.some((e) => e.action === 'model.replay')).toBe(true);
  });
});

describe('agent runtime: the gate is its own step', () => {
  const gatingPolicy = () =>
    policyFromJson(
      JSON.stringify({
        defaultTier: 'third_party',
        tiers: { third_party: { requireHuman: ['fs.write:**'] } },
      }),
    );

  it('stops the run and waits for a human', async () => {
    const store = new MemStore();
    const model = scriptModel([call('filesystem.write', { path: 'a.txt', content: 'x' }), reply('after')]);

    const runner = new ToolRunner({ policy: gatingPolicy(), audit: noopAudit });
    runner.register(createWriteTool({ roots: [process.cwd()], limits: { maxBytes: 1024 } }));

    const result = await runAgent(
      {
        model,
        store,
        audit: noopAudit,
        tools: [],
        system: 's',
        budget: budget(),
        callTool: (p) => runner.run({ agent: asAgent(), ...p } as never),
      },
      { taskId: 't1', agentId: 'a1', prompt: 'write a.txt' },
    );

    expect(result.status).toBe('waiting_approval');
    // The model was not called a second time. The turn ended at the gate.
    expect(model.calls).toBe(1);
  });

  it('writes the gate as a separate step from the model call', async () => {
    const store = new MemStore();
    const model = scriptModel([call('filesystem.write', { path: 'a.txt', content: 'x' }), reply('after')]);

    const runner = new ToolRunner({ policy: gatingPolicy(), audit: noopAudit });
    runner.register(createWriteTool({ roots: [process.cwd()], limits: { maxBytes: 1024 } }));

    await runAgent(
      {
        model,
        store,
        audit: noopAudit,
        tools: [],
        system: 's',
        budget: budget(),
        callTool: (p) => runner.run({ agent: asAgent(), ...p } as never),
      },
      { taskId: 't1', agentId: 'a1', prompt: 'write a.txt' },
    );

    const kinds = [...store.steps.entries()].sort((a, b) => a[0] - b[0]).map(([, s]) => s.kind);
    // Model call at index 0, gate at index 1. If they shared an index, resuming
    // would re-run the model call — the LangGraph trap.
    expect(kinds).toEqual(['model_call', 'gate']);
    expect(store.waiting).toBe('1');
  });

  it('never runs the tool while it waits', async () => {
    const store = new MemStore();
    const model = scriptModel([call('filesystem.write', { path: 'a.txt', content: 'x' }), reply('after')]);

    const executeSpy = vi.fn();
    const runner = new ToolRunner({ policy: gatingPolicy(), audit: noopAudit });
    const tool = createWriteTool({ roots: [process.cwd()], limits: { maxBytes: 1024 } });
    const wrapped = { ...tool, execute: executeSpy };
    runner.register(wrapped);

    await runAgent(
      {
        model,
        store,
        audit: noopAudit,
        tools: [],
        system: 's',
        budget: budget(),
        callTool: (p) => runner.run({ agent: asAgent(), ...p } as never),
      },
      { taskId: 't1', agentId: 'a1', prompt: 'write a.txt' },
    );

    expect(executeSpy).not.toHaveBeenCalled();
  });
});

function asAgent() {
  return {
    id: 'a1',
    name: 'writer',
    tier: 'third_party' as const,
    grantedTools: ['filesystem.write', 'filesystem.read'],
    toolConstraints: {},
  };
}

describe('agent runtime: cancellation', () => {
  it('sees a cancel that arrived before the run started', async () => {
    const store = new MemStore();
    store.cancel = true;
    const model = scriptModel([reply('should not happen')]);

    const result = await runAgent(
      { model, store, audit: noopAudit, tools: [], system: 's', budget: budget(), callTool: neverCalled },
      { taskId: 't1', agentId: 'a1', prompt: 'hi' },
    );

    expect(result.status).toBe('cancelled');
    expect(model.calls).toBe(0);
  });

  it('polls the store between tool calls', async () => {
    const store = new MemStore();
    const model = scriptModel([
      reply('', {
        toolCalls: [
          { id: 'a', name: 'filesystem.read', args: { path: '1' } },
          { id: 'b', name: 'filesystem.read', args: { path: '2' } },
        ],
        finishReason: 'tool_calls',
      }),
      reply('unreachable'),
    ]);

    let seen = 0;
    const result = await runAgent(
      {
        model,
        store,
        audit: noopAudit,
        tools: [],
        system: 's',
        budget: budget(),
        callTool: async () => {
          seen += 1;
          if (seen === 1) store.cancel = true;
          return { kind: 'executed' as const, output: { ok: true, data: 'x' } };
        },
      },
      { taskId: 't1', agentId: 'a1', prompt: 'hi' },
    );

    expect(result.status).toBe('cancelled');
    expect(seen).toBe(1);
  });

  it('honours an in-process abort signal', async () => {
    const store = new MemStore();
    const controller = new AbortController();
    controller.abort();
    const model = scriptModel([reply('should not happen')]);

    const result = await runAgent(
      { model, store, audit: noopAudit, tools: [], system: 's', budget: budget(), callTool: neverCalled },
      { taskId: 't1', agentId: 'a1', prompt: 'hi', signal: controller.signal },
    );

    expect(result.status).toBe('cancelled');
  });

  it('passes the signal to the model so an in-flight call gives up', async () => {
    const store = new MemStore();
    const controller = new AbortController();
    let sawSignal = false;
    const model: ModelClient = {
      async generate({ signal }) {
        sawSignal = signal !== undefined;
        return reply('ok');
      },
    };

    await runAgent(
      { model, store, audit: noopAudit, tools: [], system: 's', budget: budget(), callTool: neverCalled },
      { taskId: 't1', agentId: 'a1', prompt: 'hi', signal: controller.signal },
    );

    expect(sawSignal).toBe(true);
  });
});

describe('agent runtime: budgets', () => {
  it('stops at the step ceiling', async () => {
    const store = new MemStore();
    // Always asks for a tool, so the loop can only end by running out of budget.
    const model = scriptModel([call('filesystem.read', { path: 'x' })]);

    const result = await runAgent(
      {
        model,
        store,
        audit: noopAudit,
        tools: [],
        system: 's',
        budget: budget({ maxSteps: 3 }),
        callTool: async () => ({ kind: 'executed' as const, output: { ok: true, data: 'x' } }),
      },
      { taskId: 't1', agentId: 'a1', prompt: 'loop' },
    );

    const narrowed = expectStatus(result, 'budget_exhausted');
    expect(narrowed.why).toContain('step budget');
  });

  it('stops when output tokens exceed the ceiling', async () => {
    const store = new MemStore();
    const model = scriptModel([
      reply('a', { usage: { inputTokens: 1, outputTokens: 100 } }),
    ]);

    const result = await runAgent(
      { model, store, audit: noopAudit, tools: [], system: 's', budget: budget({ maxOutputTokens: 10 }), callTool: neverCalled },
      { taskId: 't1', agentId: 'a1', prompt: 'hi' },
    );

    const narrowed = expectStatus(result, 'budget_exhausted');
    expect(narrowed.why).toContain('output tokens');
  });

  it('stops when the cost ceiling is crossed', async () => {
    const store = new MemStore();
    const model = scriptModel([reply('a', { costUsd: 0.5 })]);

    const result = await runAgent(
      { model, store, audit: noopAudit, tools: [], system: 's', budget: budget({ maxCostUsd: 0.1 }), callTool: neverCalled },
      { taskId: 't1', agentId: 'a1', prompt: 'hi' },
    );

    const narrowed = expectStatus(result, 'budget_exhausted');
    expect(narrowed.why).toContain('USD');
  });

  it('marks usage as partial when a price is unknown, rather than counting it as free', async () => {
    const store = new MemStore();
    const model = scriptModel([reply('a', { costUsd: undefined })]);

    const result = await runAgent(
      { model, store, audit: noopAudit, tools: [], system: 's', budget: budget({ maxCostUsd: 0.01 }), callTool: neverCalled },
      { taskId: 't1', agentId: 'a1', prompt: 'hi' },
    );

    // The call completed, and the cost is a floor rather than a total.
    expect(result.status).toBe('completed');
    expect(result.usage.costPartial).toBe(true);
    expect(result.usage.costUsd).toBe(0);
  });

  it('does not stop on cost while the price is unknown', async () => {
    const store = new MemStore();
    let calls = 0;
    const model: ModelClient = {
      async generate() {
        calls += 1;
        return calls <= 2
          ? reply('', { toolCalls: [{ id: 'c', name: 'filesystem.read', args: {} }], finishReason: 'tool_calls' as const, costUsd: undefined })
          : reply('done');
      },
    };

    const result = await runAgent(
      {
        model,
        store,
        audit: noopAudit,
        tools: [],
        system: 's',
        budget: budget({ maxCostUsd: 0.0001 }),
        callTool: async () => ({ kind: 'executed' as const, output: { ok: true, data: 'x' } }),
      },
      { taskId: 't1', agentId: 'a1', prompt: 'hi' },
    );

    // A money ceiling cannot bind against an unknown price. Pretending otherwise
    // would be the worse bug: the run stops for a reason that does not exist.
    expect(result.status).toBe('completed');
    expect(result.usage.costPartial).toBe(true);
  });
});

describe('agent runtime: model failures', () => {
  it('records the failure as a failed step and returns failed', async () => {
    const store = new MemStore();
    const model: ModelClient = {
      async generate() {
        throw new Error('provider 503');
      },
    };

    const result = await runAgent(
      { model, store, audit: noopAudit, tools: [], system: 's', budget: budget(), callTool: neverCalled },
      { taskId: 't1', agentId: 'a1', prompt: 'hi' },
    );

expect(result.status).toBe('failed');
    expect(expectStatus(result, 'failed').error).toContain('503');

    const failedSteps = [...store.steps.values()].filter((s) => s.state === 'failed');
    expect(failedSteps).toHaveLength(1);
  });
});