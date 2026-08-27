# Wave-03 就绪任务队列（Ready Tasks）

> **追加约定（append-only）**：沿用 wave-01/wave-02 同名文件的分区纪律——每个槽的内容包裹在
> `<!-- BEGIN:xxx -->` / `<!-- END:xxx -->` 标记之间；各槽**只在文件末尾追加自己的分区**，
> 不修改、不覆盖其他分区的有效内容。对已有分区的勘误由原槽负责人以追加「修订记录」小节完成。
> 任务 ID 格式 `W{波次}-{槽位}-T{序号}`，全库唯一，被引用后不得复用或改义。
>
> 说明：本文件在分支 `cursor/w3-spec-draft-export-revise-193d` 上基于 `main @ deda75a`（无此文件）创建，
> **仅含 WAVE03-DRAFT 分区**。既有 wave-03 分区分布：WAVE03-PLAN 分区在
> `cursor/w3-integration-map-bf24 @ 43a6ecf` 的同名文件。合并时按分区标记取**并集**拼接即可，
> 本分区未改写任何既有分区的任何内容，无冲突。

---

<!-- BEGIN:WAVE03-DRAFT -->
## WAVE03-DRAFT draft / export 实现与主链联验任务（SPEC-05/06 落地）

- 来源方案：[`docs/wave-03/spec-draft-export-revise.md`](./spec-draft-export-revise.md)（下称「规格文档」，含 SPEC-05 `sw draft` §4、SPEC-06 `sw export` §5、SPEC-04 revise 对齐增补 §6、错误码编号预留 §7、测试验收总表 §10）
- 产出分支：`cursor/w3-spec-draft-export-revise-193d`
- 公共约束：**基分支一律取 W3 集成分支头**（集成图 §5 纪律，禁止从 scaffold 或单个 W2 分支分叉）；CI 门不可降标（lint / lint:errors / typecheck / test / build / smoke / smoke:exit-codes 全绿 0 跳过）；测试只增不减、断言只迁移不删除；不合并进 `main`；不开 PR
- 立项边界：**`sw revise` 的实现任务仍为 `W2-GAP-T01`，本分区不重复立项**（规格文档 §6 是其开工依据的对齐增补，非新任务）；短别名 `sw d`/`sw x`/`sw r` 仍归 `W2-GAP-T02`，T01/T02 不得散落注册
- 状态图例：`ready`＝直接前置就绪即可开工；`blocked`＝等待前置任务

### 总览

| 任务 ID | 名称 | 对应依据 | 优先级 | 工作量 | 依赖 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| W3-DRAFT-T01 | 实现 SPEC-05 `sw draft`（创建/幂等保留/`--done`） | 规格文档 §4、§7（E032）、§8 | P0 | M | W3-PLAN-T02；建议 W3-PLAN-T03 先行（§4.4-4 分母消费） | blocked(W3-PLAN-T02) |
| W3-DRAFT-T02 | 实现 SPEC-06 `sw export` markdown v1 导出管线 | 规格文档 §5、§7（E033/E034）、§8 | P0 | M | W3-PLAN-T02（可与 T01 并行） | blocked(W3-PLAN-T02) |
| W3-DRAFT-T03 | 主链 e2e 与 TTFS 基准雏形 | 规格文档 §10-2/3、P1 §4、MP-01/03/05 | P0 | S | W3-DRAFT-T01、W3-DRAFT-T02 | blocked(T01,T02) |

依赖图：`W3-PLAN-T02 → {T01 ∥ T02} → T03`；`W2-GAP-T01`（revise）与 T01/T02 并行不冲突（文件面独立，顺序耦合仅 §4.4-4 的渐进增强分支，两向交付均不破坏断言）。

### 任务明细

#### W3-DRAFT-T01 · P0 · 实现 SPEC-05 `sw draft`（创建 / 幂等保留 / `--done`）

