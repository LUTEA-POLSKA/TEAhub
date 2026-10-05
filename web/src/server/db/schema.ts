import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// Eight tables. §34 listed nine; `tools` and `provider_metadata` became config
// in STEP 7 of the architecture proposal — three tools and at most two providers
// do not justify a registry table.

export const taskStatus = pgEnum('task_status', [
  'queued',
  'running',
  'waiting_approval',
  'completed',
  'failed',
  'cancelled',
]);

export const stepState = pgEnum('step_state', ['running', 'completed', 'failed']);

export const stepKind = pgEnum('step_kind', [
  'model_call',
  'tool_call',
  'gate',
]);

export const outcome = pgEnum('outcome', [
  'allowed',
  'blocked',
  'required_human',
  'error',
]);

export const userRole = pgEnum('user_role', ['admin', 'user']);

/**
 * Provenance of an agent, named after the Rust contract in src/policy.rs rather
 * than after a flattering adjective. `standard` and `trusted` say how good
 * something is; `builtin`, `local` and `third_party` say where it came from,
 * which is the question the policy engine actually asks.
 */
export const agentTier = pgEnum('agent_tier', [
  'builtin',
  'local',
  'third_party',
  'untrusted',
]);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    role: userRole('role').notNull().default('user'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex('users_email_idx').on(sql`lower(${t.email})`)],
);

export const sessions = pgTable(
  'sessions',
  {
    // Session id is the opaque cookie value, so it is text and not a uuid:
    // a uuid would leak a guessable structure to whoever holds the cookie.
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const agents = pgTable('agents', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  description: text('description'),

  /**
   * Persisted prompt text becomes a signature problem: an old step recorded
   * under prompt v1 cannot be resumed against v2 without the answer changing.
   * Version the prompt from the first commit. §15 of the research.
   */
  systemPromptVersion: text('system_prompt_version').notNull(),
  systemPrompt: text('system_prompt').notNull(),

  tier: agentTier('tier').notNull().default('third_party'),
  enabled: boolean('enabled').notNull().default(false),

  /**
   * 0–100. Drops on every blocked action, recovers slowly on success.
   * A tier is derived from this, never the other way round.
   */
  trustScore: integer('trust_score').notNull().default(0),

  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const agentPermissions = pgTable(
  'agent_permissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    /** ['filesystem.read', 'filesystem.write', 'web.fetch'] */
    tools: text('tools').array().notNull().default(sql`ARRAY[]::text[]`),
    /** Per-tool limits: { "filesystem.write": { "requireApproval": true } } */
    toolConstraints: jsonb('tool_constraints')
      .$type<Record<string, Record<string, unknown>>>()
      .notNull()
      .default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex('agent_permissions_agent_idx').on(t.agentId)],
);

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: text('title').notNull(),
    status: taskStatus('status').notNull().default('queued'),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => users.id),
    agentId: uuid('agent_id').references(() => agents.id),

    input: jsonb('input').$type<Record<string, unknown>>().notNull(),

    /**
     * sha256 of the flow definition, fixed at task creation. On resume it must
     * still match; otherwise the task is refused loudly rather than replayed
     * against a changed definition. A silent divergent replay is the bug you
     * hunt for six months later.
     */
    flowHash: text('flow_hash').notNull(),

    output: jsonb('output').$type<Record<string, unknown>>(),
    error: text('error'),

    /**
     * Cancellation lives in the database, not in an AbortSignal. A signal dies
     * with the process — and cancelling is exactly what you want when the
     * process is the thing that is stuck.
     */
    cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true }),

    queuedAt: timestamp('queued_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('tasks_status_idx').on(t.status),
    index('tasks_requested_by_idx').on(t.requestedBy),
  ],
);

