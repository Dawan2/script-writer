/**
 * SPEC-03-EXT 退出码进程级冒烟（W2-GAP-T06，CI 在 build 后运行）。
 * 对构建产物 dist/cli/main.js 逐用例 spawn 真实进程，断言退出码 0/1/2：
 * 退出码 1 档随首个真实业务命令落地（W3 集成：`sw status` 于非项目目录 → SW-E011 → 1）。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const emptyDir = mkdtempSync(join(tmpdir(), 'sw-smoke-'));

const CASES = [
  { args: ['--version'], expected: 0, note: '正常终止（版本）' },
  { args: ['--help'], expected: 0, note: '正常终止（帮助）' },
  { args: [], expected: 0, note: '无参数 = 输出帮助，成功' },
  { args: ['status'], cwd: emptyDir, expected: 1, note: '非项目目录 status = 运行期错误（SW-E011）' },
  { args: ['--no-such-flag'], expected: 2, note: '未知旗标 = 用法错误' },
  { args: ['no-such-command'], expected: 2, note: '未知命令（多余参数）= 用法错误' },
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

if (failed > 0) {
  console.error(`✖ 退出码冒烟未通过：${failed}/${CASES.length} 用例失败`);
  process.exitCode = 1;
} else {
  console.log(`✔ 退出码冒烟通过：${CASES.length}/${CASES.length}（SPEC-03-EXT 0/1/2 全三档）`);
}
