import { describe, expect, it } from 'vitest';
import { WORKFLOW_STEPS } from '../../src/core/model/workflow.js';
import { nextCommandHint } from '../../src/app/workflow/status.js';

describe('app/workflow/status', () => {
  it('每个步骤都有可复制的建议命令，且以 sw 开头（SPEC-02 约定）', () => {
    for (const step of WORKFLOW_STEPS) {
      const hint = nextCommandHint(step);
      expect(hint.startsWith('sw ')).toBe(true);
    }
  });

  it('步骤与命令词汇一致（P1 §6.1 单一词汇表）', () => {
    expect(nextCommandHint('outline')).toBe('sw outline');
    expect(nextCommandHint('export')).toBe('sw export');
    expect(nextCommandHint('draft')).toContain('sw draft');
  });
});
