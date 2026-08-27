# W2 工作槽：实现 SPEC-02 工作流引擎最小版（W1-P1-T05）

| 项目 | 内容 |
| --- | --- |
| 波次 / 槽位 | 第 2 波 / 周期 W2 落地 / 工作槽「实现 W1-P1-T05 SPEC-02 工作流引擎最小版」 |
| 仓库 | github.com/Dawan2/script-writer |
| 基线 | `cursor/w2-scaffold-ci-ccbf @ 9f61b37`（脚手架 + CI，未改写） |
| 工作分支 | `cursor/w2-workflow-engine-4cad`（已 push，未开 PR） |
| 任务 | W1-P1-T05（SPEC-02 状态文件与恢复式工作流引擎）**最小版**：核心状态机 + status/恢复入口 + 原子写；`sw outline/draft/export` 子命令不在本槽（见 §4 范围裁剪） |
| 并行槽位 | init 向导（T04）与错误框架（T06）并行开发，可能同时改 CLI——本槽 CLI 改动刻意最小化（见 §5 合并注意） |

---

## 1. 做了什么

按 P1 §5.1 分层（核心域零 IO / 应用层编排 / 基础设施适配 / 接口层接线），全部为**基线上新增文件**，
对既有文件只有两处最小改动（`src/cli/program.ts` 挂载 status + 路线图标注、`package.json` 增加 `yaml` 依赖）。

### 1.1 核心域（`src/core/model/`，零 IO）

- **`parseProject.ts`**：project.yaml **schema v1 的解析与序列化纯函数**。
  - `parseProjectMeta(unknown)`：校验数据体 → 领域模型或结构化失败
    （`schema-incompatible`＝SW-E020 语义，附双方版本；`malformed`＝逐条 issues）。
  - `toProjectFileShape(meta)`：领域模型（camelCase `scenesDone`）→ 磁盘形态（SPEC-01 键名，snake_case `scenes_done`），
    与 `createProjectMeta` 工厂（T03 已交付）**无损往返**——工厂衔接契约有单测锁定。
- **`progress.ts`**：进度状态机纯函数。
  - `recordSceneDone`：幂等记录场景完成（同 id 重复无变化，§6.2 幂等约束）；
  - `ensureStepAtLeast`：步骤只进不退（§6.2 可跳过：直接 draft 时自动把步骤补齐到 draft）；
  - `sceneCompletion`：完成度 = `scenes_done` 数 / 磁盘实际场文件数（status 的 `3/5 场已完成`）；
  - `ProjectDiskSnapshot`：磁盘只读快照类型——由基础设施扫描注入，核心域保持零 IO。

### 1.2 基础设施（`src/infra/store/`）

- **`atomicFile.ts`**：`writeFileAtomic`——同目录写临时文件 → fsync → rename。
  POSIX 下 rename 原子，进程任意时刻被 kill（含 kill -9），目标文件要么旧内容要么新内容，绝无半成品；
  失败时清理临时文件不留残骸（有单测）。
