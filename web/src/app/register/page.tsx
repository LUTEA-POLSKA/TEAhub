'use client';

import { useState } from 'react';
import Link from 'next/link';
import { api, endpoints, ApiRequestError } from '@/lib/api';
import { useSession } from '@/components/session-provider';

export default function RegisterPage() {
  const { refresh } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'user' | 'admin'>('user');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api(endpoints.register, {
        method: 'POST',
        body: JSON.stringify({ email, password, role }),
      });
      await refresh();
      setOk(true);
    } catch (err) {
      setError((err as ApiRequestError).message);
    } finally {
      setSubmitting(false);
    }
  }

  if (ok) {
    return (
      <div className="content" style={{ maxWidth: 420, margin: '8vh auto' }}>
        <h1 style={{ marginTop: 0 }}>Account created</h1>
        <p className="muted" style={{ marginTop: 8 }}>
          You are signed in. Head to <Link href="/tasks">Tasks</Link>.
        </p>
      </div>
    );
  }

  return (
    <div className="content" style={{ maxWidth: 420, margin: '8vh auto' }}>
      <h1 style={{ marginTop: 0 }}>Create account</h1>
      <p className="muted" style={{ marginTop: -8, marginBottom: 24 }}>
        TEAhub runs locally — sessions last 12 hours.
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
            autoComplete="new-password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={inputStyle}
          />
        </label>
        <label className="muted" style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
          Role
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as 'user' | 'admin')}
            style={{ ...inputStyle, appearance: 'auto' }}
          >
            <option value="user">User</option>
            <option value="admin">Admin</option>
          </select>
        </label>
        {error && <span style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</span>}
        <button type="submit" disabled={submitting} style={{ ...primaryBtn, opacity: submitting ? 0.6 : 1 }}>
          {submitting ? 'Creating…' : 'Create account'}
        </button>
      </form>
      <p className="muted" style={{ marginTop: 16, fontSize: 13 }}>
        Already have an account? <Link href="/login">Sign in</Link>
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