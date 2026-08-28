/**
 * SPEC-03-EXT 退出码进程级冒烟（W2-GAP-T06，CI 在 build 后运行）。
 * 对构建产物 dist/cli/main.js 逐用例 spawn 真实进程，断言退出码 0/1/2：
 * 退出码 1 档随首个真实业务命令落地（W3 集成：`sw status` 于非项目目录 → SW-E011 → 1）。
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { hostname } from 'node:os';
import { join } from 'node:path';

const emptyDir = mkdtempSync(join(tmpdir(), 'sw-smoke-'));

// W4-LOCK-T01（AT-L13）：预置活锁的项目目录——holder pid = 本进程（断言期间存活）
const lockedDir = mkdtempSync(join(tmpdir(), 'sw-smoke-lock-'));
spawnSync(process.execPath, [join(process.cwd(), 'dist/cli/main.js'), 'init', '--yes'], {
  cwd: lockedDir,
});
mkdirSync(join(lockedDir, '.sw'), { recursive: true });
writeFileSync(
  join(lockedDir, '.sw', 'lock'),
  `pid: ${process.pid}\nhostname: ${hostname()}\nacquired_at: 2026-08-28T02:31:07Z\n`,
  'utf8',
);

const CASES = [
  { args: ['--version'], expected: 0, note: '正常终止（版本）' },
  { args: ['--help'], expected: 0, note: '正常终止（帮助）' },
  { args: [], expected: 0, note: '无参数 = 输出帮助，成功' },
  { args: ['status'], cwd: emptyDir, expected: 1, note: '非项目目录 status = 运行期错误（SW-E011）' },
  { args: ['s'], cwd: emptyDir, expected: 1, note: '别名 s ≡ status（SPEC-07 §4.2）' },
  { args: ['help'], expected: 0, note: 'help 子命令（≡ --help）' },
  { args: ['help', '--all'], cwd: emptyDir, expected: 0, note: 'help --all 非项目目录可用（SPEC-07 §4.6）' },
  { args: ['help', 'status'], expected: 0, note: 'help <command>（≡ <command> --help）' },
  { args: ['help', 'draft', '--all'], expected: 2, note: '--all 与 <command> 互斥 = 用法错误（SPEC-07 §4.4）' },
  { args: ['help', 'no-such-command'], expected: 2, note: 'help 未知词条 = 用法错误（SPEC-07 §4.4）' },
  { args: ['--no-such-flag'], expected: 2, note: '未知旗标 = 用法错误' },
  { args: ['no-such-command'], expected: 2, note: '未知命令（多余参数）= 用法错误' },
  { args: ['outline'], cwd: lockedDir, expected: 1, note: '活锁下写命令 = 运行期错误（SW-E012，SPEC-07/AT-L13）' },
];

const distEntry = join(process.cwd(), 'dist/cli/main.js');

let failed = 0;
for (const { args, expected, note, cwd } of CASES) {
  const result = spawnSync(process.execPath, [distEntry, ...args], {
    encoding: 'utf8',
    cwd: cwd ?? process.cwd(),
  });
  const actual = result.status;
  const label = `sw ${args.join(' ')}`.trim();
  if (actual === expected) {
    console.log(`✔ ${label} → 退出码 ${actual}（${note}）`);
  } else {
    failed += 1;
    console.error(`✖ ${label} → 期望退出码 ${expected}，实得 ${actual}（${note}）`);
    console.error(result.stderr || result.stdout);
  }
}

rmSync(emptyDir, { recursive: true, force: true });
rmSync(lockedDir, { recursive: true, force: true });

if (failed > 0) {
  console.error(`✖ 退出码冒烟未通过：${failed}/${CASES.length} 用例失败`);
  process.exitCode = 1;
} else {
  console.log(`✔ 退出码冒烟通过：${CASES.length}/${CASES.length}（SPEC-03-EXT 0/1/2 全三档）`);
}
