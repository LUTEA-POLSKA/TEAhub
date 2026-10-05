import { NextResponse } from 'next/server';
import { cancelTaskRoute } from '@/server/http/routes/tasks';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    // TODO: wire up properly
    return NextResponse.json({ error: { code: 'not_implemented', detail: 'Route not yet wired' } }, { status: 501 });
  } catch (error) {
    console.error('Cancel task error:', error);
    return NextResponse.json({ error: { code: 'internal', detail: 'Cancel task failed' } }, { status: 500 });
  }
}