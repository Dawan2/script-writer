/**
 * help 系统快照测试（SPEC-07 §5，W4-HELP-T02；W1-P1-T10 快照半面完成定义）。
 * 结构断言优先、不锁全文（快照易碎缓解沿用）；进程级用法错误档在
 * scripts/smoke-exit-codes.mjs（§5-⑥）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMAND_REGISTRY } from '../../src/cli/registry.js';
import { buildProgram } from '../../src/cli/program.js';
import type { CliIo } from '../../src/cli/run.js';
import {
  EXIT_OK,
  EXIT_USAGE_ERROR,
  runCli,
} from '../../src/cli/run.js';

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

const argv = (...args: string[]): string[] => ['node', 'sw', ...args];

const available = COMMAND_REGISTRY.filter((s) => s.status === 'available');
const planned = COMMAND_REGISTRY.filter((s) => s.status === 'planned');
const mainAvailable = available.filter((s) => s.group === 'main');
const auxAvailable = available.filter((s) => s.group === 'aux');

describe('cli/help：① 渐进披露（默认 help 四入口）', () => {
  it.each([['--help'], ['-h'], ['help'], []] as string[][])(
    '入口 sw %j：含 main 组 available 命令与别名、--all 提示行与尾部 URL，不含 aux 组命令词条',
    async (...args) => {
      const io = captureIo();
      expect(await runCli(argv(...args), io)).toBe(EXIT_OK);
      const printed = io.stdout();
      for (const s of mainAvailable) {
        const label = s.alias === undefined ? s.name : `${s.name}|${s.alias}`;
        expect(printed).toContain(label);
      }
      expect(printed).toContain('运行 sw help --all 查看全部命令与别名');
      expect(printed).toContain('docs/quickstart.md');
      // aux 组命令词条不出现在默认 help 的 Commands 清单（提示行的 "sw help --all"
      // 是指引文案而非命令词条；清单行形态为 "  <name> " 起始）
      for (const s of auxAvailable) {
        expect(printed).not.toMatch(new RegExp(`^  ${s.name}\\s`, 'm'));
      }
    },
  );
});

describe('cli/help：② 三向一致（注册表 ↔ commander 注册 ↔ --all 输出）', () => {
  it('注册表 available ↔ commander 实际注册：name/alias 集合双向相等', () => {
    const program = buildProgram(captureIo());
    const registered = program.commands.map((c) => ({ name: c.name(), alias: c.alias() ?? '' }));
    const expected = available.map((s) => ({ name: s.name, alias: s.alias ?? '' }));
    expect(registered.sort((a, b) => a.name.localeCompare(b.name))).toEqual(
      expected.sort((a, b) => a.name.localeCompare(b.name)),
    );
  });

  it('注册表 ↔ --all 输出词条：available 与 planned 全量出现且带责任标注', async () => {
    const io = captureIo();
    expect(await runCli(argv('help', '--all'), io)).toBe(EXIT_OK);
    const printed = io.stdout();
    for (const s of available) {
      const label = s.alias === undefined ? s.name : `${s.name}|${s.alias}`;
      expect(printed).toContain(`sw ${label}`);
    }
    for (const s of planned) {
      const label = s.alias === undefined ? s.name : `${s.name}|${s.alias}`;
      expect(printed).toContain(`sw ${label}`);
      expect(printed).toContain(`[规划中 · ${s.taskId}]`);
    }
  });

  it('commander 注册 ↔ --all 输出：已注册命令均出现于 --all', async () => {
    const io = captureIo();
    await runCli(argv('help', '--all'), io);
    const printed = io.stdout();
    const program = buildProgram(captureIo());
    for (const c of program.commands) {
      expect(printed).toContain(`sw ${c.name()}`);
    }
  });
});

describe('cli/help：③ 别名等价（框架 + 已注册命令即时生效，§5-③ 渐进增强）', () => {
  const aliasedAvailable = available.filter((s) => s.alias !== undefined);
  it.each(aliasedAvailable.map((s) => [s.alias as string, s.name]))(
    'sw %s --help 与 sw %s --help 逐字节等价（stdout/stderr/退出码）',
    async (alias, name) => {
      const viaAlias = captureIo();
      const viaName = captureIo();
      const codeAlias = await runCli(argv(alias, '--help'), viaAlias);
      const codeName = await runCli(argv(name, '--help'), viaName);
      expect(codeAlias).toBe(codeName);
      expect(viaAlias.stdout()).toBe(viaName.stdout());
      expect(viaAlias.stderr()).toBe(viaName.stderr());
    },
  );

  it.todo('写命令别名（d/r/x）等价断言：随对应命令落地由使能槽补齐（双 fixture 目录产物逐字节对比法）');
});

describe('cli/help：④ 别名可见 + ≥1 可复制示例（§4.5）', () => {
  it.each(available.map((s) => [s.name, s.alias] as const))(
    'sw %s --help 含 ≥1 示例；有别名者含别名词条',
    async (name, alias) => {
      const io = captureIo();
      expect(await runCli(argv(name, '--help'), io)).toBe(EXIT_OK);
      const printed = io.stdout();
      expect(printed).toContain('示例');
      // ≥1 可复制示例：示例块中出现主命令全词（示例不用别名书写，§4.2-5）
      expect(printed).toContain(`sw ${name}`);
      if (alias !== undefined) {
        expect(printed).toContain(`短别名：sw ${alias} ≡ sw ${name}`);
      }
    },
  );
});

describe('cli/help：⑤ 等价入口（逐字节）', () => {
  it('sw help ≡ sw --help', async () => {
    const a = captureIo();
    const b = captureIo();
    expect(await runCli(argv('help'), a)).toBe(await runCli(argv('--help'), b));
    expect(a.stdout()).toBe(b.stdout());
    expect(a.stderr()).toBe(b.stderr());
  });

  it.each(mainAvailable.map((s) => [s.name]))('sw help %s ≡ sw %s --help', async (name) => {
    const a = captureIo();
    const b = captureIo();
    expect(await runCli(argv('help', name), a)).toBe(await runCli(argv(name, '--help'), b));
    expect(a.stdout()).toBe(b.stdout());
    expect(a.stderr()).toBe(b.stderr());
  });
});

describe('cli/help：⑥ 用法错误档（退出码 2，零副作用）', () => {
  it('sw help draft --all（互斥违反）→ 2，stdout 无输出', async () => {
    const io = captureIo();
    expect(await runCli(argv('help', 'draft', '--all'), io)).toBe(EXIT_USAGE_ERROR);
    expect(io.stdout()).toBe('');
    expect(io.stderr()).toContain('互斥');
  });

  it('sw help <未知词条> → 2，stderr 含词条名', async () => {
    const io = captureIo();
    expect(await runCli(argv('help', 'no-such-command'), io)).toBe(EXIT_USAGE_ERROR);
    expect(io.stderr()).toContain('no-such-command');
  });

  it('sw help --all 在非项目目录 → 0（不读 project.yaml、零状态写入，§4.6）', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'sw-help-'));
    const previousCwd = process.cwd();
    try {
      process.chdir(emptyDir);
      const io = captureIo();
      expect(await runCli(argv('help', '--all'), io)).toBe(EXIT_OK);
      expect(io.stdout()).toContain('全部命令与别名');
    } finally {
      process.chdir(previousCwd);
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

describe('cli/help：§6.3 URL 渐进增强', () => {
  it('docs/user/commands.md 未并入实现基分支前，--all 不印其 URL（虚假 URL 禁令）', async () => {
    const io = captureIo();
    await runCli(argv('help', '--all'), io);
    // 本分支时点该文件未并入（尚在 cursor/w3-user-docs-ia-f6ca）；
    // 并入后本断言随 W4-HELP-T02 收口翻转为「包含」。
    expect(io.stdout()).not.toContain('docs/user/commands.md');
  });
});
