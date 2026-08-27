# DISPATCH 回执（append-only）

> **追加约定**：每个工作槽完成后在文件末尾追加一节回执，不得修改或删除既有回执。
>
> 注：本分支（`cursor/w3-integration-map-bf24`）基于 `main @ deda75a`（无此文件）创建，
> 仅含本槽一节回执，不携带他槽回执副本；合并时按既定约定与其他分支版本取**并集追加**，
> 保留全部历史回执。

---

## 回执：W3 / 计划槽「并行实现分支集成图」

- **日期**：2026-08-27（UTC）
- **槽位**：第 3 波 / 周期 W3 / 计划槽 并行实现分支集成图
- **分支**：`cursor/w3-integration-map-bf24`（基于 `main @ deda75a`，已 push，未开 PR）
- **产出**：
  - `docs/wave-03/integration-map.md` — 集成图主文档：W2 四代码分支现状总览（头提交锚点 + 本地实测测试数 21/69/77/77 全绿 + CI run 号全绿）与拓扑事实（init/error/engine 三分支 merge-base 均为 scaffold 头 `9f61b37`，scaffold 无需单独合并）；三对两两 `git merge-tree --write-tree` 实测冲突面（error×engine 仅 2 docs、init×error 4 文件、init×engine 7 文件，真正需人脑的源码冲突仅 main.ts/run.ts/program.ts/projectFile.ts 四处）；语义冲突清单 7 项（①engine status 直赋 process.exitCode 违反 error 的 eslint 新规、②E011/E020 未走 fail()、③init 用 SW-E031 未登记、④两套错误实现、⑤两套 projectFile、⑥expectedSceneCount 往返静默丢字段——数据丢失级、⑦IO 抽象双轨）；合并梯队与底分支裁定（**底=error**：与 engine 并列 77 测试双绿，决胜于 CI 闸门最严 + docs 超集最大 + 首步合并最便宜；顺序 error→engine→init→docs 六分支）；每梯队验收门（全套 lint/lint:errors/typecheck/test/build/smoke/smoke:exit-codes，测试只增不减、终态 ≥160）；下一工作槽基分支表与交接清单 6 条
  - `docs/wave-03/ready-tasks.md` — 新建 wave-03 任务队列，**仅含 WAVE03-PLAN 分区**（W3-PLAN-T01…T05：建集成分支合 engine、合 init 归一双轨、expectedSceneCount 贯通、六 docs 分支并集收编、集成终验与证据落盘；含依赖图与二值验收），沿用 BEGIN/END 分区纪律，不携带 wave-01/02 分区副本
  - `docs/DISPATCH-receipt.md` — 本回执（本分支仅此一节，合并取并集）
- **关键结论**：四代码分支全部 CI 绿、可集成；error 与 engine 测试数并列最多（77），按决胜三条取 **error 为底**；集成的最大风险不是文本冲突（docs 占多数、机械并集可解）而是 7 项语义冲突，其中 ⑥（`sw init` 写入的 `expectedSceneCount` 会被 engine 存储层重写时静默丢弃）为数据丢失级、优先级最高；六条游离 docs 分支（w1-b/w1-c/w1-p2/w2-q1/w2-evidence/w2-plan-backlog）排第 4 梯队纯并集收编。**未重写任何槽的实现**——本槽只读 fetch、merge-tree 干跑与临时 worktree 跑测，未向任何源分支推送提交。
- **复用声明**：只读引用 16 条远端分支头（锚点见集成图 §1），未改写未覆盖；测试数为临时 worktree 内 `npm ci && npx vitest run` 实测（Node v22.14.0），CI 状态取自 GitHub Actions run 33057519551 / 33059507608 / 33059843463 / 33059618720；未携带 `docs/README.md` 副本（索引追加行已写入集成图文首供合并者粘贴）。
- **阻塞**：无新增。提示性约束一条：集成期间四条 W2 源分支应冻结，源分支若有新提交则集成图头提交锚点失效、需重跑 merge-tree 复核（集成图 §6-6）。
- **合规声明**：未创建子代理；未创建 PR；未使用 Task；未删测试、未跳过失败、未降低 CI 标准（本槽 docs-only，且集成图/任务队列明确「测试只增不减、断言只迁移不删除、CI 门不可降标」）；未合并任何代码进 `main`。
