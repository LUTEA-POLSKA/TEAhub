import { type AuditSink } from '../tools/runner';
import type { RequestedPermission } from '../policy/policy';
import {
  type FinishReason,
  type ModelClient,
  type ModelMessage,
  type RecordedStep,
  type RunResult,
  type StepStore,
  type ToolSpec,
  type Usage,
  emptyUsage,
  firstIncompleteStep,
} from './types';

export interface Budget {
  maxSteps: number;
  maxOutputTokens: number;
  /** Undefined disables the money check. An unknown price never counts as free. */
  maxCostUsd?: number;
}

export interface AgentRuntimeDeps {
  model: ModelClient;
  store: StepStore;
  audit: AuditSink;
  tools: ToolSpec[];
  system: string;
  budget: Budget;
  /**
   * The policy-gated entry point. The loop has no reference to any tool
   * implementation — only to this, which consults the policy before anything
   * runs. That is the same chokepoint the ToolRunner provides for every other
   * caller.
   */
  callTool: (params: {
    agentId: string;
    toolName: string;
    args: unknown;
    taskId: string;
    stepId: string;
    signal?: AbortSignal;
  }) => Promise<
    | { kind: 'executed'; output: { ok: boolean; data?: unknown; error?: string } }
    | { kind: 'gated'; permission: RequestedPermission; rule: string; reason: string }
    | { kind: 'blocked'; reason: string }
    | { kind: 'unknown_tool'; name: string }
  >;
}

export interface RunParams {
  taskId: string;
  agentId: string;
  prompt: string;
  signal?: AbortSignal;
}

/**
 * A single agent, expressed as a loop.
 *
 * A graph engine would buy parallelism, per-node retry and sub-workflows. The
 * MVP has none of those, and one agent is a loop. `langgraph` is 74k lines of
 * that machinery; this is the part of it that a one-agent MVP actually needs.
 *
 * The loop is written to be *resumable*, which is the property the whole design
 * hangs on:
 *
 *  * The memo is read **before** each model call, never after. A worker that
 *    crashed after paying for a call re-reads it instead of paying twice.
 *  * The gate is its own step. Never in the same step as a model call — that is
 *    exactly LangGraph's `interrupt()` trap, where resuming re-executes the node
 *    and every side effect in it runs again.
 *  * Cancellation is polled from the store *and* signalled in-process. The flag
 *    survives the process; the signal makes an in-flight call give up promptly.
 */
