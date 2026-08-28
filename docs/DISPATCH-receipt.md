# DISPATCH 回执（append-only，合并版）

> **追加约定**：每个工作槽完成后在文件末尾追加一节回执，不得修改或删除既有回执。
>
> **合并说明**：本文件由 W2 实现槽（分支 `cursor/w2-scaffold-ci-ccbf`）按"取并集追加、勿丢任何回执"约定
> （W1-A 盘点 §4 注意事项 2）组装：依次收录 W1-D（`60c37e8`）、P1（`4612cdb`）、W1-A（`92e19a4`）、
> P3（`67e6670`）、P4（`6ec86f8`）五份回执**原文**（W1-D 为表格单页式，其余为追加式，均未改写）。
> P2 回执仍在 `cursor/w1-p2-interaction-reliability-a3c2 @ 7873b66`（该分支不在本槽参考清单内），后续合并时同样取并集追加。
>
> **W2 错误框架槽追加（2026-08-27，分支 `cursor/w2-error-framework-exit-codes-f4d4`）**：按同一并集约定
> 收录 W1-B（`cursor/w1-b-features-flows-9843 @ 9ef7ea7`）与 W2-GAP（`cursor/w2-gap-adjudication-c82d @ 661b313`）
> 两份回执**原文**（追加于 P4/脚手架回执之后）。W2 证据约定槽回执仍在 `cursor/w2-evidence-ci-conventions-a17c @ 09fbfb8`
> （本槽仅参考未并入其文件），后续合并时同样取并集追加。

---

# DISPATCH 回执 —— 工作槽 W1-D

| 项目 | 内容 |
|------|------|
| 里程碑 | 第1波 / 周期W1 / 工作槽W1-D 成熟度基线与核验框架 |
| 执行角色 | Cursor Cloud 工作代理（非调度器，未创建子代理） |
| 完成日期 | 2026-08-27 |
| 工作分支 | `cursor/w1-d-maturity-baseline-b2eb`（已 push，未开 PR） |
| 评估对象 | `main` @ `deda75a`（Initial commit） |

## 交付物清单

| 交付物 | 路径 | 状态 |
|--------|------|------|
| 成熟度基线与核验框架（量表 / 证据类型 / 阻塞登记 / 下一目标模板 + 第一版三维度自评） | `docs/wave-01/maturity-baseline.md` | 已交付 |
| W5 核验报告模板 | `docs/templates/w5-verification-report.md` | 已交付 |
| 本回执 | `docs/DISPATCH-receipt.md` | 已交付 |

## 关键结论

1. **仓库现状为空仓**：`main` 仅一个初始提交，除一行 README 外无任何代码、依赖清单、测试或 CI。已核对远端仅 `main` 一个分支，无并行工作产物。
2. **三维度自评全部 L0（未起步）**：功能易用性、交互可靠性、Agent 智能化均无可评估对象。证据缺口为全量，明细见基线文档第 7 节。
3. **登记 3 项阻塞**：BLK-W1-01（无代码/未选型，高）、BLK-W1-02（模型凭据与供应商未定，高）、BLK-W1-03（无 CI，中）。
4. **登记 3 项下一目标**（GOAL-W1-01/02/03）：三维度各升至 L1，验收标准均已写成可二值判定形式，供 W5 逐条核对。

## 给 W5 核验槽位的交接说明

- 量表与证据规则的唯一权威来源是 `docs/wave-01/maturity-baseline.md`，报告格式按 `docs/templates/w5-verification-report.md` 填写，不要另立标准。
- 核验时先核对 GOAL-W1-01/02/03 达成情况与 BLK-W1-01/02/03 状态，再逐条核查证据（无法复现即证据无效、评级降级）。
- 证据存档建议统一放 `docs/evidence/`（目录约定尚未建立，属 BLK-W1-03 范围）。

## 合规声明

- 未创建子代理；未创建 PR；未删除测试、未跳过失败、未降低 CI 标准（本仓库当前无测试与 CI，本次亦未引入任何绕过机制）。

---

## 回执：Wave-01 / 槽位 P1（功能易用性）

| 项目 | 内容 |
| --- | --- |
| 波次 / 槽位 | 第 1 波（wave-01）/ 周期 W1 架构与方案 / 计划槽 P1 功能易用性 |
| 日期 | 2026-08-27 |
| 分支 | `cursor/w1-p1-usability-architecture-5d0e`（基于 `main @ deda75a`） |
| 产出 commit | `5545c22`（方案 + 任务队列）；本回执为后续 commit |
| 产出路径 | `docs/wave-01/P1-usability-architecture.md`、`docs/wave-01/ready-tasks.md`、`docs/DISPATCH-receipt.md` |
| 就绪任务 | W1-P1-T01 … W1-P1-T10（P0×3 / P1×3 / P2×3 / P3×1，含目标/文件范围/验收标准/风险/依赖） |
| 功能规格 | SPEC-01 `sw init` 向导、SPEC-02 状态文件与工作流引擎、SPEC-03 统一错误与空态框架（见方案 §7） |
| 本槽范围 | 仅方案与任务核验，未做功能开发；未开 PR |
| 仓库现状说明 | 检查基线为 Initial commit（仅 1 行 README，无代码/docs/CI），检查报告转为绿地易用性架构方案，无既有 docs 可复用、无重做 |
| 阻塞 | **B1**：产品假设 A1–A4（产品定位 / AI 可选 / CLI 优先 / TS 栈）待调度器确认；未答复则后续槽按方案 §3 默认假设执行（ADR-0001 即 W1-P1-T02 负责定案） |

---

## 回执：W1 / W1-A 代码库结构盘点

- **日期**：2026-08-27（UTC）
- **槽位**：第 1 波 / 周期 W1 / 工作槽 W1-A 代码库结构盘点
- **分支**：`cursor/w1-a-codebase-inventory-bb07`（基于 `main @ deda75a`，已 push，未开 PR）
- **产出**：
  - `docs/wave-01/inventory-codebase.md` — 结构盘点主文档：`main` 空仓事实的逐项证据（无包清单/无测试/无 CI/无 lint/无 .gitignore/无 LICENSE，全部锚定 `deda75a`）、4 个远端分支资产清点（防重做清单 + 合并注意事项）、对齐 P1 方案 §5.1/§6.1 与 W1-P1-T02/T03 的建议目标目录树（含 W1-D `docs/evidence/` 约定与 P2 测试设施落点）、结构差距摘要 6 项
  - `docs/README.md` — 新建文档索引（核实三个既有分支均无此文件，无覆盖）：只做链接与一句话描述，不承载架构正文；标注各文档当前所在分支与合并注意事项
  - `docs/DISPATCH-receipt.md` — 本回执（追加式）
- **关键结论**：空仓事实与 W1-D/P1/P2 三方结论相互印证无出入；目标目录树为 P1 既有决策的汇总具象化，**未新增架构决策**，生效以 ADR-0001（W1-P1-T02）为准；本槽未提交任何占位目录/代码，避免与实现槽冲突。
- **复用声明**：已 fetch 并逐一盘点 W1-D `@60c37e8`、P1 `@5545c22/4612cdb`、P2 `@7873b66` 成果，仅引用未改写；根 README 未动（改造属 W1-P1-T01）。
- **阻塞**：无新增。沿用 BLK-W1-01/02/03（W1-D 登记）与 B1 假设待确认（P1 登记）；目标树按"B1 未答复则按默认假设执行"策略书写。
- **合规声明**：未创建子代理；未创建 PR；未删测试、未跳过失败、未降低 CI 标准（仓库现无测试与 CI，本槽为 docs-only，亦未引入任何绕过机制）。

---

# DISPATCH 回执 —— 计划槽 W1-P3（Agent 智能化）

