/**
 * TEAhub Worker Entrypoint
 */
import { loadConfig, assertUsable } from '../http/config';
import { rateWindow } from '../http/routes/state';
import { createFallbackClient } from '../ai/router';
import { createOpenAiCompatibleClient } from '../ai/openai-compatible';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '@/server/db/schema';
import { type Requirement, type Candidate } from '../ai/router';

async function main() {
  // 1. Load & validate config
  const config = loadConfig();
  assertUsable(config);

  // 2. Initialize database (PGlite for dev, replace with real Postgres in prod)
  const client = new PGlite();
  const sql = await import('fs').then(m => m.promises.readFile('drizzle/0000_vertical_slice.sql', 'utf-8'));
  await client.exec(sql);
  const db = drizzle(client, { schema });

  // 3. Build provider fallback chain
const providers: Candidate[] = config.providers.map(p => ({
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
      price: p.price
    })
  }));

  const requirement: Requirement = {
    effort: 'medium',
    cost: 'any',
    needsTools: true,
    needsVision: false,
    minContextTokens: 4096
  };

  const model = createFallbackClient({
    req: requirement,
    candidates: providers,
    onAttemptFailed: async (candidate, error) => {
      console.warn(`Provider ${candidate.id} failed: ${error}`);
    }
  });

  // 3. Initialize audit sink
  const audit = { record: async () => {} }; // TODO: wire to real sink

  // 4. Load policy
  const policy = { default_tier: 'third_party', tiers: {} };

  // 4. Initialize task store
  const store = new (await import('../db/task-store')).PgTaskStore(db);

  // 5. Build deps for Worker
  const writeLimiter = rateWindow(db);

  const deps = {
    db,
    audit: { record: async () => {} },
    config: { publicOrigin: 'http://localhost:3000' },
    policy: { default_tier: 'third_party', tiers: {} },
    roots: [],
    allowedFetchHosts: [],
    maxBytes: 1024 * 1024,
    budgets: new Map(),
    systemPrompt: (a: any) => `${a.systemPrompt} (${a.systemPromptVersion})`,
    modelFor: async () => model,
    writeLimiter
  };

  // Graceful shutdown
  let shuttingDown = false;
  async function shutdown(signal: string) {
    console.log(`[worker] Received ${signal}, shutting down...`);
    process.exit(0);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Main loop
  console.log('[worker] Starting tick loop...');
  const intervalMs = parseInt(process.env.WORKER_INTERVAL_MS ?? '1000', 10);

  async function tick() {
    console.log('[worker] tick');
  }

  await tick();
  const interval = setInterval(tick, parseInt(process.env.WORKER_INTERVAL_MS ?? '1000', 10));
  process.stdin.resume();
}

main().catch((error) => {
  console.error('[worker] Fatal error:', error);
  process.exit(1);
});