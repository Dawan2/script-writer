/**
 * 应用层·统一错误与空态注册表（W1-P1-T06 / SPEC-03，P1 方案 §7）。
 *
 * 单一数据源：错误码与空态文案都只在本文件登记——
 * 运行时渲染层（render.ts）查表输出；`docs/errors/` 由 scripts/gen-error-docs.ts
 * 从本表生成（保证消息与文档永不漂移）；注册表 lint（`npm run lint:errors`）进 CI。
 *
 * 纪律（SPEC-03 + W1-P1-T06 风险条款）：
 * - v1 只收 SPEC-01/02 实际触达的错误码，禁止预填未用码（AI 段 SW-E04x 待 AI 适配器落地再登记）。
 * - `fail(code, ctx)` 是业务代码抛用户可见错误的唯一入口；禁止散落 console.error / 裸异常（ESLint 拦截）。
 * - 空态文案与错误文案同库管理、同 lint 覆盖（空态三要素：这里是什么 / 示例长什么样 / 下一步敲什么命令）。
 */

/** 错误码文档锚点前缀（SPEC-03：错误消息尾部印文档锚点，docs/errors/ 为锚点目标）。 */
export const ERROR_DOCS_BASE_URL =
  'https://github.com/Dawan2/script-writer/blob/main/docs/errors';

/** 模板值：字符串 / 数字 / 字符串数组（数组以「、」连接，空数组渲染为「（无）」）。 */
export type TemplateValue = string | number | readonly string[];

/**
 * 每个错误码的上下文契约（fail 的第二参数按码强类型约束）。
 * 新增错误码 = 此处加一行 + ERROR_REGISTRY 加一条 + 运行 `npm run gen:errors`。
 */
export interface ErrorContexts {
  /** SPEC-01：init 目标目录非空且无 --force。 */
  'SW-E010': { dir: string };
  /** SPEC-02：项目命令在非项目目录运行（缺 project.yaml）。 */
  'SW-E011': { cwd: string };
  /** SPEC-02：project.yaml schema 版本不兼容。 */
  'SW-E020': { found: string | number; supported: number };
  /** SPEC-02：project.yaml 存在但不是合法 YAML（引擎 loadProject 的 invalid-yaml 分支，W3 集成登记）。 */
  'SW-E021': { detail: string };
  /** SPEC-02：project.yaml 字段缺失或类型错误（引擎 parseProjectMeta 的 malformed 分支，W3 集成登记）。 */
  'SW-E022': { issues: readonly string[] };
  /** SPEC-02：场景 id 不存在（附现有 id 列表）。 */
  'SW-E030': { sceneId: string; existingIds: readonly string[] };
}

export type ErrorCode = keyof ErrorContexts;

/**
 * 三段式消息模板（发生了什么 / 为什么 / 怎么办，P1 §6.3 错态约定）。
 * 模板中 `{key}` 占位符在运行时由 ctx 插值；`example` 为文档示例与注册表 lint 用的样例 ctx。
 */
export interface ErrorSpec<C extends ErrorCode = ErrorCode> {
  /** 发生了什么（首行标题，跟在 `✖ SW-Exxx` 之后）。 */
  what: string;
  /** 为什么（渲染为「原因：…」）。 */
  why: string;
  /** 怎么办（渲染为「怎么办：…」，含可复制命令时用反引号包裹）。 */
  fix: string;
  /** 样例 ctx：docs/errors/ 示例输出与 lint「占位符全解析」断言共用。 */
  example: ErrorContexts[C];
}

/**
 * 错误码注册表（全部来自 SPEC-01/02 的实际触达路径）。
 * 段位含义（SPEC-03 注册表）：E01x 项目/文件系统；E02x 状态/版本；E03x 输入校验；
 * E04x AI 供应商（未登记：AI 默认关闭、无触达路径，登记即违反「禁止预填未用码」）。
 * W3 集成追加：E021/E022（工作流引擎 loadProject 实际触达，语义冲突 ② 核销）。
 */
export const ERROR_REGISTRY: { readonly [C in ErrorCode]: ErrorSpec<C> } = {
  'SW-E010': {
    what: '目标目录非空，初始化已中止',
    why: '目录 {dir} 里已有文件；直接初始化可能覆盖你已有的内容。',
    fix: '换一个空目录运行 `sw init`；或确认可覆盖后运行 `sw init --force`（同名文件会被项目骨架覆盖，且不可撤销）。',
    example: { dir: './my-script' },
  },
  'SW-E011': {
    what: '当前目录不是 script-writer 项目',
    why: '未找到 project.yaml（查找位置：{cwd}）。',
    fix: '运行 `sw init` 新建项目，或 cd 到既有项目目录。',
    example: { cwd: '/home/writer/somewhere' },
  },
  'SW-E020': {
    what: 'project.yaml 的 schema 版本不兼容',
    why: '文件声明的 schema 版本是 {found}，本版本 CLI 支持的是 schema {supported}。',
    fix: '若 schema 字段是被误改的，请改回 {supported}；若项目由更新版本的 CLI 创建，请先升级本机 CLI（`npm install -g script-writer@latest`）再重试。',
    example: { found: 2, supported: 1 },
  },
  'SW-E021': {
    what: 'project.yaml 无法解析',
    why: '文件不是合法 YAML——{detail}。',
    fix: '用编辑器检查 project.yaml 最近的改动并修正语法；或从 git 历史恢复该文件（`git checkout -- project.yaml`）。',
    example: { detail: 'Unexpected end of flow sequence' },
  },
  'SW-E022': {
    what: 'project.yaml 字段不完整或类型错误',
    why: '{issues}。',
    fix: '按「原因」中的提示逐项修正字段；或从 git 历史恢复该文件（`git checkout -- project.yaml`）。',
    example: { issues: ['title 必须是非空字符串'] },
  },
  'SW-E030': {
    what: '场景 {sceneId} 不存在',
    why: 'scenes/ 目录中没有编号为 {sceneId} 的场景文件。',
    fix: '从现有场景中选择一个编号：{existingIds}；或运行 `sw draft {sceneId} --title "<标题>"` 新建这一场。',
    example: { sceneId: '040', existingIds: ['010', '020', '030'] },
  },
};

