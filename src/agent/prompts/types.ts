/**
 * Agent 层·提示词库类型（TASK-P3-02 最小版，P3 方案 §2.8 Prompt Store）。
 *
 * 三层结构（目录名即契约）：
 * - `prompts/rules/`   硬规则（每文件一条规则集，所有技能共享，不可被任务指令覆盖）
 * - `prompts/skills/`  技能模板（Markdown + 元数据头：id/version/inputs/output_schema）
 * - `prompts/schemas/` 输出 JSON Schema（技能 output_schema 键指到这里）
 *
 * 版本纪律（方案 §2.8 规则 1）：技能改动必须递增 version；trace 中的技能引用
 * 恒为 `id@version`（本文件的 skillRef），使每次运行可精确回溯到提示词版本。
 */

/** 技能输入槽位声明：required = 任务实例必填；optional = 可空（模板自行兜底文案）。 */
export type SlotKind = 'required' | 'optional';

/** 技能元数据头（frontmatter 解析后的强类型形态）。 */
export interface SkillMeta {
  readonly id: string;
  readonly version: number;
  readonly inputs: Readonly<Record<string, SlotKind>>;
  /** 相对仓库根的 schema 路径（如 prompts/schemas/outline-draft.json）。 */
  readonly outputSchema: string;
}

/** 技能 = 元数据 + 正文模板（正文含 {{槽位}} 占位符）。 */
export interface Skill {
  readonly meta: SkillMeta;
  /** 版本化引用（trace/日志中的唯一形态：`generate_outline@1`）。 */
  readonly ref: string;
  readonly body: string;
}

/** 规则文件（id = 文件名去扩展名）。 */
export interface RuleFile {
  readonly id: string;
  readonly body: string;
}

/** 提示词库（加载即注册、注册即校验——非法技能在 load 时抛 PromptStoreError）。 */
export interface PromptStore {
  readonly rules: readonly RuleFile[];
  readonly skills: ReadonlyMap<string, Skill>;
  /** schema 相对路径集合（存在性校验的数据源，内容解析属 TASK-P3-03 受控输出层）。 */
  readonly schemaPaths: ReadonlySet<string>;
  /** 取技能版本化引用（不存在返回 undefined；供 trace 落 `skill: id@version`）。 */
  skillRef(id: string): string | undefined;
}

/**
 * 提示词库加载/校验错误（开发期错误：prompts/ 是仓库管理资产，非法即构建期问题，
 * 非用户运行期错态——故不走 fail()/SW-E04x；用户可见面在编排层捕获后另行映射）。
 */
export class PromptStoreError extends Error {
  /** 出问题的文件路径（相对加载根）。 */
  readonly file: string;
  /** 机器可读原因码（测试断言锚点）。 */
  readonly reason:
    | 'bad-frontmatter'
    | 'bad-meta'
    | 'missing-output-schema'
    | 'schema-not-found'
    | 'slot-mismatch'
    | 'duplicate-skill'
    | 'bad-schema-json';

  constructor(file: string, reason: PromptStoreError['reason'], detail: string) {
    super(`${file}：${detail}`);
    this.name = 'PromptStoreError';
    this.file = file;
    this.reason = reason;
  }
}