- **`projectFile.ts`**：project.yaml 存取 + 目录扫描适配器。
  读（YAML → 普通对象，schema 校验交核心域）；写（领域模型 → `toProjectFileShape` → YAML → `writeFileAtomic`）；
  `scanProjectDisk`（outline 是否存在 + `scenes/NNN-slug.md` 场编号列表）。
  YAML 库选 [`yaml`](https://www.npmjs.com/package/yaml)（零传递依赖、ESM 原生，与 ADR-0001 §3.5 选 commander 的口径一致；
  存储适配器内部库选型，不新增顶层目录，不需 ADR）。

### 1.3 应用层（`src/app/workflow/`）

- **`engine.ts`**：恢复式工作流引擎最小版，每个入口同一数据流
  （SPEC-02：①读取校验 ②算步骤缺口 ③执行 ④原子回写 ⑤交渲染层）。
  - `loadProject`：失败以判别联合返回（`not-a-project`＝SW-E011 语义 / `invalid-yaml` / `schema-incompatible`＝SW-E020 语义 / `malformed`）；
  - `initProject`：**给 T04 init 向导的衔接挂钩**——schema v1 工厂产默认值 → 建 `scenes/characters/exports` 子目录 → 原子写 project.yaml；
    重复 init 报错**且不破坏现场**（SPEC-01 幂等约束，有单测）；模板渲染仍属向导职责；
  - `markSceneDone`：draft 步的状态回写原语（读 → 幂等记录 + 步骤补齐 → 原子写回；无变化不写盘）；
  - `saveProject`：通用原子回写（outline/export 命令落地时复用）；
  - `readStatus`：恢复入口——状态源 + 磁盘扫描汇总为结构化 `ProjectStatus`。
- **`statusReport.ts`**：状态报告渲染。
  - 成功态：标题 / 当前步骤（第 N/5 步）/ 场景完成度 / **末行 = 可直接复制执行的下一步命令**（不含 `<占位符>`，有单测锁全部步骤）；
  - draft 空态给完整示例 `sw draft 010 --title "开场"`（P1 §6.3 空态三要素）；已有场景按步长 10 推算下一场编号；
  - 失败态：SPEC-03 三段式（发生了什么/原因/怎么办），错误码沿用注册表既定编号（SW-E011/SW-E020），
    **TODO(W1-P1-T06) 标记就位**：错误框架合入后迁移到 `fail(code, ctx)` 唯一入口（迁移点集中在本文件与 engine.ts 头注释）。

### 1.4 接口层（`src/cli/`）

- **`commands/status.ts`**（新增）：`sw status` 最小实现。`runStatus(dir)` 纯执行体（测试与 action 共用），
  action 只接线：项目内 exit 0、末行可复制命令；非项目目录 exit 1、SW-E011 三段式引导。
  子命令 help 含可复制示例（P1 §4 命令可发现性指标）。
- **`program.ts`**（最小改动 3 处）：import + `registerStatusCommand(program)` 挂载；
  路线图中 `sw status` 标注改为 `[可用 · W1-P1-T05 最小版]`（其余命令仍如实标"规划中"）；
  无参数 `sw` 仍输出帮助——**P1 §6.4 的"无参数 = sw status"切换点已在 action 注释标明**，
  待 T04 init 合入（非项目目录有真实引导可走）后一行切换。

## 2. 如何跑测试（本地复现）

```bash
git clone https://github.com/Dawan2/script-writer.git
cd script-writer
git checkout cursor/w2-workflow-engine-4cad
npm ci               # Node ≥ 20
npm run lint         # ESLint，零警告
npm run typecheck    # tsc --noEmit
npm test             # Vitest：12 文件 / 77 用例（基线 21 + 本槽新增 56）
npm run build        # tsc → dist/
npm run smoke        # sw --version && sw --help
```

本槽实测（2026-08-27，Node v22.14.0 / npm 10.9.7）：lint ✅ 零警告；typecheck ✅；
**test ✅ 77 passed (77)，0 失败、0 跳过（基线 21 条全部保留未删未跳）**；build ✅；smoke ✅。
另做真实 CLI 端到端演示（临时目录）：`initProject` → 写场文件 → `markSceneDone('010')` →
`node dist/cli/main.js status` 输出四行状态 + 末行 `sw draft 020`（exit 0）；
cd 到非项目目录再跑 status 输出 SW-E011 三段式（exit 1）；落盘 project.yaml 与 SPEC-01 示例逐键一致。

## 3. 验收对照（SPEC-02 验收要点 × 本槽范围）

| SPEC-02 验收要点 | 结果 |
| --- | --- |
| kill -9 中断后重跑 `sw status` 状态一致 | **满足（机制级）**：状态唯一落在 project.yaml，写回走"临时文件 + rename"原子事务（`atomicFile.ts`），任意时刻中断磁盘上只有旧/新两态；单测覆盖"回写后重新加载一致""连续两次 runStatus 输出一致""不留 .tmp 残骸" |
| 五步命令的输出末行均为可复制的下一步命令 | **status 已满足**（单测锁定全部步骤的建议命令以 `sw ` 开头且无 `<占位符>`）；outline/draft/export 命令本体不在本槽，落地时复用 `nextActionCommand`/`renderStatusReport` 即自动满足 |
| `scenes_done` 与磁盘实际文件可校验一致性（`sw doctor`） | **数据面已就绪**：`scanProjectDisk` + `sceneCompletion` 即 doctor 所需的两侧数据；doctor 命令属 W1-P1-T08 |
| 引擎数据流 ①–⑤（读取校验→算缺口→执行→原子回写→渲染输出） | 满足：`engine.ts` 每个入口同构；schema 不符 → SW-E020 语义 + 双方版本（迁移指引数据就位） |
| T05 端到端脚本（init→draft→export）进 CI | **引擎级已进 CI**：`tests/app/engine.spec.ts` 的"引擎级端到端"（initProject → 场文件落盘 → markSceneDone → readStatus 全链路互相印证）；CLI 级全链路待 T04（init 命令）与 outline/draft/export 子命令合流后补 |

## 4. 范围裁剪（按派工指令与 §8 回退策略）

- 本槽聚焦 **src/core + src/app 状态机**：五步工作流、status/恢复入口、原子写项目文件、schema v1 工厂衔接；`sw status` 最小实现。
- **不含**：`sw outline / draft / export` 子命令本体（引擎原语 `saveProject`/`markSceneDone`/`ensureStepAtLeast` 已备好）、
  init 向导（并行槽 T04，本槽只留 `initProject` 挂钩）、错误框架（并行槽 T06，本槽以 TODO 标记 + 三段式手写消息过渡）。
- 依据 P1 §8 回退策略：**status 可恢复性未砍**（不可交易项）；砍的是导出格式与命令面。

## 5. 给后续槽位的合并注意（并行冲突面）

1. **T04（init 向导）**：请直接调用 `initProject(dir, input)`（`src/app/workflow/engine.js` 导出）作为"原子写 project.yaml + 目录骨架"的落点，
   向导只负责收集答案与模板渲染，勿另写状态文件；`already-a-project` 分支即 SPEC-01"重复 init 报错不破坏现场"。
   T04 文件范围里的 `src/infra/store/projectFile.ts` 本槽已建，直接复用即可（如需扩展请追加函数勿改签名）。
2. **T06（错误框架）**：迁移点已集中——`engine.ts` 的 `ProjectFailure` 判别联合（reason → 错误码映射：
   `not-a-project`→SW-E011、`schema-incompatible`→SW-E020）与 `statusReport.ts` 的 `renderProjectFailure`（整函数替换为查注册表渲染）。
   两处文件头都有 `TODO(W1-P1-T06)` 标记。
3. **CLI 合并**：本槽对 `src/cli/program.ts` 只有 3 处小改（import / 挂载一行 / 路线图 status 行）；
   若与并行槽冲突，保留各自的 register 调用行即可。`sw` 无参数 = `sw status` 的切换点在 program.ts 默认 action 注释处，一行改动，建议随 T04 合入同槽执行。
4. **quickstart/README** 的实现进度表：本槽把 `sw status` 行改为"可用（最小版）"，其余行未动；并行槽按各自命令行改，冲突时按行合并。

## 6. 阻塞状态更新

- 无新增阻塞；不触及 BLK-W1-02（AI 凭据，属 P3）。
- W1-P4-T01 / W1-P4-T03 的前置"W1-P1-T05 引擎"在**引擎与状态源层面已可开工**
  （`ProjectDiskSnapshot`/`loadProject`/`saveProject` 即其消费面）；若需 draft/export 命令本体，仍待后续槽。
