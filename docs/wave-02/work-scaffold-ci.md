# W2 工作槽：实现脚手架 + CI（解除 BLK-W1-01）

| 项目 | 内容 |
| --- | --- |
| 波次 / 槽位 | 第 2 波 / 周期 W2 落地 / 工作槽「实现脚手架 + CI」 |
| 仓库 | github.com/Dawan2/script-writer |
| 基线 | `main @ deda75a`（Initial commit） |
| 工作分支 | `cursor/w2-scaffold-ci-ccbf`（已 push，未开 PR） |
| 完成任务 | W1-P1-T02（ADR-0001）、W1-P1-T03（脚手架 + CI）、W1-P1-T01（README 路由页，余力项） |
| 执行依据 | 调度器确认采用 P1 假设 A1–A4（脚本创作工具 / AI 可选适配器 / CLI 优先 / TypeScript） |

---

## 1. 做了什么

### 1.1 文档合并（防重做，先于实现）

从 5 个参考分支 fetch（只读）并把仍有效的架构文档合并进本分支，**正文均原样保留、未改写**：

| 来源分支 @ commit | 并入文件 |
| --- | --- |
| `cursor/w1-p1-usability-architecture-5d0e @ 4612cdb` | `docs/wave-01/P1-usability-architecture.md`、`ready-tasks.md` P1 分区 |
| `cursor/w1-a-codebase-inventory-bb07 @ 92e19a4` | `docs/wave-01/inventory-codebase.md`、`docs/README.md` |
| `cursor/w1-d-maturity-baseline-b2eb @ 60c37e8` | `docs/wave-01/maturity-baseline.md`、`docs/templates/w5-verification-report.md` |
| `cursor/w1-p3-agent-intelligence-ca4d @ 67e6670` | `docs/wave-01/P3-agent-intelligence.md`、`ready-tasks.md` P3 分区 |
| `cursor/w1-p4-major-experience-features-5fba @ 6ec86f8` | `docs/wave-01/P4-major-experience-features.md`、`ready-tasks.md` P4 分区 |

`ready-tasks.md` 与 `DISPATCH-receipt.md` 按 W1-A 盘点 §4 的约定**取并集**（分区/回执逐节拼接，未丢任何内容）。
P2 分支（`cursor/w1-p2-interaction-reliability-a3c2 @ 7873b66`）不在本槽参考清单内，其文档**未并入**、仍在原分支有效，
后续合并槽按同样方式取并集。

### 1.2 W1-P1-T02：ADR-0001 定栈定形态

[`docs/adr/0001-stack-and-product-shape.md`](../adr/0001-stack-and-product-shape.md)：A1–A4 逐条**确认**（含理由），
补齐工程决策：Node ≥ 20 + TS strict + ESM、npm（锁文件入库）、Vitest、ESLint 9 flat config + typescript-eslint、
CLI 框架 commander、**v1 默认导出格式 markdown**（对 SPEC-01 示例的勘误，见 ADR §5 勘误清单）。
每项决策附被否决选项与否决原因。

### 1.3 W1-P1-T03：脚手架 + CI 基线

- **包与构建**：`package.json`（`bin: sw` + 别名 `script-writer`，指向 `dist/cli/main.js`）、
  `tsconfig.json`（typecheck，覆盖 src+tests）、`tsconfig.build.json`（编译 src → dist）、`package-lock.json` 入库。
- **源码四层 IA**（对齐 P1 §6.1 / W1-A §5 目标树，全部为真实可测模块，非空目录）：
  - `src/core/model/`：五步工作流词汇表（`workflow.ts`）、SPEC-01 项目元数据 schema v1 工厂（`project.ts`）——零 IO；
  - `src/app/workflow/`：步骤 → 可复制建议命令映射（`status.ts`，SPEC-02"输出末行为下一步命令"的最小载体）；
  - `src/infra/store/`：P1 §6.1 项目目录布局常量与场文件名纯函数（`layout.ts`）；
  - `src/cli/`：`program.ts`（commander 构建 `sw`，help 尾部印五步路线图——未实现命令全部标注"规划中"）+ `main.ts` 入口。
