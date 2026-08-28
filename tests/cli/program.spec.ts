import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildProgram } from '../../src/cli/program.js';

const pkg = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string; description: string };

describe('cli/program', () => {
  it('命令名为 sw（P1 §6.4 单一入口命令）', () => {
    expect(buildProgram().name()).toBe('sw');
  });

  it('版本号与 package.json 一致', () => {
    expect(buildProgram().version()).toBe(pkg.version);
  });

  it('--help 输出包含五步路线图且未实现命令标注"规划中"（无虚假可用性承诺）', () => {
    // addHelpText('after') 只在 help 事件时输出，故走 parse(--help) 并捕获 stdout
    let printed = '';
    const program = buildProgram();
    program.exitOverride();
    program.configureOutput({
      writeOut: (str) => {
        printed += str;
      },
    });
    expect(() => program.parse(['node', 'sw', '--help'])).toThrow();
    expect(printed).toContain('init → outline → draft → revise → export');
    // W2-GAP-T01/W3-DRAFT-T02 落地后五步主命令全部可用（断言迁移：原「其余规划中」
    // 的诚实进度意图由逐条 [可用 · 任务号] 标注承接；doctor 仍为 aux 规划中，见 --all 视图）。
    expect(printed).toContain('[可用 · W3-DRAFT-T02]');
    expect(printed).toContain('docs/quickstart.md');
  });

  it('--help 输出含帮助与版本旗标说明', () => {
    const help = buildProgram().helpInformation();
    expect(help).toContain('-V, --version');
    expect(help).toContain('-h, --help');
  });
});
