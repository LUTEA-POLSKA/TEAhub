import { NextResponse } from 'next/server';
import { resolveSession, SESSION_COOKIE } from '@/server/auth/auth';
import { getConfig } from '@/server/http/deps';

export async function GET(request: Request) {
  try {
    const config = getConfig();
    // TODO: wire up database
    const token = request.headers.get('cookie')?.split(';').find(c => c.trim().startsWith(SESSION_COOKIE + '='))?.split('=')[1];
    
    if (!token) {
      return NextResponse.json({ user: null });
    }
    
    // TODO: wire up database session resolution
    return NextResponse.json({ user: null });
  } catch (error) {
    console.error('Me error:', error);
    return NextResponse.json({ user: null });
  }
}