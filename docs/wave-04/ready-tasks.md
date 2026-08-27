# Wave-04 就绪任务队列（Ready Tasks）

> **追加约定（append-only）**：沿用 wave-01/02/03 同名文件的分区纪律——每个槽的内容包裹在
> `<!-- BEGIN:xxx -->` / `<!-- END:xxx -->` 标记之间；各槽**只在文件末尾追加自己的分区**，
> 不修改、不覆盖其他分区的有效内容。对已有分区的勘误由原槽负责人以追加「修订记录」小节完成。
> 任务 ID 格式 `W{波次}-{槽位}-T{序号}`，全库唯一，被引用后不得复用或改义。
>
> 说明：本文件在分支 `cursor/w4-spec-help-aliases-0f4e` 上基于 `main @ deda75a`（无此文件）创建，
> **仅含 WAVE04-HELP 分区**（wave-04 队列文件首建）。wave-01/02/03 的队列文件各分区仍在各自分支，
> 本文件不携带其副本；四份文件是不同波次的队列，合并后并存，互相以任务 ID 引用。

---

<!-- BEGIN:WAVE04-HELP -->
## WAVE04-HELP help 系统与短别名任务（SPEC-07 落地配套）

- 来源方案：[`docs/wave-04/spec-help-aliases.md`](./spec-help-aliases.md)（下称「规格文档」，含注册表单一数据源 §4.1、别名全集 v1 §4.2、`help --all` §4.4、快照验收 §5、T09 互链 §6、勘误登记 §7）
- 产出分支：`cursor/w4-spec-help-aliases-0f4e`
- 公共约束：**基分支一律取 W3 集成分支头**（集成图 §5 纪律，禁止从单个 W2/W3 功能分支分叉）；CI 门不可降标（lint / lint:errors / typecheck / test / build / smoke / smoke:exit-codes 全绿 0 跳过）；测试只增不减、断言只迁移不删除；不合并进 `main`；不开 PR
- 立项边界：**集中别名表与 `sw help --all` 的实现任务仍为 `W2-GAP-T02`，本分区不重复立项**（先例：WAVE03-DRAFT 对 W2-GAP-T01 同法）——其开工依据自规格文档起为 SPEC-07 全文，依赖列经勘误追加 W4-HELP-T01（规格文档 §7-3）；W1-P1-T10 的 TTFS 半面已由 W3-DRAFT-T03 承接，本分区只承接其 **help 快照半面**
- 状态图例：`ready`＝直接前置就绪即可开工；`blocked`＝等待前置任务

### 总览

| 任务 ID | 名称 | 对应依据 | 优先级 | 工作量 | 依赖 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| W4-HELP-T01 | 命令注册表基建（单一数据源 + 挂载循环 + 手工路线图退役） | 规格文档 §4.1、§4.3、§7-7 | P1 | S | W3-PLAN-T02（已交付 @ `e2721d4`） | ready |
| W4-HELP-T02 | help 快照测试与用户文档互链收口（W1-P1-T10 快照半面） | 规格文档 §5、§6、§7-4/5 | P1 | S | W4-HELP-T01、W2-GAP-T02 | blocked(T01, W2-GAP-T02) |

依赖图：`W3-PLAN-T02 → W4-HELP-T01 → W2-GAP-T02 → W4-HELP-T02`；后续命令槽（W3-DRAFT-T01/T02、W2-GAP-T01）与本链并行不冲突——注册表交付后它们的 `program.ts` 触碰面缩为注册表条目一行（规格文档 §9），其落地只把对应 planned 条目转 available，不动 help 渲染与别名表。

### 任务明细

#### W4-HELP-T01 · P1 · 命令注册表基建（单一数据源 + 挂载循环 + 手工路线图退役）

- **目标**：按规格文档 §4.1 新建 `src/cli/registry.ts`（条目：name / alias / summary / group / status / taskId / register），`buildProgram` 改为遍历注册表挂载 available 条目并在挂载循环内统一注入别名与可见性尾注；默认 help 的 main 组清单、路线图段（含 revise planned 补行，§7-7）自注册表生成；ROADMAP_HELP 手工字面量退役。init/status 的 `registerXCommand` 模块内部零改动。
- **文件范围**：`src/cli/registry.ts`（新）、`src/cli/program.ts`（挂载循环化 + 路线图生成）、help 渲染模块（可并入 program.ts 或独立 `src/cli/helpText.ts`，实现自定）、`tests/cli/program.spec.ts` 既有断言随注册表化改写期望文案（不删断言）、注册表结构单测（词条唯一性、planned 零注册）。
- **验收标准（二值）**：① 规格文档 §5-⑦（无 ROADMAP_HELP 字面量、路线图含 revise planned 行且自注册表生成）；② §5-①（渐进披露四入口断言，此时 aux/planned 均不见于默认 help）；③ §5-②的「注册表 ↔ commander 注册」双向一致断言（`--all` 侧断言归 T02）；④ 全套 CI 门通过、测试只增不减。
- **风险**：低。改造面收敛在 `src/cli/`，不触引擎/存储；与并行命令槽的冲突面反而因注册表化收窄（规格文档 §9）。
- **依赖**：W3-PLAN-T02（集成分支 error+engine+init 归一，已交付 @ `e2721d4`）；开工前确认集成分支头未变基。

#### W4-HELP-T02 · P1 · help 快照测试与用户文档互链收口（W1-P1-T10 快照半面）

- **目标**：按规格文档 §5 交付 help 快照测试全集（结构断言不锁全文）：三向一致断言（注册表 ↔ 注册 ↔ `--all` 输出）、六别名等价性断言框架（已注册命令即时生效、未注册命令随其落地补齐——渐进增强）、别名可见 + ≥1 示例断言、`sw help` ≡ `sw --help` 与 `sw help <cmd>` ≡ `sw <cmd> --help` 等价断言、用法错误档（`help draft --all` / `help <未知词条>` → 2）进 `smoke:exit-codes`；按 §6 收口互链：`docs/user/commands.md` 别名标注与 `sw help` 行核验（使能提交应已加行，本任务补别名列与交叉核验）、`--all` 尾部 commands.md URL 在其并入基分支后点亮并补断言。
- **文件范围**：`tests/cli/help.spec.ts`（新）、`scripts/smoke-exit-codes.mjs` 扩行（只加不改）、`docs/user/commands.md`（别名标注 + 豁免清单勘误，规格文档 §7-4）、必要时 `src/cli/` 内 URL 行点亮（§6.3 条件满足时）。
- **验收标准（二值）**：规格文档 §5 ①–⑨ 全项（其中 ③ 的写命令别名断言按渐进增强口径：断言框架 + 已注册命令覆盖即达标，未注册者留 todo 断言位并在对应命令槽补齐）+ §6.2 同提交责任的历史核查（W2-GAP-T02 使能提交含 commands.md 更新）。
- **风险**：快照易碎——沿用 W1-P1-T10 既有缓解（只锁结构断言不锁全文，规格文档 §5 开头）；`--all` 尾部 URL 的点亮时机依赖 user-docs 文档并入基分支，未并入时该断言按「行不出现」验收（虚假 URL 禁令），无阻塞。
- **依赖**：W4-HELP-T01、W2-GAP-T02。

### 修订记录

（暂无）
<!-- END:WAVE04-HELP -->
