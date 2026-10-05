import type { Policy, RequestedPermission } from '../policy/policy';
import { type Verdict, decide, matches } from '../policy/policy';
import { type Tool, type ToolOutcome, failed } from './types';

/**
 * The only path from a model to an action.
 *
 * Three cuts, each of which can only ever narrow the result:
 *
 *   requested (what the agent declared)
 *     ∩ tier policy (what the operator allows)
 *     ∩ tool_constraints (what this agent may actually do here)
 *     = effective
 *
 * No cut can widen. A `require_human` verdict means the tool did not run — it
 * is not in the granted set, so nothing to execute. An unknown tool name is
 * denied rather than ignored, because a name that matches nothing is exactly
 * what a typo in a prompt injection looks like.
 */

export interface AgentIdentity {
  id: string;
  name: string;
  tier: import('../policy/policy').TrustTier;
  /** Tools this agent holds. Absence of a name is a denial. */
  grantedTools: string[];
  /** Per-tool limits: { "filesystem.write": { "maxBytes": 4096 } } */
  toolConstraints: Record<string, Record<string, unknown>>;
}

export interface AuditSink {
  record(entry: {
    actorType: 'user' | 'agent' | 'system';
    actorId?: string;
    taskId?: string;
    stepIndex?: number;
    action: string;
    target?: string;
    outcome: 'allowed' | 'blocked' | 'required_human' | 'error';
    detail?: Record<string, unknown>;
  }): Promise<void>;
}

export interface ToolRunnerDeps {
  policy: Policy;
  audit: AuditSink;
  /** Per-tool minimum bar, beyond the tier's own rules. */
  constraints?: Policy;
}

export class ToolRunner {
  private readonly tools = new Map<string, Tool>();

  constructor(private readonly deps: ToolRunnerDeps) {}

  /** A tool that is not registered cannot be called. Registration is not authority. */
  register<I, O>(tool: Tool<I, O>): this {
    this.tools.set(tool.name, tool as Tool);
    return this;
  }

  registered(): string[] {
    return [...this.tools.keys()];
  }

