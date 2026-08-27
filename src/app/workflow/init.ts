/**
 * 应用层·SPEC-01 `sw init` 向导编排（W1-P1-T04）。
 *
 * - 四问向导：①标题 ②脚本类型 ③预计场数（GAP-03 → expectedSceneCount）④AI 辅助；
 *   每问显示默认值，回车（或输入流 EOF）即接受；`--yes` 与已提供旗标自动跳过对应问题。
 * - 交互能力经 InitDeps 注入（可注入 stdin 的实现，便于自动化测试——ready-tasks T04 风险项）。
 * - 错误统一 fail(code, ctx)（SW-E010/E013/E031，SPEC-03 唯一入口——W3 集成语义冲突 ③④ 核销），
 *   由接口层顶层 catch 渲染并退出码 1（SPEC-03-EXT）。
 * - project.yaml 序列化走 engine 正典 serializeProjectFile（语义冲突 ⑤ 核销）。
 */

import path from 'node:path';
import {
  DEFAULT_EXPECTED_SCENE_COUNT,
  SCRIPT_FORMATS,
  createProjectMeta,
  isScriptFormat,
  type ProjectMeta,
  type ScriptFormat,
} from '../../core/model/project.js';
import {
  CHARACTERS_DIR,
  EXPORTS_DIR,
  PROJECT_FILE,
  SCENES_DIR,
} from '../../infra/store/layout.js';
import {
  inspectDir,
  materializeProjectDir,
  serializeProjectFile,
  type ProjectFileEntry,
} from '../../infra/store/projectFile.js';
import { listTemplates, loadTemplate, renderTemplateFiles } from '../../infra/store/templates.js';
import { fail } from '../errors/registry.js';

export interface InitFlags {
  template?: string;
  yes?: boolean;
  title?: string;
  format?: ScriptFormat;
  scenes?: number;
  ai?: boolean;
  force?: boolean;
}

export interface InitDeps {
  /** 提问并返回用户输入的一行（''=接受默认；EOF 时实现方应返回 ''） */
  ask(question: string): Promise<string>;
  /** 向导过程中的提示行（如输入无法识别时的重问说明） */
  info(line: string): void;
  /** 当天日期 YYYY-MM-DD（注入以获得确定性输出） */
  today(): string;
}

export type WizardQuestionKey = 'title' | 'format' | 'expectedSceneCount' | 'aiEnabled';

const ALL_QUESTIONS: WizardQuestionKey[] = ['title', 'format', 'expectedSceneCount', 'aiEnabled'];

/** 计算需要实际提问的问题（SPEC-01：--yes 全跳过；旗标提供的问题自动跳过）。 */
export function planQuestions(flags: InitFlags): WizardQuestionKey[] {
  if (flags.yes) {
    return [];
  }
  return ALL_QUESTIONS.filter((key) => {
    switch (key) {
      case 'title':
        return flags.title === undefined;
      case 'format':
        return flags.format === undefined;
      case 'expectedSceneCount':
        return flags.scenes === undefined;
      case 'aiEnabled':
        return flags.ai === undefined;
    }
  });
}

/** 第 ② 问答案解析：''=默认；序号（1..n，按 SCRIPT_FORMATS 顺序）或格式名；无法识别返回 null。 */
export function parseFormatAnswer(raw: string, fallback: ScriptFormat): ScriptFormat | null {
  const input = raw.trim().toLowerCase();
  if (input === '') {
    return fallback;
  }
  const index = Number(input);
  if (Number.isInteger(index) && index >= 1 && index <= SCRIPT_FORMATS.length) {
    return SCRIPT_FORMATS[index - 1] ?? null;
  }
  return isScriptFormat(input) ? input : null;
}

/** 第 ③ 问答案解析：''=默认；正整数；否则 null。 */
export function parseSceneCountAnswer(raw: string, fallback: number): number | null {
  const input = raw.trim();
  if (input === '') {
    return fallback;
  }
  if (!/^\d+$/.test(input)) {
    return null;
  }
  const value = Number(input);
  return value >= 1 ? value : null;
}

/** 第 ④ 问答案解析：''=默认；y/yes/是 → true；n/no/否 → false；否则 null。 */
export function parseYesNoAnswer(raw: string, fallback: boolean): boolean | null {
  const input = raw.trim().toLowerCase();
  if (input === '') {
    return fallback;
  }
  if (input === 'y' || input === 'yes' || input === '是') {
    return true;
  }
  if (input === 'n' || input === 'no' || input === '否') {
    return false;
  }
  return null;
}

export interface InitResult {
  /** 项目根（绝对路径） */
  dir: string;
  /** 实际渲染使用的模板 id */
  templateId: string;
  /** 所选脚本类型尚无同名模板、回退到通用模板时为 true */
  templateFallback: boolean;
  meta: ProjectMeta;
  /** 实际提问的问题（≤ 4；--yes 或旗标全给时为空） */
  questionsAsked: WizardQuestionKey[];
}

interface WizardAnswers {
  title: string;
  format: ScriptFormat;
  expectedSceneCount: number;
  aiEnabled: boolean;
}

