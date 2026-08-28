/**
 * 应用层·doctor 检查项注册表（W1-P1-T08；移植自 `cursor/w3-doctor-3e3d` 并适配 W3 集成后的引擎体系）。
 *
 * 按 ready-tasks 风险注记以「可注册检查项数组」组织（DOCTOR_CHECKS），
 * 后续功能槽新增检查（如 W2-GAP-T04 的 stale 锁判定）只需追加数组元素。
 *
 * 状态语义（退出码裁定见 doctor.ts / cli 命令层）：
 * - pass（绿）：检查通过；
 * - fail（红）：发现问题，必附可复制修复命令，任一红项 → 退出码 1；
 * - skip（跳过）：检查目标未实现 / 前置红项未通过 / 不适用，不计红。
 *
 * 与源分支的差异（适配记录）：
 * - 子集解析器 projectMetaRead.ts 整体退役——诊断层改消费引擎的 readProjectFileRaw +
 *   parseProjectMeta 严格校验（源分支 work-doctor.md §4-2/§5 交接注记明文允许的整体替换）；
 * - scenes-done 修复文案更新：sw draft 已交付（SPEC-05 §8.2 交接核销），移除「随 T05 交付」标注。
 */

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { SCHEMA_VERSION } from '../../core/model/project.js';
import {
  CHARACTERS_DIR,
  EXPORTS_DIR,
  OUTLINE_FILE,
  PROJECT_FILE,
  SCENES_DIR,
} from '../../infra/store/layout.js';
import { inspectDir } from '../../infra/store/projectFile.js';
import type { ProjectMetaFindings } from './validate.js';

export type CheckStatus = 'pass' | 'fail' | 'skip';

export interface CheckOutcome {
  status: CheckStatus;
  /** pass：一句话结论；fail：发生了什么/为什么；skip：为何跳过（未实现/前置未通过/不适用） */
  detail: string;
  /** fail 时必附：可复制的修复命令/操作 */
  fix?: string;
}

export interface CheckResult extends CheckOutcome {
  id: string;
  title: string;
}

/** project.yaml 预读四态（doctor.ts 一次 IO，多检查共享）。 */
export type DoctorProjectFile =
  | { state: 'missing' }
  | { state: 'not-file' }
  | { state: 'invalid'; reason: string }
  | { state: 'parsed' };

export interface DoctorContext {
  /** 项目根（绝对路径） */
  dir: string;
  /** 用户书写的目录参数（修复命令展示用；缺省时以 <dir> 占位） */
  dirArg?: string;
  /** Node 版本串（process.version 形态，注入以便测试） */
  nodeVersion: string;
  /** project.yaml 预读结果 */
  projectFile: DoctorProjectFile;
  /** 字段级校验结果（projectFile 为 parsed 时给出） */
  findings: ProjectMetaFindings | null;
}

export interface DoctorCheck {
  id: string;
  title: string;
  run(ctx: DoctorContext): Promise<CheckOutcome> | CheckOutcome;
}

function pass(detail: string): CheckOutcome {
  return { status: 'pass', detail };
}

function fail(detail: string, fix: string): CheckOutcome {
  return { status: 'fail', detail, fix };
}

function skip(detail: string): CheckOutcome {
  return { status: 'skip', detail };
}

function dirHint(ctx: DoctorContext): string {
  return ctx.dirArg ?? '<dir>';
}

/** 与 package.json engines.node（">=20"，ADR-0001 §3.2）保持一致；变更须两处同步。 */
export const REQUIRED_NODE_MAJOR = 20;

function parseNodeMajor(version: string): number | null {
  const match = /^v?(\d+)\./.exec(version);
  return match ? Number(match[1]) : null;
}

