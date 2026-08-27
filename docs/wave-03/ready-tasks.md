# Wave-03 就绪任务队列（Ready Tasks）

> **追加约定（append-only）**：沿用 wave-01/wave-02 同名文件的分区纪律——每个槽的内容包裹在
> `<!-- BEGIN:xxx -->` / `<!-- END:xxx -->` 标记之间；各槽**只在文件末尾追加自己的分区**，
> 不修改、不覆盖其他分区的有效内容。对已有分区的勘误由原槽负责人以追加「修订记录」小节完成。
> 任务 ID 格式 `W{波次}-{槽位}-T{序号}`，全库唯一，被引用后不得复用或改义。
>
> 说明：本文件在分支 `cursor/w3-integration-map-bf24` 上基于 `main @ deda75a`（无此文件）创建，
> 仅含 WAVE03-PLAN 分区。wave-01/wave-02 的队列文件各分区仍在各自分支，本文件不携带其副本；
> 三份文件是不同波次的队列，合并后并存，互相以任务 ID 引用。

---

<!-- BEGIN:WAVE03-PLAN -->
## WAVE03-PLAN 并行实现分支集成任务（Integration of W2 Parallel Branches）

- 来源方案：[`docs/wave-03/integration-map.md`](./integration-map.md)（下称「集成图」，含实测冲突面 §2、语义冲突清单 §3、合并梯队 §4）
- 产出分支：`cursor/w3-integration-map-bf24`
- 公共约束：全程 CI 门不可降标（lint / lint:errors / typecheck / test / build / smoke / smoke:exit-codes 全绿）；测试只增不减、断言只迁移不删除；不合并进 `main`；不开 PR
- 状态图例：`ready`＝直接前置就绪即可开工；`blocked`＝等待前置任务

### 总览

| 任务 ID | 名称 | 对应依据 | 优先级 | 工作量 | 依赖 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| W3-PLAN-T01 | 建立集成分支并合入 engine（底=error） | 集成图 §4 第 1–2 梯队、§3-①② | P0 | M | 无（四源分支已冻结即可开工） | ready |
| W3-PLAN-T02 | 合入 init 并归一错误/存储双轨 | 集成图 §4 第 3 梯队、§3-③④⑤⑦ | P0 | M | W3-PLAN-T01 | blocked(T01) |
| W3-PLAN-T03 | `expectedSceneCount` 贯通存储层与端到端往返断言 | 集成图 §3-⑥（数据丢失级）、W2-GAP-T03 | P0 | S | W3-PLAN-T02 | blocked(T02) |
| W3-PLAN-T04 | 六条游离 docs 分支并集收编 | 集成图 §1.2、§4 第 4 梯队 | P1 | S | W3-PLAN-T01（可与 T02/T03 并行） | blocked(T01) |
| W3-PLAN-T05 | 集成终验与证据落盘 | 集成图 §4 验收门、§6 交接清单 | P0 | S | W3-PLAN-T02、T03、T04 | blocked(T02,T03,T04) |

依赖图：`T01 → T02 → T03 → T05`；`T01 → T04 → T05`（T04 与 T02/T03 并行不冲突，均为 docs 并集）。

### 任务明细

#### W3-PLAN-T01 · P0 · 建立集成分支并合入 engine（底=error）

- **目标**：以 `cursor/w2-error-framework-exit-codes-f4d4 @ e3aff95` 为底拉集成分支；merge
  `cursor/w2-workflow-engine-4cad @ a628de1`。解 2 个 docs 文本冲突（回执/索引并集）；完成语义
  适配：① status 命令退出码改走 `runCli` 返回码通道（命令层不触碰 `process.exitCode`）；
  ② engine 的 SW-E011/SW-E020 错误路径改 `fail(code, ctx)`，ad-hoc 文案并入注册表模板。
  lock 文件重跑 `npm install` 验证。
- **验收标准（二值）**：① merge 后无冲突标记残留；② 全套验收门通过（lint / lint:errors /
  typecheck / test / build / smoke / smoke:exit-codes 全绿 0 跳过）；③ 测试数 ≥ 77 且 engine
  的 56 条增量断言全部存活（允许因 fail() 化改写期望文案，不允许删除断言）；④ `sw status`
  在非项目目录退出码 1 且输出 SW-E011 三段式（进程级断言）。
- **风险**：status 的「发现问题 → 1」与「正常报告 → 0」双路径改造返回码通道时易漏掉一路；
  以 error 分支 `tests/cli/run.spec.ts` 的既有矩阵扩 status 行覆盖。
- **依赖**：无。开工前确认四条 W2 源分支头提交与集成图 §1.1 锚点一致，不一致则先重跑
  merge-tree 复核（集成图 §6-6）。

#### W3-PLAN-T02 · P0 · 合入 init 并归一错误/存储双轨

- **目标**：在 T01 产物上 merge `cursor/w2-init-wizard-87b4 @ 4be6a21`。文本冲突按集成图
  §2.2/§2.3 解法执行（main.ts/run.ts 取 error 版、program.ts 命令注册并集、projectFile.ts 取
  engine 版）。语义适配：③ 同一提交内登记 SW-E031 并生成 `docs/errors/SW-E031.md`；
  ④ 废弃 init 的 `sw-error.ts` 与自版 `run.ts`，错误现场改 `fail()`，E010 双现场（目录非空 /
  目标是文件）的归并决策写入落地说明；⑤ init 的 `inspectDir`/`materializeProjectDir` 迁移保留，
  `serializeProjectMeta` 废弃改走 engine 序列化；⑦ IO 抽象统一为 error 版注入口径 + init 交互能力。
