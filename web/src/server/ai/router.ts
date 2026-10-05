import type { FinishReason, ModelClient, ModelMessage, ModelResponse, ToolSpec } from '../agent/types';

/**
 * Provider selection.
 *
 * The Vercel AI SDK turned out to be a provider *specification*, not a gateway:
 * `@ai-sdk/gateway` is a client for Vercel's hosted service, and routing,
 * fallback and cooldown are simply not in it. So this is the ~150 lines the
 * research said a gateway really costs — Portkey's routing was 156 lines and its
 * cache 113.
 *
 * The requirement is ranked against each candidate's declared capabilities and
 * the winner is the best match, with a fallback chain behind it. Two rules earn
 * their place:
 *
 *  * **An unknown price stays unknown.** A candidate with no price is not "free",
 *    it is unpriced. Budget logic that treats it as 0 is a budget that stopped
 *    binding, and it fails silently.
 *  * **The chain is exhausted, not the task.** If every candidate fails, the
 *    caller gets a provider failure — not a task failure. Those are different
 *    events for the user, and conflating them is how a provider outage gets
 *    reported as "the agent is broken".
 */

export interface Requirement {
  /** How much the task matters. Higher prefers the stronger model. */
  effort: 'low' | 'medium' | 'high';
  cost: 'free' | 'cheap' | 'any';
  needsTools: boolean;
  needsVision: boolean;
  minContextTokens: number;
}

export interface Candidate {
  id: string;
  provider: string;
  model: string;
  client: ModelClient;
  /** USD per million input and output tokens. Undefined means unpriced. */
  price?: { inputPerM: number; outputPerM: number };
  contextTokens: number;
  supportsTools: boolean;
  supportsVision: boolean;
  /** Reachable right now. A cooldown sets this false rather than removing it. */
  healthy: boolean;
}

/** Returns a score, or null when the candidate cannot satisfy the requirement at all. */
export function scoreCandidate(req: Requirement, c: Candidate): number | null {
  if (!c.healthy) return null;
  if (c.contextTokens < req.minContextTokens) return null;
  if (req.needsTools && !c.supportsTools) return null;
  if (req.needsVision && !c.supportsVision) return null;

  let score = 0;

  // Effort maps to capability, not to a brand. A candidate is not "better", it is
  // capable or it is not, and within what it can do the cheaper one wins.
  const contextWeight = Math.min(c.contextTokens / 1_000_000, 1) * 40;
  score += contextWeight;

  if (req.cost === 'free') {
    // Free means free. An unpriced candidate cannot be called free.
    if (c.price === undefined) return null;
    score += 50 - Math.min(c.price.inputPerM, 50);
  } else if (req.cost === 'cheap') {
    if (c.price !== undefined) {
      score += 50 - Math.min(c.price.inputPerM + c.price.outputPerM, 50);
    }
    // An unpriced candidate stays eligible, ranked below every priced one. That
    // is the honest position: we do not know that it is expensive.
  }

  if (req.effort === 'high') score += 25;
  else if (req.effort === 'medium') score += 10;

  return score;
}

export interface OrderedChain {
  ordered: Candidate[];
  /** Why each rejected candidate was dropped, for the audit log. */
  rejected: Array<{ id: string; reason: string }>;
}

export function buildChain(req: Requirement, candidates: Candidate[]): OrderedChain {
  const scored: Array<{ candidate: Candidate; score: number }> = [];
  const rejected: Array<{ id: string; reason: string }> = [];

  for (const c of candidates) {
    if (!c.healthy) {
      rejected.push({ id: c.id, reason: 'in cooldown' });
      continue;
    }
    if (c.contextTokens < req.minContextTokens) {
      rejected.push({ id: c.id, reason: `context ${c.contextTokens} below required ${req.minContextTokens}` });
      continue;
    }
    if (req.needsTools && !c.supportsTools) {
      rejected.push({ id: c.id, reason: 'no tool support' });
      continue;
    }
    if (req.needsVision && !c.supportsVision) {
      rejected.push({ id: c.id, reason: 'no vision support' });
      continue;
    }
    const score = scoreCandidate(req, c);
    if (score === null) {
      rejected.push({ id: c.id, reason: 'cannot satisfy the requirement' });
      continue;
    }
    scored.push({ candidate: c, score });
  }

  // Ties break towards the cheaper candidate, then by id so the order is stable
  // and a rerun picks the same provider.
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ap = a.candidate.price;
    const bp = b.candidate.price;
    const at = ap ? ap.inputPerM + ap.outputPerM : Number.POSITIVE_INFINITY;
    const bt = bp ? bp.inputPerM + bp.outputPerM : Number.POSITIVE_INFINITY;
    if (at !== bt) return at - bt;
    return a.candidate.id.localeCompare(b.candidate.id);
  });

  return { ordered: scored.map((s) => s.candidate), rejected };
}

