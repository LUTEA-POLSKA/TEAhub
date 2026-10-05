import { NextResponse } from 'next/server';
import { decideApprovalRoute } from '@/server/http/routes/approvals';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // TODO: implement
    return NextResponse.json({ error: { code: 'not_implemented', detail: 'Route not yet wired' } }, { status: 501 });
  } catch (error) {
    console.error('Decide approval error:', error);
    return NextResponse.json({ error: { code: 'internal', detail: 'Decide approval failed' } }, { status: 500 });
  }
}