| 项目 | 内容 |
|------|------|
| 里程碑 | 第1波 / 周期W1 / 计划槽P3 Agent 智能化 |
| 执行角色 | Cursor Cloud 工作代理（非调度器，未创建子代理） |
| 完成日期 | 2026-08-27 |
| 工作分支 | `cursor/w1-p3-agent-intelligence-ca4d`（基于 `cursor/w1-d-maturity-baseline-b2eb` @ `60c37e8` 续建，已 push，未开 PR） |
| 输入依据 | `docs/wave-01/maturity-baseline.md` @ `60c37e8`（空仓、三维度 L0、BLK/GOAL 登记，均未重做） |

## 交付物清单

| 交付物 | 路径 | 状态 |
|--------|------|------|
| Agent 智能化绿田架构方案（8 子系统设计 + 量表映射 + 实施顺序 + 3 份功能规格 SPEC-P3-01/02/03） | `docs/wave-01/P3-agent-intelligence.md` | 已交付 |
| 就绪任务队列 P3 分区（TASK-P3-01 … TASK-P3-10，含目标/建议文件/二值验收/依赖） | `docs/wave-01/ready-tasks.md` | 已交付（新建文件，含只追加分区约定） |
| 本回执（追加于 W1-D 回执之后，未改动原文） | `docs/DISPATCH-receipt.md` | 已交付 |

## 关键结论

1. **纯方案槽**：本槽只产出可落地的架构方案与规格，未虚构任何实现；所有模块/文件均标注为待建，栈中立契约（目录与 schema 为契约，扩展名随选型定）。
2. **与基线严格对齐**：架构组件已逐级映射到量表 C 维度（方案 §3）——阶段一 3 个任务即解 GOAL-W1-03（C-L1），阶段二达 L2，阶段三至五冲 L3。
3. **关键路径任务**：TASK-P3-01（模型网关）、TASK-P3-02（提示词库）、TASK-P3-03（受控输出）、TASK-P3-04（trace）为 P0，其中 TASK-P3-01/02/04 直接受 BLK-W1-01、BLK-W1-02 阻塞，凭据到位前只能以录制/回放模式先行开发（方案 §6 R-2）。
4. **对 P1/P2 槽位的接口要求**：仅两条——剧本存储"分场可寻址"（方案 §6 R-4）、接口层走 `AgentRequest/AgentResult` 契约（方案 §2.9），已在方案中写明，避免波次间各自发明。

## 给后续槽位的交接说明

- 实现槽位领取任务时按 `docs/wave-01/ready-tasks.md` P3 分区的"领取与状态约定"追加状态行，勿改任务定义。
- W5 核验 C 维度时：L1/L2/L3 的证据要求已在各 TASK 验收标准中标注证据类型（E1–E5），与基线 §2 三要素规则一致。
- 三份功能规格（SPEC-P3-01 一致性守卫 / SPEC-P3-02 引导式大纲 / SPEC-P3-03 场景改写）验收标准均为二值，可直接作为实现波次立项单元。

## 合规声明

- 未创建子代理；未创建 PR；未删除测试、未跳过失败、未降低 CI 标准；未重做/覆盖 W1-D 有效成果（基线三文档原样保留，本回执为追加）。

---

## 回执：Wave-01 / 槽位 P4（重大工具体验功能提案与任务核验）

| 项目 | 内容 |
| --- | --- |
| 波次 / 槽位 | 第 1 波（wave-01）/ 周期 W1 / 计划槽 P4 重大工具体验功能提案与任务核验 |
| 日期 | 2026-08-27（UTC） |
| 分支 | `cursor/w1-p4-major-experience-features-5fba`（基于 `main @ deda75a`，已 push，未开 PR） |
| 产出路径 | `docs/wave-01/P4-major-experience-features.md`、`docs/wave-01/ready-tasks.md`（P4 分区）、本回执 |
| 功能提案 | 6 项：F1 `sw check` 剧本一致性检查（P0）、F2 版本快照与场景级 diff（P0）、F3 `sw character` 角色卡与出场索引（P1）、F5 专业导出管线 v2 Fountain/PDF/标题页（P1）、F4 `sw stats` 统计与节奏（P2）、F6 `sw move/renumber/remove` 场景重排事务（P2）；另设公共地基「内容索引层」（P0） |
| 就绪任务 | W1-P4-T01 … T09（P0×3 / P1×3 / P2×3，含目标/文件范围/验收/风险/依赖与依赖图） |
| 去重核验 | 已通读并核对 W1-D（`cursor/w1-d-maturity-baseline-b2eb`）、P1（`cursor/w1-p1-usability-architecture-5d0e`，SPEC-01/02/03 与 T01–T10）、P2 已推送分支（`cursor/w1-p2-interaction-reliability-a3c2`，D1–D39 与 S1–S3）；去重矩阵见主文档 §2.2。F5 为对 T05 明确砍掉范围的深化；F3 填补 IA 已规划但无任务的空白；有意避开 P2 S2「Agent 结果暂存箱」同题 |
| 可实现性核验 | 空仓按约定转为假设栈贴合核验：6 项功能 × A1–A4 全部通过（主文档 §5.1）；架构硬约束核验通过，发现并处置 1 处张力（`.sw/` 存档 vs「无隐藏 dotfile 状态」，以「删 `.sw/` 行为不变」验收 + 补充 ADR 处置，见 §5.2）；登记唯一跨槽对齐点：台词署名语法（W1-P1-T07 ↔ W1-P4-T05/T06，先开工者以 ADR 定案） |
| 本槽范围 | 仅提案与任务核验，未做功能开发；未开 PR |
| 阻塞 | 承接 P1 的 B1（假设 A1–A4 待调度器确认，默认推进）；P4 全部任务前置于 W1-P1-T03/T05/T06（脚手架/引擎/错误框架），已逐条登记依赖，不空转 |
| 合规声明 | 未创建子代理；未创建 PR；未删测/跳过失败/降低 CI 标准（仓库当前无测试与 CI，亦未引入绕过机制）；未改写其他槽已推送文档，本分支三个文件均为基线上新建 |

---

## 回执：Wave-02 / 工作槽「实现脚手架 + CI」

| 项目 | 内容 |
| --- | --- |
| 波次 / 槽位 | 第 2 波 / 周期 W2 落地 / 工作槽 实现脚手架 + CI（解除 BLK-W1-01） |
| 日期 | 2026-08-27（UTC） |
| 分支 | `cursor/w2-scaffold-ci-ccbf`（基于 `main @ deda75a`，已 push，未开 PR） |
| 完成任务 | W1-P1-T02（ADR-0001 定栈定形态）、W1-P1-T03（脚手架 + CI 基线）、W1-P1-T01（README 路由页，余力项） |
| 执行依据 | 调度器默认执行确认：采用 P1 假设 A1–A4（脚本创作工具 / AI 可选 / CLI 优先 / TypeScript）；B1 就此关闭 |
| 产出路径 | `docs/adr/0001-stack-and-product-shape.md`；`package.json`/`package-lock.json`/`tsconfig*.json`/`eslint.config.js`/`vitest.config.ts`/`.gitignore`；`src/{core,app,cli,infra}/`；`tests/`（5 文件 21 单测）；`.github/workflows/ci.yml`；`templates/README.md`；`README.md` + `docs/quickstart.md`；`docs/wave-02/work-scaffold-ci.md`；本回执 |
| 文档合并 | 已将 W1-D/P1/W1-A/P3/P4 五分支 docs 并入本分支（正文原样保留；`ready-tasks.md` 取 P1+P3+P4 分区并集、本文件取五份回执并集）；P2 分支不在参考清单内未并入，其文档仍在原分支有效 |
| 测试与验证 | 本地实测（Node v22.14.0）：`npm run lint` ✅ 零警告、`npm run typecheck` ✅、`npm test` ✅ **21 passed / 0 失败 / 0 跳过**、`npm run build` ✅、`npm run smoke` ✅（`sw --version`→`0.1.0`、`--help` 输出五步路线图）；`npm link` 后 `sw` 与别名 `script-writer` 均可执行。CI（push+PR 触发，Node 20/22 矩阵）随本分支 push 生效 |
| 阻塞更新 | **BLK-W1-01 解除**（定栈 + 可构建骨架入库）；**BLK-W1-03 解除**（CI 入库，合并 main 后完全生效）；BLK-W1-02 未动（属 P3 范围）；B1 关闭（调度器确认 A1–A4） |
| 合规声明 | 未创建子代理；未创建 PR；未删测试、未跳过失败、未降低 CI 标准（本槽为仓库首次引入测试与 CI，21 条单测全部真实执行并通过）；未重做/覆盖任何有效架构文档（全部原样并入） |

