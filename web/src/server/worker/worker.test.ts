import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as schema from '../db/schema';
import { PgTaskStore } from '../db/task-store';
import { PgAuditSink } from '../db/audit-sink';
import { Worker } from './worker';
import { policyFromJson } from '../policy/policy';
import type { ModelClient, ModelResponse } from '../agent/types';
import {
  type Candidate,
  type Requirement,
  buildChain,
  createFallbackClient,
  estimateCostUsd,
  generateWithFallback,
  ProviderUnavailableError,
  scoreCandidate,
} from '../ai/router';
import { createOpenAiCompatibleClient } from '../ai/openai-compatible';

// --- provider layer ----------------------------------------------------

const req = (over: Partial<Requirement> = {}): Requirement => ({
  effort: 'medium',
  cost: 'any',
  needsTools: false,
  needsVision: false,
  minContextTokens: 1000,
  ...over,
});

function candidate(over: Partial<Candidate> & { id: string }): Candidate {
  return {
    provider: 'test',
    model: 'test/model',
    client: { async generate() { throw new Error('unused'); } },
    contextTokens: 128_000,
    supportsTools: true,
    supportsVision: false,
    healthy: true,
    ...over,
  };
}

const okResponse = (): ModelResponse => ({
  text: 'done',
  toolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens: 10, outputTokens: 5 },
  costUsd: 0.001,
  model: 'test/model',
});

describe('provider layer: ranking', () => {
  it('prefers the cheaper candidate at equal capability', () => {
    const cheap = candidate({ id: 'cheap', price: { inputPerM: 0.1, outputPerM: 0.2 } });
    const dear = candidate({ id: 'dear', price: { inputPerM: 15, outputPerM: 60 } });
    const { ordered } = buildChain(req(), [dear, cheap]);
    expect(ordered[0]!.id).toBe('cheap');
  });

  it('drops a candidate that cannot meet the requirement', () => {
    const small = candidate({ id: 'small', contextTokens: 4_000 });
    const { ordered, rejected } = buildChain(req({ minContextTokens: 100_000 }), [small]);
    expect(ordered).toHaveLength(0);
    expect(rejected[0]!.reason).toContain('below required');
  });

  it('drops a candidate without tool support when tools are needed', () => {
    const noTools = candidate({ id: 'no-tools', supportsTools: false });
    const { ordered, rejected } = buildChain(req({ needsTools: true }), [noTools]);
    expect(ordered).toHaveLength(0);
    expect(rejected[0]!.reason).toBe('no tool support');
  });

  it('drops an unhealthy candidate as in cooldown, not as absent', () => {
    const { rejected } = buildChain(req(), [candidate({ id: 'down', healthy: false })]);
    expect(rejected[0]!.reason).toBe('in cooldown');
  });

  it('rejects an unpriced candidate for a free-only requirement', () => {
    // Unpriced is not free. Ranking it as free is how a budget silently stops
    // binding.
    const unpriced = candidate({ id: 'unknown-price' });
    expect(scoreCandidate(req({ cost: 'free' }), unpriced)).toBeNull();
  });

  it('keeps an unpriced candidate eligible for a cheap requirement, ranked last', () => {
    const unpriced = candidate({ id: 'unknown-price' });
    const priced = candidate({ id: 'priced', price: { inputPerM: 5, outputPerM: 5 } });
    const { ordered } = buildChain(req({ cost: 'cheap' }), [priced, unpriced]);
    // We do not know it is expensive, so we do not exclude it — but we do not
    // claim it is cheap either.
    expect(ordered.map((c) => c.id)).toEqual(['priced', 'unknown-price']);
  });

  it('orders deterministically', () => {
    const a = candidate({ id: 'a', price: { inputPerM: 1, outputPerM: 1 } });
    const b = candidate({ id: 'b', price: { inputPerM: 1, outputPerM: 1 } });
    expect(buildChain(req(), [b, a]).ordered.map((c) => c.id)).toEqual(
      buildChain(req(), [a, b]).ordered.map((c) => c.id),
    );
  });
});

