import { NextResponse } from 'next/server';
import { getConfig } from '@/server/http/deps';

export async function GET() {
  const config = getConfig();
  return NextResponse.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: '0.1.0',
    environment: process.env.NODE_ENV ?? 'development',
  }, {
    headers: {
      'cache-control': 'no-store',
    },
  });
}