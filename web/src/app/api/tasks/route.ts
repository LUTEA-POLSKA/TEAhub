import { NextResponse } from 'next/server';
import { createTaskRoute, listTasksRoute } from '@/server/http/routes/tasks';
import { getConfig } from '@/server/http/deps';

export async function POST(request: Request) {
  try {
    const config = getConfig();
    const deps = {
      db: null, // TODO: wire up database
      audit: { record: async () => {} },
      config: getConfig(),
      policy: { default_tier: 'third_party', tiers: {} },
      roots: config.workspaceRoots,
      allowedFetchHosts: config.allowedFetchHosts,
      maxBytes: 1024 * 1024,
      budgets: new Map(),
      systemPrompt: (a: any) => `${a.systemPrompt} (${a.systemPromptVersion})`,
      modelFor: async () => { throw new Error('Provider not configured'); },
    };

    // TODO: wire up the route properly
    return NextResponse.json({ error: { code: 'not_implemented', detail: 'Route not yet wired' } }, { status: 501 });
  } catch (error) {
    console.error('Create task error:', error);
    return NextResponse.json({ error: { code: 'internal', detail: 'Create task failed' } }, { status: 500 });
  }
}

export async function GET(request: Request) {
  try {
    // TODO: implement list tasks
    return NextResponse.json({ tasks: [] });
  } catch (error) {
    console.error('List tasks error:', error);
    return NextResponse.json({ error: { code: 'internal', detail: 'List tasks failed' } }, { status: 500 });
  }
}