---

## 回执：W1 / W1-B 功能与交互路径盘点

- **日期**：2026-08-27（UTC）
- **槽位**：第 1 波 / 周期 W1 / 工作槽 W1-B 功能与交互路径盘点
- **分支**：`cursor/w1-b-features-flows-9843`（基于 `main @ deda75a`，已 push，未开 PR）
- **产出**：
  - `docs/wave-01/inventory-features-flows.md` — 功能与交互路径盘点主文档：因 `main` 空仓（引用 W1-A 证据，不复述），盘点对象为**目标交互路径**——用户可见功能 13 项（F-01…F-13）、主路径 6 条（MP，含 TTFS 首跑/恢复/非交互/AI opt-in/跳步/导出）、边缘路径 12 条（EP，含中断/幂等/schema 漂移/AI 降级/并发）、空态位点 6 个（ES 表，即 P1 §4"空态覆盖率 100%"的评审基准清单）、错态 6 码（ER 表，SPEC-03 注册表 v1 全集 + 三段式对照）、P2 向导/会话裁决（D5–D9、D20–D25、D32–D39）的 CLI 阶段映射表（已映射/部分映射/延后回接三档）、差距登记 6 项（GAP-01…06，含 revise 无规格、别名无任务归属、预计场数去向、并发写无裁决、characters/ 无命令、退出码约定不全）
  - `docs/DISPATCH-receipt.md` — 本回执（本分支文件 = W1-A 版全文原样 + 本节追加，为超集，合并时按既定约定取并集）
- **关键结论**：全部路径以 P1 假设 A1–A4（CLI 优先）为前提、锚定 SPEC-01/02/03 与 ready-tasks 任务号（每条路径带验收锚）；P2 Web 表述的裁决按其 §0"先落地者为准"声明与 W1-A §5 映射原则逐条归档，**未裁决新冲突、未新增架构决策、未重复架构正文**（依据均以 § / 条款号引用）。
- **复用声明**：只引用 W1-D `@60c37e8`、P1 `@5545c22`、P2 `@7873b66`、W1-A `@92e19a4` 成果，未改写未覆盖；未携带 `docs/README.md` 副本（避免改写 W1-A 分支的"本分支"注记），索引追加行的现成文本已写入主文档 §8 交接项供合并者粘贴；根 README 未动（属 W1-P1-T01）。
- **阻塞**：无新增。沿用 BLK-W1-01/02/03 与 B1；新登记 6 项 GAP 均为规格缺口（非阻塞），归属建议见主文档 §7。
- **合规声明**：未创建子代理；未创建 PR；未删测试、未跳过失败、未降低 CI 标准（仓库现无测试与 CI，本槽为 docs-only，亦未引入任何绕过机制）；未使用 Task。

---

## 回执：W2 / GAP 裁决与任务补登

- **日期**：2026-08-27（UTC）
- **槽位**：第 2 波 / 周期 W2 / 计划槽 GAP 裁决与任务补登
- **分支**：`cursor/w2-gap-adjudication-c82d`（基于 `main @ deda75a`，已 push，未开 PR）
- **产出**：
  - `docs/wave-02/P-gap-adjudication.md` — GAP 裁决落地主文档：调度器对 W1-B GAP-01…06 的裁决逐条落地（每条含裁决、开工粒度要点、勘误对象与承接任务）；承载 **SPEC-04 `sw revise`** 规格要点（清单/打开/`--done` 幂等/`scenes_revised` 字段/status 联动/可跳过/无新错误码）、**SPEC-03-EXT 退出码约定**（0 成功 / 1 运行期错误 / 2 用法错误，doctor/check 既有语义零变更）、**文件锁机制要点**（`.sw/lock` 建议锁、`SW-E012`、stale 接管、doctor 检查项、与 P2 D32 的形态对应关系）；勘误登记表 8 条（append-only，供合并者回写，不改写他槽原文）
  - `docs/wave-02/ready-tasks.md` — 新建 wave-02 任务队列，**仅含 WAVE02-GAP 分区**（W2-GAP-T01…T06：revise 实现 P0、别名+help --all、expectedSceneCount schema、文件锁、characters 空态覆盖、退出码落地；均前置于 W1 实现任务，含依赖图与建议开工顺序）；沿用 wave-01 同名文件的 BEGIN/END 分区纪律，不携带 wave-01 各分区副本
  - `docs/DISPATCH-receipt.md` — 本回执（本分支文件 = W1-B 版全文原样 + 本节追加，为超集，合并时按既定约定取并集）
- **关键结论**：6 项 GAP 全部闭合——GAP-01 以 SPEC-04 补全五步工作流第四步（P0）；GAP-02 别名/全集从命令注册表生成、验收并入 W1-P1-T10；GAP-03 定案 `expectedSceneCount` 可选字段（schema v1 追加，零迁移）；GAP-04 否决「最后写者胜」、采文件锁（CLI 单机形态对 P2 D32 的对应物，幂等映射 D5–D7 不变）；GAP-05 功能面全归 W1-P4-T05、本槽只补空态核验与过渡期不误报；GAP-06 以 SPEC-03 扩展段定三档退出码，不重写 SPEC-03 长文。**未重做任何有效架构**（A1–A4 已由调度器确认，B1 关闭；SPEC-01/02/03、D1–D39、F1–F6 原样沿用）。
- **复用声明**：只引用 W1-B `@9ef7ea7`、P1/P2/P4 分支成果，未改写未覆盖；对既有文档的全部影响以勘误登记表表达（主文档 §4），由合并者回写；未携带 `docs/README.md` 与 wave-01 `ready-tasks.md` 副本。
- **阻塞**：无新增。B1（假设 A1–A4）由调度器确认而关闭；W2-GAP 任务的 blocked/ready 状态均为对 W1 实现任务的正常前置。
- **合规声明**：未创建子代理；未创建 PR；未删测试、未跳过失败、未降低 CI 标准（仓库现无测试与 CI，本槽为 docs-only，亦未引入任何绕过机制）；未使用 Task。

---

## 回执：Wave-02 / 工作槽「错误框架 + 退出码」

