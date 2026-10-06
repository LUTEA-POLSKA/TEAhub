'use client';

import { useState } from 'react';
import Link from 'next/link';
import { api, endpoints, ApiRequestError } from '@/lib/api';
import { useSession } from '@/components/session-provider';

export default function LoginPage() {
  const { refresh } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api<{ user: unknown }>(endpoints.login, {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      await refresh();
    } catch (err) {
      const e = err as ApiRequestError;
      setError(e.code === 'rate_limited' ? 'Too many attempts. Try again later.' : 'That email and password do not match.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="content" style={{ maxWidth: 420, margin: '8vh auto' }}>
      <h1 style={{ marginTop: 0 }}>Sign in</h1>
      <p className="muted" style={{ marginTop: -8, marginBottom: 24 }}>
        TEAhub runs locally. Sessions last 12 hours.
      </p>
      <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <label className="muted" style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
          Email
          <input
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={inputStyle}
          />
        </label>
        <label className="muted" style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
          Password
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={inputStyle}
          />
        </label>
        {error && <span style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</span>}
        <button type="submit" disabled={submitting} style={{ ...primaryBtn, opacity: submitting ? 0.6 : 1 }}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <p className="muted" style={{ marginTop: 16, fontSize: 13 }}>
        No account? <Link href="/register">Register</Link>
      </p>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: 'var(--bg-elevated)',
  color: 'var(--text)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
  padding: '9px 11px',
  fontSize: 14,
  outline: 'none',
  fontFamily: 'inherit',
};

const primaryBtn: React.CSSProperties = {
  background: 'var(--accent)',
  color: '#fff',
  border: 'none',
  borderRadius: 'var(--radius-sm)',
  padding: '10px 14px',
  fontSize: 14,
  cursor: 'pointer',
  fontFamily: 'inherit',
};