async function askUntilParsed<T>(
  deps: InitDeps,
  prompt: string,
  parse: (raw: string) => T | null,
  retryHint: string,
): Promise<T> {
  for (;;) {
    const raw = await deps.ask(prompt);
    const parsed = parse(raw);
    if (parsed !== null) {
      return parsed;
    }
    deps.info(retryHint);
  }
}

async function collectAnswers(flags: InitFlags, defaults: WizardAnswers, deps: InitDeps): Promise<{ answers: WizardAnswers; asked: WizardQuestionKey[] }> {
  const asked = planQuestions(flags);
  const answers: WizardAnswers = {
    title: flags.title?.trim() || defaults.title,
    format: flags.format ?? defaults.format,
    expectedSceneCount: flags.scenes ?? defaults.expectedSceneCount,
    aiEnabled: flags.ai ?? defaults.aiEnabled,
  };
  for (const key of asked) {
    switch (key) {
      case 'title': {
        const raw = await deps.ask(`? ①项目标题（默认：${defaults.title}）：`);
        answers.title = raw.trim() || defaults.title;
        break;
      }
      case 'format': {
        const menu = SCRIPT_FORMATS.map((format, i) => `[${i + 1}] ${format}`).join(' ');
        answers.format = await askUntilParsed(
          deps,
          `? ②脚本类型 ${menu}（默认：${defaults.format}）：`,
          (raw) => parseFormatAnswer(raw, defaults.format),
          `  无法识别，请输入 1-${SCRIPT_FORMATS.length} 或格式名（${SCRIPT_FORMATS.join(' / ')}）。`,
        );
        break;
      }
      case 'expectedSceneCount': {
        answers.expectedSceneCount = await askUntilParsed(
          deps,
          `? ③预计场数（默认：${defaults.expectedSceneCount}）：`,
          (raw) => parseSceneCountAnswer(raw, defaults.expectedSceneCount),
          '  无法识别，请输入一个正整数。',
        );
        break;
      }
      case 'aiEnabled': {
        answers.aiEnabled = await askUntilParsed(
          deps,
          '? ④启用 AI 辅助？[y/N]（默认：否）：',
          (raw) => parseYesNoAnswer(raw, defaults.aiEnabled),
          '  无法识别，请输入 y 或 n。',
        );
        break;
      }
    }
  }
  return { answers, asked };
}

// E010 双现场裁定（W3 集成，integration-map §3-④）：目录非空沿用注册表既有 SW-E010 模板；
// 「目标是文件」语义不同，拆为新码 SW-E013（同码双文案会破坏注册表单一数据源）。

async function resolveTemplate(
  explicitId: string | undefined,
  format: ScriptFormat,
): Promise<{ templateId: string; templateFallback: boolean }> {
  const available = await listTemplates();
  if (explicitId !== undefined) {
    if (!available.includes(explicitId)) {
      fail('SW-E031', { templateId: explicitId, available });
    }
    return { templateId: explicitId, templateFallback: false };
  }
  if (available.includes(format)) {
    return { templateId: format, templateFallback: false };
  }
  // screenplay / podcast 专属模板随 W1-P1-T07 交付；此前回退到 v1 通用骨架。
  return { templateId: 'short-video', templateFallback: true };
}

/** SPEC-01 数据流：收集答案 → 模板渲染 → 原子写入。返回摘要所需信息，输出渲染由接口层负责。 */
export async function runInitWorkflow(
  dirArg: string | undefined,
  flags: InitFlags,
  deps: InitDeps,
): Promise<InitResult> {
  const target = path.resolve(dirArg ?? '.');

  const dirState = await inspectDir(target);
  if (dirState === 'file') {
    fail('SW-E013', { target });
  }
  if (dirState === 'non-empty' && !flags.force) {
    fail('SW-E010', { dir: target });
  }

  const defaults: WizardAnswers = {
    title: path.basename(target),
    format: flags.template !== undefined && isScriptFormat(flags.template) ? flags.template : 'short-video',
    expectedSceneCount: DEFAULT_EXPECTED_SCENE_COUNT,
    aiEnabled: false,
  };
  const { answers, asked } = await collectAnswers(flags, defaults, deps);

  const { templateId, templateFallback } = await resolveTemplate(flags.template, answers.format);

  const meta = createProjectMeta({
    title: answers.title,
    format: answers.format,
    created: deps.today(),
    expectedSceneCount: answers.expectedSceneCount,
    aiEnabled: answers.aiEnabled,
  });

  const templateFiles = renderTemplateFiles(await loadTemplate(templateId), {
    title: meta.title,
    format: meta.format,
    expectedSceneCount: String(answers.expectedSceneCount),
  });
  const files: ProjectFileEntry[] = [
    { relPath: PROJECT_FILE, content: serializeProjectFile(meta) },
    ...templateFiles,
  ];

  await materializeProjectDir(target, files, {
    dirState,
    ensureDirs: [CHARACTERS_DIR, SCENES_DIR, EXPORTS_DIR],
  });

  return { dir: target, templateId, templateFallback, meta, questionsAsked: asked };
}
