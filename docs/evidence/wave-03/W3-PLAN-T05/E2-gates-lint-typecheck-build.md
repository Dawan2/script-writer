# E2 · 静态质量门：lint / lint:errors / typecheck / build

| 项 | 值 |
| --- | --- |
| 任务 ID | W3-PLAN-T05（集成终验） |
| 证据类型 | E2 静态质量 |
| 锚定 commit | `02f0a6a`（分支 `cursor/w3-integrate-w2-f334`） |
| 日期 | 2026-08-27（UTC） |
| 环境 | Linux（Cloud Agent VM）、Node v22.14.0、npm ci 安装依赖 |
| 采集人 | W3 集成槽（Cloud Agent） |
| 脱敏声明 | 输出不含凭据、用户主目录路径、邮箱、主机名；按 README 自查命令零命中 |

## 复现命令

```bash
npm run lint && npm run lint:errors && npm run typecheck && npm run build
```

## 原始输出（含退出码）

```text
> script-writer@0.1.0 lint
> eslint . --max-warnings 0

（无输出，退出码 0）

> script-writer@0.1.0 lint:errors
> tsx scripts/gen-error-docs.ts --check

✔ 注册表 lint 通过：8 个错误码 / 2 个空态位点，docs/errors/ 零漂移
（退出码 0）

> script-writer@0.1.0 typecheck
> tsc --noEmit

（无输出，退出码 0）

> script-writer@0.1.0 build
> tsc -p tsconfig.build.json

（无输出，退出码 0）
```

四步全绿，`--max-warnings 0` 未放宽；错误码注册表 8 码（SW-E010/E011/E013/E020/E021/E022/E030/E031）与 `docs/errors/` 生成物零漂移。