export async function runAgent(
  deps: AgentRuntimeDeps,
  params: RunParams,
): Promise<RunResult> {
  const { model, store, audit, tools, system, budget, callTool } = deps;
  const usage = emptyUsage();
  const messages: ModelMessage[] = [{ role: 'user', content: params.prompt }];

  // Record slots are allocated monotonically and carry no opinion about
  // completeness. The *logical* step to resume at is derived from the records
  // themselves — see `firstIncompleteStep`, and the comment there on why a fixed
  // stride does not survive a step with more than one tool call.
  let recordIndex = await store.nextIndex(params.taskId);
  // Held in memory and appended to as the loop writes, so a resumed run looks up
  // its own records by step rather than by a freshly allocated slot. Reading by
  // slot would miss every existing memo and re-run the whole step.
  const records = await store.readAll(params.taskId);
  let step = firstIncompleteStep(records);

  const recordFor = (stepNo: number, kind: RecordedStep['kind']): RecordedStep | undefined =>
    records.find((r) => r.stepNo === stepNo && r.kind === kind);

  /**
   * Write a record to the store and keep the in-memory copy in step, so the
   * replay lookups above see what this run just wrote. Two sources of truth for
   * "what has happened" is how a resume ends up re-running a tool.
   */
  const record = async (stepNo: number, value: RecordedStep): Promise<void> => {
    await store.write(params.taskId, value);
    records.push(value);
  };

  for (; step < budget.maxSteps; step++) {
    if (await store.isCancelRequested(params.taskId)) {
      return { status: 'cancelled', steps: step, usage };
    }
    if (params.signal?.aborted) {
      return { status: 'cancelled', steps: step, usage };
    }

    // --- model call, memoised -------------------------------------------
    const memoKey = recordIndex++;
    const memo = recordFor(step, 'model_call');

    let response;
    if (memo?.result) {
      // Replayed, not recomputed. This is the whole point of the memo.
      response = memo.result as unknown as Awaited<ReturnType<ModelClient['generate']>>;
      await audit.record({
        actorType: 'system',
        taskId: params.taskId,
        action: 'model.replay',
        outcome: 'allowed',
        detail: { step, model: response.model, reused: true },
      });
    } else {
      try {
        response = await model.generate({ system, messages, tools, signal: params.signal });
      } catch (error) {
        await record(step, {
          stepIndex: memoKey,
          stepNo: step,
          kind: 'model_call',
          state: 'failed',
          error: (error as Error).message,
        });
        return { status: 'failed', error: (error as Error).message, steps: step, usage };
      }

      await record(step, {
        stepIndex: memoKey,
        stepNo: step,
        kind: 'model_call',
        state: 'completed',
        // toolCallCount is what lets a resumed run reconstruct the grouping. With
        // it, a step that announced three tool calls is known to need three
        // records, so a missing one cannot be mistaken for the end of the step.
        result: {
          ...(response as unknown as Record<string, unknown>),
          toolCallCount: response.toolCalls.length,
        },
      });
    }

    usage.inputTokens += response.usage.inputTokens;
    usage.outputTokens += response.usage.outputTokens;
    if (response.costUsd === undefined) {
      usage.costPartial = true;
    } else {
      usage.costUsd += response.costUsd;
    }

    // Budget is checked after the call, not before, because the point of a
    // budget is to stop *future* spending, not to forbid the call in progress.
    if (usage.outputTokens > budget.maxOutputTokens) {
      return {
        status: 'budget_exhausted',
        why: `output tokens ${usage.outputTokens} exceed ${budget.maxOutputTokens}`,
        steps: step,
        usage,
      };
    }
    if (budget.maxCostUsd !== undefined && !usage.costPartial && usage.costUsd > budget.maxCostUsd) {
      return {
        status: 'budget_exhausted',
        why: `cost ${usage.costUsd.toFixed(4)} USD exceeds ${budget.maxCostUsd}`,
        steps: step,
        usage,
      };
    }

    // A truncated answer that reports `length` is not a finished answer. Only one
    // of the thirteen runtimes surveyed checks this; without it a cut-off
    // response keeps a task alive as though it had concluded.
    if (response.finishReason === 'length') {
      await record(step, {
        stepIndex: recordIndex++,
        stepNo: step,
        kind: 'model_call',
        state: 'failed',
        error: 'finish_reason=length: the model ran out of output tokens mid-answer',
      });
      return {
        status: 'incomplete',
        why: 'finish_reason=length, the answer was truncated',
        steps: step,
        usage,
      };
    }

    if (response.finishReason === 'cancelled') {
      return { status: 'cancelled', steps: step, usage };
    }
    if (response.finishReason === 'content_filter') {
      return {
        status: 'failed',
        error: 'the provider refused the request via a content filter',
        steps: step,
        usage,
      };
    }

    if (response.toolCalls.length === 0) {
      return { status: 'completed', text: response.text, steps: step + 1, usage };
    }

    messages.push({ role: 'assistant', content: response.text });

    // --- tools, memoised individually -----------------------------------
    //
    // The tool call is memoised as well as the model call. Without that, a run
    // interrupted after `filesystem.write` succeeded would replay the write on
    // resume — and a write is not idempotent.
    for (const call of response.toolCalls) {
      if (await store.isCancelRequested(params.taskId)) {
        return { status: 'cancelled', steps: step, usage };
      }

// Each tool call gets its own record slot. Allocated from the same counter
      // as the model memo, so a step with three calls occupies four records and
      // the next step's memo cannot collide with the third tool's index.
      const toolKey = recordIndex++;

      // Every tool record of this step, looked up by step rather than by the freshly
      // allocated slot. A resumed run must see the records it already wrote.
      const toolRecords = records.filter((r) => r.stepNo === step && r.kind === 'tool_call');

      // Any tool record of this step that did not complete blocks a retry in
      // place. Matched without requiring the call id: a `failed` record may not
      // carry one, and requiring it would let precisely the case this guard
      // exists for slip through.
      const failedTool = toolRecords.find((r) => r.state !== 'completed');
      if (failedTool) {
        // Retrying in place would mean overwriting a recorded step, which the
        // unique index forbids — and that is the right constraint, not an
        // obstacle. A tool may have applied part of its effect before failing,
        // so re-running it is not guaranteed idempotent. A failed attempt is
        // retried as a *new* attempt, never in place.
        return {
          status: 'failed',
          error:
            `step ${step}: a tool already failed on an earlier attempt ` +
            `(${failedTool.error ?? 'no reason recorded'}); not retried in place`,
          steps: step,
          usage,
        };
      }

      const toolMemo = toolRecords.find((r) => r.result?.toolCallId === call.id);

      if (toolMemo?.state === 'completed') {
        // Already executed on an earlier attempt. Replayed, not re-run.
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          toolName: call.name,
          content: String(toolMemo.result?.content ?? ''),
        });
        await audit.record({
          actorType: 'system',
          taskId: params.taskId,
          action: 'tool.replay',
          outcome: 'allowed',
          detail: { step, toolName: call.name, toolCallId: call.id },
        });
        continue;
      }

      let outcome: Awaited<ReturnType<typeof callTool>>;
      try {
        outcome = await callTool({
          agentId: params.agentId,
          toolName: call.name,
          args: call.args,
          taskId: params.taskId,
          stepId: `${memoKey}`,
          signal: params.signal,
        });
      } catch (error) {
        // `ToolRunner` returns values and never throws, so a throw here is a
        // defect in the wiring — and we cannot tell whether the tool already ran.
        // Fail closed and record it rather than continuing on an unknown state.
        await record(step, {
          stepIndex: toolKey,
          stepNo: step,
          kind: 'tool_call',
          state: 'failed',
          error: `tool entry point threw: ${(error as Error).message}`,
        });
        return {
          status: 'failed',
          error: `tool entry point threw for ${call.name}: ${(error as Error).message}`,
          steps: step,
          usage,
        };
      }

      if (outcome.kind === 'unknown_tool') {
        // A value, not an exception. The loop continues so the model can react.
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          toolName: call.name,
          content: `error: there is no tool called ${call.name}`,
        });
        continue;
      }

      if (outcome.kind === 'blocked') {
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          toolName: call.name,
          content: `refused: ${outcome.reason}`,
        });
        continue;
      }

      if (outcome.kind === 'gated') {
        // The run stops here. The gate occupies its own index, separate from the
        // model memo, so resuming cannot re-run the model call that led to it.
        const gateKey = toolKey;
        await record(step, {
          stepIndex: gateKey,
          stepNo: step,
          kind: 'gate',
          state: 'running',
          result: {
            toolCallId: call.id,
            toolName: call.name,
            permission: outcome.permission,
            rule: outcome.rule,
            reason: outcome.reason,
            arguments: call.args,
          },
        });
        await store.markWaitingApproval(params.taskId, `${gateKey}`);
        return {
          status: 'waiting_approval',
          stepId: `${gateKey}`,
          permission: outcome.permission,
          rule: outcome.rule,
          reason: outcome.reason,
          steps: step,
          usage,
        };
      }

      const content = outcome.output.ok
        ? JSON.stringify(outcome.output.data)
        : `error: ${outcome.output.error}`;

      messages.push({
        role: 'tool',
        toolCallId: call.id,
        toolName: call.name,
        content,
      });

      await record(step, {
        stepIndex: toolKey,
        stepNo: step,
        kind: 'tool_call',
        state: 'completed',
        result: { toolCallId: call.id, toolName: call.name, content },
      });
    }
  }

  return {
    status: 'budget_exhausted',
    why: `step budget of ${budget.maxSteps} reached`,
    steps: budget.maxSteps,
    usage,
  };
}