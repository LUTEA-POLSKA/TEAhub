'use client';

import { useEffect, useState } from 'react';
import { api, endpoints, ApiRequestError } from '@/lib/api';
import { useSession } from '@/components/session-provider';
import { Badge, Card, EmptyState, Spinner } from '@/components/ui';

interface ApprovalRow {
  id: string;
  taskId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

export default function ApprovalsPage() {
  const { user } = useSession();
  const [rows, setRows] = useState<ApprovalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);

  async function load() {
    try {
      const data = await api<{ approvals: ApprovalRow[] }>(endpoints.approvals);
      setRows(data.approvals);
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

  async function decide(id: string, decision: 'approved' | 'denied') {
    setActing(id);
    setError(null);
    try {
      await api(endpoints.approval(id), {
        method: 'POST',
        body: JSON.stringify({ decision }),
      });
      await load();
    } catch (err) {
      setError((err as ApiRequestError).message);
    } finally {
      setActing(null);
    }
  }

  if (user?.role !== 'admin') {
    return (
      <div>
        <h1 style={{ margin: 0 }}>Approvals</h1>
        <p className="muted" style={{ marginTop: 8 }}>
          Only admins can decide approvals.
        </p>
      </div>
    );
  }

  return (
    <div>
      <h1 style={{ margin: 0, marginBottom: 4 }}>Approvals</h1>
      <p className="muted" style={{ margin: 0, marginBottom: 20 }}>
        Human decisions on actions the policy could not authorise on its own.
      </p>

      {loading ? (
        Spinner()
      ) : error ? (
        <span style={{ color: 'var(--danger)' }}>{error}</span>
      ) : rows.length === 0 ? (
        EmptyState({ title: 'Nothing waiting', detail: 'Approvals appear here when an action needs a human.' })
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {rows.map((row) => (
            <Card key={row.id}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 8 }}>
                <div>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-faint)' }}>{row.toolName}</span>
                  <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                    task {row.taskId.slice(0, 8)} Â· approval {row.id.slice(0, 8)}
                  </div>
                </div>
                {Badge({ status: 'pending' })}
              </div>
              <pre
                style={{
                  background: 'var(--bg-elevated-2)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-sm)',
                  padding: 10,
                  margin: 0,
                  fontSize: 12,
                  overflow: 'auto',
                  color: 'var(--text-dim)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  marginBottom: 12,
                }}
              >
                {JSON.stringify(row.arguments, null, 2)}
              </pre>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={() => void decide(row.id, 'approved')}
                  disabled={acting === row.id}
                  style={{ background: 'var(--ok)', color: '#06210f', border: 'none', borderRadius: 'var(--radius-sm)', padding: '7px 12px', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', opacity: acting === row.id ? 0.6 : 1 }}
                >
                  Approve
                </button>
                <button
                  onClick={() => void decide(row.id, 'denied')}
                  disabled={acting === row.id}
                  style={{ background: 'transparent', border: '1px solid var(--danger)', color: 'var(--danger)', borderRadius: 'var(--radius-sm)', padding: '7px 12px', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', opacity: acting === row.id ? 0.6 : 1 }}
                >
                  Deny
                </button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}


