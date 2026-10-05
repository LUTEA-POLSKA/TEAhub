import { NextResponse } from 'next/server';
import { logoutRoute } from '@/server/http/routes/auth';
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
    const config = getConfig();
    const client = new PGlite();
    const { drizzle } = await import('drizzle-orm/pglite');
    globalThis.__teahub_db = drizzle(new PGlite(), { schema });
  }
  return globalThis.__teahub_db!;
}

export async function POST(request: Request) {
  try {
    const db = await getDatabase();
    const config = getConfig();
    const deps = {
      db,
      audit: new PgAuditSink(db),
      config: getConfig(),
      policy: { default_tier: 'third_party', tiers: {} },
      roots: config.workspaceRoots,
      allowedFetchHosts: config.allowedFetchHosts,
      maxBytes: 1024 * 1024,
      budgets: new Map(),
      systemPrompt: (a: any) => `${a.systemPrompt} (${a.systemPromptVersion})`,
      modelFor: async () => { throw new Error('Provider not configured'); },
    };

    const route = logoutRoute(deps);
    return await route(request);
  } catch (error) {
    console.error('Logout error:', error);
    return Response.json({ error: { code: 'internal', detail: 'Logout failed' } }, { status: 500 });
  }
}