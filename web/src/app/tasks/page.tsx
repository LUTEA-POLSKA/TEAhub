'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, endpoints, ApiRequestError } from '@/lib/api';
import { useSession } from '@/components/session-provider';
import { Badge, Card, EmptyState, Spinner } from '@/components/ui';

interface TaskRow {
  id: string;
  title: string;
  status: string;
  queuedAt: string | null;
  finishedAt: string | null;
}

export default function TasksPage() {
  const { user } = useSession();
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const data = await api<{ tasks: TaskRow[] }>(endpoints.tasks);
      setTasks(data.tasks);
    } catch (err) {
      const e = err as ApiRequestError;
      if (e.status !== 401) setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function cancel(id: string) {
    try {
      await api(endpoints.task(id), { method: 'POST' });
      await load();
    } catch (err) {
      setError((err as ApiRequestError).message);
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <h1 style={{ margin: 0 }}>Tasks</h1>
          <p className="muted" style={{ margin: '4px 0 0' }}>
            {user?.role === 'admin' ? 'All tasks' : 'Your tasks'}
          </p>
        </div>
        <Link href="/tasks/new">
          <button style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)', padding: '9px 14px', fontSize: 14, cursor: 'pointer', fontFamily: 'inherit' }}>
            + New task
          </button>
        </Link>
      </div>

      {loading ? (
        Spinner()
      ) : error ? (
        <span style={{ color: 'var(--danger)' }}>{error}</span>
      ) : tasks.length === 0 ? (
        EmptyState({ title: 'No tasks yet', detail: 'Create one to get started.' })
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {tasks.map((task) => (
            <Card key={task.id} style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-faint)' }}>{task.id.slice(0, 8)}</span>
                  {Badge({ status: task.status })}
                </div>
                <div style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{task.title}</div>
              </div>
              {['queued', 'running', 'waiting_approval'].includes(task.status) && (
                <button
                  onClick={() => void cancel(task.id)}
                  style={{ background: 'transparent', border: '1px solid var(--border-strong)', color: 'var(--text-dim)', borderRadius: 'var(--radius-sm)', padding: '6px 10px', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' }}
                >
                  Cancel
                </button>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}