const runtimeCheck: DoctorCheck = {
  id: 'runtime-node',
  title: '运行时版本',
  run(ctx) {
    const major = parseNodeMajor(ctx.nodeVersion);
    if (major === null) {
      return fail(
        `无法解析 Node 版本号：${ctx.nodeVersion}`,
        `安装官方发行版 Node ${REQUIRED_NODE_MAJOR}+（https://nodejs.org）后重跑 \`sw doctor\``,
      );
    }
    if (major < REQUIRED_NODE_MAJOR) {
      return fail(
        `Node ${ctx.nodeVersion} 低于要求（≥ ${REQUIRED_NODE_MAJOR}，package.json engines）`,
        `升级 Node 至 ${REQUIRED_NODE_MAJOR}+（如 \`nvm install 22\`，或从 https://nodejs.org 安装）`,
      );
    }
    return pass(`Node ${ctx.nodeVersion} 满足要求（≥ ${REQUIRED_NODE_MAJOR}）`);
  },
};

const projectFileCheck: DoctorCheck = {
  id: 'project-file',
  title: '项目文件',
  run(ctx) {
    switch (ctx.projectFile.state) {
      case 'missing':
        return fail(
          `未找到 ${PROJECT_FILE}——目标目录可能不是 script-writer 项目`,
          `运行 \`sw init ${dirHint(ctx)}\` 新建项目，或 cd 到既有项目根后重跑 \`sw doctor\``,
        );
      case 'not-file':
        return fail(
          `${PROJECT_FILE} 被同名目录占用，无法作为项目元数据读取`,
          `移走该同名目录后运行 \`sw init ${dirHint(ctx)} --force\` 重建（同名脚手架文件将被覆盖，其余文件保留）`,
        );
      default:
        return pass(`${PROJECT_FILE} 存在且可读取`);
    }
  },
};

const schemaCheck: DoctorCheck = {
  id: 'meta-schema',
  title: '元数据 schema',
  run(ctx) {
    if (ctx.projectFile.state === 'missing' || ctx.projectFile.state === 'not-file') {
      return skip('前置红项「项目文件」未通过，跳过');
    }
    if (ctx.projectFile.state === 'invalid') {
      return fail(
        `${PROJECT_FILE} 无法解析：${ctx.projectFile.reason}`,
        `对照 \`sw init --yes\` 产出的文件样式修正 ${PROJECT_FILE}；或备份其内容后运行 \`sw init ${dirHint(ctx)} --force\` 重建（同名脚手架文件将被覆盖）`,
      );
    }
    const issues = ctx.findings?.issues ?? [];
    if (issues.length > 0) {
      return fail(
        `字段校验未通过：${issues.join('；')}`,
        `编辑 ${PROJECT_FILE} 逐项修正（schema 须为 ${SCHEMA_VERSION}）；或备份后运行 \`sw init ${dirHint(ctx)} --force\` 重建（同名脚手架文件将被覆盖）`,
      );
    }
    return pass(`schema: ${SCHEMA_VERSION}，必填字段与取值均合法`);
  },
};

const layoutCheck: DoctorCheck = {
  id: 'layout',
  title: '目录布局',
  async run(ctx) {
    const problems: string[] = [];
    const missingDirs: string[] = [];
    const occupied: string[] = [];
    let outlineMissing = false;

    const outlineState = await inspectDir(path.join(ctx.dir, OUTLINE_FILE));
    if (outlineState === 'missing') {
      problems.push(`${OUTLINE_FILE} 缺失`);
      outlineMissing = true;
    } else if (outlineState !== 'file') {
      problems.push(`${OUTLINE_FILE} 被同名目录占用`);
      occupied.push(OUTLINE_FILE);
    }

    for (const dir of [CHARACTERS_DIR, SCENES_DIR, EXPORTS_DIR]) {
      const state = await inspectDir(path.join(ctx.dir, dir));
      if (state === 'missing') {
        problems.push(`${dir}/ 缺失`);
        missingDirs.push(dir);
      } else if (state === 'file') {
        problems.push(`${dir}/ 被同名文件占用`);
        occupied.push(dir);
      }
    }

    if (problems.length === 0) {
      return pass(`${OUTLINE_FILE}、${CHARACTERS_DIR}/、${SCENES_DIR}/、${EXPORTS_DIR}/ 齐备`);
    }
    const fixParts: string[] = [];
    if (missingDirs.length > 0) {
      fixParts.push(`在项目根运行 \`mkdir -p ${missingDirs.join(' ')}\` 补齐目录`);
    }
    if (outlineMissing) {
      fixParts.push(
        `运行 \`sw outline\` 补齐 ${OUTLINE_FILE} 模板骨架（幂等：只补缺、不覆盖）`,
      );
    }
    if (occupied.length > 0) {
      fixParts.push(`移走被同名条目占用的路径（${occupied.join('、')}）后重跑 \`sw doctor\``);
    }
    return fail(`布局不完整：${problems.join('；')}`, fixParts.join('；'));
  },
};