- **目标**：按规格文档 §4 落地 `sw draft <scene-id> [--title] [--done]`：行为矩阵 D1–D7（创建骨架原子写、按编号幂等保留、`--done` 走引擎 `markSceneDone` 且磁盘存在性防线前置、outline 缺失时自动补骨架——MP-05）；场编号归一（§3-7）；`SW-E032` 登记与首个触达用例同提交；`statusReport` draft 期建议细化（§4.4-4，revise 未注册前建议 `sw export`）；doctor `scenesDoneCheck` 修复文案顺手更新（§8.2 交接项）。
- **文件范围**：`src/infra/store/sceneFile.ts`（新）、`src/app/workflow/draft.ts` + `draftReport.ts`（新）、`src/cli/commands/draft.ts`（新）、`program.ts` 挂载与路线图行、`registry.ts` + `docs/errors/SW-E032.md`、`statusReport.ts` 建议细化、`checks.ts` 文案、对应单测。
- **验收标准（二值）**：规格文档 §4.5 ①–⑨ 全项 + 全套 CI 门通过 + `lint:errors` 全绿（E032 非预填、生成物提交）。
- **风险**：`--done` 与磁盘漂移的先后关系——防线放应用层入口（§4.4），不改引擎 `markSceneDone` 签名，避免与集成分支的存储归一提交竞争。
- **依赖**：W3-PLAN-T02（集成分支就绪：`fail()` 与存储正典归一）；§4.4-4 第 3 分支消费 `expectedSceneCount` 分母，建议 W3-PLAN-T03 先行（未先行时该分支按「字段缺省退化」路径先交付，T03 落地后补有字段分支断言）。

#### W3-DRAFT-T02 · P0 · 实现 SPEC-06 `sw export` markdown v1 导出管线

- **目标**：按规格文档 §5 落地 `sw export [--format] [--out]`：格式面 v1 仅 markdown（`md` 别名归一，其余 `SW-E033`；ADR-0001 §3.6 的命令面落实）；聚合布局与确定性五裁定（§5.2：无时间戳同输入同字节、空节省略、双空 `SW-E034` 零产物、文件名升序、派生产物允许覆盖）；`--out` 父目录自动创建；`ensureStepAtLeast('export')` 回写；完成度提示行（§5.3）。E033/E034 登记与首个触达用例同提交。
- **文件范围**：`src/app/workflow/export.ts` + `exportRender.ts`（聚合纯函数，零 IO）+ `exportReport.ts`（新）、`src/cli/commands/export.ts`（新）、`program.ts` 挂载与路线图行、`registry.ts` + `docs/errors/SW-E033.md`/`SW-E034.md`、对应单测（含字节级确定性断言）。
- **验收标准（二值）**：规格文档 §5.4 ①–⑩ 全项 + 全套 CI 门通过 + `lint:errors` 全绿。
- **风险**：确定性输出与「产物含导出时间戳」的直觉冲突——已在规格 §5.2-1 显式裁定（无时间戳），实现不得回加；`--out` 写项目外路径属用户显式意图，不做路径白名单（过度设计）。
- **依赖**：W3-PLAN-T02；与 T01 并行可行（共同触碰面仅 `program.ts` 挂载行，并集解法有 init×engine 先例）。

#### W3-DRAFT-T03 · P0 · 主链 e2e 与 TTFS 基准雏形

- **目标**：按规格文档 §10-2/3 交付：进程级主链 e2e（`sw init --yes` → `sw draft 010 --title "开场"` → `sw draft 010 --done` → `sw export`，4 条命令，outline 由 draft D3 自动补齐）断言每步退出码 0、每步末行可整行粘贴为下一步、终态 `exports/*.md` 存在；TTFS ≤ 5 条命令达标（P1 §4 指标的首个可执行基准，W1-P1-T10 的雏形）；「跳过 revise 直接 export 合法」回归断言（SPEC-04 可跳过条款）；三命令退出码冒烟进 `smoke:exit-codes`（0/1/2 三档全覆盖）。
- **文件范围**：e2e 测试脚本（进程级，沿用 error 分支 `smoke:exit-codes` 形态）、CI 工作流接线（只加步骤不改既有门）、TTFS 基准脚本雏形。
- **验收标准（二值）**：① e2e 在 CI 中运行并全绿；② TTFS 命令数断言 ≤ 5；③ revise 跳过合法回归通过；④ 三命令 0/1/2 三档冒烟各至少一例；⑤ 既有测试零删除零跳过。
- **风险**：低。纯验证与基准；W2-GAP-T01（revise）后续交付时本任务的主链断言不变（revise 不在 TTFS 路径上），五步全链 e2e 属 W2-GAP-T01 验收 ①，不在此重复。
- **依赖**：W3-DRAFT-T01、W3-DRAFT-T02。

### 修订记录

（暂无）
<!-- END:WAVE03-DRAFT -->
