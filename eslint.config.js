// ESLint 9+ flat config（ADR-0001 §3.4）：eslint recommended + typescript-eslint recommended，零警告过关。
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'coverage/', 'node_modules/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      // 接口契约优先：禁止裸 any 从脚手架期就生效（recommended 已含，此处显式固定为 error 防降级）
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    // SPEC-03-EXT（W2-GAP-T06 验收 ④）：业务代码禁碰 process.exit——错误一律 fail(code, ctx)，
    // 由接口层顶层 catch（src/cli/run.ts）映射退出码，保证 0/1/2 约定不可绕过。
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'exit',
          message:
            'SPEC-03-EXT：业务代码禁止直接 process.exit；用户可见错误走 fail(code, ctx)，退出码由 src/cli/main.ts 统一设定（0 成功 / 1 运行期错误 / 2 用法错误）。',
        },
      ],
      // 退出码只允许在进程入口 main.ts 写入（见下方豁免），其余位置一律经 runCli 返回值传递。
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "AssignmentExpression[left.object.name='process'][left.property.name='exitCode']",
          message:
            'SPEC-03-EXT：process.exitCode 只能在 src/cli/main.ts 设定（唯一出口）；业务代码经 runCli 返回退出码。',
        },
      ],
    },
  },
  {
    // P1 §5.2 UX 强制通道：core/app/infra 禁止散落 console 输出，
    // 用户可见错误/空态一律经 SPEC-03 渲染层（fail/renderError/renderHint）。
    files: ['src/core/**/*.ts', 'src/app/**/*.ts', 'src/infra/**/*.ts'],
    rules: {
      'no-console': 'error',
    },
  },
  {
    // 唯一豁免点：进程入口设定 process.exitCode（SPEC-03-EXT 落地位置）。
    files: ['src/cli/main.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
  {
    // 构建/CI 脚本（非业务代码）：补 Node 运行时全局，供 no-undef 识别。
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
      },
    },
  },
);
