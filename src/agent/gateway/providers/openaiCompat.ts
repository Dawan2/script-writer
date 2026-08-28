/**
 * OpenAI 兼容供应商适配器（TASK-P3-01；/chat/completions 形态，DeepSeek/Moonshot 等
 * 兼容端点换 baseUrl 即用）。
 *
 * 只发单次请求，不重试（重试在网关层）；凭据仅以 Authorization 头出现，
 * 错误消息一律过 redactSecrets，凭据不进任何 message/stack。
 */

import { redactSecrets } from '../redact.js';
import { ProviderError, type ModelResponse, type ProviderAdapter } from '../types.js';

interface ChatCompletionPayload {
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function createOpenAiCompatAdapter(options: {
  apiKey: string;
  baseUrl: string;
  fetchFn: typeof fetch;
}): ProviderAdapter {
  const endpoint = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`;

  return {
    id: 'openai-compatible',

    async complete(request): Promise<ModelResponse> {
      let response: Response;
      try {
        response = await options.fetchFn(endpoint, {
          method: 'POST',
          signal: request.signal,
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify({
            model: request.model,
            messages: request.messages,
            ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
            ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          }),
        });
      } catch (error) {
        // 网关层超时以 abort 实现：AbortError 归为 timeout（F3 可重试）。
        const aborted = error instanceof Error && error.name === 'AbortError';
        throw new ProviderError(
          aborted ? 'timeout' : 'network',
          redactSecrets(`网络层失败：${error instanceof Error ? error.message : String(error)}`, [
            options.apiKey,
          ]),
        );
      }

      if (!response.ok) {
        const body = redactSecrets(await response.text().catch(() => ''), [options.apiKey]);
        const brief = body.length > 200 ? `${body.slice(0, 200)}…` : body;
        const kind =
          response.status === 429
            ? 'http-429'
            : response.status >= 500
              ? 'http-5xx'
              : 'http-4xx';
        throw new ProviderError(kind, `HTTP ${response.status}：${brief}`, {
          status: response.status,
        });
      }

      let payload: ChatCompletionPayload;
      try {
        payload = (await response.json()) as ChatCompletionPayload;
      } catch {
        throw new ProviderError('invalid-response', '响应不是合法 JSON');
      }

      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        throw new ProviderError('invalid-response', '响应缺 choices[0].message.content');
      }

      return {
        content,
        model: request.model,
        promptTokens: asOptionalNumber(payload.usage?.prompt_tokens),
        completionTokens: asOptionalNumber(payload.usage?.completion_tokens),
      };
    },
  };
}