| 项目 | 内容 |
| --- | --- |
| 波次 / 槽位 | 第 2 波 / 周期 W2 / 工作槽 实现 W1-P1-T06（SPEC-03 错误框架）+ W2-GAP-T06（SPEC-03-EXT 退出码） |
| 日期 | 2026-08-27（UTC） |
| 分支 | `cursor/w2-error-framework-exit-codes-f4d4`（基于 `cursor/w2-scaffold-ci-ccbf @ 9f61b37`，已 push，未开 PR） |
| 完成任务 | W1-P1-T06（错误码注册表 + `fail()/hint()` 渲染层 + `docs/errors/` 生成器 + 注册表 lint 进 CI）、W2-GAP-T06（退出码 0/1/2 顶层 catch 统一设定 + 业务代码 `process.exit` lint 拦截） |
| 执行依据 | P1 方案 §7 SPEC-03（`cursor/w1-p1-usability-architecture-5d0e`，已并入基线）；SPEC-03-EXT 退出码表（`cursor/w2-gap-adjudication-c82d @ 661b313` §3.6，本槽已原样并入 `docs/wave-02/P-gap-adjudication.md`） |
| 产出路径 | `src/app/errors/{registry,render}.ts`；`src/cli/{run,main}.ts`；`scripts/gen-error-docs.ts`、`scripts/smoke-exit-codes.mjs`；`docs/errors/`（4 码 + 索引，注册表生成物）；`eslint.config.js`（process.exit / process.exitCode / no-console 拦截）；`.github/workflows/ci.yml`（+2 步骤）；`tests/{app,cli}/` 新增 3 文件 56 用例；`docs/wave-02/work-error-framework.md`；本回执 |
| 注册纪律 | 注册表 v1 只收 SPEC-01/02 实际触达的 4 码（E010/E011/E020/E030）+ 2 空态位点（scenes-empty/outline-empty）；SW-E04x（AI）按「禁止预填未用码」未登记；未注册码字面量由 `npm run lint:errors` 在 CI 拦截 |
| 测试与验证 | 本地实测（Node v22.14.0）：`npm run lint` ✅ 零警告、`npm run lint:errors` ✅、`npm run typecheck` ✅、`npm test` ✅ **77 passed / 0 失败 / 0 跳过**（基线 21 → 77，只增不减）、`npm run build` ✅、`npm run smoke` ✅、`npm run smoke:exit-codes` ✅（真实进程断言 0/2 档）；lint 拦截反例验证（console/process.exit/process.exitCode/未注册码四道防线均触发）与 docs 漂移篡改验证均通过 |
| 文档合并 | 按并集约定原样并入 `cursor/w2-gap-adjudication-c82d @ 661b313` 的 `docs/wave-02/{P-gap-adjudication,ready-tasks}.md` 与其两份回执（W1-B、W2-GAP）；证据约定分支（`cursor/w2-evidence-ci-conventions-a17c`）仅参考未并入 |
| 并行避让 | 未触碰 `sw init` 向导（W1-P1-T04，并行分支）文件范围（`src/cli/commands/`、`src/app/workflow/init.ts`、`templates/`）；`src/cli/program.ts` 零改动；T04 合并前对接清单见 `docs/wave-02/work-error-framework.md` §5 |
| 阻塞更新 | 无新增阻塞；W2-GAP-T01/T04（依赖 T06）的错误框架前置就此解除 |
| 合规声明 | 未创建子代理；未创建 PR；未使用 Task；未删除测试、未跳过失败、未降低 CI 标准（CI 步骤只增不减：+注册表 lint、+退出码冒烟）；未重写脚手架、未改写他槽文档正文（任务状态按既定备注行格式追加） |

---

## 回执：Wave-02 / 工作槽「实现 W1-P1-T05 SPEC-02 工作流引擎最小版」

| 项目 | 内容 |
| --- | --- |
| 波次 / 槽位 | 第 2 波 / 周期 W2 落地 / 工作槽 实现 W1-P1-T05 SPEC-02 工作流引擎最小版 |
| 日期 | 2026-08-27（UTC） |
| 分支 | `cursor/w2-workflow-engine-4cad`（基于 `cursor/w2-scaffold-ci-ccbf @ 9f61b37`，已 push，未开 PR） |
| 任务进度 | W1-P1-T05 **最小版交付**：恢复式引擎 + 状态机 + 原子写 + `sw status`；`sw outline/draft/export` 子命令本体不在本槽（引擎原语已备好，任务在 ready-tasks 标记"领取"而非"完成"） |
| 产出路径 | `src/core/model/{parseProject,progress}.ts`（零 IO：schema v1 解析/序列化 + 进度状态机）；`src/infra/store/{atomicFile,projectFile}.ts`（临时文件+rename 原子写、YAML 存取、目录扫描）；`src/app/workflow/{engine,statusReport}.ts`（恢复式引擎含 T04 init 挂钩、三段式渲染）；`src/cli/commands/status.ts` + `program.ts` 三处最小改动；`tests/` 新增 7 文件 56 单测；`package.json` 增 `yaml` 依赖；`docs/wave-02/work-workflow-engine.md`；本回执 |
| 与并行槽衔接 | T04（init 向导）：调 `initProject` 挂钩即得"原子写 project.yaml + 目录骨架 + 重复 init 报错不破坏现场"；T06（错误框架）：迁移点集中在 `ProjectFailure` 判别联合与 `renderProjectFailure`，均有 `TODO(W1-P1-T06)` 标记；CLI 冲突面刻意压到 3 行（详见落地说明 §5） |
| 测试与验证 | 本地实测（Node v22.14.0）：lint ✅ 零警告、typecheck ✅、**test ✅ 77 passed / 0 失败 / 0 跳过（基线 21 条只增不减）**、build ✅、smoke ✅；真实 CLI 端到端：initProject → markSceneDone → `sw status` 输出末行可复制命令（exit 0），非项目目录输出 SW-E011 三段式（exit 1），落盘 YAML 与 SPEC-01 逐键一致 |
| 阻塞更新 | 无新增；BLK-W1-02 未动（属 P3）。W1-P4-T01/T03 的"待 P1 引擎"前置在引擎与状态源层面已可开工 |
| 合规声明 | 未创建子代理；未创建 PR；未删测试、未跳过失败、未降低 CI 标准（新增 56 条真实单测全部执行通过）；未重写脚手架/ADR（基线文件仅 program.ts 三处最小改动与 package.json 依赖追加） |

---

## 回执：Wave-02 / 工作槽「实现 W1-P1-T04 SPEC-01 sw init 向导」

| 项目 | 内容 |
| --- | --- |
| 波次 / 槽位 | 第 2 波 / 周期 W2 / 工作槽 实现 W1-P1-T04 SPEC-01 `sw init` 向导 |
| 日期 | 2026-08-27（UTC） |
| 分支 | `cursor/w2-init-wizard-87b4`（基于 `cursor/w2-scaffold-ci-ccbf @ 9f61b37`，已 push，未开 PR） |
| 完成任务 | W1-P1-T04（SPEC-01 init 向导，验收全项对照见 `docs/wave-02/work-init-wizard.md` §3.1）；一并落地 GAP-03 `expectedSceneCount` 写入侧与 GAP-06 退出码约定接口层（对照见同文 §3.2，未虚报 W2-GAP-T03/T06 整任务完成） |
| 执行依据 | P1 §7 SPEC-01；ADR-0001 §3.6（默认导出 markdown）；W2 GAP 裁决 §3.3/§3.6（`cursor/w2-gap-adjudication-c82d @ 661b313`） |
| 产出路径 | `src/app/workflow/init.ts`、`src/app/errors/sw-error.ts`、`src/infra/store/{projectFile,templates}.ts`、`src/cli/{run,io}.ts`、`src/cli/commands/init.ts`、`src/core/model/project.ts`（扩展）、`templates/short-video/`（首个模板）、`tests/{app,cli,infra,core}/` 新增/扩展 5 个测试文件、`docs/wave-02/work-init-wizard.md`、quickstart/README/templates 索引与进度更新、本回执 |
| 功能要点 | 四问向导（回车接受默认、无法识别重问）；`--yes` 与逐旗标跳问；EOF=接受默认（管道/CI 不挂起）；SW-E010/SW-E031 三段式错态；临时目录+rename 原子写（三种目标状态分路径）；退出码 0/1/2（GAP-06，顶层唯一裁定点，业务代码零 process.exit）；`expectedSceneCount` 两模式均显式落盘（GAP-03） |
| 测试与验证 | 本地实测（Node v22.14.0）：lint ✅ 零警告、typecheck ✅、**test ✅ 69 passed / 9 文件 / 0 失败 / 0 跳过**（基线 21 条全保留 + 新增 48 条）、build ✅、smoke ✅；构建产物实测：`--yes`、管道交互、伪终端 TTY 交互、EOF 全默认、SW-E010（退出码 1）、非法旗标（退出码 2）全通过 |
| 偏差登记 | 摘要末行暂不印未实现的 `sw status`（TODO 标记 T05 切换点）；错误框架为暂行 SwError（TODO 标记 T06 迁移义务）；新触达码 SW-E031 待 T06 注册表收录——详见 `docs/wave-02/work-init-wizard.md` §4 |
| 阻塞 | 无新增；BLK-W1-02 未动（本槽 AI 问答仅落布尔开关，未接供应商） |
| 合规声明 | 未创建子代理；未创建 PR；未删除测试、未跳过失败、未降低 CI 标准（基线 21 条单测原样保留并全数通过）；未重做 ADR-0001/T01/T03 及任何有效架构文档（基线取自已推送脚手架分支，GAP 裁决文档只引用未改写） |

