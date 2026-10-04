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
  stepIndex: number;
  kind: 'model_call' | 'tool_call' | 'gate';
  state: 'running' | 'completed' | 'failed';
  result?: Record<string, unknown>;
  error?: string;
}

export interface StepStore {
  /** The memo for a step, if it already ran. The loop must never recompute one. */
  read(taskId: string, stepIndex: number): Promise<RecordedStep | undefined>;

  /** Commits the memo. A second write at the same index must be rejected by the store. */
  write(taskId: string, step: RecordedStep): Promise<void>;

  /**
   * The first step that is not fully recorded.
   *
   * A step is variable-length, so the layout cannot be derived from a fixed
   * stride. The model memo at index `2n` carries `toolCallCount`, and the tool
   * calls that follow occupy `2n+1 … 2n+count`. A step counts as complete only
   * when its model memo is `completed` **and** every one of its tool records is
   * present and `completed`. A failed or absent tool record leaves the step
   * unfinished, which is what sends a resumed run back to it instead of past it.
   */
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