import { NextResponse } from 'next/server';
import { listApprovalsRoute, decideApprovalRoute } from '@/server/http/routes/approvals';

export async function GET() {
  try {
    // TODO: implement
    return NextResponse.json({ approvals: [] });
  } catch (error) {
    console.error('List approvals error:', error);
    return NextResponse.json({ error: { code: 'internal', detail: 'List approvals failed' } }, { status: 500 });
  }
}