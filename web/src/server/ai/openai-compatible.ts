import { type ModelClient, type ModelMessage, type ModelResponse, type ToolSpec } from '../agent/types';
import { estimateCostUsd, mapFinishReason } from './router';

/**
 * A `ModelClient` over any endpoint speaking `POST /chat/completions`.
 *
 * OpenAI-compatible is the point: ModelMesh will expose one, OpenRouter exposes
 * one, Ollama exposes one. This file contains no provider name and no branch on
 * one, which is why TEAhub needs no MLHSM-specific code for it to work — only a
 * base URL and a key.
 *
 * Deliberately hand-rolled over `fetch` rather than a vendor SDK. The AI SDK
 * would be a reasonable choice for the schema handling; for the wire format it
 * would add a large dependency to reach the same endpoint, and the SDK's value
 * (provider coverage) is exactly what we do not need when every provider we talk
 * to already speaks this one protocol.
 */

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
  price?: { inputPerM: number; outputPerM: number };
  /** Sent as `Authorization: Bearer`. Omitted when there is no key. */
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface ChatCompletionResponse {
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export function createOpenAiCompatibleClient(opts: OpenAiCompatibleOptions): ModelClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`;

  return {
    async generate(req: {
      system: string;
      messages: ModelMessage[];
      tools: ToolSpec[];
      signal?: AbortSignal;
    }): Promise<ModelResponse> {
      const controller = new AbortController();
      const timer = opts.timeoutMs
        ? setTimeout(() => controller.abort(), opts.timeoutMs)
        : undefined;
      const onAbort = () => controller.abort();
      req.signal?.addEventListener('abort', onAbort, { once: true });

      const headers: Record<string, string> = {
        'content-type': 'application/json',
        ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
        ...opts.headers,
      };

      const body = {
        model: opts.model,
        messages: [
          { role: 'system', content: req.system },
          ...req.messages.map((m) => toWireMessage(m)),
        ],
        ...(req.tools.length > 0 ? { tools: toWireTools(req.tools) } : {}),
      };

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (error) {
        throw new Error(`request to ${opts.model} failed: ${(error as Error).message}`);
      } finally {
        if (timer) clearTimeout(timer);
        req.signal?.removeEventListener('abort', onAbort);
      }

      if (!response.ok) {
        // The status and a truncated body, never the whole thing: a provider
        // error page can echo the request, and the request is the user's data.
        const detail = (await response.text().catch(() => '')).slice(0, 200);
        throw new Error(`HTTP ${response.status} from ${opts.model}${detail ? `: ${detail}` : ''}`);
      }

      const payload = (await response.json()) as ChatCompletionResponse;
      const choice = payload.choices?.[0];
      if (!choice) throw new Error(`no choice returned by ${opts.model}`);

      const toolCalls = (choice.message?.tool_calls ?? [])
        .map((tc, i) => ({
          id: tc.id ?? `call_${i}`,
          name: tc.function?.name ?? '',
          args: parseArguments(tc.function?.arguments),
        }))
        .filter((tc) => tc.name !== '');

      const usage = {
        inputTokens: payload.usage?.prompt_tokens ?? 0,
        outputTokens: payload.usage?.completion_tokens ?? 0,
      };

      return {
        text: choice.message?.content ?? '',
        toolCalls,
        finishReason: mapFinishReason(choice.finish_reason),
        usage,
        costUsd: estimateCostUsd(opts.price, usage),
        model: opts.model,
      };
    },
  };
}

function toWireMessage(m: ModelMessage): Record<string, unknown> {
  if (m.role === 'tool') {
    return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  }
  return { role: m.role, content: m.content };
}

function toWireTools(tools: ToolSpec[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

/**
 * Tool arguments come back as a JSON *string*, and a malformed one must not take
 * the turn down. A value the model can react to beats an exception.
 */
function parseArguments(raw: string | undefined): unknown {
  if (raw === undefined || raw === '') return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { __unparseable: raw };
  }
}