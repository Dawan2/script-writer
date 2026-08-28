/**
 * 模型网关测试（TASK-P3-01 回放模式半程）。
 * 全部经注入依赖运行：零网络（fetchFn 替身）、零真睡（sleep 记录器）、零真时钟。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isSwError, type SwError } from '../../src/app/errors/registry.js';
import { createGateway, gatewayConfigFromEnv } from '../../src/agent/gateway/gateway.js';
import { createReplayAdapter, replayFingerprint } from '../../src/agent/gateway/providers/replay.js';
import { redactSecrets } from '../../src/agent/gateway/redact.js';
import { ProviderError, type ChatMessage } from '../../src/agent/gateway/types.js';

const MESSAGES: readonly ChatMessage[] = [{ role: 'user', content: '写一场雨夜开场的梗概' }];

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sw-gw-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeFixture(model: string, messages: readonly ChatMessage[], fixture: unknown): void {
  writeFileSync(join(dir, `${replayFingerprint(model, messages)}.json`), JSON.stringify(fixture));
}

/** 记录退避间隔的假 sleep。 */
function sleepRecorder(): { sleep: (ms: number) => Promise<void>; intervals: number[] } {
  const intervals: number[] = [];
  return { sleep: (ms) => (intervals.push(ms), Promise.resolve()), intervals };
}

function httpResponse(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
}

const OK_BODY = {
  choices: [{ message: { content: '雨夜，电话铃响。' } }],
  usage: { prompt_tokens: 12, completion_tokens: 8 },
};

describe('agent/gateway：回放适配器（replay provider）', () => {
  it('命中夹具 → 返回 content 与 token 计数，model 回显请求模型', async () => {
    writeFixture('m1', MESSAGES, { content: '梗概正文', promptTokens: 12, completionTokens: 34 });
    const adapter = createReplayAdapter({ replayDir: dir });
    const res = await adapter.complete({ model: 'm1', messages: MESSAGES, signal: new AbortController().signal });
    expect(res).toEqual({ content: '梗概正文', model: 'm1', promptTokens: 12, completionTokens: 34 });
  });

  it('夹具缺失 → ProviderError fixture-miss（不可重试）', async () => {
    const adapter = createReplayAdapter({ replayDir: dir });
    await expect(
      adapter.complete({ model: 'm1', messages: MESSAGES, signal: new AbortController().signal }),
    ).rejects.toMatchObject({ name: 'ProviderError', kind: 'fixture-miss', retryable: false });
  });

  it('录制了错误的夹具 → 按录制的 kind 拒绝（http-5xx 可重试 / http-4xx 不可）', async () => {
    writeFixture('m5', MESSAGES, { error: { kind: 'http-5xx', status: 500, message: '录制失败' } });
    writeFixture('m4', MESSAGES, { error: { kind: 'http-4xx', status: 400, message: '坏请求' } });
    const adapter = createReplayAdapter({ replayDir: dir });
    const signal = new AbortController().signal;
    await expect(adapter.complete({ model: 'm5', messages: MESSAGES, signal })).rejects.toMatchObject({
      kind: 'http-5xx',
      retryable: true,
      status: 500,
    });
    await expect(adapter.complete({ model: 'm4', messages: MESSAGES, signal })).rejects.toMatchObject({
      kind: 'http-4xx',
      retryable: false,
    });
  });

  it('请求指纹稳定且随内容变化（录/放同一算法）', () => {
    expect(replayFingerprint('m1', MESSAGES)).toBe(replayFingerprint('m1', MESSAGES));
    expect(replayFingerprint('m1', MESSAGES)).not.toBe(replayFingerprint('m2', MESSAGES));
    expect(replayFingerprint('m1', MESSAGES)).not.toBe(
      replayFingerprint('m1', [{ role: 'user', content: '别的' }]),
    );
  });
});

describe('agent/gateway：脱敏（redactSecrets）', () => {
  it('秘密值全部替换为 ***；多处出现一并替换', () => {
    expect(redactSecrets('key=sk-abcdef，又见 sk-abcdef', ['sk-abcdef'])).toBe('key=***，又见 ***');
  });
  it('过短秘密（<4 字符）不替换，防误伤正常文本', () => {
    expect(redactSecrets('abc abc', ['abc'])).toBe('abc abc');
  });
});