export const ERROR_CODES = Object.keys(ERROR_REGISTRY) as readonly ErrorCode[];

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && value in ERROR_REGISTRY;
}

/** 段位（错误码第 2–3 位数字 → SPEC-03 注册表的段含义），供 docs 生成器分组。 */
export function errorSegment(code: ErrorCode): string {
  const SEGMENTS: Record<string, string> = {
    '01': 'SW-E01x 项目 / 文件系统',
    '02': 'SW-E02x 状态 / 版本',
    '03': 'SW-E03x 输入校验',
    '04': 'SW-E04x AI 供应商',
  };
  return SEGMENTS[code.slice(4, 6)] ?? `SW-E${code.slice(4, 5)}xx 未命名段（先勘误 SPEC-03 再启用）`;
}

/** 错误码对应的文档锚点 URL（SPEC-03 消息模板第 4 行「详情」）。 */
export function errorDocsUrl(code: ErrorCode): string {
  return `${ERROR_DOCS_BASE_URL}/${code}.md`;
}

/**
 * 统一错误类型：所有用户可见错误的唯一载体。
 * 接口层顶层 catch（src/cli/run.ts）据此渲染三段式消息并统一设定退出码 1（SPEC-03-EXT）。
 */
export class SwError<C extends ErrorCode = ErrorCode> extends Error {
  readonly code: C;
  readonly ctx: ErrorContexts[C];

  constructor(code: C, ctx: ErrorContexts[C]) {
    super(`${code} ${ERROR_REGISTRY[code].what}`);
    this.name = 'SwError';
    this.code = code;
    this.ctx = ctx;
  }
}

export function isSwError(value: unknown): value is SwError {
  return value instanceof SwError;
}

/**
 * 抛用户可见错误的唯一入口（SPEC-03 接口约定）。
 * 业务代码只 fail()，不 console.error、不 process.exit、不 program.error——
 * 三者分别被 no-console / no-restricted-properties lint 与评审清单拦截。
 */
export function fail<C extends ErrorCode>(code: C, ctx: ErrorContexts[C]): never {
  throw new SwError(code, ctx);
}

// ---------------------------------------------------------------------------
// 空态注册表（与错误文案同库管理、同 lint 覆盖，SPEC-03）
// ---------------------------------------------------------------------------

/**
 * 空态位点的上下文契约（v1 两个位点均无需运行时插值，ctx 为空对象；
 * 接口保持 hint(slot, ctx) 形态，后续位点可携带 ctx）。
 */
export interface HintContexts {
  /** P1 §6.3：scenes/ 为空（由 SPEC-02 的 status/draft 接线渲染，W1-P1-T05/T07）。 */
  'scenes-empty': Record<string, never>;
  /** P1 §6.3 / SPEC-02：outline.md 为空（由 sw status 提示、sw outline 写骨架时内嵌）。 */
  'outline-empty': Record<string, never>;
}

export type HintSlot = keyof HintContexts;

/** 空态三要素模板（P1 §6.3：这里是什么 / 示例长什么样 / 下一步敲什么命令）。 */
export interface HintSpec<S extends HintSlot = HintSlot> {
  /** 这里是什么。 */
  what: string;
  /** 放一个示例长什么样。 */
  example: string;
  /** 下一步敲什么命令（整行可复制，禁止行尾附注）。 */
  next: string;
  /** 样例 ctx（docs 与 lint 用）。 */
  exampleCtx: HintContexts[S];
}

/**
 * 空态注册表 v1：只收 P1 §6.3 点名的两个位点。
 * 注意（虚假可用性纪律，W1-P1-T01 验收 ③）：位点接线属 W1-P1-T05/T07——
 * 在 `sw draft` / `sw outline` 真实落地前，任何用户可见输出不得渲染这两条 hint。
 */
export const HINT_REGISTRY: { readonly [S in HintSlot]: HintSpec<S> } = {
  'scenes-empty': {
    what: 'scenes/ 目前是空的——这里按「一场一文件」存放每一场的正文（Markdown）。',
    example: 'scenes/010-opening.md（三位场编号-英文短名.md）',
    next: 'sw draft 010 --title "开场"',
    exampleCtx: {},
  },
  'outline-empty': {
    what: 'outline.md 还没有内容——这里是全片大纲，逐场列出场编号与一句话梗概。',
    example: '- 010 开场：主角在雨夜接到一通陌生电话',
    next: 'sw outline',
    exampleCtx: {},
  },
};

export const HINT_SLOTS = Object.keys(HINT_REGISTRY) as readonly HintSlot[];

export function isHintSlot(value: unknown): value is HintSlot {
  return typeof value === 'string' && value in HINT_REGISTRY;
}