---

## 回执：W2 / 计划槽 Q1 裁定（P2 任务 CLI 适配）

- **日期**：2026-08-27（UTC）
- **槽位**：第 2 波 / 周期 W2 / 计划槽 Q1 裁定
- **分支**：`cursor/w2-q1-p2-cli-adaptation-1f96`（基于 `main @ deda75a`，已 push，未开 PR）
- **输入依据**：P2 `@7873b66`（任务原文权威）、W2 积压清单 `@c3c5e8e`（backlog 主体 `877a064`，Q1 登记处）、W1-B `@9ef7ea7`（§6 既有 CLI 映射）、W2-GAP 裁决 `@661b313`（文件锁 W2-GAP-T04、SPEC-03-EXT）、P3 `@67e6670`（R-2 录制/回放、P3-04/07 承接物）、W1-A `@92e19a4`、脚手架 `@39a0b30`（ADR-0001 + W1-P1-T03 已交付，就绪判定参照）。全部只读引用未改写；调度器 Q1 裁定原文照录于主文档 §1。
- **产出**：
  - `docs/wave-02/Q1-p2-cli-adaptation.md` — Q1 裁定落地主文档：调度器裁定原文照录；T02–T09 全量对照表（原 P2 任务 ID → 本波 CLI 任务 ID / 范围 / 验收要点 / 延后部分）；去向 = 新立 4（W2-Q1-T01…T04）+ 承接既有 2（W1-P2-T03 → SPEC-02 原子写 + W2-GAP-T04 + W1-P4-T03；W1-P2-T05 → W2-GAP-T04）+ 整项延后 2（W1-P2-T06、T09）；明确延后清单（CRDT 多人协作、HTTP 中间件、SSE Last-Event-ID、If-Match 的 HTTP 形态，各带回接锚点）；BLK-W1-02 处置重申；勘误登记 6 条（append-only，供合并者回写）；梯队插入建议（E3–E6）。
  - `docs/wave-02/ready-tasks.md` — **仅新增 `WAVE02-Q1` 分区**（本分支基于 main 新建文件；与 GAP 分支同名文件按 BEGIN/END 分区取并集，WAVE02-GAP 分区一字未动）：登记 W2-Q1-T01 跨命令幂等契约测试矩阵（源 T02）、W2-Q1-T02 `sw init` 向导中断恢复·本地会话（源 T04）、W2-Q1-T03 Agent run 状态落盘与失败路径·CLI 本地（源 T07，扩展 TASK-P3-04/07 禁止第二套状态机）、W2-Q1-T04 批量部分失败输出契约与残留清扫（源 T08，退出码按 SPEC-03-EXT 无新码），各含目标/建议文件/二值验收/依赖与依赖图。
  - `docs/DISPATCH-receipt.md` — 本回执（追加式）。
- **关键结论**：Q1 关闭——CLI 优先（A3）下 P2 的 T02–T09 **不整包丢弃**：命令幂等、向导中断恢复、部分失败、Agent run 状态落盘（本地）四个面新立 CLI 任务；文件锁面承接 GAP-04 既有裁决（W2-GAP-T04，不重立）；离线/outbox 按裁定「可延后」执行为延后；会话一致性（D23–D25）CLI 无对应物整项延后。对账口径：完成 W2-Q1-Txx ≠ 完成原 W1-P2-Txx，原任务 ID 与定义原样保留供 Web 形态回接（例外沿用 GAP-04 先例：文件锁不迁移不废弃）。BLK-W1-02 重申：P3 网关继续录制/回放，不得阻塞非模型路径——Q1 全部 4 项任务无凭据可完成（W2-Q1-T03 验收显式断言无凭据环境 CI 全绿）。
- **阻塞与开放问题**：无新增阻塞。BLK-W1-02 仍开放（仅阻塞 P3 验收级真实调用证据）；开放问题 Q1 就此关闭。
- **合规声明**：未创建子代理；未创建 PR；未删测试、未跳过失败、未降低 CI 标准（本槽为 docs-only，未触碰 `cursor/w2-scaffold-ci-ccbf` 的 CI 与测试，未引入任何绕过机制）；未重做有效成果（A1–A4、D1–D39、SPEC-01/02/03/04、SPEC-03-EXT、W2-GAP/W2-PLAN 任务定义全部原样沿用，只引用不改写）；未覆盖任何他槽原文（勘误以登记表表达）；未使用 Task。

---

## 回执：W2 / 计划槽「任务核验与落地排序」

- **日期**：2026-08-27（UTC）
- **槽位**：第 2 波 / 周期 W2 落地 / 计划槽 任务核验与落地排序
- **分支**：`cursor/w2-plan-backlog-verification-f51f`（基于 `main @ deda75a`，已 push，未开 PR）
- **输入依据**：P1 `@5545c22/4612cdb`、P2 `@7873b66`、P3 `@67e6670`、P4 `@718e28e/6ec86f8`、W1-C `@8553c7f`、W1-A `@92e19a4`、W1-D `@60c37e8`，全部只读引用未改写；调度器已确认 P1 假设 A1–A4。
- **产出**：
  - `docs/wave-02/implementation-backlog.md` — 实施积压清单：汇总四槽 ready-tasks 共 39 项 + 本波补登记 5 项 = 44 项；去重与接口协调登记 7 项（D1–D7，含 P2-T01↔P3-01 双「唯一网络出口」的本波分工、P4-T02↔SPEC-P3-01↔format_lint 三层检查划界、search_script 复用 P4-T01 索引等）；波内拓扑梯队 E0–E8 与关键路径（P1-T02→T03→T04→T05→P4-T01→P3-05→P3-06→W2-PLAN-T03→T04）；本波四线并行建议；脚手架接口核验专节。
  - `docs/wave-01/ready-tasks.md` — **仅新增 `WAVE02-PLAN` 分区**（本分支基于 main 新建文件，合并取分区并集）：处置 W1-C 缺口 G1，为第二/三批 5 个工具与 WF-02/03 补登记独立任务 ID W2-PLAN-T01…T05（含目标/建议文件/二值验收/依赖），以 SPEC-P3-01/02/03 为立项单元；P1/P2/P3/P4 既有分区一字未动。
  - `docs/DISPATCH-receipt.md` — 本回执（追加式）。
- **T03 接口核验结论**（任务 3）：W1-P1-T03（脚手架+CI）完成后**无条件立即就绪 4 项**——W1-P1-T04、W1-P1-T06、W1-P2-T01（附 D1 协调条件）、W1-P2-T10；**条件就绪 1 项**——TASK-P3-01（BLK-W1-01 已随 A4 确认实质解除，可按 R-2 录制/回放模式开工，验收级完成仍待 BLK-W1-02 凭据）；W1-P2-T08 因依赖「服务端脚手架」（T03 交付面不含）不就绪；P4 全线前置为 P1-T05/T06，不因 T03 改变。已向 T03 执行者登记两点接口提醒（目录契约对齐、`.gitignore` 预留 `runs/` 与 `.sw/`）。
- **阻塞与开放问题**：无新增阻塞。BLK-W1-01 实质解除（形式解除待 ADR-0001 落档）、BLK-W1-02 **仍开放**（阻塞 P3 线验收证据，请调度器优先处置）、BLK-W1-03 待 T03 解除；新登记开放问题 **Q1**——A3（CLI 优先）确认后 P2 方案「服务端脚手架」与客户端-服务端交互面的本波适用性待调度器澄清，影响 W1-P2-T02…T09 共 8 项排期（含经前置传导的 T07/T09；不阻塞其余 36 项，P2 本波实际推进 T01+T10）。
- **合规声明**：未创建子代理；未创建 PR；未删测试、未跳过失败、未降低 CI 标准（本槽为 docs-only，未引入任何绕过机制）；未重做 W1 架构正文（backlog 与新分区均为索引/登记，任务定义以各槽原文为权威）；未覆盖 wave-01 任何原文；未使用 Task。

