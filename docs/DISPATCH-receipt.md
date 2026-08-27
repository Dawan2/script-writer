# DISPATCH 回执（append-only）

> **追加约定**：每个工作槽完成后在文件末尾追加一节回执，不得修改或删除既有回执。
>
> 注：本分支（`cursor/w3-spec-check-snapshot-973a`）基于 `main @ deda75a`（无此文件）创建，
> 仅含本槽一节回执，不携带他槽回执副本；合并时按既定约定与其他分支版本取**并集追加**，
> 保留全部历史回执。

---

## 回执：W3 / 计划槽「P4 F1/F2 规格细化」

- **日期**：2026-08-27（UTC）
- **槽位**：第 3 波 / 周期 W3 / 计划槽 P4 F1/F2 规格细化（`sw check` 内容一致性检查 + `.sw/history/` 版本快照）
- **分支**：`cursor/w3-spec-check-snapshot-973a`（基于 `main @ deda75a`，docs-only，已 push，未开 PR）
- **产出**：
  - `docs/wave-03/spec-check-snapshot.md` — 可实现级规格：**doctor/check 划界正式化**（一句话判定准则 + 含边界案例的归属表：doctor 管环境/文件/状态字段，已实现七项检查零迁移、`scenes-done` 永久归 doctor；check 管内容 lint；前置与互荐协议）；**解析契约 G1–G7**（场景文件名、大纲条目、模板帮助注释、占位符、空场景、内容白名单、台词署名待 ADR——索引层 W1-P4-T01 照此实现，附最小接口契约）；**`sw check` 命令面定稿**（`[dir] --format text|json --profile default|export --fix [--write]`，退出码 0/1/2 逐字沿用 GAP-06，聚合码 SW-E014 与 doctor 的 E013 同构，JSON schema v1 字段冻结）；**SW-Cxxx 规则注册表 v1 共 10 条**（C01x 漂移 / C02x 编号 / C03x 内容 / C04x 角色 / C05x 模板残留，逐条二值判定 + 定位 + severity；漂移类默认 warn、export 档位升 error——「大纲先行、场景后建」中间态不判红；--fix 白名单 v1 仅 C011/C051，dry-run 默认；C040 在角色卡与台词语法 ADR 就绪前 skip）；**`.sw/history/` 存储协议定稿**（内容寻址 objects/ 写前查存在 + index.yaml schema v1 冻结 + writeFileAtomic rename 为唯一提交点、kill -9 崩溃语义、快照引用解析 id 精确>唯一前缀≥8>label）；**四命令 CLI 面**（snapshot/history/diff/restore，含恢复前无条件 auto-safety 快照、全项目恢复的白名单内删除语义、单场恢复不触碰 project.yaml、diff v1 行级渲染留台词分类升级位）；**错误码提案 E014/E050–E053**（触达时登记，已核对与 E012 锁预留/E013 doctor/E04x AI 段零冲突）；**ADR-0002 要点**（状态 vs 存档：「删 .sw/ 主工作流行为不变」判定标准，正式 ADR 随实现槽交付）；**验收测试清单 AT-C01…C16 + AT-S01…S15** 与 P4 原验收 F1①–⑤/F2①–⑥ 的追溯矩阵；范围裁剪（无配置文件、无语义规则、无 GC/压缩、无模糊匹配）与开放决策 D1–D6 登记
  - `docs/wave-03/ready-tasks.md` — **WAVE03-CHECK 分区**（本分支仅此分区；WAVE03-PLAN 分区在 `cursor/w3-integration-map-bf24`，合并取分区并集）：W3-CHECK-T01…T05（check 引擎+规则集、--fix 管线、快照存储+ADR-0002、history/diff、C04x+doctor 互荐），含与 W1-P4-T02/T03/T04 的承接核销映射、二值验收（引用规格 AT 编号）、依赖图；全部任务 blocked 于 W3-PLAN-T02（集成分支头），T03 与 W1-P4-T01（索引层）可并行
  - `docs/DISPATCH-receipt.md` — 本回执（本分支仅此一节，合并取并集）
- **关键结论**：① F1/F2 从提案级到可实现级的全部缺口已补齐——命令旗标、目录布局、schema、规则判定、错误码、崩溃语义、验收断言均二值化，实现槽拿到即可开工；② 与 doctor 的划界经实测对照（doctor 七项检查逐项归位）后无一项需要迁移，唯一 doctor 侧改动是全绿时追加一行引荐；③ 快照任务（T03）不依赖内容索引层，集成完成后即可与 W1-P4-T01 并行，是最早可开工的 F2 落点；④ 登记 6 项细化决策（D1 label 改旗标、D2/D3 错误码段、D4 快照 id、D5 fix 白名单、D6 漂移默认 warn + diff 行级降级），均附理由供调度器复核。
- **复用声明**：只读引用 `main` 与 8 条远端分支（w1-p4 提案原文、w2-error 注册表/run.ts/docs 索引、w2-engine 与 w3-outline 的 layout/atomicFile/模板语法、w3-doctor 七项检查、w3-integration-map 集成图与 WAVE03-PLAN 队列），未改写未覆盖任何他槽产出；未携带 `docs/README.md` 副本（索引追加行已写入规格文首供合并者粘贴）。
- **阻塞**：无新增。提示两条：R2 内容索引层（W1-P4-T01）尚无实现槽认领，规格 §4.5 已给最小接口契约供其独立开工；R3 本分区全部实现任务受集成进度（W3-PLAN-T02）门控，禁止从旧基线抢跑（集成图 §5 纪律）。
- **合规声明**：未创建子代理；未创建 PR；未使用 Task；本槽 docs-only、未触碰 `src/`（集成进行中纪律）；未删测试、未跳过失败、未降低 CI 标准（规格与任务队列明确「测试只增不减、CI 门不可降标、错误码同提交登记」）；未合并任何内容进 `main`。