export const taskSteps = pgTable(
  'task_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    /**
     * The logical step, distinct from `step_index`.
     *
     * A step is variable-length — one with three tool calls occupies four
     * records — so the resume decision cannot be derived from a fixed stride.
     * `step_no` carries the grouping, `step_index` the order.
     */
    stepNo: integer('step_no').notNull().default(0),
    stepIndex: integer('step_index').notNull(),
    kind: stepKind('kind').notNull(),
    state: stepState('state').notNull().default('running'),
    result: jsonb('result').$type<Record<string, unknown>>(),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    /**
     * The step memo, and the single most important constraint in this schema.
     *
     * It makes step replay idempotent: a worker that crashes after an LLM call
     * but before the commit re-reads the existing row instead of paying for the
     * call twice. This is the countermeasure to LangGraph's `interrupt()`, which
     * re-executes the whole node and therefore re-runs every side effect in it.
     */
    uniqueIndex('task_steps_task_index_idx').on(t.taskId, t.stepIndex),
    index('task_steps_task_idx').on(t.taskId),
    index('task_steps_task_step_idx').on(t.taskId, t.stepNo),
  ],
);

export const approvals = pgTable(
  'approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    stepId: uuid('step_id')
      .notNull()
      .references(() => taskSteps.id, { onDelete: 'cascade' }),

    toolName: text('tool_name').notNull(),
    arguments: jsonb('arguments')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),

    /** null means pending. Kept in its own table so "which gates are waiting" is
     *  a query, not a scan across task rows. CrewAI separates it the same way. */
    decision: text('decision', { enum: ['approved', 'denied'] }),
    decidedBy: uuid('decided_by').references(() => users.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('approvals_task_idx').on(t.taskId),
    index('approvals_pending_idx').on(t.decision),
  ],
);

/**
 * Append-only. There is deliberately no `updated_at` and no delete path: an
 * audit row that can be rewritten is not an audit row.
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    at: timestamp('at', { withTimezone: true })
      .notNull()
      .defaultNow(),

    actorType: text('actor_type', {
      enum: ['user', 'agent', 'system'],
    }).notNull(),
    actorId: text('actor_id'),

    taskId: uuid('task_id'),
    /**
     * The record index within the task, not a foreign key to `task_steps.id`.
     *
     * The loop knows an index; the row has a uuid. Conflating the two meant a
     * string index was written into a uuid column and every audit insert for a
     * tool call failed. The audit log records *what happened*, and an index
     * survives the row it points at.
     */
    stepIndex: integer('step_index'),
    agentId: uuid('agent_id'),

    action: text('action').notNull(),
    target: text('target'),
    outcome: outcome('outcome').notNull(),

    /**
     * Model, token counts, normalised cost, TTFT, tool schema hash. Redacted
     * before it is written — never store a raw secret or raw PII here.
     * The three fields worth copying from Langfuse are `provided_by`, the
     * normalised cost, and a separate TTFT column.
     */
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [
    index('audit_events_task_idx').on(t.taskId),
    index('audit_events_at_idx').on(t.at),
    index('audit_events_actor_idx').on(t.actorType, t.actorId),
  ],
);

export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(sessions),
  tasks: many(tasks),
}));

export const agentsRelations = relations(agents, ({ one, many }) => ({
  permissions: one(agentPermissions, {
    fields: [agents.id],
    references: [agentPermissions.agentId],
  }),
  tasks: many(tasks),
}));

export const tasksRelations = relations(tasks, ({ one, many }) => ({
  requester: one(users, {
    fields: [tasks.requestedBy],
    references: [users.id],
  }),
  agent: one(agents, { fields: [tasks.agentId], references: [agents.id] }),
  steps: many(taskSteps),
  approvals: many(approvals),
}));

export const taskStepsRelations = relations(taskSteps, ({ one, many }) => ({
  task: one(tasks, { fields: [taskSteps.taskId], references: [tasks.id] }),
  approvals: many(approvals),
}));

export const approvalsRelations = relations(approvals, ({ one }) => ({
  task: one(tasks, { fields: [approvals.taskId], references: [tasks.id] }),
  step: one(taskSteps, { fields: [approvals.stepId], references: [taskSteps.id] }),
  decider: one(users, { fields: [approvals.decidedBy], references: [users.id] }),
}));

export type User = typeof users.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type TaskStep = typeof taskSteps.$inferSelect;
export type Approval = typeof approvals.$inferSelect;
export type Agent = typeof agents.$inferSelect;
export type AgentPermission = typeof agentPermissions.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type TaskStatus = (typeof taskStatus.enumValues)[number];
export type Outcome = (typeof outcome.enumValues)[number];
export type AgentTier = (typeof agentTier.enumValues)[number];