# DISPATCH 回执（append-only）

> **追加约定**：每个工作槽完成后在文件末尾追加一节回执，不得修改或删除既有回执。
>
> 注：本分支（`cursor/w4-spec-help-aliases-0f4e`）基于 `main @ deda75a`（无此文件）创建，
> 仅含本槽一节回执，不携带他槽回执副本；合并时按既定约定与其他分支版本取**并集追加**，
> 保留全部历史回执。

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