- **测试**：`tests/{core,app,infra,cli}/` 共 5 个文件 21 条单测（Vitest），覆盖上述全部模块，含
  "help 输出含'规划中'（无虚假可用性承诺）""AI 默认关闭""默认导出 markdown（ADR 勘误）"等契约断言。
- **Lint**：`eslint.config.js`（flat config，`--max-warnings 0`）。
- **CI**：[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)——push + pull_request 触发，
  Node 20/22 矩阵，五步：`npm ci → lint → typecheck → test → build → smoke`（smoke = `sw --version` + `sw --help` 实际执行）。
- **其他**：`.gitignore`（node_modules/dist/coverage/exports）、`templates/README.md` 占位。

### 1.4 W1-P1-T01：README 路由页（余力项）

`README.md` 重写为路由页（一句话定位 + 五步工作流示意 + 可复制 Quickstart + docs 导航表 + CI 徽章）；
新建 [`docs/quickstart.md`](../quickstart.md) 占位（目标命令序列 + 逐命令实现进度表）。
相对链接已脚本检查无死链；所有未实现命令均标"规划中"。

## 2. 如何跑测试（本地复现）

```bash
git clone https://github.com/Dawan2/script-writer.git
cd script-writer
git checkout cursor/w2-scaffold-ci-ccbf
npm ci               # Node ≥ 20
npm run lint         # ESLint，零警告
npm run typecheck    # tsc --noEmit
npm test             # Vitest：5 文件 / 21 用例
npm run build        # tsc → dist/
npm run smoke        # node dist/cli/main.js --version && --help
```

本槽实测结果（2026-08-27，Node v22.14.0 / npm 10.9.7）：lint ✅ 零警告；typecheck ✅；
**test ✅ 21 passed (21)，0 失败、0 跳过**；build ✅；smoke ✅（`--version` 输出 `0.1.0`，
`--help` 输出五步路线图）；另验证 `npm link` 后 `sw --version` 与别名 `script-writer --version` 均可执行。

## 3. 验收对照（W1-P1-T03）

| 验收标准 | 结果 |
| --- | --- |
| ① `npm test` / `npm run lint` 本地与 CI 均通过 | 本地已通过；CI workflow 随本分支 push 触发（main 合并后持续生效） |
| ② CI 在 PR 与 push 触发 | `on: [push, pull_request]` |
| ③ 空跑 `sw --version` 可执行 | 通过（smoke 步骤 + npm link 双验证） |
| ④ 顶层目录与 P1 §6.1 仓库 IA 一致 | `src/{core,app,cli,infra}` + `templates/` + `docs/`；`scripts/`、`docs/errors/` 等随责任任务（T06/T10）创建，未预建空目录 |

## 4. 阻塞状态更新

- **BLK-W1-01**（无代码/未选型，高）：**解除**——ADR-0001 定栈 + 可构建骨架（E1：本分支源码与包清单；E2：本文 §2 构建/测试输出记录）。
- **BLK-W1-03**（无 CI，中）：**解除（合并 main 后完全生效）**——`ci.yml` 已入库并在本分支 push 触发。
- **BLK-W1-02**（模型凭据/供应商未定，高）：**未解除**，不属本槽范围（P3 的 TASK-P3-01 承接）。
- **B1**（假设 A1–A4 待确认）：**关闭**——调度器已确认，ADR-0001 定案。

## 5. 给后续槽位的交接

- 下一批可领任务：W1-P1-T04（`sw init` 向导）与 W1-P1-T06（SPEC-03 错误框架）可并行开工（依赖 T03 已解除）；随后 T05。
- 领域词汇、schema v1 工厂、目录布局常量已在 `src/core`/`src/infra` 就位，T04/T05 直接消费，勿另起词汇。
- 默认导出格式按 ADR-0001 §3.6 为 markdown；SPEC-01 示例 yaml 的 fountain 默认值已勘误，实现时以 ADR 为准。
- 合并 main 时注意：`ready-tasks.md` 与 `DISPATCH-receipt.md` 若与 P2 分支同时合并，仍按并集拼接（本分支版本已含 P1/P3/P4 分区与五份回执）。
