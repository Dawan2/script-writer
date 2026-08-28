import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildProgram } from '../../src/cli/program.js';
import { runOutline } from '../../src/cli/commands/outline.js';
import { initProject } from '../../src/app/workflow/engine.js';
import { isSwError } from '../../src/app/errors/registry.js';
import { OUTLINE_FILE } from '../../src/infra/store/layout.js';
import type { CliIo } from '../../src/cli/io.js';

function captureIo(): CliIo & { stdout: () => string; stderr: () => string } {
  let out = '';
  let err = '';
  return {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
    stdout: () => out,
    stderr: () => err,
  };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sw-cli-outline-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('cli/commands/outline：注册与帮助', () => {
  it('outline 子命令已注册到 sw（W1-P1-T07 最小版落地）', () => {
    const names = buildProgram(captureIo()).commands.map((cmd) => cmd.name());
    expect(names).toContain('outline');
  });

  it('outline --help 含 ≥1 个可复制示例（P1 §4 命令可发现性指标）', () => {
    const program = buildProgram(captureIo());
    const outline = program.commands.find((cmd) => cmd.name() === 'outline');
    expect(outline).toBeDefined();
    let printed = '';
    outline?.exitOverride();
    outline?.configureOutput({
      writeOut: (str) => {
        printed += str;
      },
    });
    expect(() => outline?.parse(['node', 'sw', '--help'])).toThrow();
    expect(printed).toContain('示例');
    expect(printed).toContain('sw outline');
  });

  it('主程序 --help 中 outline 标注为可用而非规划中（注册表化后仍满足诚实进度）', () => {
    let printed = '';
    const program = buildProgram(captureIo());
    program.exitOverride();
    program.configureOutput({
      writeOut: (str) => {
        printed += str;
      },
    });
    expect(() => program.parse(['node', 'sw', '--help'])).toThrow();
    const line = printed.split('\n').find((text) => text.includes('sw outline'));
    expect(line).toContain('可用');
    expect(line).not.toContain('规划中');
  });

  it('短别名 o 已注册且 help 尾注可见（SPEC-07 §4.5）', () => {
    const outline = buildProgram(captureIo()).commands.find((cmd) => cmd.name() === 'outline');
    expect(outline?.alias()).toBe('o');
    let printed = '';
    outline?.exitOverride();
    outline?.configureOutput({
      writeOut: (str) => {
        printed += str;
      },
    });
    expect(() => outline?.parse(['node', 'sw', '--help'])).toThrow();
    expect(printed).toContain('短别名：sw o ≡ sw outline');
  });
});

describe('cli/commands/outline：执行体（引擎接线，失败走 fail() 通道）', () => {
  it('项目目录内首跑：报告创建，末行为可复制的下一步命令', async () => {
    await initProject(dir, { title: '我的短片', created: '2026-08-27' });
    const lines = await runOutline(dir);
    expect(lines.join('\n')).toContain('已创建 outline.md');
    const last = lines[lines.length - 1];
    expect(last?.startsWith('sw ')).toBe(true);
    expect(last).not.toContain('<');
  });

  it('重复运行：幂等报告"未改动"', async () => {
    await initProject(dir, { title: '我的短片', created: '2026-08-27' });
    await runOutline(dir);
    const lines = await runOutline(dir);
    expect(lines.join('\n')).toContain('未改动');
  });

  it('已有手写大纲：不覆盖并如实报告（幂等约束）', async () => {
    await initProject(dir, { title: '我的短片', created: '2026-08-27' });
    await writeFile(join(dir, OUTLINE_FILE), '# 手写大纲\n010 开场\n');
    const lines = await runOutline(dir);
    expect(lines.join('\n')).toContain('未改动');
  });

  it('非项目目录：抛 SW-E011（渲染与退出码 1 由 runCli 顶层负责）', async () => {
    try {
      await runOutline(dir);
      expect.unreachable('应抛 SwError');
    } catch (error) {
      expect(isSwError(error)).toBe(true);
      if (isSwError(error)) {
        expect(error.code).toBe('SW-E011');
      }
    }
  });

  it('中断恢复：kept 态下连续两次运行输出一致（状态只源于磁盘）', async () => {
    await initProject(dir, { title: '我的短片', created: '2026-08-27' });
    await runOutline(dir);
    const second = await runOutline(dir);
    const third = await runOutline(dir);
    expect(third).toEqual(second);
  });
});
