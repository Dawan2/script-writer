/**
 * SPEC-03 注册表 → docs/errors/ 生成器 + 注册表 lint（W1-P1-T06）。
 *
 * 用法：
 *   npm run gen:errors    # 校验注册表并（重新）生成 docs/errors/*
 *   npm run lint:errors   # 校验注册表 + 断言生成物与注册表零漂移（CI 步骤）
 *
 * lint 检查项：
 *   L1 错误码格式 ^SW-E\d{3}$ 且段位可解析；
 *   L2 三段式（what/why/fix）与空态三要素（what/example/next）非空；
 *   L3 样例 ctx 渲染后无未解析的 {placeholder}（模板与 ctx 契约一致）；
 *   L4 空态「下一步」为可复制的 sw 命令；
 *   L5 业务代码中不得出现注册表之外的 SW-Exxx 字面量（未注册码在 CI 失败）；
 *   L6（--check）docs/errors/ 与注册表逐字节一致，且无手写的多余文件。
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ERROR_CODES,
  ERROR_REGISTRY,
  HINT_REGISTRY,
  HINT_SLOTS,
  SwError,
  errorDocsUrl,
  errorSegment,
} from '../src/app/errors/registry.js';
import type { ErrorCode, TemplateValue } from '../src/app/errors/registry.js';
import { formatTemplate, renderError, renderHint } from '../src/app/errors/render.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ERRORS_DIR = join(ROOT, 'docs', 'errors');
const SRC_DIR = join(ROOT, 'src');
const REGISTRY_FILE = join(SRC_DIR, 'app', 'errors', 'registry.ts');

const problems: string[] = [];

function check(condition: boolean, message: string): void {
  if (!condition) {
    problems.push(message);
  }
}

const UNRESOLVED_PLACEHOLDER = /\{[a-zA-Z][a-zA-Z0-9]*\}/;

// ---------------------------------------------------------------------------
// L1–L4 注册表自身校验
// ---------------------------------------------------------------------------

for (const code of ERROR_CODES) {
  const spec = ERROR_REGISTRY[code];
  check(/^SW-E\d{3}$/.test(code), `L1 ${code}：错误码格式必须为 SW-E + 三位数字`);
  check(!errorSegment(code).includes('未命名段'), `L1 ${code}：段位未在 SPEC-03 注册表定义`);
  check(spec.what.trim().length > 0, `L2 ${code}：三段式「发生了什么」为空`);
  check(spec.why.trim().length > 0, `L2 ${code}：三段式「原因」为空`);
  check(spec.fix.trim().length > 0, `L2 ${code}：三段式「怎么办」为空`);
  const rendered = renderError(new SwError(code, spec.example));
  check(
    !UNRESOLVED_PLACEHOLDER.test(rendered),
    `L3 ${code}：样例 ctx 渲染后仍有未解析占位符：${rendered.match(UNRESOLVED_PLACEHOLDER)?.[0] ?? ''}`,
  );
}

for (const slot of HINT_SLOTS) {
  const spec = HINT_REGISTRY[slot];
  check(spec.what.trim().length > 0, `L2 空态 ${slot}：「这里是什么」为空`);
  check(spec.example.trim().length > 0, `L2 空态 ${slot}：「示例」为空`);
  check(spec.next.trim().length > 0, `L2 空态 ${slot}：「下一步」为空`);
  check(
    /^sw( |$)/.test(formatTemplate(spec.next, spec.exampleCtx as Record<string, TemplateValue>)),
    `L4 空态 ${slot}：「下一步」必须是可复制的 sw 命令（以 "sw" 开头）`,
  );
  const rendered = renderHint(slot, spec.exampleCtx);
  check(!UNRESOLVED_PLACEHOLDER.test(rendered), `L3 空态 ${slot}：样例 ctx 渲染后仍有未解析占位符`);
}

// ---------------------------------------------------------------------------
// L5 业务代码禁用未注册的 SW-Exxx 字面量
// ---------------------------------------------------------------------------

function* walkTsFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* walkTsFiles(full);
    } else if (full.endsWith('.ts')) {
      yield full;
    }
  }
}

const registered = new Set<string>(ERROR_CODES);
for (const file of walkTsFiles(SRC_DIR)) {
  if (resolve(file) === REGISTRY_FILE) continue;
  const content = readFileSync(file, 'utf8');
  for (const match of content.matchAll(/SW-E\d{3}/g)) {
    check(
      registered.has(match[0]),
      `L5 ${file.slice(ROOT.length + 1)}：出现未注册错误码字面量 ${match[0]}（先在 registry.ts 登记）`,
    );
  }
}

// ---------------------------------------------------------------------------
// 生成物组装（单一数据源 → docs/errors/，保证消息与文档永不漂移）
// ---------------------------------------------------------------------------

const GENERATED_NOTICE =
  '> **生成物，请勿手改**：本页由 `scripts/gen-error-docs.ts` 从 `src/app/errors/registry.ts` 生成；' +
  '修改文案请改注册表后运行 `npm run gen:errors`。CI 的 `npm run lint:errors` 会拦截漂移与手改。';

function errorPage(code: ErrorCode): string {
  const spec = ERROR_REGISTRY[code];
  const sample = renderError(new SwError(code, spec.example));
  return [
    `# ${code} ${spec.what}`,
    '',
    GENERATED_NOTICE,
    '',
    '| 项目 | 内容 |',
    '| --- | --- |',
    `| 段位 | ${errorSegment(code)} |`,
    `| 发生了什么 | ${spec.what} |`,
    `| 原因 | ${spec.why} |`,
    `| 怎么办 | ${spec.fix} |`,
    '| 退出码 | 1（SPEC-03-EXT：运行期错误） |',
    '',
    '文案中的 `{key}` 为运行时上下文占位符，输出时由实际值替换。',
    '',
    '## 示例输出',
    '',
    '```text',
    sample,
    '```',
    '',
  ].join('\n');
}

function indexPage(): string {
  const errorRows = ERROR_CODES.map(
    (code) => `| [\`${code}\`](./${code}.md) | ${ERROR_REGISTRY[code].what} | ${errorSegment(code)} |`,
  );
  const hintRows = HINT_SLOTS.map(
    (slot) => `| \`${slot}\` | ${HINT_REGISTRY[slot].what} | \`${HINT_REGISTRY[slot].next}\` |`,
  );
  return [
    '# 错误码目录（SPEC-03 注册表生成物）',
    '',
    GENERATED_NOTICE,
    '',
    '所有用户可见错误均为三段式（发生了什么 / 原因 / 怎么办）+ 本目录锚点链接，',
    '由 `fail(code, ctx)` 抛出、CLI 顶层 catch 统一渲染。',
    '',
    '## 退出码约定（SPEC-03-EXT，勘误前禁止新增其他码）',
    '',
    '| 退出码 | 含义 |',
    '| --- | --- |',
    '| 0 | 成功（含幂等式「无事可做」的成功） |',
    '| 1 | 运行期错误（任何经 `fail()` 输出的 SW-Exxx；亦含检查类命令发现问题） |',
    '| 2 | 用法错误（参数/旗标解析失败，未进入业务逻辑） |',
    '',
    '正文见 `docs/wave-02/P-gap-adjudication.md` §3.6。',
    '',
    '## 错误码索引',
    '',
    '| 错误码 | 发生了什么 | 段位 |',
    '| --- | --- | --- |',
    ...errorRows,
    '',
    '注：SW-E04x（AI 供应商）段暂无登记——AI 默认关闭、无触达路径，',
    '按 W1-P1-T06「禁止预填未用码」纪律待 AI 适配器落地时再登记。',
    '',
    '## 空态位点索引（与错误文案同库管理、同 lint 覆盖）',
    '',
    '| 位点 | 这里是什么 | 下一步命令 |',
    '| --- | --- | --- |',
    ...hintRows,
    '',
    '空态由 `hint(slot, ctx)` 渲染（三要素：这里是什么 / 示例 / 下一步命令）；',
    '位点接线属 W1-P1-T05/T07，接线前不得在用户可见输出中渲染。',
    '',
  ].join('\n');
}

const expectedFiles = new Map<string, string>();
expectedFiles.set('README.md', indexPage());
for (const code of ERROR_CODES) {
  expectedFiles.set(`${code}.md`, errorPage(code));
}

// 锚点 URL 与生成文件名一致性（渲染层的「详情」链接必须指向真实生成物）
for (const code of ERROR_CODES) {
  check(
    errorDocsUrl(code).endsWith(`/docs/errors/${code}.md`),
    `L1 ${code}：errorDocsUrl 与生成物路径不一致`,
  );
}

// ---------------------------------------------------------------------------
// 执行：--check 断言零漂移；默认写盘
// ---------------------------------------------------------------------------

const checkMode = process.argv.includes('--check');

if (checkMode) {
  for (const [name, content] of expectedFiles) {
    const path = join(ERRORS_DIR, name);
    if (!existsSync(path)) {
      problems.push(`L6 docs/errors/${name} 缺失：改动注册表后未运行 npm run gen:errors`);
      continue;
    }
    if (readFileSync(path, 'utf8') !== content) {
      problems.push(`L6 docs/errors/${name} 与注册表漂移（或被手改）：运行 npm run gen:errors 重新生成`);
    }
  }
  if (existsSync(ERRORS_DIR)) {
    for (const entry of readdirSync(ERRORS_DIR)) {
      check(expectedFiles.has(entry), `L6 docs/errors/${entry} 不是注册表生成物：该目录禁止手写文件`);
    }
  }
} else {
  mkdirSync(ERRORS_DIR, { recursive: true });
  for (const entry of readdirSync(ERRORS_DIR)) {
    // 只清理本生成器命名空间内的陈旧文件（码被移除时同步删页），不触碰其他文件
    if (!expectedFiles.has(entry) && (/^SW-E\d{3}\.md$/.test(entry) || entry === 'README.md')) {
      rmSync(join(ERRORS_DIR, entry));
    }
  }
  for (const [name, content] of expectedFiles) {
    writeFileSync(join(ERRORS_DIR, name), content, 'utf8');
  }
}

if (problems.length > 0) {
  console.error(`✖ 错误码注册表 lint 未通过（${problems.length} 项）：`);
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    checkMode
      ? `✔ 注册表 lint 通过：${ERROR_CODES.length} 个错误码 / ${HINT_SLOTS.length} 个空态位点，docs/errors/ 零漂移`
      : `✔ 已生成 docs/errors/（${expectedFiles.size} 个文件：${ERROR_CODES.length} 码 + 索引）`,
  );
}