describe('agent/gateway：网关核心（F3 重试 / 超时 / 降级）', () => {
  const baseConfig = {
    provider: 'openai-compatible' as const,
    apiKey: 'sk-testkey-0001',
    baseUrl: 'https://example.invalid/v1',
    model: 'main-model',
    timeoutMs: 1_000,
    maxRetries: 3,
    backoffBaseMs: 500,
  };

  it('一次成功：attempts=1、fallbackUsed=false、token 计数透传', async () => {
    const gateway = createGateway(baseConfig, {
      fetchFn: async () => httpResponse(200, OK_BODY),
      now: (() => { let t = 100; return () => (t += 50); })(),
    });
    const result = await gateway.call({ messages: MESSAGES });
    expect(result.response.content).toBe('雨夜，电话铃响。');
    expect(result.response.promptTokens).toBe(12);
    expect(result.attempts).toBe(1);
    expect(result.fallbackUsed).toBe(false);
    expect(result.latencyMs).toBe(50);
  });

  it('F3：5xx 指数退避 500/1000/2000 后成功，共 4 次尝试', async () => {
    let calls = 0;
    const { sleep, intervals } = sleepRecorder();
    const gateway = createGateway(baseConfig, {
      fetchFn: async () => (calls += 1, calls < 4 ? httpResponse(500, 'err') : httpResponse(200, OK_BODY)),
      sleep,
    });
    const result = await gateway.call({ messages: MESSAGES });
    expect(result.attempts).toBe(4);
    expect(intervals).toEqual([500, 1000, 2000]);
  });

  it('F3：重试耗尽 → fail SW-E040（model/attempts/lastError 齐备）', async () => {
    const gateway = createGateway(baseConfig, {
      fetchFn: async () => httpResponse(500, 'boom'),
      sleep: sleepRecorder().sleep,
    });
    try {
      await gateway.call({ messages: MESSAGES });
      expect.unreachable('必须抛 SW-E040');
    } catch (error) {
      expect(isSwError(error)).toBe(true);
      const swError = error as SwError<'SW-E040'>;
      expect(swError.code).toBe('SW-E040');
      expect(swError.ctx).toMatchObject({ model: 'main-model', attempts: 4 });
      expect(swError.ctx.lastError).toContain('HTTP 500');
    }
  });

  it('4xx 不重试：一次尝试即失败', async () => {
    let calls = 0;
    const gateway = createGateway(baseConfig, {
      fetchFn: async () => (calls += 1, httpResponse(400, 'bad request')),
      sleep: sleepRecorder().sleep,
    });
    await expect(gateway.call({ messages: MESSAGES })).rejects.toMatchObject({ code: 'SW-E040' });
    expect(calls).toBe(1);
  });

  it('F3 降级：主模型耗尽后切换备用模型一次并成功（fallbackUsed=true）', async () => {
    const seenModels: string[] = [];
    const gateway = createGateway(
      { ...baseConfig, fallbackModel: 'backup-model' },
      {
        fetchFn: async (_url, init) => {
          const model = (JSON.parse(String(init?.body)) as { model: string }).model;
          seenModels.push(model);
          return model === 'main-model' ? httpResponse(500, 'err') : httpResponse(200, OK_BODY);
        },
        sleep: sleepRecorder().sleep,
      },
    );
    const result = await gateway.call({ messages: MESSAGES });
    expect(result.fallbackUsed).toBe(true);
    expect(result.response.model).toBe('backup-model');
    expect(result.attempts).toBe(5); // 主模型 4 次 + 备用 1 次
    expect(seenModels).toEqual(['main-model', 'main-model', 'main-model', 'main-model', 'backup-model']);
  });

  it('主备都耗尽 → SW-E040，attempts=8，错误消息不含凭据明文（脱敏）', async () => {
    const gateway = createGateway(
      { ...baseConfig, fallbackModel: 'backup-model' },
      {
        // 供应商回包里带回显凭据的恶意/调试文本——不得泄进错误消息
        fetchFn: async () => httpResponse(500, `debug echo: ${baseConfig.apiKey}`),
        sleep: sleepRecorder().sleep,
      },
    );
    try {
      await gateway.call({ messages: MESSAGES });
      expect.unreachable();
    } catch (error) {
      const swError = error as SwError<'SW-E040'>;
      expect(swError.ctx.attempts).toBe(8);
      expect(swError.ctx.lastError).not.toContain(baseConfig.apiKey);
      expect(swError.ctx.lastError).toContain('***');
    }
  });

  it('超时：fetch 尊重 abort → 归 timeout 并进入重试（F3）', async () => {
    let calls = 0;
    const { sleep, intervals } = sleepRecorder();
    const gateway = createGateway({ ...baseConfig, timeoutMs: 10, maxRetries: 1 }, {
      fetchFn: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          calls += 1;
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
      sleep,
    });
    await expect(gateway.call({ messages: MESSAGES })).rejects.toMatchObject({
      code: 'SW-E040',
      ctx: { attempts: 2 },
    });
    expect(calls).toBe(2);
    expect(intervals).toEqual([500]);
  });

  it('未配置凭据（openai-compatible 缺 apiKey）→ 建网关即 fail SW-E041', () => {
    expect(() => createGateway({ ...baseConfig, apiKey: undefined })).toThrowError(
      expect.objectContaining({ code: 'SW-E041' }) as Error,
    );
  });

  it('replay 模式缺夹具目录 → 建网关即 fail SW-E041', () => {
    expect(() =>
      createGateway({
        provider: 'replay',
        model: 'm1',
        timeoutMs: 100,
        maxRetries: 0,
        backoffBaseMs: 1,
      }),
    ).toThrowError(expect.objectContaining({ code: 'SW-E041' }) as Error);
  });

  it('回放模式端到端：夹具命中 → 一次尝试返回（无网络）', async () => {
    writeFixture('m1', MESSAGES, { content: '回放正文' });
    const gateway = createGateway(
      { provider: 'replay', model: 'm1', timeoutMs: 100, maxRetries: 0, backoffBaseMs: 1, replayDir: dir },
    );
    const result = await gateway.call({ messages: MESSAGES });
    expect(result.response.content).toBe('回放正文');
    expect(result.attempts).toBe(1);
  });

  it('回放夹具缺失走 SW-E040（fixture-miss 不可重试，不重试不放 fallback）', async () => {
    const gateway = createGateway(
      {
        provider: 'replay',
        model: 'm1',
        fallbackModel: 'm2',
        timeoutMs: 100,
        maxRetries: 3,
        backoffBaseMs: 1,
        replayDir: dir,
      },
      { sleep: sleepRecorder().sleep },
    );
    // 主备两模型均无夹具 → 各 1 次尝试（fixture-miss 不可重试），共 2 次
    await expect(gateway.call({ messages: MESSAGES })).rejects.toMatchObject({
      code: 'SW-E040',
      ctx: { attempts: 2, model: 'm2' },
    });
  });
});

