import { describe, expect, it } from 'vitest';
import type { ProjectProgress } from '../../src/core/model/project.js';
import {
  ensureStepAtLeast,
  isStepBefore,
  recordSceneDone,
  recordSceneRevised,
  sceneCompletion,
} from '../../src/core/model/progress.js';

const base: ProjectProgress = { step: 'outline', scenesDone: [], scenesRevised: [] };

describe('core/model/progress：recordSceneRevised（SPEC-04/W2-GAP-T01，与 recordSceneDone 同构）', () => {
  it('记录场编号且不改入参；幂等；保持升序', () => {
    const once = recordSceneRevised(base, '020');
    expect(once.scenesRevised).toEqual(['020']);
    expect(base.scenesRevised).toEqual([]);
    expect(recordSceneRevised(once, '020')).toBe(once);
    expect(recordSceneRevised(once, '010').scenesRevised).toEqual(['010', '020']);
  });
});

describe('core/model/progress', () => {
  it('recordSceneDone 记录场编号且不改入参（纯函数）', () => {
    const next = recordSceneDone(base, '010');
    expect(next.scenesDone).toEqual(['010']);
    expect(base.scenesDone).toEqual([]);
  });

  it('recordSceneDone 幂等：同 id 重复记录返回原对象、不产生变化（§6.2）', () => {
    const once = recordSceneDone(base, '010');
    const twice = recordSceneDone(once, '010');
    expect(twice).toBe(once);
    expect(twice.scenesDone).toEqual(['010']);
  });

  it('recordSceneDone 保持场编号有序（020 后补 010 仍升序）', () => {
    const progress = recordSceneDone(recordSceneDone(base, '020'), '010');
    expect(progress.scenesDone).toEqual(['010', '020']);
  });

  it('recordSceneDone 拒绝空编号', () => {
    expect(() => recordSceneDone(base, '  ')).toThrow(RangeError);
  });

  it('ensureStepAtLeast 向前补齐步骤（可跳过语义）、不回退（幂等）', () => {
    expect(ensureStepAtLeast(base, 'draft').step).toBe('draft');
    const atExport: ProjectProgress = { step: 'export', scenesDone: [], scenesRevised: [] };
    expect(ensureStepAtLeast(atExport, 'draft')).toBe(atExport);
  });

  it('isStepBefore 遵循五步顺序', () => {
    expect(isStepBefore('init', 'outline')).toBe(true);
    expect(isStepBefore('draft', 'draft')).toBe(false);
    expect(isStepBefore('export', 'draft')).toBe(false);
  });

  it('sceneCompletion = 已记录完成数 / 磁盘实际场文件数（sw status 的 3/5 语义）', () => {
    const progress: ProjectProgress = { step: 'draft', scenesDone: ['010', '020', '030'], scenesRevised: [] };
    const disk = { outlineExists: true, sceneIds: ['010', '020', '030', '040', '050'] };
    expect(sceneCompletion(progress, disk)).toEqual({ done: 3, total: 5 });
  });
});
