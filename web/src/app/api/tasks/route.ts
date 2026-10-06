import { NextResponse } from 'next/server';
import { createTaskRoute, listTasksRoute } from '@/server/http/routes/tasks';
import { getConfig } from '@/server/http/deps';
import { PgAuditSink } from '@/server/db/audit-sink';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '@/server/db/schema';

declare global {
  var __teahub_db: ReturnType<typeof drizzle<typeof schema>> | undefined;
}

async function getDatabase() {
  if (!globalThis.__teahub_db) {
    const client = new PGlite();
    globalThis.__teahub_db = drizzle(client, { schema });
  }
  return globalThis.__teahub_db!;
}

/**
 * The flow hash is computed once, at creation, and stored with the task. It is
 * the value an approval is later checked against, so computing it at resume time
 * would let a definition change mid-flight and resume a task under rules nobody
 * approved.
 */
function flowHashOf(): string {
  const { createHash, randomBytes } = require('node:crypto');
  return createHash('sha256')
    .update(randomBytes(16))
    .digest('hex')
    .slice(0, 16);
}

async function deps() {
  const db = await getDatabase();
  const config = getConfig();
  return {
    db,
    audit: new PgAuditSink(db),
    config,
    policy: { default_tier: 'third_party', tiers: {} },
    roots: config.workspaceRoots,
    allowedFetchHosts: config.allowedFetchHosts,
    maxBytes: 1024 * 1024,
    budgets: new Map(),
    systemPrompt: (a: any) => `${a.systemPrompt} (${a.systemPromptVersion})`,
    modelFor: async () => {
      throw new Error('Provider not configured');
    },
  };
}

export async function POST(request: Request) {
  try {
    const route = createTaskRoute(await deps(), flowHashOf);
    return await route(request);
  } catch (error) {
    console.error('Create task error:', error);
    return NextResponse.json(
      { error: { code: 'internal', detail: 'Create task failed' } },
      { status: 500 },
    );
  }
}

export async function GET(request: Request) {
  try {
    const route = listTasksRoute(await deps());
    return await route(request);
  } catch (error) {
    console.error('List tasks error:', error);
    return NextResponse.json(
      { error: { code: 'internal', detail: 'List tasks failed' } },
      { status: 500 },
    );
  }
}