import { sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type { AuditSink } from '../tools/runner';
import * as schema from './schema';
import type { Db } from './task-store';

/**
 * The audit sink, writing to PostgreSQL.
 *
 * Append-only by construction: this module offers no update and no delete. A
 * sink that could rewrite history would make the table's shape irrelevant, so the
 * capability is absent rather than merely unused.
 */
export class PgAuditSink implements AuditSink {
  constructor(private readonly db: Db) {}

  async record(entry: {
    actorType: 'user' | 'agent' | 'system';
    actorId?: string;
    taskId?: string;
    stepIndex?: number;
    action: string;
    target?: string;
    outcome: 'allowed' | 'blocked' | 'required_human' | 'error';
    detail?: Record<string, unknown>;
  }): Promise<void> {
    await this.db.insert(schema.auditEvents).values({
      actorType: entry.actorType,
      actorId: entry.actorId,
      taskId: entry.taskId ?? null,
      stepIndex: entry.stepIndex ?? null,
      action: entry.action,
      target: entry.target ?? null,
      outcome: entry.outcome,
      detail: entry.detail ?? {},
    });
  }
}

/**
 * Redacts secrets before they are written.
 *
 * The audit log is the one place an operator is guaranteed to look, which makes
 * it the worst place for a key. Patterns cover the shapes a provider hands out;
 * anything unrecognised is left alone rather than mangled, because a mangled log
 * is worse than a readable one.
 */
const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9]{16,}/g,
  /gh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bBearer\s+[A-Za-z0-9._-]{20,}/gi,
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, '[redacted]');
  }
  return out;
}

/** Walks a detail object and redacts any string that looks like a credential. */
export function redactDetail(detail: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (typeof value === 'string') {
      out[key] = redactSecrets(value);
    } else if (Array.isArray(value)) {
      out[key] = value.map((v) => (typeof v === 'string' ? redactSecrets(v) : v));
    } else if (typeof value === 'object' && value !== null) {
      out[key] = redactDetail(value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Counts audit rows, for the one query the dashboard opens with.
 *
 * Kept next to the sink rather than in a route handler so the shape of the
 * query lives with the table it reads.
 */
export async function countByOutcome(db: Db): Promise<Record<string, number>> {
  const rows = await db
    .select({
      outcome: schema.auditEvents.outcome,
      count: sql<number>`count(*)::int`,
    })
    .from(schema.auditEvents)
    .groupBy(schema.auditEvents.outcome);

  return Object.fromEntries(rows.map((r) => [r.outcome, r.count]));
}