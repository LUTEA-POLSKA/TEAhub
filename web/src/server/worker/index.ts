/**
 * TEAhub Worker Entrypoint
 *
 * A dedicated process so a human gate can stay open for days without holding a
 * request open. The loop is deliberately trivial: claim a task, run it, record
 * what happened, repeat. The behaviour itself lives in `Worker` and is covered
 * by tests; this file only wires it to configuration and the database.
 */
import { loadConfig, assertUsable, type Config } from '../http/config';
import { policyFromJson, denyAll } from '../policy/policy';
import { PgTaskStore } from '../db/task-store';
import { PgAuditSink } from '../db/audit-sink';
import { createFallbackClient, type Candidate, type Requirement } from '../ai/router';
import { createOpenAiCompatibleClient } from '../ai/openai-compatible';
import { Worker } from './worker';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../db/schema';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

const MAX_BYTES = 1024 * 1024;
const DEFAULT_INTERVAL_MS = 1000;

/** Build the provider fallback chain every agent is offered. */
function buildModel(config: Config) {
  const candidates: Candidate[] = config.providers.map((p) => ({
    id: p.id,
    provider: p.id,
    model: p.model,
    price: p.price,
    contextTokens: p.contextTokens,
    supportsTools: p.supportsTools,
    supportsVision: p.supportsVision,
    healthy: true,
    client: createOpenAiCompatibleClient({
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
      model: p.model,
      price: p.price,
    }),
  }));

  const requirement: Requirement = {
    effort: 'medium',
    cost: 'any',
    needsTools: true,
    needsVision: false,
    minContextTokens: 4096,
  };

  return createFallbackClient({
    req: requirement,
    candidates,
    onAttemptFailed: async (candidate, error) => {
      console.warn(`[worker] provider ${candidate.id} failed: ${error}`);
    },
  });
}

/** Fail closed: a policy that cannot be read is a policy that denies everything. */
function loadPolicy(path: string) {
  try {
    return policyFromJson(readFileSync(path, 'utf-8'));
  } catch (error) {
    console.warn(`[worker] policy at ${path} not usable (${(error as Error).message}); denying everything`);
    return denyAll();
  }
}

async function main(): Promise<void> {
  // 1. Config: fail closed, so a missing key or origin refuses to start.
  const config = loadConfig();
  assertUsable(config);

  // 2. Database. Dev bootstrap uses in-memory PGlite seeded from the migration,
  //    mirroring the test harness. A production worker should connect to a real
  //    Postgres via node-postgres (DATABASE_URL) - not yet in the dependency set.
  const client = new PGlite();
  const migration = await readFile('drizzle/0000_vertical_slice.sql', 'utf-8');
  await client.exec(migration);
  const db = drizzle(client, { schema });

  // 3. Wire the worker. modelFor returns a provider chain, never a single
  //    endpoint, so a provider outage surfaces as ProviderUnavailableError (a
  //    worker problem) rather than as a task failure.
  const worker = new Worker({
    db,
    store: new PgTaskStore(db),
    audit: new PgAuditSink(db),
    policy: loadPolicy(config.policyPath),
    roots: config.workspaceRoots,
    allowedFetchHosts: config.allowedFetchHosts,
    maxBytes: MAX_BYTES,
    budgets: new Map(),
    systemPrompt: (agent) => `${agent.systemPrompt} (${agent.systemPromptVersion})`,
    modelFor: () => buildModel(config),
  });

  // 4. Loop. `running` is flipped by a signal; the loop exits between ticks so a
  //    half-finished task and its DB writes are never cut in flight.
  let running = true;
  const stop = (signal: string) => {
    console.log(`[worker] received ${signal}, finishing current tick and exiting...`);
    running = false;
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  const intervalMs =
    Number.parseInt(process.env.WORKER_INTERVAL_MS ?? `${DEFAULT_INTERVAL_MS}`, 10) || DEFAULT_INTERVAL_MS;

  console.log('[worker] starting tick loop...');
  while (running) {
    try {
      const result = await worker.tick();
      if (result.kind !== 'idle') console.log('[worker]', JSON.stringify(result));
    } catch (error) {
      console.error('[worker] tick error:', error);
    }
    if (!running) break;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  console.log('[worker] shutting down.');
}

main().catch((error) => {
  console.error('[worker] fatal error:', error);
  process.exit(1);
});
