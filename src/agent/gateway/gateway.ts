/**
 * Agent 层·模型网关核心（TASK-P3-01 回放模式半程，P3 方案 §2「模型网关层」+ F3 策略表）。
 *
 * 职责（唯一调用出口）：
 * - 供应商适配：replay（夹具回放）/ openai-compatible（真实端点），由 config.provider 切换；
 * - 超时：单次请求 config.timeoutMs，以 AbortSignal 实现，归 ProviderError('timeout')；
 * - F3 重试：可重试错误（timeout/network/429/5xx）指数退避，上限 config.maxRetries 次
 *   （缺省 3）；重试耗尽且配置了 fallbackModel → 切换备用模型一次（重试预算重置）；
 *   仍失败 → fail('SW-E040')；未配置凭据 → fail('SW-E041')；
 * - 脱敏：任何进错误消息的供应商文本过 redactSecrets（apiKey 在秘密集内）。
 *
 * 半程边界（方案 R-2）：本交付不含真实调用证据（E4 验收项）——BLK-W1-02 凭据到位后，
 * 以同一网关（provider='openai-compatible'）补一次真实调用脱敏记录归档 docs/evidence/。
 */

import { fail } from '../../app/errors/registry.js';
import { createOpenAiCompatAdapter } from './providers/openaiCompat.js';
import { createReplayAdapter } from './providers/replay.js';
import { redactSecrets } from './redact.js';
import {
  ProviderError,
  type GatewayConfig,
  type GatewayDeps,
  type GatewayResult,
  type ModelGateway,
  type ModelRequest,
  type ProviderAdapter,
} from './types.js';

/** 默认配置（环境变量键名即契约：SW_LLM_API_KEY / BASE_URL / MODEL / FALLBACK_MODEL / REPLAY_DIR）。 */
export const GATEWAY_DEFAULTS = {
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  timeoutMs: 30_000,
  maxRetries: 3,
  backoffBaseMs: 500,
} as const;

/**
 * 从环境变量装配配置（凭据只读进内存对象，永不写盘）。
 * 缺省 provider：有 SW_LLM_API_KEY → openai-compatible；否则 replay（须配 SW_LLM_REPLAY_DIR）。
 */
export function gatewayConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const replayDir = env.SW_LLM_REPLAY_DIR;
  const apiKey = env.SW_LLM_API_KEY;
  return {
    provider: apiKey !== undefined && apiKey !== '' ? 'openai-compatible' : 'replay',
    apiKey: apiKey === '' ? undefined : apiKey,
    baseUrl: env.SW_LLM_BASE_URL ?? GATEWAY_DEFAULTS.baseUrl,
    model: env.SW_LLM_MODEL ?? GATEWAY_DEFAULTS.model,
    fallbackModel: env.SW_LLM_FALLBACK_MODEL,
    timeoutMs: GATEWAY_DEFAULTS.timeoutMs,
    maxRetries: GATEWAY_DEFAULTS.maxRetries,
    backoffBaseMs: GATEWAY_DEFAULTS.backoffBaseMs,
    replayDir,
  };
}

function buildAdapter(config: GatewayConfig, deps: GatewayDeps): ProviderAdapter {
  if (config.provider === 'replay') {
    if (config.replayDir === undefined || config.replayDir === '') {
      fail('SW-E041', {});
    }
    return createReplayAdapter({ replayDir: config.replayDir });
  }
  if (config.apiKey === undefined || config.apiKey === '') {
    fail('SW-E041', {});
  }
  return createOpenAiCompatAdapter({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl ?? GATEWAY_DEFAULTS.baseUrl,
    fetchFn: deps.fetchFn ?? fetch,
  });
}

/** 单次带超时的适配器调用：setTimeout 触发 abort，适配器须以 ProviderError('timeout') 拒绝。 */
async function callOnce(
  adapter: ProviderAdapter,
  request: ModelRequest & { model: string },
  timeoutMs: number,
): Promise<Awaited<ReturnType<ProviderAdapter['complete']>>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await adapter.complete({ ...request, signal: controller.signal });
  } catch (error) {
    // 回放/测试夹具可能不尊重 signal：abort 已触发且错误不是 ProviderError 时归为 timeout。
    if (controller.signal.aborted && !(error instanceof ProviderError)) {
      throw new ProviderError('timeout', `请求超时（>${timeoutMs}ms）`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** 创建模型网关（唯一调用出口；deps 全注入，测试零网络零真睡）。 */
export function createGateway(config: GatewayConfig, deps: GatewayDeps = {}): ModelGateway {
  const adapter = buildAdapter(config, deps);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());
  const secrets = config.apiKey !== undefined ? [config.apiKey] : [];

  return {
    async call(request): Promise<GatewayResult> {
      const startedAt = now();
      let attempts = 0;
      let fallbackUsed = false;
      // F3 候选模型序列：主模型 + （若配置）备用模型一次。
      const models = [request.model ?? config.model];
      if (config.fallbackModel !== undefined) models.push(config.fallbackModel);

      let lastError: ProviderError | undefined;
      for (let modelIndex = 0; modelIndex < models.length; modelIndex += 1) {
        const model = models[modelIndex] ?? config.model;
        if (modelIndex > 0) fallbackUsed = true;
        for (let retry = 0; retry <= config.maxRetries; retry += 1) {
          attempts += 1;
          try {
            const response = await callOnce(
              adapter,
              { ...request, model },
              config.timeoutMs,
            );
            return {
              response,
              attempts,
              fallbackUsed,
              latencyMs: now() - startedAt,
            };
          } catch (error) {
            if (!(error instanceof ProviderError)) {
              throw error;
            }
            lastError = error;
            if (!error.retryable) break; // 4xx/响应非法/夹具缺失：不退避，直接换模型或失败
            if (retry < config.maxRetries) {
              await sleep(config.backoffBaseMs * 2 ** retry);
            }
          }
        }
      }

      fail('SW-E040', {
        model: models[models.length - 1] ?? config.model,
        attempts,
        lastError: redactSecrets(lastError?.message ?? '未知错误', secrets),
      });
    },
  };
}
