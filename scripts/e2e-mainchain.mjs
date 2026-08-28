/**
 * 主链进程级 e2e + TTFS 基准（W3-DRAFT-T03，规格 §10-2；CI 在 build 后运行）。
 * 链：sw init --yes → sw draft 010 --title "开场" → sw draft 010 --done → sw export
 * （4 条命令 ≤ TTFS 5；outline 由 D3 自动补齐——MP-05；跳过 revise 直接 export 合法——SPEC-04 可跳过条款）。
 * 每步断言：退出码 0 + stdout 末行是可整行粘贴的下一步命令；终态断言 exports/*.md 产物存在。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'sw-e2e-'));
const distEntry = join(process.cwd(), 'dist/cli/main.js');

const STEPS = [
  { args: ['init', '--yes'], lastLine: 'sw status' },
  { args: ['draft', '010', '--title', '开场'], lastLine: 'sw draft 010 --done' },
  { args: ['draft', '010', '--done'], lastLine: 'sw draft 020' },
  { args: ['export'], lastLine: 'sw status' },
];

let failed = 0;
for (const { args, lastLine } of STEPS) {
  const result = spawnSync(process.execPath, [distEntry, ...args], { encoding: 'utf8', cwd: dir });
  const lines = (result.stdout ?? '').trimEnd().split('\n');
  const actual = lines[lines.length - 1];
  const label = `sw ${args.join(' ')}`;
  if (result.status === 0 && actual === lastLine) {
    console.log(`✔ ${label} → 退出码 0，末行逐字 \`${actual}\``);
  } else {
    failed += 1;
    console.error(
      `✖ ${label} → 退出码 ${result.status}（期望 0），末行 \`${actual}\`（期望 \`${lastLine}\`）`,
    );
    console.error(result.stderr || result.stdout);
  }
}

// 终态：产物存在（markdown v1）
const exportsDir = join(dir, 'exports');
const products = existsSync(exportsDir) ? readdirSync(exportsDir).filter((f) => f.endsWith('.md')) : [];
if (products.length === 1) {
  console.log(`✔ 产物就位：exports/${products[0]}（TTFS ${STEPS.length} 条命令 ≤ 5 达标）`);
} else {
  failed += 1;
  console.error(`✖ exports/ 产物缺失或超数：${products.join('、') || '（无）'}`);
}

rmSync(dir, { recursive: true, force: true });

if (failed > 0) {
  console.error(`✖ 主链 e2e 未通过：${failed} 处失败`);
  process.exitCode = 1;
} else {
  console.log(`✔ 主链 e2e 通过：${STEPS.length} 步全绿（W3-DRAFT-T03 / TTFS ≤ 5）`);
}