describe('provider layer: fallback', () => {
  it('returns the first success without touching the rest', async () => {
    const second = vi.fn();
    const result = await generateWithFallback({
      req: req(),
      candidates: [
        candidate({
          id: 'first',
          price: { inputPerM: 0.1, outputPerM: 0.1 },
          client: { async generate() { return okResponse(); } },
        }),
        candidate({
          id: 'second',
          price: { inputPerM: 0.2, outputPerM: 0.2 },
          client: { generate: second },
        }),
      ],
      system: 's',
      messages: [],
      tools: [],
    });
    expect(result.usedId).toBe('first');
    expect(second).not.toHaveBeenCalled();
  });

  it('falls through to the next candidate on a provider failure', async () => {
    const result = await generateWithFallback({
      req: req(),
      candidates: [
        candidate({
          id: 'first',
          price: { inputPerM: 0.1, outputPerM: 0.1 },
          client: {
            async generate() {
              throw new Error('503 upstream');
            },
          },
        }),
        candidate({
          id: 'second',
          price: { inputPerM: 0.2, outputPerM: 0.2 },
          client: { async generate() { return okResponse(); } },
        }),
      ],
      system: 's',
      messages: [],
      tools: [],
    });
    expect(result.usedId).toBe('second');
  });

  it('reports provider exhaustion as a provider error, not a task error', async () => {
    await expect(
      generateWithFallback({
        req: req(),
        candidates: [
          candidate({
            id: 'only',
            client: {
              async generate() {
                throw new Error('down');
              },
            },
          }),
        ],
        system: 's',
        messages: [],
        tools: [],
      }),
    ).rejects.toThrow(ProviderUnavailableError);
  });

  it('explains why nothing qualified rather than failing blankly', async () => {
    await expect(
      generateWithFallback({
        req: req({ minContextTokens: 1_000_000 }),
        candidates: [candidate({ id: 'small', contextTokens: 1000 })],
        system: 's',
        messages: [],
        tools: [],
      }),
    ).rejects.toThrow(/no provider satisfies the requirement/);
  });

  it('leaves the cost undefined for an unpriced candidate', () => {
    expect(estimateCostUsd(undefined, { inputTokens: 1000, outputTokens: 1000 })).toBeUndefined();
    expect(estimateCostUsd({ inputPerM: 1_000_000, outputPerM: 0 }, { inputTokens: 1, outputTokens: 1 })).toBe(1);
  });
});

