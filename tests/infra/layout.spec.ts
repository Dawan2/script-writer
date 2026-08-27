import { describe, expect, it } from 'vitest';
import {
  CHARACTERS_DIR,
  EXPORTS_DIR,
  OUTLINE_FILE,
  PROJECT_FILE,
  SCENES_DIR,
  padSceneId,
  sceneFileName,
} from '../../src/infra/store/layout.js';

describe('infra/store/layout', () => {
  it('目录布局常量与 P1 方案 §6.1 一致', () => {
    expect(PROJECT_FILE).toBe('project.yaml');
    expect(OUTLINE_FILE).toBe('outline.md');
    expect(CHARACTERS_DIR).toBe('characters');
    expect(SCENES_DIR).toBe('scenes');
    expect(EXPORTS_DIR).toBe('exports');
  });

  it('padSceneId 三位零填充', () => {
    expect(padSceneId(10)).toBe('010');
    expect(padSceneId(0)).toBe('000');
    expect(padSceneId(1234)).toBe('1234');
  });

  it('padSceneId 拒绝负数与非整数', () => {
    expect(() => padSceneId(-1)).toThrow(RangeError);
    expect(() => padSceneId(1.5)).toThrow(RangeError);
  });

  it('sceneFileName 产出 §6.1 形态的文件名（010-opening.md）', () => {
    expect(sceneFileName(10, 'opening')).toBe('010-opening.md');
    expect(sceneFileName(1, '  Cold Open ')).toBe('001-cold-open.md');
  });

  it('sceneFileName 拒绝空 slug', () => {
    expect(() => sceneFileName(1, '   ')).toThrow(RangeError);
  });
});