---

## 回执：W2 / 计划槽「证据与 CI 约定」

- **日期**：2026-08-27（UTC）
- **槽位**：第 2 波 / 周期 W2 / 计划槽 证据与 CI 约定（推进 BLK-W1-03，承接 W1-C 缺口 G2 归档段）
- **分支**：`cursor/w2-evidence-ci-conventions-a17c`（基于 `main @ deda75a`，已 push，未开 PR）
- **输入依据**（全部只读引用，未改写）：W1-D 基线 `cursor/w1-d-maturity-baseline-b2eb @ 60c37e8`（E1–E5 定义、证据三要素、BLK-W1-03 登记）；W2 积压清单 `cursor/w2-plan-backlog-verification-f51f`（G2 分工、WAVE02-PLAN 分区）；脚手架槽 `cursor/w2-scaffold-ci-ccbf @ 39a0b30`（CI 五步基线快照，**尚未合入 main，本槽未动其任何文件**）；W1-C 盘点 `cursor/w1-c-agent-tooling-inventory-0ec2 @ 8553c7f`（L-E 证据链与 G2）；P3 方案 `cursor/w1-p3-agent-intelligence-ca4d @ 67e6670`（trace 脱敏原则、`docs/evidence/spot-checks/` 既有约定）。
- **产出**：
  - `docs/wave-02/evidence-and-ci-conventions.md` — 证据与 CI 约定正文：`docs/evidence/` 目录结构与波次归属规则（§1）、命名规范与冻结规则（§2）、E1–E5 逐类型落盘形态 + 通用文件头模板 + 输出体量规则（§3）、归档流程与 W5 衔接（§4）、五条脱敏规则 + 自查命令 + 违规处置（§5）、实现槽 CI 证据清单——必须项 C1–C8（lint 零警告 / typecheck / 单测通过数只增不减 / build / smoke / help 快照 / CI 覆盖面 / 证据落盘）+ help 快照专项（T10 前后两阶段口径）+ 禁止清单 7 条 + 例外登记通道 + CI 文件修改纪律（§6）。
  - `docs/evidence/README.md` — 证据目录操作速查（目录树、命名、归档五步、脱敏底线、CI 红线摘要），权威指回约定正文。
  - `docs/DISPATCH-receipt.md` — 本回执（追加式）。
- **关键结论**：
  1. **只定约定，未动实现**：脚手架（W1-P1-T03）尚未合入 main，本槽为 docs-only——未新建/修改任何 CI 文件、代码或测试；CI 清单以 `39a0b30` 快照为基线，约定“与合入版本不一致时取更严格者”。
  2. **未重做 W1-D 量表正文**：E1–E5 定义、三要素、评级规则的唯一权威仍是 `maturity-baseline.md` §1–§2，本文只规定落盘位置/命名/流程/脱敏与 CI 红线，并声明文档优先级（基线 ＞ 约定正文 ＞ evidence README）。
  3. **P3 既有约定原样保留**：`docs/evidence/spot-checks/`（TASK-P3-10）维持顶层长期滚动；`runs/*.jsonl` 永不入 evidence/git，只归档脱敏摘要（对齐 P3 §2.7 与 TASK-P3-04）。
  4. **BLK-W1-03 未宣布解除**：本槽交付其证据归档段约定；解除仍以基线登记条件（CI 合入 main 且状态可查）为准，由当事槽登记。G2 手工归档段即刻可用；CI 自动归档不立项，登记为开放方向留调度器裁决。
- **阻塞与开放问题**：无新增阻塞。沿用 BLK-W1-02（仍开放）、BLK-W1-03（待脚手架合入解除）；开放方向 1 项——evidence 文件名 lint（§2.1 已给正则）与 CI 自动归档是否立项，留调度器。
- **合并说明**：本分支文件面与各并行分支不相交（两份新建文档 + 本回执）；`docs/README.md` 由他槽持有，其“规划中分区”的 `evidence/` 条目迁移按该文件自身约定在合并时处理，本槽未代改。
- **合规声明**：未创建子代理；未创建 PR；未使用 Task；未删除测试、未跳过失败、未降低 CI 标准（本槽 docs-only，且约定正文 §6.4 将降标行为逐条列为红线）；未重做 W1-D 成熟度量表正文；未改写任何他槽已推送文档。

---

## 回执：W1 / W1-C Agent/工具/自动化链路盘点

- **日期**：2026-08-27（UTC）
- **槽位**：第 1 波 / 周期 W1 / 工作槽 W1-C Agent/工具/自动化链路盘点
- **分支**：`cursor/w1-c-agent-tooling-inventory-0ec2`（基于 `main @ deda75a`，已 push，未开 PR）
- **产出**：
  - `docs/wave-01/inventory-agent-tooling.md` — 链路盘点主文档：`main @ deda75a` 上 Agent/工具/自动化 21 个专属路径逐项探测（全部缺失，E1 证据可复现）+ 五分支复核（均 docs-only，无代码可盘）；对照 P3 方案（`67e6670`）抽取的三张对账表——组件链路 12 项（C1–C12）、目标工具清单 8 项（T1–T8）、调用链 5 条（L-A…L-E）+ 三条工作流实例（WF-01/02/03），**现状全部标注缺失**，每项挂接 P3 章节、目标目录契约与承接任务（TASK-P3-01…10 / SPEC-P3-01…03）；登记 2 项缺口（G1：二/三批工具与 WF-02/03 无独立任务 ID；G2：证据链 CI 段责任在 W1-P1-T03）
  - `docs/DISPATCH-receipt.md` — 本回执（追加式，本分支新建于 main 基础，合并取并集）
- **关键结论**：三条链路（Agent/工具/自动化）现状均为空集；目标态完全以 P3 方案为单一事实来源，本文只做对账索引，**未重写 P3 架构正文、未新增架构决策、未新增任务定义**（缺口仅登记，处置建议遵守 ready-tasks「只追加不改写他区」约定）。
- **复用声明**：已 fetch 并核对 W1-D `@60c37e8`、P1 `@5545c22`（远端 HEAD 已前进至 `4612cdb`，为其回执追加提交，方案内容不变）、P2 `@7873b66`、P3 `@67e6670`、W1-A `@92e19a4`，全部仅引用未改写；通用工程要件探测不重复 W1-A 成果，仅补充 Agent/自动化专属路径探测。
- **阻塞**：无新增。沿用 BLK-W1-01/02/03（W1-D 登记）与 B1（P1 登记）；G1/G2 为登记缺口非阻塞。
- **合规声明**：未创建子代理；未创建 PR；未删测试、未跳过失败、未降低 CI 标准（仓库现无测试与 CI，本槽为 docs-only，亦未引入任何绕过机制）；未使用 Task。

---

## 回执：W1 / P2 交互可靠性

