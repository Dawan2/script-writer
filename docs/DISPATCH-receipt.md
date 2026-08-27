# DISPATCH 回执（append-only）

> **追加约定**：每个工作槽完成后在文件末尾追加一节回执，不得修改或删除既有回执。
> 本文件在分支 `cursor/w1-p4-major-experience-features-5fba` 上基于 `main @ deda75a`（无此文件）创建，
> 仅含 P4 回执；W1-D / P1 / P2 的回执在各自分支，合并时按追加顺序拼接。

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
