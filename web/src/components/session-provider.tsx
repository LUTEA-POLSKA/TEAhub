'use client';

import { useContext, createContext, useEffect, useState } from 'react';
import { api, endpoints, ApiRequestError } from '@/lib/api';

export interface SessionUser {
  id: string;
  role: 'admin' | 'user';
  email: string;
  name: string;
}

export interface SessionContextValue {
  user: SessionUser | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
  logout: () => Promise<void>;
}

export const SessionContext = createContext<SessionContextValue>({} as SessionContextValue);

export function useSession(): SessionContextValue {
  return useContext(SessionContext);
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api<{ user: SessionUser | null }>(endpoints.me)
      .then((data) => {
        if (!cancelled) setUser(data.user ?? null);
      })
      .catch((err: ApiRequestError) => {
        // 401 is the expected state of an unauthenticated page, not a failure.
        if (err.status !== 401 && !cancelled) {
          setError(err.message);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const logout = async () => {
    try {
      await api(endpoints.logout, { method: 'POST' });
    } finally {
      setUser(null);
      setTick((t) => t + 1);
    }
  };

  return (
    <SessionContext.Provider value={{ user, loading, error, refresh: () => setTick((t) => t + 1), logout }}>
      {children}
    </SessionContext.Provider>
  );
}