- **验收标准（二值）**：① 全套验收门通过；② 测试数 ≥ 160 且不低于任何单分支（77）；
  ③ `sw init --yes` 与向导路径的 48 条增量断言全部存活（允许随 fail()/存储归一改写，不允许删除）；
  ④ `rg 'SwError|sw-error' src/` 零命中（旧实现无残留）；⑤ lint:errors 通过（SW-E031 已登记、
  无未注册码字面量）。
- **风险**：projectFile 归一是本波最大的手工冲突（add/add 双实现）；先迁移 init 侧测试到
  engine 读写路径再动实现，保证红-绿次序可审计。
- **依赖**：W3-PLAN-T01。

#### W3-PLAN-T03 · P0 · `expectedSceneCount` 贯通存储层与端到端往返断言

- **目标**：把可选字段 `expectedSceneCount` 贯通 engine 的 `ProjectFileShape` /
  `parseProjectMeta` / `toProjectFileShape` 三处（消除集成图 §3-⑥ 的静默丢字段），status 完成度
  分母消费该字段、缺省退化为 `scenes_done` 长度（承接 W2-GAP-T03 的消费侧）。
- **验收标准（二值）**：① 往返断言：`sw init --yes` → `markSceneDone` 重写 → 重新读取，
  `expectedSceneCount` 字节级不丢；② 有/无字段双分支解析与分母测试各自独立通过；③ 字段名
  逐字为 `expectedSceneCount`（GAP-03 裁决原文，禁止「顺手统一」命名风格）。
- **风险**：低。纯增量字段，schema 仍为 1，零迁移。
- **依赖**：W3-PLAN-T02。

#### W3-PLAN-T04 · P1 · 六条游离 docs 分支并集收编

- **目标**：把 `w2-q1`、`w2-plan-backlog`、`w2-evidence`、`w1-b`、`w1-c`、`w1-p2` 六分支
  （头提交锚点见集成图 §1.2）按 append-only 并集并入集成分支：正文原样收编；
  `docs/DISPATCH-receipt.md` 取回执并集；`docs/wave-01/ready-tasks.md` 补 P2 与 WAVE02-PLAN
  分区、`docs/wave-02/ready-tasks.md` 补 WAVE02-Q1 分区；`docs/README.md` 索引行并集。
- **验收标准（二值）**：① 六分支 `git diff --name-only` 所列文档在集成分支逐一存在且正文
  未改写；② 三份 ready-tasks 的全部既有分区（BEGIN/END 对）完整无缺；③ 回执文件包含全部
  历史回执（以各分支回执标题数为对照清单）；④ docs 变更不触碰 `src/`，CI 全绿。
- **风险**：低。全部机械并集；唯一注意 `w2-plan-backlog` 自带的 `wave-01/ready-tasks.md`
  是基于 main 的旧底版本，只摘其 WAVE02-PLAN 分区追加，不得整文件覆盖。
- **依赖**：W3-PLAN-T01（可与 T02/T03 并行）。

#### W3-PLAN-T05 · P0 · 集成终验与证据落盘

- **目标**：在 T02/T03/T04 齐备后做终验：全套验收门 + 五步链实际互通冒烟
  （`sw init --yes` → `sw status` 读出 expectedSceneCount 分母 → markSceneDone → status 进度
  推进），按 `docs/wave-02/evidence-and-ci-conventions.md`（T04 并入后）落盘证据；追加本槽
  DISPATCH 回执与落地说明；逐项核销集成图 §3-①…⑦（提交信息引用编号）与 §6 交接清单。
- **验收标准（二值）**：① 验收门全绿且测试数 ≥ 160、0 跳过；② 冒烟脚本进程级断言退出码
  0/1/2 三档各至少一例；③ 集成图 §3 七项在落地说明中逐项标记「已核销 + 提交号」；
  ④ 四条 W2 源分支的 56+56+48 增量断言存活率核对表落盘。
- **风险**：低。纯验证与归档。
- **依赖**：W3-PLAN-T02、W3-PLAN-T03、W3-PLAN-T04。

### 修订记录

（暂无）

### 执行状态（W3 集成槽 2026-08-27 追加，证据见括号内路径）

- W3-PLAN-T01：**完成** @ `ce910ad`（分支 `cursor/w3-integrate-w2-f334`；145 测试全绿，语义冲突①②核销）
- W3-PLAN-T02：**完成** @ `e2721d4`（207 测试全绿 ≥160，`rg 'sw-error' src/` 零命中，SW-E031/E013 登记，语义冲突③④⑤⑦核销）
- W3-PLAN-T03：**完成** @ `e2721d4`（往返断言常驻 `tests/cli/status.spec.ts`；进程级走查证据 `docs/evidence/wave-03/W3-PLAN-T05/E4-init-status-walkthrough.md`）
- W3-PLAN-T04：**完成** @ `874c783`…`a0236e5` 六提交（六分支正文逐一在位、三份 ready-tasks 分区完整、回执并集无丢失）
- W3-PLAN-T05：**完成**（终验锚定 `02f0a6a`：验收门全绿、207 测试 0 跳过、退出码 0/1/2 三档冒烟各≥1 例；证据 `docs/evidence/wave-03/W3-PLAN-T05/`；①–⑦ 核销表见 [`work-integration.md`](./work-integration.md) §3）
<!-- END:WAVE03-PLAN -->