- **日期**：2026-08-27（UTC）
- **槽位**：第 1 波 / 周期 W1 / 计划槽 P2 交互可靠性
- **分支**：`cursor/w1-p2-interaction-reliability-a3c2`
- **基线**：`main @ deda75a5245caf96d3ee1ac7b22109d0f421c333`（空仓库，仅 README，无既有成果可复用/冲突）
- **产出**：
  - `docs/wave-01/P2-interaction-reliability.md` — 12 维度设计前置审查（竞态、幂等、错误恢复、超时、重试、部分失败、向导中断、会话一致性、乐观回滚、网络失败、并发编辑、Agent 工具调用失败路径）、39 条设计裁决（D1–D39）、分层架构方案、任务明细、3 项后续波次规格（S1 协作编辑 / S2 Agent 断点续跑 / S3 离线优先）
  - `docs/wave-01/ready-tasks.md` — 新建（此前不存在），已按分区标记（`BEGIN:P2`/`END:P2`）写入 P2 分区，文件头注明追加约定供其他槽遵守
- **任务 ID**：W1-P2-T01 ～ W1-P2-T10（明细与验收见主文档 §3；索引见 ready-tasks.md）
- **性质**：本槽以方案为主，未产出实现代码（符合槽定义；且仓库尚无脚手架可依附）
- **阻塞**：
  - B1：技术栈/脚手架未定（待 P1 或对应槽）——T01/T08/T10 就绪待此
  - B2：Agent 编排框架未定——影响 T07 落库细节，协议要求已在 D35–D39 固化
  - B3：认证方案未定——T06 语义不受影响，实现映射待定
- **未做**：未创建 PR（按指令）；未创建子代理（按指令）；无测试可运行（仓库无代码与 CI）

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

---

## 回执：W3 / 工作槽「WAVE03-PLAN T01–T05 三线集成」

- **日期**：2026-08-27（UTC）
- **槽位**：第 3 波 / 周期 W3 / 工作槽 WAVE03-PLAN T01–T05 三线集成
- **分支**：`cursor/w3-integrate-w2-f334`（基于 `cursor/w2-error-framework-exit-codes-f4d4 @ e3aff95`，已 push，未开 PR，未合并进 `main`）
- **产出**：
  - 合并提交九个：engine 并入 `ce910ad`（语义冲突①②核销）、init 并入 `e2721d4`（③④⑤⑥⑦核销）、六游离 docs 分支并集收编 `874c783`/`775f32e`/`45d623a`/`7c2ebcb`/`fe80055`/`a0236e5`、集成图分支收编 `02f0a6a`
  - `docs/wave-03/work-integration.md` — 落地说明：合并梯队执行记录、文本冲突解法表、语义冲突①–⑦核销表（含核销提交号）、测试对账（77→145→207 零删测）、错误码 8 码现状、doctor/outline rebase 交接清单 6 条
  - `docs/evidence/wave-03/W3-PLAN-T05/` — E2 静态门 / E3 测试套件 / E4 五步链走查三份证据（按 evidence 约定：锚定 commit、复现命令、原始输出含退出码、脱敏自查零命中）
  - `docs/wave-03/ready-tasks.md` — WAVE03-PLAN 分区追加执行状态行（T01–T05 全部完成，各附提交号与证据路径）
  - 注册表新增四码：SW-E021（YAML 不合法）、SW-E022（字段不合法）、SW-E013（目标是文件）、SW-E031（模板不存在）；`docs/errors/` 同步再生成
- **关键结论**：三线集成完成，终态 **207 测试全绿（0 失败 0 跳过）≥160**；四源分支 181 条并集断言全存活 + 集成期净增 26；全套验收门（lint/lint:errors/typecheck/test/build/smoke/smoke:exit-codes）在终验锚点 `02f0a6a` 全绿；`expectedSceneCount` 数据丢失风险（集成图 §3-⑥）以存储层贯通 + 端到端往返断言 + 进程级走查三重核销。
- **复用声明**：严格按 `docs/wave-03/integration-map.md @ 43a6ecf` 执行，合并顺序、底分支裁定、冲突解法均出自集成图；四源分支头提交与集成图锚点核对一致后才开工；六 docs 分支正文原样收编未改写。
- **阻塞**：无新增。doctor/outline 并行槽未等待（按指令），其 rebase 到本分支的接口清单见 `work-integration.md` §7（预期冲突面：program.ts 注册行与 ROADMAP_HELP、registry.ts 码表、回归锁测试）。
- **合规声明**：未创建子代理；未创建 PR；未使用 Task；未删测试、未跳过失败、未降低 CI 标准（断言仅按集成图授权迁移改写，数目只增不减）；未合并任何代码进 `main`。

---

## 回执：W4 / 计划槽「W2-GAP-T02 help --all 与别名」

- **日期**：2026-08-27（UTC）
- **槽位**：第 4 波 / 周期 W4 落地 / 计划槽 W2-GAP-T02 help --all 与别名
- **分支**：`cursor/w4-spec-help-aliases-0f4e`（基于 `main @ deda75a`，docs-only，已 push，未开 PR）
- **产出**：
  - `docs/wave-04/spec-help-aliases.md` — SPEC-07 主文档：GAP-02 裁决（w2-gap §3.2）的可实现级细化——命令注册表 `src/cli/registry.ts` 单一数据源（name/alias/summary/group/status/taskId/register，planned 条目零注册防虚假可用性）+ 挂载循环唯一别名注入点；**别名全集 v1 六只 `i/o/d/r/x/s`**（d/x/r 承 P1 §6.4 与 SPEC-04 既有裁定、i/o/s 为 W4 调度指令增补，经中央表交付，GAP-02 机制条款不改义）；默认 help 渐进披露（四入口同渲染、路线图自注册表生成、手工 ROADMAP_HELP 退役并顺带修正漏 revise 行）；`sw help [command] [--all]` 子命令（`--all` 三段分组全集视图、与 command 参数互斥按 argparse 层 → 退出码 2，沿用 SPEC-F1 先例）；**零新错误码**（help 面仅 0/2 两档）；快照测试验收 ①–⑨（三向一致断言、六别名逐字节等价、结构断言不锁全文——W1-P1-T10 快照半面完成定义）；T09 用户文档互链（commands.md 人读口径 / `--all` 机器口径划界、使能提交同步更新责任、URL 渐进增强点亮条件）；勘误登记 7 条与非目标 5 条
  - `docs/wave-04/ready-tasks.md` — 新建 wave-04 任务队列，**仅含 WAVE04-HELP 分区**：W4-HELP-T01（注册表基建，ready——前置 W3-PLAN-T02 已在集成分支 `e2721d4` 交付）、W4-HELP-T02（help 快照测试与用户文档互链收口，blocked 于 T01 与 W2-GAP-T02）；**实现主体仍为 W2-GAP-T02 不重复立项**（先例：WAVE03-DRAFT 对 W2-GAP-T01 同法），其开工依据经勘误改指 SPEC-07、依赖追加 W4-HELP-T01；依赖链 `W3-PLAN-T02 → T01 → W2-GAP-T02 → T02`
  - `docs/DISPATCH-receipt.md` — 本回执（本分支仅此一节，合并取并集）
- **关键结论**：
  1. 集成分支头（`e2721d4`，error+engine+init 三梯队已并入）实测差距四条：手工 ROADMAP_HELP（且漏 revise 行）、无 help 子命令、零别名、无 help 快照——GAP-02「全集从注册表生成、禁止手工清单」尚未兑现，SPEC-07 以注册表单一数据源一次关闭该类缺陷（漏行在注册表制下不可能复现）。
  2. 别名全集扩为六只是本文唯一的裁决面变更（GAP-02 原文「当前全集 d/x/r」），走 GAP-02 自带的「新增别名必须改此表」扩展路径 + 勘误登记（§7-1/2），机制条款与既有别名含义原样沿用；未来命令别名不预占（对齐「禁止预填未用码」纪律）。
  3. 注册表先行（W4-HELP-T01）可把并行命令槽（W3-DRAFT-T01/T02、W2-GAP-T01）在 `program.ts` 的冲突面从「挂载行 + 路线图行」缩为「注册表条目一行」，是集成友好的排序依据。
  4. help 面零新错误码、零状态写入、非项目目录可运行、不加锁——验收全部落在 0/2 退出码档与结构断言上，无运行期错误面。