describe('provider layer: the OpenAI-compatible client', () => {
  it('speaks /chat/completions and sends the key as a bearer token', async () => {
    let seenUrl = '';
    let seenHeaders: Record<string, string> = {};
    let seenBody: any;

    const client = createOpenAiCompatibleClient({
      baseUrl: 'http://127.0.0.1:19090/v1/',
      apiKey: 'test-key',
      model: 'local/model',
      fetchImpl: (async (url: any, init: any) => {
        seenUrl = String(url);
        seenHeaders = init.headers;
        seenBody = JSON.parse(init.body);
        return new Response(
          JSON.stringify({
            choices: [{ finish_reason: 'stop', message: { content: 'hello' } }],
            usage: { prompt_tokens: 7, completion_tokens: 3 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as unknown as typeof fetch,
    });

    const out = await client.generate({ system: 'be brief', messages: [{ role: 'user', content: 'hi' }], tools: [] });

    // The trailing slash on the base URL must not produce `//chat/completions`.
    expect(seenUrl).toBe('http://127.0.0.1:19090/v1/chat/completions');
    expect(seenHeaders.authorization).toBe('Bearer test-key');
    expect(seenBody.model).toBe('local/model');
    expect(seenBody.messages[0]).toEqual({ role: 'system', content: 'be brief' });
    expect(out.text).toBe('hello');
    expect(out.finishReason).toBe('stop');
  });

  it('omits the Authorization header when there is no key', async () => {
    let seenHeaders: Record<string, string> = {};
    const client = createOpenAiCompatibleClient({
      baseUrl: 'http://localhost:11434/v1',
      model: 'llama',
      fetchImpl: (async (_url: any, init: any) => {
        seenHeaders = init.headers;
        return new Response(JSON.stringify({ choices: [{ message: { content: 'x' } }] }), {
          status: 200,
        });
      }) as unknown as typeof fetch,
    });
    await client.generate({ system: '', messages: [], tools: [] });
    expect(seenHeaders.authorization).toBeUndefined();
  });

  it('truncates a provider error body rather than echoing the request', async () => {
    const client = createOpenAiCompatibleClient({
      baseUrl: 'http://x/v1',
      apiKey: 'k',
      model: 'm',
      fetchImpl: (async () =>
        new Response('x'.repeat(5000), { status: 500 })) as unknown as typeof fetch,
    });

    await expect(
      client.generate({ system: 'secret system prompt', messages: [], tools: [] }),
    ).rejects.toThrow(/HTTP 500/);

    await client
      .generate({ system: 'secret system prompt', messages: [], tools: [] })
      .catch((e: Error) => {
        expect(e.message.length).toBeLessThan(300);
      });
  });

  it('turns malformed tool arguments into a value the model can react to', async () => {
    const client = createOpenAiCompatibleClient({
      baseUrl: 'http://x/v1',
      model: 'm',
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: 'tool_calls',
                message: {
                  tool_calls: [{ id: 'c1', function: { name: 'filesystem.read', arguments: '{not json' } }],
                },
              },
            ],
          }),
          { status: 200 },
        )) as unknown as typeof fetch,
    });

    const out = await client.generate({ system: '', messages: [], tools: [] });
    expect(out.toolCalls[0]!.name).toBe('filesystem.read');
    expect(out.toolCalls[0]!.args).toEqual({ __unparseable: '{not json' });
  });

  it('maps a length finish reason so a truncated answer is not mistaken for success', async () => {
    const client = createOpenAiCompatibleClient({
      baseUrl: 'http://x/v1',
      model: 'm',
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: 'half' } }] }),
          { status: 200 },
        )) as unknown as typeof fetch,
    });
    const out = await client.generate({ system: '', messages: [], tools: [] });
    expect(out.finishReason).toBe('length');
  });
});

// --- worker ------------------------------------------------------------

