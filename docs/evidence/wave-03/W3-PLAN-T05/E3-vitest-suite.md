# E3 · 自动化测试：vitest 全量 + 退出码进程级冒烟

| 项 | 值 |
| --- | --- |
| 任务 ID | W3-PLAN-T05（集成终验） |
| 证据类型 | E3 自动化测试 |
| 锚定 commit | `02f0a6a`（分支 `cursor/w3-integrate-w2-f334`） |
| 日期 | 2026-08-27（UTC） |
| 环境 | Linux（Cloud Agent VM）、Node v22.14.0、npm ci 安装依赖 |
| 采集人 | W3 集成槽（Cloud Agent） |
| 脱敏声明 | 输出不含凭据、用户主目录路径、邮箱、主机名；按 README 自查命令零命中 |

## 复现命令

```bash
npx vitest run && npm run build && npm run smoke:exit-codes
```

## 原始输出（含退出码）

### vitest 全量（尾部统计）

```text
 Test Files  18 passed (18)
      Tests  207 passed (207)
   Start at  10:41:45
   Duration  880ms (transform 308ms, setup 0ms, import 724ms, tests 350ms, environment 1ms)
（退出码 0）
```

### 退出码进程级冒烟（对 dist/cli/main.js spawn 真实进程）

```text
> script-writer@0.1.0 smoke:exit-codes
> node scripts/smoke-exit-codes.mjs

✔ sw --version → 退出码 0（正常终止（版本））
✔ sw --help → 退出码 0（正常终止（帮助））
✔ sw → 退出码 0（无参数 = 输出帮助，成功）
✔ sw status → 退出码 1（非项目目录 status = 运行期错误（SW-E011））
✔ sw --no-such-flag → 退出码 2（未知旗标 = 用法错误）
✔ sw no-such-command → 退出码 2（未知命令（多余参数）= 用法错误）
✔ 退出码冒烟通过：6/6（SPEC-03-EXT 0/1/2 全三档）
（退出码 0）
```

## 覆盖范围与对账

- **207 passed / 0 failed / 0 skipped**，验收目标 ≥160 达成（集成图 §4 验收门）。
- 测试数演进：基线 error 77 → 并 engine 后 145 → 并 init 后 207（docs 收编不改代码，数目不变）。
- 四源分支增量断言存活对账：scaffold 21 + error 增量 56 + engine 增量 56 + init 增量 48 = 并集 181，
  实测 207 = 181 全存活 + 集成期净增 26（新错误码 SW-E021/E022/E013/E031 的注册表与渲染断言、
  `expectedSceneCount` 端到端往返断言、runCli×status 退出码矩阵扩行等）。**零删除**；
  改写仅限期望文案随 fail() 化 / yaml 序列化归一的迁移（集成图允许「改写不删除」）。
- 退出码 0/1/2 三档各 ≥1 例进程级断言（T05 验收②）。
