/**
 * Agent 层·工具注册表类型（TASK-P3-05，P3 方案 §2.1）。
 *
 * 工具描述是单一事实来源（供运行时与文档双向生成）；描述按代码同等标准管理。
 * 强制字段规则（方案 §2.1）：
 * - side_effect 枚举 none | draft_write | destructive（destructive 第一波不提供，P-3）；
 * - description 必须写「何时该用」（注册校验机器断言：须含「用于」）；
 * - 每个失败码在 failure_modes 枚举，供自修复层映射策略（F2 参数校验失败码内置）。
 */

/** 工具参数描述。 */
export interface ToolParamDesc {
  readonly type: 'string' | 'number' | 'boolean';
  readonly required: boolean;
  readonly desc: string;
}

/** 工具描述（机器可读契约；注册即校验，非法拒载 fail fast）。 */
export interface ToolDescription {
  readonly name: string;
  readonly version: string;
  /** 何时该用 + 是什么（须含「用于」，注册校验断言）。 */
  readonly description: string;
  readonly params: Readonly<Record<string, ToolParamDesc>>;
  readonly returns?: { readonly type: string; readonly schema_ref?: string };
  readonly sideEffect: 'none' | 'draft_write' | 'destructive';
  readonly preconditions: readonly string[];
  readonly failureModes: readonly string[];
  readonly costHint: 'cheap' | 'medium' | 'expensive';
}

/** 工具执行上下文（v1：项目目录；后续按需挂 bible/trace 句柄）。 */
export interface ToolContext {
  readonly projectDir: string;
}

/**
 * 工具调用错误：code 取自工具 failure_modes 枚举（业务失败）或注册表内置码
 * TOOL_NOT_FOUND / TOOL_ARG_UNKNOWN / TOOL_ARG_MISSING / TOOL_ARG_TYPE（F2 前置校验）。
 * 属编排层内部载体，非用户可见错态（用户可见面由编排层映射，同 PromptStoreError 裁定）。
 */
export class ToolCallError extends Error {
  readonly tool: string;
  readonly code: string;

  constructor(tool: string, code: string, message: string) {
    super(`${tool}：${message}`);
    this.name = 'ToolCallError';
    this.tool = tool;
    this.code = code;
  }
}

/** 工具 = 描述 + 实现（同目录成对，方案 §2.1「描述与实现同目录」）。 */
export interface Tool {
  readonly desc: ToolDescription;
  readonly handler: (ctx: ToolContext, args: Readonly<Record<string, unknown>>) => Promise<unknown>;
}

/** 工具注册表。 */
export interface ToolRegistry {
  /** 全量描述（供模型声明/文档生成）。 */
  readonly descriptions: readonly ToolDescription[];
  /** 取工具（不存在返回 undefined）。 */
  get(name: string): Tool | undefined;
  /** F2 前置参数校验 + 执行；失败抛 ToolCallError。 */
  call(name: string, ctx: ToolContext, args?: Readonly<Record<string, unknown>>): Promise<unknown>;
}

/** 注册表加载错误（开发期错误，同 PromptStoreError 裁定）。 */
export class ToolRegistryError extends Error {
  readonly tool: string;
  readonly reason:
    | 'bad-name'
    | 'bad-description'
    | 'bad-params'
    | 'bad-side-effect'
    | 'bad-failure-modes'
    | 'duplicate-tool';

  constructor(tool: string, reason: ToolRegistryError['reason'], detail: string) {
    super(`${tool}：${detail}`);
    this.name = 'ToolRegistryError';
    this.tool = tool;
    this.reason = reason;
  }
}
