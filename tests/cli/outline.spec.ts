import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildProgram } from '../../src/cli/program.js';
import { runOutline } from '../../src/cli/commands/outline.js';
import { initProject } from '../../src/app/workflow/engine.js';
import { OUTLINE_FILE } from '../../src/infra/store/layout.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sw-cli-outline-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('cli/commands/outline：注册与帮助', () => {
  it('outline 子命令已注册到 sw（W1-P1-T07 最小版落地）', () => {
    const names = buildProgram().commands.map((cmd) => cmd.name());
    expect(names).toContain('outline');
  });

  it('outline --help 含 ≥1 个可复制示例（P1 §4 命令可发现性指标）', () => {
    const program = buildProgram();
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

  it('主程序 --help 中 outline 标注为可用而非规划中', () => {
    let printed = '';
    const program = buildProgram();
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
});

describe('cli/commands/outline：执行体（引擎接线）', () => {
  it('项目目录内首跑：exit 0，报告创建，末行为可复制的下一步命令', async () => {
    await initProject(dir, { title: '我的短片', created: '2026-08-27' });
    const { exitCode, lines } = await runOutline(dir);
    expect(exitCode).toBe(0);
    expect(lines.join('\n')).toContain('已创建 outline.md');
    const last = lines[lines.length - 1];
    expect(last?.startsWith('sw ')).toBe(true);
    expect(last).not.toContain('<');
  });

  it('重复运行：exit 0，幂等报告"未改动"', async () => {
    await initProject(dir, { title: '我的短片', created: '2026-08-27' });
    await runOutline(dir);
    const { exitCode, lines } = await runOutline(dir);
    expect(exitCode).toBe(0);
    expect(lines.join('\n')).toContain('未改动');
  });

  it('已有手写大纲：不覆盖并如实报告（幂等约束）', async () => {
    await initProject(dir, { title: '我的短片', created: '2026-08-27' });
    await writeFile(join(dir, OUTLINE_FILE), '# 手写大纲\n010 开场\n');
    const { exitCode, lines } = await runOutline(dir);
    expect(exitCode).toBe(0);
    expect(lines.join('\n')).toContain('未改动');
  });

  it('非项目目录：exit 1，输出 SW-E011 三段式引导', async () => {
    const { exitCode, lines } = await runOutline(dir);
    expect(exitCode).toBe(1);
    const text = lines.join('\n');
    expect(text).toContain('SW-E011');
    expect(text).toContain('怎么办');
  });

  it('中断恢复：kept 态下连续两次运行输出一致（状态只源于磁盘）', async () => {
    await initProject(dir, { title: '我的短片', created: '2026-08-27' });
    await runOutline(dir);
    const second = await runOutline(dir);
    const third = await runOutline(dir);
    expect(third).toEqual(second);
  });
});