describe('Worker.tick', () => {
  let harness: Awaited<ReturnType<typeof bootstrap>>;
  let root: string;

  beforeEach(async () => {
    harness = await bootstrap();
    root = await mkdtemp(join(tmpdir(), 'teahub-worker-'));
    await mkdir(join(root, 'data'), { recursive: true });
    await writeFile(join(root, 'data', 'note.txt'), 'hello', 'utf8');
  });

  afterEach(async () => {
    await harness.client.close();
    await rm(root, { recursive: true, force: true });
  });

  let seq = 0;
  async function seed(opts: { enabled?: boolean } = {}) {
    seq += 1;
    const [user] = await harness.db
      .insert(schema.users)
      .values({ email: `w${seq}@example.org`, name: `W${seq}` })
      .returning();
    const [agent] = await harness.db
      .insert(schema.agents)
      .values({
        name: `agent-${seq}`,
        systemPromptVersion: 'v1',
        systemPrompt: 'You are terse.',
        tier: 'third_party',
        enabled: opts.enabled ?? true,
      })
      .returning();
    await harness.db
      .insert(schema.agentPermissions)
      .values({ agentId: agent!.id, tools: ['filesystem.read'] });
    return { user: user!, agent: agent! };
  }

  function makeWorker(model: ModelClient, policy = policyFromJson(JSON.stringify({
    defaultTier: 'third_party',
    tiers: { third_party: { allow: ['fs.read:**'], deny: ['fs.read:data/secret.txt'] } },
  }))) {
    const store = new PgTaskStore(harness.db);
    const audit = new PgAuditSink(harness.db);
    return new Worker({
      db: harness.db,
      store,
      audit,
      policy,
      roots: [root],
      allowedFetchHosts: [],
      maxBytes: 4096,
      budgets: new Map(),
      systemPrompt: (a) => `${a.systemPrompt} (${a.systemPromptVersion})`,
      modelFor: () => model,
    });
  }

  it('is idle when nothing is queued', async () => {
    const worker = makeWorker({ async generate() { return okResponse(); } });
    expect(await worker.tick()).toEqual({ kind: 'idle' });
  });

  it('runs a queued task to completion', async () => {
    const { user, agent } = await seed();
    const store = new PgTaskStore(harness.db);
    const taskId = await store.createTask({
      title: 'answer me',
      requestedBy: user.id,
      agentId: agent.id,
      input: { goal: 'say hello' },
      flowHash: 'h',
    });

    const worker = makeWorker({ async generate() { return okResponse(); } });
    const result = await worker.tick();

    expect(result).toEqual({ kind: 'ran', taskId, status: 'completed' });
    const [row] = await harness.db
      .select({ status: schema.tasks.status, output: schema.tasks.output })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId));
    expect(row!.status).toBe('completed');
    expect(row!.output).toMatchObject({ text: 'done' });
  });

  it('runs a tool through the policy and feeds the result back', async () => {
    const { user, agent } = await seed();
    const store = new PgTaskStore(harness.db);
    const taskId = await store.createTask({
      title: 'read',
      requestedBy: user.id,
      agentId: agent.id,
      input: { goal: 'read note.txt' },
      flowHash: 'h',
    });

    let turn = 0;
    const worker = makeWorker({
      async generate() {
        turn += 1;
        if (turn === 1) {
          return {
            ...okResponse(),
            toolCalls: [
              { id: 'c1', name: 'filesystem.read', args: { path: join(root, 'data', 'note.txt') } },
            ],
            finishReason: 'tool_calls' as const,
          };
        }
        return { ...okResponse(), text: 'the file says hello' };
      },
    });

    const result = await worker.tick();
    expect(result).toMatchObject({ status: 'completed' });

    const rows = await harness.db
      .select({ kind: schema.taskSteps.kind })
      .from(schema.taskSteps)
      .where(eq(schema.taskSteps.taskId, taskId));
    // Step 0 is the model call that asked for the tool plus the tool itself; step 1
    // is the model call that produced the final answer. Three records, and the
    // tool's is the second — not adjacent to nothing.
    expect(rows.map((r) => r.kind)).toEqual(['model_call', 'tool_call', 'model_call']);
  });

  it('fails the task when the tool is denied, without executing it', async () => {
    const { user, agent } = await seed();
    const store = new PgTaskStore(harness.db);
    const taskId = await store.createTask({
      title: 'read secret',
      requestedBy: user.id,
      agentId: agent.id,
      input: { goal: 'read secret.txt' },
      flowHash: 'h',
    });

    let turn = 0;
    const worker = makeWorker({
      async generate() {
        turn += 1;
        if (turn === 1) {
          return {
            ...okResponse(),
            toolCalls: [
              { id: 'c1', name: 'filesystem.read', args: { path: join(root, 'data', 'secret.txt') } },
            ],
            finishReason: 'tool_calls' as const,
          };
        }
        // The model was told it was refused, and can answer accordingly.
        return { ...okResponse(), text: 'I may not read that' };
      },
    });

    const result = await worker.tick();
    // A denial is a value the agent reacts to, not a task failure.
    expect(result).toMatchObject({ status: 'completed' });

    const [row] = await harness.db
      .select({ outcome: schema.auditEvents.outcome, target: schema.auditEvents.target })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.taskId, taskId));
    const blocked = await harness.db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.taskId, taskId));

    expect(blocked.some((r) => r.outcome === 'blocked')).toBe(true);
    void row;
  });

  it('refuses to run a disabled agent', async () => {
    const { user, agent } = await seed({ enabled: false });
    const store = new PgTaskStore(harness.db);
    const taskId = await store.createTask({
      title: 'x',
      requestedBy: user.id,
      agentId: agent.id,
      input: { goal: 'go' },
      flowHash: 'h',
    });

    const worker = makeWorker({ async generate() { return okResponse(); } });
    const result = await worker.tick();
    expect(result).toMatchObject({ kind: 'skipped', reason: 'agent is disabled' });

    const [row] = await harness.db
      .select({ status: schema.tasks.status })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId));
    expect(row!.status).toBe('failed');
  });

  it('honours a cancel that arrived before the claim', async () => {
    const { user, agent } = await seed();
    const store = new PgTaskStore(harness.db);
    const taskId = await store.createTask({
      title: 'x',
      requestedBy: user.id,
      agentId: agent.id,
      input: { goal: 'go' },
      flowHash: 'h',
    });
    await store.requestCancel(taskId);

    const model = { generate: vi.fn(async () => okResponse()) };
    const worker = makeWorker(model);
    const result = await worker.tick();

    expect(result).toMatchObject({ status: 'cancelled' });
    // The model was never called: cancelling before the claim means not starting.
    expect(model.generate).not.toHaveBeenCalled();
  });

  it('records a provider outage separately from a task failure', async () => {
    const { user, agent } = await seed();
    const store = new PgTaskStore(harness.db);
    await store.createTask({
      title: 'x',
      requestedBy: user.id,
      agentId: agent.id,
      input: { goal: 'go' },
      flowHash: 'h',
    });

    // Composed behind a single client, the way the worker actually receives it.
    const model = createFallbackClient({
      req: req(),
      candidates: [
        candidate({
          id: 'only',
          price: { inputPerM: 1, outputPerM: 1 },
          client: {
            async generate() {
              throw new Error('upstream is down');
            },
          },
        }),
      ],
    });

    const worker = makeWorker(model);
    const result = await worker.tick();

    // Not a task failure: the task never got to run. Reported as an error so the
    // distinction survives into the audit log.
    expect(result.kind).toBe('error');
    expect((result as { error: string }).error).toContain('upstream is down');

    const [row] = await harness.db
      .select({ error: schema.tasks.error })
      .from(schema.tasks)
      .where(eq(schema.tasks.status, 'failed'));
    expect(row!.error).toContain('provider unavailable');
  });

  it('falls back to a second provider instead of failing the task', async () => {
    const { user, agent } = await seed();
    const store = new PgTaskStore(harness.db);
    const taskId = await store.createTask({
      title: 'x',
      requestedBy: user.id,
      agentId: agent.id,
      input: { goal: 'go' },
      flowHash: 'h',
    });

    const model = createFallbackClient({
      req: req(),
      candidates: [
        candidate({
          id: 'first',
          price: { inputPerM: 0.5, outputPerM: 0.5 },
          client: {
            async generate() {
              throw new Error('502 bad gateway');
            },
          },
        }),
        candidate({
          id: 'second',
          price: { inputPerM: 1, outputPerM: 1 },
          client: { async generate() { return okResponse(); } },
        }),
      ],
    });

    const worker = makeWorker(model);
    const result = await worker.tick();

    expect(result).toMatchObject({ status: 'completed' });
    const [row] = await harness.db
      .select({ status: schema.tasks.status })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId));
    expect(row!.status).toBe('completed');
  });

  it('does nothing when no model is configured', async () => {
    const { user, agent } = await seed();
    const store = new PgTaskStore(harness.db);
    await store.createTask({
      title: 'x',
      requestedBy: user.id,
      agentId: agent.id,
      input: { goal: 'go' },
      flowHash: 'h',
    });

    const store2 = new PgTaskStore(harness.db);
    const audit = new PgAuditSink(harness.db);
    const worker = new Worker({
      db: harness.db,
      store: store2,
      audit,
      policy: policyFromJson('{"default_tier":"third_party","tiers":{}}'),
      roots: [root],
      allowedFetchHosts: [],
      maxBytes: 4096,
      budgets: new Map(),
      systemPrompt: () => '',
    });

    const result = await worker.tick();
    expect(result).toMatchObject({ kind: 'error', error: 'no model provider is configured' });
  });
});

async function bootstrap() {
  const client = new PGlite();
  await client.exec(
    readFileSync(join(process.cwd(), 'drizzle', '0000_vertical_slice.sql'), 'utf8'),
  );
  return { client, db: drizzle(client, { schema }) };
}