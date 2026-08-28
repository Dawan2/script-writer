/**
 * 基础设施·项目目录布局常量与路径纯函数（P1 方案 §6.1 用户项目布局）。
 * 只做路径计算，不做 IO；原子写等存储实现属 W1-P1-T04/T05。
 */

export const PROJECT_FILE = 'project.yaml';
export const OUTLINE_FILE = 'outline.md';
export const CHARACTERS_DIR = 'characters';
export const SCENES_DIR = 'scenes';
export const EXPORTS_DIR = 'exports';
/** 项目级建议性文件锁路径（SPEC-07 §3.1：常量正典在本模块，doctor 检查项从此导入）。 */
export const LOCK_FILE = '.sw/lock';

/** 场编号 → 三位零填充字符串（10 → "010"）。 */
export function padSceneId(id: number): string {
  if (!Number.isInteger(id) || id < 0) {
    throw new RangeError(`场编号必须是非负整数，收到：${id}`);
  }
  return String(id).padStart(3, '0');
}

/** 场文件名 = 场编号 + slug（P1 §6.1：scenes/010-opening.md）。 */
export function sceneFileName(id: number, slug: string): string {
  const normalized = slug
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-');
  if (normalized.length === 0) {
    throw new RangeError('场景 slug 不能为空');
  }
  return `${padSceneId(id)}-${normalized}.md`;
}
