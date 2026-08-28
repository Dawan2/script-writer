/**
 * Agent 层·首批只读工具（TASK-P3-05，P3 方案 §2.1 首批清单）：
 * read_scene / list_scenes / get_bible_entry，side_effect 全为 none（P-3）。
 *
 * 取数面纪律：剧本正文经 P1 既有 store 层（sceneFile/layout），不自带第二套解析；
 * 设定集 v1 读取 `story-bible/` 与 `characters/` 两个目录的 <名>.md（TASK-P3-06
 * Story Bible 结构化层落地后切换取数面，工具描述不变——方案 §6 R-4 接口不变条款）。
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CHARACTERS_DIR, SCENES_DIR } from '../../infra/store/layout.js';
import {
  findSceneFileById,
  listSceneFiles,
  normalizeSceneId,
} from '../../infra/store/sceneFile.js';
import { ToolCallError, type Tool } from './types.js';

const SCENE_FILE = /^(\d{3,})-(.+)\.md$/;

/** read_scene：按场号读场景原文（改写/续写前取权威原文用）。 */
export const readSceneTool: Tool = {
  desc: {
    name: 'read_scene',
    version: '1',
    description: '读取指定场号的场景全文与元数据。用于改写/续写/一致性检查前获取权威原文。',
    params: { scene_id: { type: 'string', required: true, desc: '场号，如 010（1–3 位自动补零）' } },
    returns: { type: 'object' },
    sideEffect: 'none',
    preconditions: ['剧本已存在且包含该场号'],
    failureModes: ['SCENE_NOT_FOUND', 'SCENE_ID_INVALID'],
    costHint: 'cheap',
  },
  async handler(ctx, args) {
    const sceneId = normalizeSceneId(String(args.scene_id));
    if (sceneId === null) {
      throw new ToolCallError('read_scene', 'SCENE_ID_INVALID', `场号不合法：${String(args.scene_id)}`);
    }
    const fileName = await findSceneFileById(ctx.projectDir, sceneId);
    if (fileName === undefined) {
      throw new ToolCallError('read_scene', 'SCENE_NOT_FOUND', `场 ${sceneId} 不存在`);
    }
    return {
      scene_id: sceneId,
      file: fileName,
      content: await readFile(join(ctx.projectDir, SCENES_DIR, fileName), 'utf8'),
    };
  },
};

/** list_scenes：列出分场结构（场号/slug/文件）。 */
export const listScenesTool: Tool = {
  desc: {
    name: 'list_scenes',
    version: '1',
    description: '列出剧本的分场结构（场号、短名、文件名）。用于规划改写范围或检索前先摸清分场全貌。',
    params: {},
    returns: { type: 'array' },
    sideEffect: 'none',
    preconditions: ['剧本目录存在'],
    failureModes: ['PROJECT_DIR_MISSING'],
    costHint: 'cheap',
  },
  async handler(ctx) {
    const files = await listSceneFiles(ctx.projectDir);
    return files.map((file) => {
      const match = SCENE_FILE.exec(file);
      return { scene_id: match?.[1] ?? '', slug: match?.[2] ?? '', file };
    });
  },
};

/** get_bible_entry：读设定集条目（story-bible/ 优先，characters/ 兼容）。 */
export const getBibleEntryTool: Tool = {
  desc: {
    name: 'get_bible_entry',
    version: '1',
    description: '读取设定集条目（人物/地点/伏笔）全文。用于改写或一致性检查前核对既定事实，防止虚构设定外的内容。',
    params: { name: { type: 'string', required: true, desc: '条目名（人物/地点名，对应 <名>.md 文件名）' } },
    returns: { type: 'object' },
    sideEffect: 'none',
    preconditions: ['设定集条目文件存在（story-bible/ 或 characters/ 下 <名>.md）'],
    failureModes: ['ENTRY_NOT_FOUND'],
    costHint: 'cheap',
  },
  async handler(ctx, args) {
    const name = String(args.name);
    if (/[/\\]|\.\./.test(name)) {
      throw new ToolCallError('get_bible_entry', 'ENTRY_NOT_FOUND', `条目名非法：${name}`);
    }
    for (const dirName of ['story-bible', CHARACTERS_DIR]) {
      const path = join(ctx.projectDir, dirName, `${name}.md`);
      try {
        return { name, path: `${dirName}/${name}.md`, content: await readFile(path, 'utf8') };
      } catch {
        // 继续下一目录
      }
    }
    throw new ToolCallError('get_bible_entry', 'ENTRY_NOT_FOUND', `条目不存在：${name}`);
  },
};

/** 首批只读工具集（注册表输入）。 */
export const BUILTIN_TOOLS: readonly Tool[] = [readSceneTool, listScenesTool, getBibleEntryTool];
