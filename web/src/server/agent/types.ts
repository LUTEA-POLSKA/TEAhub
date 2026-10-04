import type { RequestedPermission } from '../policy/policy';
import type { ToolOutcome } from '../tools/types';

/**
 * Where a run's progress lives.
 *
 * The interface is deliberately narrow so the loop can be tested without a
 * database, and deliberately about *steps* rather than about a run document,
 * because the step is the unit that has to be replayable.
 */

export interface RecordedStep {
  /**
   * The logical step this record belongs to. Distinct from the record index:
   * a step is variable-length, so step 0 with three tool calls occupies four
   * records, and a fixed stride would collide with the next step's memo.
   */
  stepNo: number;
  stepIndex: number;
  kind: 'model_call' | 'tool_call' | 'gate';
  state: 'running' | 'completed' | 'failed';
  result?: Record<string, unknown>;
  error?: string;
}

export interface StepStore {
  /** The memo for a record slot, if it already ran. The loop must never recompute one. */
  read(taskId: string, stepIndex: number): Promise<RecordedStep | undefined>;

  /** Every record for a task, ordered by index. The resume decision is made from this. */
  readAll(taskId: string): Promise<RecordedStep[]>;

  /** Commits the memo. A second write at the same index must be rejected by the store. */
  write(taskId: string, step: RecordedStep): Promise<void>;

  /** The next free record slot. A plain allocation, with no opinion on completeness. */
  nextIndex(taskId: string): Promise<number>;

  /** Set from outside the loop: a cancel arrives while a model call is in flight. */
  isCancelRequested(taskId: string): Promise<boolean>;

  /** Marks the run as waiting on a human. The loop does not decide this; the gate does. */
  markWaitingApproval(taskId: string, stepId: string): Promise<void>;
}

export interface ModelMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolName?: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
}

export type FinishReason =
  | 'stop'
  | 'length'
  | 'tool_calls'
  | 'content_filter'
  | 'error'
  | 'cancelled';

export interface ModelResponse {
  text: string;
  toolCalls: Array<{ id: string; name: string; args: unknown }>;
  finishReason: FinishReason;
  usage: { inputTokens: number; outputTokens: number };
  /**
   * Undefined when the price is not known. Never 0 — a zero cost claim is a
   * claim, and a wrong one is how a budget silently stops binding.
   */
  costUsd?: number;
  model: string;
}

export interface ModelClient {
  generate(req: {
    system: string;
    messages: ModelMessage[];
    tools: ToolSpec[];
    signal?: AbortSignal;
  }): Promise<ModelResponse>;
}

/**
 * The first logical step that is not fully recorded.
 *
 * A step is complete when its model record is `completed` and every tool record
 * it announced is present and `completed`. The model record carries
 * `toolCallCount`, so the grouping is read from the data rather than guessed from
 * a stride — a fixed `2n` layout collides as soon as one step makes three tool
 * calls, because the third tool's index is where the next step's memo belongs.
 *
 * A `failed` tool record makes its step incomplete, which is what sends a resumed
 * run back to it. The runtime then refuses to retry in place rather than
 * overwriting the record.
 */
export function firstIncompleteStep(records: RecordedStep[]): number {
  const byStep = new Map<number, RecordedStep[]>();
  for (const record of records) {
    const list = byStep.get(record.stepNo) ?? [];
    list.push(record);
    byStep.set(record.stepNo, list);
  }

  // Counting upward from zero rather than over the recorded keys: a gap means an
  // unfinished step, not the end of the run. Records are appended in order, so a
  // later step cannot exist without the earlier ones — but if one is missing, the
  // run belongs there.
  for (let stepNo = 0; ; stepNo += 1) {
    const group = byStep.get(stepNo);
    if (!group) return stepNo;

    const model = group.find((r) => r.kind === 'model_call');
    if (!model || model.state !== 'completed') return stepNo;

    const count = Number(model.result?.toolCallCount ?? 0);
    const tools = group.filter((r) => r.kind === 'tool_call');
    if (tools.length < count) return stepNo;
    if (tools.some((t) => t.state !== 'completed')) return stepNo;
  }
}

/** What the loop reports back. */
export type RunResult =
  | { status: 'completed'; text: string; steps: number; usage: Usage }
  | {
      status: 'waiting_approval';
      stepId: string;
      permission: RequestedPermission;
      rule: string;
      reason: string;
      steps: number;
      usage: Usage;
    }
  | { status: 'blocked'; reason: string; steps: number; usage: Usage }
  | { status: 'cancelled'; steps: number; usage: Usage }
  | { status: 'budget_exhausted'; why: string; steps: number; usage: Usage }
  | {
      status: 'incomplete';
      /**
       * The model ran out of output tokens mid-thought. Recorded rather than
       * treated as success: a truncated answer that looks complete is worse than
       * a visible failure, because nothing downstream can tell the difference.
       */
      why: string;
      steps: number;
      usage: Usage;
    }
  | { status: 'failed'; error: string; steps: number; usage: Usage };

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** True when at least one call had an unknown price, so `costUsd` is a floor. */
  costPartial: boolean;
}

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, costUsd: 0, costPartial: false };
}