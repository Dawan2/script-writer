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
);
