import { NextResponse } from 'next/server';
import { cancelTaskRoute } from '@/server/http/routes/tasks';
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

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const route = cancelTaskRoute(await deps());
    return await route(request, { id });
  } catch (error) {
    console.error('Cancel task error:', error);
    return NextResponse.json(
      { error: { code: 'internal', detail: 'Cancel task failed' } },
      { status: 500 },
    );
  }
}