- **复用声明**：只引用不重做——GAP-02/SPEC-04 裁决、P1 §6.4/§6.5 与 §4 指标、SPEC-03-EXT 退出码表、W3 规格 §3-4 别名交接句与 SPEC-F1 argparse 先例、集成分支 `program.ts`/`run.ts`/eslint 防线现状、T09 的 commands.md 口径与余项登记均原样消费并注明分支锚点（规格 §2）；未搬运任何裁决/规格正文段落；SPEC-07 编号已核对无撞号（01–06、F1/F2 占用清单见规格 §9）。
- **阻塞**：无新增。W4-HELP-T01 前置（W3-PLAN-T02）已交付；W3-PLAN-T04/T05 未完成不阻塞规格消费，实现槽开工前确认集成分支头稳定即可；`--all` 尾部 commands.md URL 的点亮依赖 user-docs 文档并入实现基分支，未并入前按「行不出现」验收（渐进增强，非阻塞）。
- **合规声明**：未创建子代理；未使用 Task；未创建 PR；本槽 docs-only，零 `src/` 改动、零测试与 CI 配置改动（未删测试、未跳过失败、未降低 CI 标准——规格与任务明确「CI 门不可降标、测试只增不减、断言只迁移不删除」）；未合并任何内容进 `main`。
>>>>>>> origin/cursor/w4-spec-help-aliases-0f4e

---

## 回执：W4 / 实现槽「help 注册表与别名」（W4-HELP-T01 + W2-GAP-T02 + W4-HELP-T02）

- **日期**：2026-08-28（UTC）
- **槽位**：第 4 波 / 周期 W4 落地 / 实现槽「help 注册表与别名」
- **分支**：`cursor/w4-help-registry-impl`（基于 W3 集成分支头 `b99cb92`；并集合入 docs 槽 `cursor/w4-spec-help-aliases-0f4e`，DISPATCH add/add 冲突按并集解、零回执丢失；已 push，未开 PR）
- **产出**：
  - `src/cli/registry.ts`（新）— 命令注册表单一数据源（name/alias/summary/group/status/taskId/register）+ 唯一挂载循环 `mountCommands`；全库唯一 `.alias()` setter 调用点
  - `src/cli/helpText.ts`（新）— 默认 help / 路线图 / `--all` 三视图同源渲染；`--all` 尾部 commands.md URL 渐进增强（文件并入才点亮）
  - `src/cli/commands/help.ts`（新）— `sw help [command] [--all]`；隐式 help 命令经 `addHelpCommand(false)` 停用；互斥与未知词条走 CommanderError → 退出码 2
  - `src/cli/program.ts`（改）— 挂载循环化；ROADMAP_HELP 手工字面量退役（grep 零命中）；aux 组经 `configureHelp.visibleCommands` 隐出默认 help
  - `eslint.config.js`（改）— 带参 `.alias(...)` 调用在注册表外即 lint 失败（反例验证通过，见落地说明 §2-⑧）
  - `tests/cli/registry.spec.ts`（新，7 例）、`tests/cli/help.spec.ts`（新，20 例含 1 条 §5-③ 授权的 `it.todo` 断言位）、`scripts/smoke-exit-codes.mjs`（只加不改 +6 行，12/12）
  - `docs/wave-04/work-help-registry.md`（落地说明：验收 ①–⑨ 核销表 / 偏差登记 / 交接清单）、ready-tasks 状态行（wave-02 W2-GAP-T02 + wave-04 T01/T02）、docs/README.md wave-04 分区索引、本回执
- **关键结论**：
  1. SPEC-07 §5 验收 ①–⑨ 全项核销；CI 七门全绿 0 跳过；测试 207 → 234（233 过 + 1 todo 占位），只增不减，既有 `program.spec.ts` 断言原文保留全部通过。
  2. 别名全集 v1 六只（i/o/d/r/x/s）一次交付：i/s 随 init/status 即时生效并逐字节等价断言；o/d/r/x 声明入表、随命令落地生效（别名先行禁令满足——planned 条目零注册）。
  3. ROADMAP_HELP 漏 revise 行的缺陷类别由注册表化彻底关闭（路线图首行与逐行清单同一数据生成）。
  4. 后续命令槽（W3-DRAFT-T01/T02、W2-GAP-T01、doctor）在 `program.ts` 的冲突面缩为注册表条目一行（SPEC-07 §9 预期兑现）。
- **复用声明**：只引用不重做——SPEC-07 全文即开工依据；init/status 命令模块内部零改动；runCli 退出码通道、CliIo 抽象、SPEC-03-EXT 三档表原样消费。
- **余项**：`docs/user/commands.md` 别名标注 / 豁免清单勘误与 §6.2 同提交核查留作 W4-HELP-T02 互链余项（该文件未并入实现基分支，避免与 `cursor/w3-user-docs-ia-f6ca` 双写冲突；并入后 URL 自动点亮并翻转对应断言，交接见落地说明 §5）。
- **阻塞**：无新增。BLK-W1-02（模型凭据）仍开放，与本槽无关。
- **合规声明**：未创建子代理；未使用 Task；未创建 PR；未删测试、未跳过失败、未降低 CI 标准（`it.todo` 为规格 §5-③ 明文授权的渐进增强断言位，非跳过失败）；未合并任何内容进 `main`。

---

## 回执：W3 / 实现槽「draft 场景写作命令」（W3-DRAFT-T01 / SPEC-05）

- **日期**：2026-08-28（UTC）
- **槽位**：第 3 波 / 实现槽「draft 场景写作命令」（承接 W3 计划槽 SPEC-05）
- **分支**：`cursor/w4-help-registry-impl`（基于 W3 集成分支头 `b99cb92`，已含 W4 help 注册表与 outline 落地；已 push，未开 PR）
- **产出**：
  - `src/infra/store/sceneFile.ts`（新）— 场文件存取与 id 归一（`10` ≡ `010`）
  - `src/app/workflow/draft.ts` + `draftReport.ts`（新）— 行为矩阵 D1–D7 全实现；D3 复用 ensureOutline；D5 防线 SW-E032
  - `src/cli/commands/draft.ts`（新）— `--done` 与 `--title` 经 Option.conflicts 互斥 → 退出码 2
  - 注册表：draft planned→available（别名 d 生效）；错误注册表 +SW-E032（同提交登记，`docs/errors/SW-E032.md` 生成零漂移）
  - `statusReport.nextActionCommand` draft 期细化（无场→首场 / 有未完成→`--done` / 全完成未满→下一场 / 否则→`sw export`；revise 未注册不落 `sw revise`，规格 §11 渐进增强口径）
  - `docs/wave-03/work-draft.md`（落地说明：§4.5 验收 ①–⑨ 逐项核销表 + 真实 CLI 走查证据）、本回执
- **关键结论**：
  1. SPEC-05 §4.5 验收 ①–⑨ 全项核销；CI 七门全绿；测试 289 → 321（320 过 + 1 todo），只增不减。
  2. 「完成 = 用户显式 `--done`」裁定落地：创建即完成的语义陷阱关闭，MP-02 `x/y 场已完成` 语义保住。
  3. 命令槽冲突面兑现 SPEC-07 §9 预期：draft 落地在 `program.ts` 的触碰面 = 注册表条目一行。
- **复用声明**：只引用不重做——ensureOutline（outline 槽交付）、engine 原子写与 ensureStepAtLeast、fail()/hint() 错误框架、CliIo 抽象原样消费。
- **阻塞**：无新增。BLK-W1-02（模型凭据）仍开放，与本槽无关。
- **合规声明**：未创建子代理；未使用 Task；未创建 PR；未删测试、未跳过失败、未降低 CI 标准；未合并任何内容进 `main`。
