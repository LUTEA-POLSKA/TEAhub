'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, endpoints, ApiRequestError } from '@/lib/api';
import { useSession } from '@/components/session-provider';
import { Button, EmptyState, TextInput, TextArea } from '@/components/ui';

export default function NewTaskPage() {
  const router = useRouter();
  const { user, loading } = useSession();
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (loading) return null;
  if (!user) {
    return EmptyState({ title: 'Sign in first', detail: 'You need an account to create tasks.' });
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api<{ taskId: string; status: string }>(endpoints.tasks, {
        method: 'POST',
        body: JSON.stringify({ title, goal }),
      });
      router.push('/tasks');
    } catch (err) {
      setError((err as ApiRequestError).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ maxWidth: 640 }}>
      <h1 style={{ margin: 0, marginBottom: 4 }}>New task</h1>
      <p className="muted" style={{ margin: 0, marginBottom: 24 }}>
        Describe what you want done. The agent runs it and stops for a human if the
        policy cannot authorise an action.
      </p>
      <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <label className="muted" style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
          Title
          <TextInput
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Summarise the task in one line"
            required
            maxLength={200}
          />
        </label>
        <label className="muted" style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
          Goal
          <TextArea
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="What should the agent actually do?"
            required
            maxLength={20_000}
            rows={6}
          />
        </label>
        {error && <span style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</span>}
        <div style={{ display: 'flex', gap: 8 }}>
          <Button variant="primary" disabled={submitting} onClick={() => void onSubmit({ preventDefault: () => {} } as React.FormEvent)}>
            {submitting ? 'Creating…' : 'Create task'}
          </Button>
        </div>
      </form>
    </div>
  );
}