describe('agent/gateway：环境装配（gatewayConfigFromEnv）', () => {
  it('有 SW_LLM_API_KEY → openai-compatible；无 → replay', () => {
    expect(gatewayConfigFromEnv({ SW_LLM_API_KEY: 'sk-x' }).provider).toBe('openai-compatible');
    expect(gatewayConfigFromEnv({}).provider).toBe('replay');
    expect(gatewayConfigFromEnv({ SW_LLM_API_KEY: '' }).provider).toBe('replay');
  });

  it('模型与端点缺省值 + 覆盖', () => {
    expect(gatewayConfigFromEnv({}).model).toBe('gpt-4o-mini');
    expect(gatewayConfigFromEnv({ SW_LLM_MODEL: 'kimi-k2', SW_LLM_BASE_URL: 'https://api.moonshot.cn/v1' })).toMatchObject({
      model: 'kimi-k2',
      baseUrl: 'https://api.moonshot.cn/v1',
    });
  });

  it('凭据只进内存配置对象——配置序列化不自动脱敏但永不写盘（纪律约定见模块头）', () => {
    const config = gatewayConfigFromEnv({ SW_LLM_API_KEY: 'sk-secret-1234' });
    expect(config.apiKey).toBe('sk-secret-1234'); // 内存可见
  });
});

describe('agent/gateway：ProviderError 归类', () => {
  it('可重试集合 = timeout/network/http-429/http-5xx，其余不可重试', () => {
    expect(new ProviderError('timeout', 'x').retryable).toBe(true);
    expect(new ProviderError('network', 'x').retryable).toBe(true);
    expect(new ProviderError('http-429', 'x').retryable).toBe(true);
    expect(new ProviderError('http-5xx', 'x').retryable).toBe(true);
    expect(new ProviderError('http-4xx', 'x').retryable).toBe(false);
    expect(new ProviderError('invalid-response', 'x').retryable).toBe(false);
    expect(new ProviderError('fixture-miss', 'x').retryable).toBe(false);
  });
});
