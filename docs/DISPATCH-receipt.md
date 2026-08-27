# DISPATCH 回执（append-only）

> **追加约定**：每个工作槽完成后在文件末尾追加一节回执，不得修改或删除既有回执。
>
> 注：本分支（`cursor/w3-spec-draft-export-revise-193d`）基于 `main @ deda75a`（无此文件）创建，
> 仅含本槽一节回执，不携带他槽回执副本；合并时按既定约定与其他分支版本取**并集追加**，
> 保留全部历史回执。

---

## 回执：W3 / 计划槽「draft/export/revise 规格对齐」

- **日期**：2026-08-27（UTC）
- **槽位**：第 3 波 / 周期 W3 / 计划槽 draft/export/revise 规格对齐
- **分支**：`cursor/w3-spec-draft-export-revise-193d`（基于 `main @ deda75a`，docs-only，已 push，未开 PR）
- **产出**：
  - `docs/wave-03/spec-draft-export-revise.md` — 规格主文档：SPEC-05 `sw draft`（创建与完成两动作分离——`--done` 显式标记、行为矩阵 D1–D7、场编号归一 `^\d{1,3}$`→3 位零填充、骨架代码生成不扩模板文件树、outline 缺失自动补骨架承接 MP-05、statusReport draft 期建议四分支细化）；SPEC-06 `sw export`（v1 仅 markdown 按 ADR-0001 §3.6 落实、`md` 别名归一、聚合布局与确定性五裁定——无时间戳同输入同字节、空节省略、双空报错零产物、文件名升序、派生产物允许覆盖无需 `--force`、`ensureStepAtLeast('export')` 回写）；SPEC-04 revise 对齐增补（打开语义对齐 outline 先例、`scenes_revised` 落盘 snake_case 且空数组不落键保证旧文件字节稳定、status 修订期建议命令切换与 `sw revise` 注册同提交、清单取数面轻量首行解析不硬依赖 P4 索引层）；三命令公共契约（引擎数据流 ①–⑤ 映射、SPEC-03-EXT 退出码、GAP-04 锁矩阵、别名归 W2-GAP-T02、虚假可用性禁令）；错误码编号预留 SW-E032/E033/E034（已核对 E012 为 GAP-04 预留、E013 被 doctor 占用、E030/E031 已用，预留 ≠ 登记，登记仍随首个触达用例）；勘误登记 7 条（append-only）；测试验收总表（单命令二值验收 + 4 命令主链 e2e + TTFS ≤ 5 命令 + 退出码冒烟 + 注册纪律 + CI 门不可降标）
  - `docs/wave-03/ready-tasks.md` — 追加 **WAVE03-DRAFT 分区**（本分支基于 main 新建文件、仅含本分区，与 WAVE03-PLAN 分区按并集拼接）：W3-DRAFT-T01（实现 `sw draft`，P0）、W3-DRAFT-T02（实现 `sw export` markdown v1，P0，可与 T01 并行）、W3-DRAFT-T03（主链 e2e 与 TTFS 基准雏形，P0），全部前置于集成分支就绪（W3-PLAN-T02）；**`sw revise` 实现不重复立项**（仍为 W2-GAP-T01，规格 §6 为其对齐增补），短别名仍归 W2-GAP-T02
  - `docs/DISPATCH-receipt.md` — 本回执（本分支仅此一节，合并取并集）
- **关键结论**：五步主工作流仅剩 draft/export 无开工粒度规格，本文补齐为 SPEC-05/06 并与已实现面（engine `markSceneDone`、outline 打开语义与原子写先例、错误框架 `fail()`/退出码、`expectedSceneCount` 往返、`scanProjectDisk` 场编号口径）逐点对齐；最重的两处裁定是 draft 的「创建 ≠ 完成」（否则 `3/5 场已完成` 语义被摧毁）与 export 的「确定性输出 + 派生产物允许覆盖」（EP-04 幂等条款的边界说明已登记勘误）；revise 零新规格零新码（沿用 SPEC-04 原文与 E030 复用裁定）。主链 TTFS 路径实测口径为 4 条命令（init --yes → draft --title → draft --done → export，outline 自动补齐），达标 P1 §4 的 ≤ 5 条。
- **复用声明**：只引用不重做——SPEC-04 原文、ADR-0001 导出裁定、GAP-03/04/06 裁决、集成图基分支纪律、engine/outline/error/init/doctor 五分支实现（锚点见规格 §2）均原样消费；错误码编号占用经全分支实测核对（E012/E013/E030/E031），新码只预留编号未登记注册表（SPEC-03「禁止预填未用码」纪律由实现槽随触达用例执行）。
- **阻塞**：无新增。W3-DRAFT 三任务 blocked 于 W3-PLAN-T02（集成分支）属正常前置；若并行槽在本文合并前占用 E032–E034 编号，以先登记进注册表者为准、本文顺延并追加修订记录（规格 §11 已声明）。
- **合规声明**：未创建子代理；未创建 PR；未使用 Task；本槽 docs-only，零 `src/` 改动、零测试与 CI 配置改动（未删测、未跳过失败、未降低 CI 标准，且规格与任务明细均明确「CI 门不可降标、测试只增不减、断言只迁移不删除」）；未合并任何内容进 `main`。