  async run(params: {
    agent: AgentIdentity;
    toolName: string;
    args: unknown;
    taskId?: string;
    stepIndex?: number;
    signal?: AbortSignal;
  }): Promise<ToolOutcome> {
    const { agent, toolName, args, taskId, stepIndex, signal } = params;

    const tool = this.tools.get(toolName);
    if (!tool) {
      await this.deps.audit.record({
        actorType: 'agent',
        actorId: agent.id,
        taskId,
        stepIndex,
        action: `tool.call:${toolName}`,
        outcome: 'blocked',
        detail: { reason: 'no such tool' },
      });
      return { kind: 'unknown_tool', name: toolName };
    }

    // Cut 1: does this agent hold the tool at all.
    if (!agent.grantedTools.includes(toolName)) {
      await this.block(agent, toolName, 'not granted to this agent', taskId, stepIndex);
      return {
        kind: 'blocked',
        permission: { kind: 'fs.read', resource: toolName },
        rule: 'agent permissions',
        reason: `${toolName} is not granted to this agent`,
      };
    }

    let typed: unknown;
    try {
      typed = tool.validate(args);
    } catch (error) {
      // Malformed arguments are the model's mistake, not a policy failure, and it
      // gets a value back so the loop can continue.
      await this.deps.audit.record({
        actorType: 'agent',
        actorId: agent.id,
        taskId,
        stepIndex,
        action: `tool.call:${toolName}`,
        outcome: 'error',
        detail: { reason: 'invalid arguments', message: (error as Error).message },
      });
      return {
        kind: 'executed',
        output: failed(`invalid arguments: ${(error as Error).message}`),
        // `typed` was never assigned, so `tool.permission` cannot be asked for a
        // real resource. A generic marker beats a crash in the one branch whose
        // entire job is to survive a bad model turn.
        permission: { kind: 'fs.read', resource: '<invalid arguments>' },
      };
    }

    const permission: RequestedPermission = tool.permission(typed as never);

    // Cut 2: the operator's tier rules. Only the requested permission is judged,
    // so a policy can never widen what the agent asked for.
    const decision = decide([permission], agent.tier, this.deps.policy);
    const judgement = decision.judgements[0];
    const verdict: Verdict = judgement?.verdict ?? 'deny';

    if (verdict === 'deny') {
      await this.block(agent, toolName, judgement?.reason ?? 'denied', taskId, stepIndex, permission);
      return {
        kind: 'blocked',
        permission,
        rule: judgement?.rule ?? 'no rule',
        reason: judgement?.reason ?? 'denied',
      };
    }

    if (verdict === 'require_human') {
      await this.deps.audit.record({
        actorType: 'agent',
        actorId: agent.id,
        taskId,
        stepIndex,
        action: `tool.call:${toolName}`,
        target: `${permission.kind}:${permission.resource ?? ''}`,
        outcome: 'required_human',
        detail: { rule: judgement?.rule, arguments: redact(typed) },
      });
      return {
        kind: 'gated',
        permission,
        rule: judgement?.rule ?? 'require_human',
        reason: judgement?.reason ?? 'needs a human',
      };
    }

    // Cut 3: per-tool constraints. Independent of the tier, and can only narrow.
    const constraint = agent.toolConstraints[toolName];
    if (constraint) {
      const violated = checkConstraints(typed, constraint);
      if (violated !== null) {
        await this.block(agent, toolName, violated, taskId, stepIndex, permission);
        return { kind: 'blocked', permission, rule: 'agent constraint', reason: violated };
      }
    }

    const output = await tool.execute(typed as never, signal);

    await this.deps.audit.record({
      actorType: 'agent',
      actorId: agent.id,
      taskId,
      stepIndex,
      action: `tool.call:${toolName}`,
      target: `${permission.kind}:${permission.resource ?? ''}`,
      outcome: output.ok ? 'allowed' : 'error',
      // The arguments are redacted, never the raw model output: a successful
      // `web.fetch` result is exactly the thing that must not land in a log.
      detail: {
        rule: judgement?.rule,
        ok: output.ok,
        size: output.size,
        contentType: output.contentType,
        error: output.error,
        arguments: redact(typed),
      },
    });

    return { kind: 'executed', output, permission };
  }

  private async block(
    agent: AgentIdentity,
    toolName: string,
    reason: string,
    taskId?: string,
    stepIndex?: number,
    permission?: RequestedPermission,
  ): Promise<void> {
    await this.deps.audit.record({
      actorType: 'agent',
      actorId: agent.id,
      taskId,
      stepIndex,
      action: `tool.call:${toolName}`,
      target: permission ? `${permission.kind}:${permission.resource ?? ''}` : undefined,
      outcome: 'blocked',
      detail: { reason },
    });
  }
}

/**
 * Arguments are logged, but only the shape of them. A path is useful in an
 * audit log; the content someone asked to write is not the log's business.
 */
function redact(args: unknown): Record<string, unknown> {
  if (typeof args !== 'object' || args === null) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (key === 'content') {
      out[key] = `<${typeof value === 'string' ? value.length : 0} chars>`;
    } else if (typeof value === 'string' && value.length > 200) {
      out[key] = `${value.slice(0, 200)}…`;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Per-tool limits an operator can put on one agent. Returns a reason or null. */
function checkConstraints(
  args: unknown,
  constraints: Record<string, unknown>,
): string | null {
  if (typeof args !== 'object' || args === null) return null;
  const record = args as Record<string, unknown>;

  const maxBytes = constraints.maxBytes;
  if (typeof maxBytes === 'number' && typeof record.content === 'string') {
    if (Buffer.byteLength(record.content, 'utf8') > maxBytes) {
      return `agent constraint: content exceeds ${maxBytes} bytes`;
    }
  }

  const allowedPaths = constraints.allowedPathPrefixes;
  if (Array.isArray(allowedPaths) && typeof record.path === 'string') {
    const ok = allowedPaths.some(
      (prefix) => typeof prefix === 'string' && matches(`${prefix}**`, record.path as string),
    );
    if (!ok) {
      return `agent constraint: path does not start with an allowed prefix`;
    }
  }

  return null;
}