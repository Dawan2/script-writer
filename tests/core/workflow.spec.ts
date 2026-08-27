import { describe, expect, it } from 'vitest';
import { WORKFLOW_STEPS, isWorkflowStep, nextStep } from '../../src/core/model/workflow.js';

describe('core/model/workflow', () => {
  it('五步主工作流顺序与 P1 方案 §6.2 一致', () => {
    expect(WORKFLOW_STEPS).toEqual(['init', 'outline', 'draft', 'revise', 'export']);
  });

  it('nextStep 沿五步顺序推进', () => {
    expect(nextStep('init')).toBe('outline');
    expect(nextStep('outline')).toBe('draft');
    expect(nextStep('draft')).toBe('revise');
    expect(nextStep('revise')).toBe('export');
  });

  it('最后一步 export 之后没有下一步', () => {
    expect(nextStep('export')).toBeNull();
  });

  it('isWorkflowStep 只认领域词汇表内的步骤名', () => {
    for (const step of WORKFLOW_STEPS) {
      expect(isWorkflowStep(step)).toBe(true);
    }
    expect(isWorkflowStep('chapter')).toBe(false);
    expect(isWorkflowStep('')).toBe(false);
    expect(isWorkflowStep(42)).toBe(false);
    expect(isWorkflowStep(null)).toBe(false);
  });
});