/**
 * One generation, trying each candidate in turn.
 *
 * Only a *provider* failure moves to the next candidate. A refusal, a truncation
 * or a content filter is the model's answer and is returned as-is — falling
 * through to another model there would hide exactly the signal the caller needs.
 */
export async function generateWithFallback(params: {
  req: Requirement;
  candidates: Candidate[];
  system: string;
  messages: ModelMessage[];
  tools: ToolSpec[];
  signal?: AbortSignal;
  /** Reported when every candidate failed. */
  onAttemptFailed?: (candidate: Candidate, error: string) => Promise<void>;
}): Promise<{ response: ModelResponse; usedId: string }> {
  const { ordered, rejected } = buildChain(params.req, params.candidates);

  if (ordered.length === 0) {
    const why =
      rejected.length === 0
        ? 'no providers are configured'
        : `no provider satisfies the requirement: ${rejected
            .map((r) => `${r.id} (${r.reason})`)
            .join(', ')}`;
    // A distinct error type, because this is not the task's fault.
    throw new ProviderUnavailableError(why);
  }

  const failures: string[] = [];
  for (const candidate of ordered) {
    try {
      const response = await candidate.client.generate({
        system: params.system,
        messages: params.messages,
        tools: params.tools,
        signal: params.signal,
      });
      return { response, usedId: candidate.id };
    } catch (error) {
      const message = (error as Error).message;
      failures.push(`${candidate.id}: ${message}`);
      await params.onAttemptFailed?.(candidate, message);
    }
  }

  throw new ProviderUnavailableError(`every candidate failed — ${failures.join('; ')}`);
}

/**
 * A `ModelClient` that is itself the fallback chain.
 *
 * The runtime takes one client and does not know about providers, so composing the
 * chain behind that interface keeps the loop free of routing concerns — and keeps
 * a provider outage from becoming a task failure, because the chain throws
 * `ProviderUnavailableError` only once every candidate is exhausted.
 */
export function createFallbackClient(params: {
  req: Requirement;
  candidates: Candidate[];
  onAttemptFailed?: (candidate: Candidate, error: string) => Promise<void>;
}): ModelClient {
  return {
    async generate(req) {
      const { response } = await generateWithFallback({
        req: params.req,
        candidates: params.candidates,
        system: req.system,
        messages: req.messages,
        tools: req.tools,
        signal: req.signal,
        onAttemptFailed: params.onAttemptFailed,
      });
      return response;
    },
  };
}

export class ProviderUnavailableError extends Error {
  /**
   * Structural marker the agent loop checks without importing this module.
   *
   * "The model failed" and "the model layer could not be reached" are different
   * events, and conflating them turns a provider outage into a task failure.
   */
  readonly isProviderUnavailable = true;

  constructor(message: string) {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}

export function estimateCostUsd(
  price: { inputPerM: number; outputPerM: number } | undefined,
  usage: { inputTokens: number; outputTokens: number },
): number | undefined {
  // Undefined in, undefined out. A cost of 0 would be a claim, and a wrong one.
  if (price === undefined) return undefined;
  return (
    (usage.inputTokens / 1_000_000) * price.inputPerM +
    (usage.outputTokens / 1_000_000) * price.outputPerM
  );
}

export function mapFinishReason(raw: string | null | undefined): FinishReason {
  switch (raw) {
    case 'stop':
    case 'tool_calls':
    case 'function_call':
      return raw === 'stop' ? 'stop' : 'tool_calls';
    case 'length':
      return 'length';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'error';
  }
}