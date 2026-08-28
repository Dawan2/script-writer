/**
 * 回放供应商适配器（TASK-P3-01 回放模式半程，方案 R-2）。
 *
 * 用途：BLK-W1-02（模型凭据未定）期间的开发与测试——不触网络，从夹具目录按
 * 请求指纹取录制响应。凭据到位后由同网关 config.provider='openai-compatible'
 * 切真实端点，调用方代码零改动。
 *
 * 夹具格式（`<replayDir>/<fingerprint>.json`）：
 * ```json
 * { "content": "…", "promptTokens": 12, "completionTokens": 34,
 *   "error": { "kind": "http-5xx", "status": 500, "message": "录制的失败" } }
 * ```
 * `error` 键存在时按所录失败类型拒绝（重试策略路径也可回放）；缺文件 = fixture-miss。
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ProviderError,
  type ChatMessage,
  type ModelResponse,
  type ProviderAdapter,
  type ProviderErrorKind,
} from '../types.js';

/** 请求指纹：model + messages 的 sha1 前 16 位（录/放两侧同一算法）。 */
export function replayFingerprint(model: string, messages: readonly ChatMessage[]): string {
  return createHash('sha1')
    .update(JSON.stringify({ model, messages }))
    .digest('hex')
    .slice(0, 16);
}

const ERROR_KINDS: readonly ProviderErrorKind[] = [
  'timeout',
  'network',
  'http-429',
  'http-5xx',
  'http-4xx',
  'invalid-response',
  'fixture-miss',
];

interface FixtureShape {
  content?: unknown;
  promptTokens?: unknown;
  completionTokens?: unknown;
  error?: { kind?: unknown; status?: unknown; message?: unknown };
}

export function createReplayAdapter(options: { replayDir: string }): ProviderAdapter {
  return {
    id: 'replay',

    async complete(request): Promise<ModelResponse> {
      const path = join(options.replayDir, `${replayFingerprint(request.model, request.messages)}.json`);
      let raw: string;
      try {
        raw = await readFile(path, 'utf8');
      } catch {
        throw new ProviderError('fixture-miss', `回放夹具缺失：${path}`);
      }

      let fixture: FixtureShape;
      try {
        fixture = JSON.parse(raw) as FixtureShape;
      } catch {
        throw new ProviderError('invalid-response', `回放夹具不是合法 JSON：${path}`);
      }

      if (fixture.error !== undefined) {
        const kind = ERROR_KINDS.includes(fixture.error.kind as ProviderErrorKind)
          ? (fixture.error.kind as ProviderErrorKind)
          : 'invalid-response';
        throw new ProviderError(
          kind,
          typeof fixture.error.message === 'string' ? fixture.error.message : `录制失败：${kind}`,
          typeof fixture.error.status === 'number' ? { status: fixture.error.status } : {},
        );
      }

      if (typeof fixture.content !== 'string') {
        throw new ProviderError('invalid-response', `回放夹具缺 content 字段：${path}`);
      }

      return {
        content: fixture.content,
        model: request.model,
        promptTokens:
          typeof fixture.promptTokens === 'number' ? fixture.promptTokens : undefined,
        completionTokens:
          typeof fixture.completionTokens === 'number' ? fixture.completionTokens : undefined,
      };
    },
  };
}