const scenesDoneCheck: DoctorCheck = {
  id: 'scenes-done',
  title: '场景一致性',
  async run(ctx) {
    const scenesDone = ctx.findings?.scenesDone ?? null;
    if (scenesDone === null) {
      return skip(`依赖 ${PROJECT_FILE} 的 progress.scenes_done 字段，前置红项未通过，跳过`);
    }
    if (scenesDone.length === 0) {
      return pass('progress.scenes_done 为空，无需比对');
    }
    let names: string[];
    try {
      names = await readdir(path.join(ctx.dir, SCENES_DIR));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        names = [];
      } else {
        throw error;
      }
    }
    const missing = scenesDone.filter(
      (id) =>
        !names.some((name) => name === `${id}.md` || (name.startsWith(`${id}-`) && name.endsWith('.md'))),
    );
    if (missing.length === 0) {
      return pass(`progress.scenes_done 记录的 ${scenesDone.length} 个场景在磁盘均有对应文件`);
    }
    // SPEC-05 §8.2 交接核销：sw draft 已交付，修复路径指向真实命令（移除「随 T05 交付」标注）
    return fail(
      `progress.scenes_done 记录的场景缺少磁盘文件：${missing.join('、')}`,
      `运行 \`sw draft ${missing[0]}\` 重建该场骨架，或编辑 ${PROJECT_FILE} 从 progress.scenes_done 移除缺失编号`,
    );
  },
};

/** GAP-04 裁决的项目级建议性文件锁路径（实现属 W2-GAP-T04）。 */
export const LOCK_FILE = '.sw/lock';

const lockCheck: DoctorCheck = {
  id: 'project-lock',
  title: '项目锁',
  async run(ctx) {
    // 锁机制（GAP-04：`.sw/lock`，pid/hostname/acquired_at）属 W2-GAP-T04，尚未交付。
    // 按调度指令报「未实现」且不崩溃；T04 落地后本检查项接入 stale 判定（红项 + 修复命令）。
    const state = await inspectDir(path.join(ctx.dir, LOCK_FILE));
    const foundNote = state === 'file' ? `（已发现 ${LOCK_FILE} 文件，暂不判定其健康度）` : '';
    return skip(
      `未实现——锁机制（GAP-04 裁决的 ${LOCK_FILE}）属 W2-GAP-T04，尚未交付；落地后本检查项接入 stale 锁判定与修复命令${foundNote}`,
    );
  },
};

const aiKeyCheck: DoctorCheck = {
  id: 'ai-key',
  title: 'AI key',
  run(ctx) {
    const aiEnabled = ctx.findings?.aiEnabled ?? null;
    if (aiEnabled === null) {
      return skip(`依赖 ${PROJECT_FILE} 的 settings.ai 字段，前置红项未通过，跳过`);
    }
    if (!aiEnabled) {
      return pass('AI 辅助未启用（settings.ai.enabled: false），无需检查 key');
    }
    return skip(
      '未实现——AI 已启用，但供应商网关属 TASK-P3-01（BLK-W1-02 凭据未定），key 有效性检查随其交付',
    );
  },
};

/** doctor 检查项注册表（执行顺序即报告顺序）。 */
export const DOCTOR_CHECKS: DoctorCheck[] = [
  runtimeCheck,
  projectFileCheck,
  schemaCheck,
  layoutCheck,
  scenesDoneCheck,
  lockCheck,
  aiKeyCheck,
];
