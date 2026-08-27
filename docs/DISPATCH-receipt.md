# DISPATCH 回执（append-only）

> **追加约定**：每个工作槽完成后在文件末尾追加一节回执，不得修改或删除既有回执。
>
> 注：本分支（`cursor/w3-user-docs-ia-f6ca`）基于 `main @ deda75a`（无此文件）创建，
> 仅含本槽一节回执，不携带他槽回执副本；合并时按既定约定与其他分支版本取**并集追加**，
> 保留全部历史回执。

---

## 回执：W3 / 工作槽 W1-P1-T09 用户文档 IA

- **日期**：2026-08-27（UTC）
- **槽位**：第 3 波 / 周期 W3 / 工作槽 W1-P1-T09 用户文档 IA
- **分支**：`cursor/w3-user-docs-ia-f6ca`（基于 `main @ deda75a`，docs-only，已 push，未开 PR）
- **产出**：
  - `docs/user/README.md` — 用户文档 IA 总览：三条用户路径（上手 / 查命令 / 看懂报错）与三跳可达目标、分区结构树（`concepts/`、`reference/` 标注规划中）、help ↔ docs ↔ 错误锚点互链约定、编写纪律（不复制架构长文 / 诚实进度 / append-only 友好）、T09 余项四条的显式登记
  - `docs/user/quickstart.md` — 快速开始 T09 补全版：素材取自脚手架槽 README 路由页与 quickstart 占位页（`cursor/w2-scaffold-ci-ccbf`）；安装步骤、当前能走通的路径（口径=集成分支头，`--help`/`--version`/`status` 可用）、目标新手路径（TTFS ≤ 5 命令）、中断恢复（`sw status` 末行可复制）、下一步导航表
  - `docs/user/commands.md` — 命令索引（命令可用性**唯一口径**）：主工作流五步 + 辅助命令 + check/快照 + 提案级共 15+ 命令逐行「一句话 / 状态 / 规格出处（所在分支）/ 责任任务」；状态四值图例（可用 / 待并入 / 规划中·规格就绪 / 提案级）；「使能槽同一提交更新本表」的更新责任约定；全局约定（退出码、三段式、项目目录要求）
  - `docs/user/errors-and-empty-states.md` — 空态与错态导读：三段式示例与遇错三步法、退出码 0/1/2 表（权威指向 `errors/README.md` 与 GAP §3.6）、错误码段位速览（E01x–E05x 现状如实）、空态三要素与两个已登记位点（接线状态如实标注）、常见处境速查表；逐码正文一律链接 `docs/errors/`（生成物勿手改）不复制
  - `docs/quickstart.md` — 指针页：正文迁 `user/quickstart.md`，路径保留保证根 README 与 `--help` 尾部 URL（`src/cli/program.ts` 印死该路径，集成期禁触 `src/`）入链不断；文件头给出合并指引（占位版标注「随 T09 补全」，冲突时取本版整体替换，占位版信息已全部迁入无丢失）
  - `docs/README.md` — 增量索引分区（本分支基于 main 新建、仅含本槽增量，合并按「索引行并集」约定）：新增「用户文档」分区四条目 + `quickstart.md` 行替换文本（该行原文标注「T09 补全」，属指定回填）+ 「规划中的用户文档分区」更新表述（concepts/reference 改挂 `docs/user/` 下）
  - `docs/DISPATCH-receipt.md` — 本回执（本分支仅此一节，合并取并集）
- **关键结论**：
  1. IA 选型 `docs/user/`（调度指令二选一）：用户文档聚拢单一分区，`concepts/`、`reference/` 未来挂其下，与全量索引「规划中的用户文档分区」既有规划衔接；`docs/quickstart.md` 转指针页而非删除——`src/cli/program.ts` help 尾部与根 README 均印该路径，集成期禁触 `src/`，指针页以零代码代价保住入链。
  2. 命令状态口径经实测锚定：集成分支头 `ce910ad`（error+engine 已并入，第 2 梯队完成）可用命令仅 `--help`/`--version`/`status` 最小版；init（`cursor/w2-init-wizard-87b4`）、outline（`cursor/w3-outline-templates-5596`）、doctor（`cursor/w3-doctor-3e3d`）为「待并入」；draft/export/revise/check/快照四命令为「规划中·规格就绪」并逐行链接 SPEC-05/06/04 与 F1/F2 规格——全表遵守虚假可用性禁令。
  3. **T09 验收拆分**：验收 ①③（链接检查脚本进 CI、`--help` 尾部 URL 改指 reference 页）与 ②（reference 逐条页 + 示例可执行）依赖 `src/`/CI 改动与已并入的命令实现，集成窗口期（集成图 §5：并行槽只允许 docs-only）不可触碰，已在 `user/README.md` §2 显式登记为 **T09 余项**四条，待集成分支就绪（W3-PLAN-T02）后由实现槽收口；本槽交付 IA 骨架、quickstart 补全、命令索引与错态导读四件 docs 实体。
- **复用声明**：只引用不重做——脚手架 README/quickstart 素材（调度指令许可）、SPEC-03 错误框架与 `errors/` 生成物纪律、GAP-06 退出码表、集成图基线纪律与梯队、五分支实现状态与各 wave 规格均原样消费并注明所在分支；未搬运任何规格/裁决正文段落。
- **阻塞**：无新增。T09 余项 blocked 于 W3-PLAN-T02（集成分支就绪）属正常前置；`docs/quickstart.md` 与集成分支占位版存在预期内容冲突，解法已写入文件头（取 T09 版），与集成图既有 docs 冲突处置口径一致。
- **合规声明**：未创建子代理；未使用 Task；未创建 PR；本槽 docs-only，零 `src/` 改动、零测试与 CI 配置改动（未删测、未跳过失败、未降低 CI 标准）；未合并任何内容进 `main`。
