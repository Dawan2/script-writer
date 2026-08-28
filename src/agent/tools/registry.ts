/**
 * Agent 层·工具注册表（TASK-P3-05，P3 方案 §2.1）。
 *
 * 注册即校验（fail fast）：name 形态、description 须含「用于」（何时该用）、
 * params 每项 desc 非空、side_effect 枚举、failure_modes 非空、重名拒载。
 * F2 前置参数校验（方案 §2.4 F2：注册表前置校验）：未知参数 / 缺必填 / 类型错
 * 在执行前拦截，抛 ToolCallError（TOOL_ARG_*），不进 handler。
 */

import {
  ToolCallError,
  ToolRegistryError,
  type Tool,
  type ToolDescription,
  type ToolRegistry,
} from './types.js';

/** F2 前置校验内置失败码（不占用工具 failure_modes 枚举位）。 */
export const ARG_ERROR_CODES = ['TOOL_ARG_UNKNOWN', 'TOOL_ARG_MISSING', 'TOOL_ARG_TYPE'] as const;

function validateDescription(tool: Tool): void {
  const d = tool.desc;
  if (!/^[a-z][a-z0-9_]*$/.test(d.name)) {
    throw new ToolRegistryError(d.name || '（空）', 'bad-name', 'name 须为小写蛇形');
  }
  if (d.description.trim() === '' || !d.description.includes('用于')) {
    throw new ToolRegistryError(d.name, 'bad-description', 'description 须写明「何时该用」（含「用于」）');
  }
  if (d.version.trim() === '') {
    throw new ToolRegistryError(d.name, 'bad-name', 'version 须非空');
  }
  for (const [param, spec] of Object.entries(d.params)) {
    if (!['string', 'number', 'boolean'].includes(spec.type) || spec.desc.trim() === '') {
      throw new ToolRegistryError(d.name, 'bad-params', `params.${param} 的 type/desc 非法`);
    }
  }
  if (!['none', 'draft_write', 'destructive'].includes(d.sideEffect)) {
    throw new ToolRegistryError(d.name, 'bad-side-effect', `side_effect 非法：${d.sideEffect}`);
  }
  if (d.sideEffect === 'destructive') {
    throw new ToolRegistryError(d.name, 'bad-side-effect', 'destructive 工具第一波不提供（原则 P-3）');
  }
  if (d.failureModes.length === 0) {
    throw new ToolRegistryError(d.name, 'bad-failure-modes', 'failure_modes 须枚举至少一个失败码');
  }
}

/** F2 前置参数校验：返回 null = 通过；否则 ToolCallError。 */
export function validateArgs(
  desc: ToolDescription,
  args: Readonly<Record<string, unknown>>,
): ToolCallError | null {
  for (const key of Object.keys(args)) {
    if (!(key in desc.params)) {
      return new ToolCallError(
        desc.name,
        'TOOL_ARG_UNKNOWN',
        `未知参数 ${key}（可用：${Object.keys(desc.params).join('、') || '（无）'}）`,
      );
    }
  }
  for (const [param, spec] of Object.entries(desc.params)) {
    const value = args[param];
    if (value === undefined) {
      if (spec.required) {
        return new ToolCallError(desc.name, 'TOOL_ARG_MISSING', `缺必填参数 ${param}（${spec.desc}）`);
      }
      continue;
    }
    if (typeof value !== spec.type) {
      return new ToolCallError(
        desc.name,
        'TOOL_ARG_TYPE',
        `参数 ${param} 类型应为 ${spec.type}，实为 ${typeof value}`,
      );
    }
  }
  return null;
}

/** 创建注册表（加载即全量校验，任一非法整批拒载 fail fast）。 */
export function createToolRegistry(tools: readonly Tool[]): ToolRegistry {
  const map = new Map<string, Tool>();
  for (const tool of tools) {
    validateDescription(tool);
    if (map.has(tool.desc.name)) {
      throw new ToolRegistryError(tool.desc.name, 'duplicate-tool', '重复注册');
    }
    map.set(tool.desc.name, tool);
  }
  return {
    descriptions: [...map.values()].map((t) => t.desc),
    get: (name) => map.get(name),
    async call(name, ctx, args = {}) {
      const tool = map.get(name);
      if (tool === undefined) {
        throw new ToolCallError(name, 'TOOL_NOT_FOUND', `工具未注册（可用：${[...map.keys()].join('、')}）`);
      }
      const argError = validateArgs(tool.desc, args);
      if (argError !== null) throw argError;
      return tool.handler(ctx, args);
    },
  };
}
