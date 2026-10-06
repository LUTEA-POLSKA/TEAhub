/**
 * Shared UI primitives.
 *
 * Inline styles are deliberate: the project ships next + react + zod and
 * nothing else, so a component-level style object is the honest minimum. Every
 * token here is also a CSS variable in globals.css, which is the one place to
 * restyle the product.
 */
import type { ReactNode } from 'react';

export function Badge({ status }: { status: string }) {
  const tone =
    status === 'completed' ? 'var(--ok)'
    : status === 'failed' || status === 'cancelled' ? 'var(--danger)'
    : status === 'running' ? 'var(--accent)'
    : status === 'waiting_approval' ? 'var(--warn)'
    : 'var(--text-dim)';
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 999,
        background: `${tone}22`,
        color: tone,
        fontSize: 11,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        fontWeight: 600,
      }}
    >
      {status}
    </span>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        padding: 16,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function Button({
  children,
  onClick,
  disabled,
  variant = 'primary',
  style,
}: {
  children: ReactNode;
  onClick?: () => void | Promise<void>;
  disabled?: boolean;
  variant?: 'primary' | 'danger' | 'ghost';
  style?: React.CSSProperties;
}) {
  const base: React.CSSProperties = {
    border: '1px solid var(--border-strong)',
    background: 'transparent',
    color: 'var(--text)',
    borderRadius: 'var(--radius-sm)',
    padding: '7px 12px',
    fontSize: 13,
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontFamily: 'inherit',
    opacity: disabled ? 0.5 : 1,
    ...style,
  };
  if (variant === 'primary') {
    base.background = 'var(--accent)';
    base.color = '#fff';
    base.borderColor = 'transparent';
  } else if (variant === 'danger') {
    base.color = 'var(--danger)';
    base.borderColor = 'var(--danger)';
  }
  return (
    <button type="button" style={base} disabled={disabled} onClick={() => void onClick?.()}>
      {children}
    </button>
  );
}

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      style={{
        background: 'var(--bg-elevated)',
        color: 'var(--text)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-sm)',
        padding: '8px 10px',
        fontSize: 14,
        outline: 'none',
        fontFamily: 'inherit',
        width: '100%',
        ...props.style,
      }}
    />
  );
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      style={{
        background: 'var(--bg-elevated)',
        color: 'var(--text)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-sm)',
        padding: '8px 10px',
        fontSize: 14,
        outline: 'none',
        fontFamily: 'inherit',
        width: '100%',
        resize: 'vertical',
        ...props.style,
      }}
    />
  );
}

export function EmptyState({ title, detail }: { title: string; detail?: string }) {
  return (
    <div
      style={{
        border: '1px dashed var(--border-strong)',
        borderRadius: 'var(--radius)',
        padding: 24,
        color: 'var(--text-dim)',
        textAlign: 'center',
      }}
    >
      <div style={{ marginBottom: 4 }}>{title}</div>
      {detail && <div style={{ fontSize: 12 }}>{detail}</div>}
    </div>
  );
}

export function Spinner() {
  return <span className="muted">…</span>;
}
