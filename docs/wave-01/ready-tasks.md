# Wave-01 就绪任务队列（Ready Tasks）

> **追加约定（append-only）**：本文件按计划槽分区维护。每个槽的内容包裹在
> `<!-- BEGIN:Px -->` / `<!-- END:Px -->` 标记之间；各槽**只在文件末尾追加自己的分区**，
> 不修改、不覆盖其他分区的有效内容。对已有分区的勘误由原槽负责人以追加「修订记录」小节完成。
>
> 说明：本文件在分支 `cursor/w2-plan-backlog-verification-f51f` 上基于 `main @ deda75a`（无此文件）创建，
> **仅含 WAVE02-PLAN 分区**。既有分区分布：P1 分区在 `cursor/w1-p1-usability-architecture-5d0e` @ `5545c22`、
> P2 分区在 `cursor/w1-p2-interaction-reliability-a3c2` @ `7873b66`、P3 分区在
> `cursor/w1-p3-agent-intelligence-ca4d` @ `67e6670`、P4 分区在
> `cursor/w1-p4-major-experience-features-5fba` @ `718e28e`。合并时按分区标记取并集拼接即可，
> 本分区未改写任何既有分区的任何内容，无冲突。

---

<!-- BEGIN:WAVE02-PLAN -->
## WAVE02-PLAN 分区：G1 缺口补登记（登记于 2026-08-27，第 2 波计划槽）

- **登记依据**：W1-C 链路盘点 `docs/wave-01/inventory-agent-tooling.md` @ `8553c7f` §7.1 缺口 G1——P3 第二/三批共 5 个工具（`write_scene_draft`、`upsert_bible_draft`、`search_script`、`consistency_check`、`format_lint`）与工作流 WF-02/03 在 ready-tasks 无独立任务 ID，仅以 SPEC 依赖形式存在，实现槽无法按「领取与状态约定」认领，W5 无对账锚点。
- **登记方式**：遵守 W1-C §7.1 处置建议与本文件追加约定——**只新增本分区，不改写 P3 分区**（TASK-P3-01…10 定义原样有效）；以 SPEC-P3-01/02/03 为立项单元拆解。
- **权威来源**：工具行为契约见 P3 方案 `docs/wave-01/P3-agent-intelligence.md` @ `67e6670` §2.1 首批工具表；工作流行为契约与验收见同文档 §5（SPEC-P3-01/02/03）。本分区不复述架构正文，只登记任务锚点。
- **任务 ID 格式**：`W2-PLAN-T{序号}`（兼容 P1/P4 分区的 `W{波次}-{槽位}-T{序号}` 约定），全库唯一，被引用后不得复用或改义。
- **排序与协调**：波内梯队位置与跨槽协调项（D1–D7）见 `docs/wave-02/implementation-backlog.md` §2/§3；涉及协调项的任务领取时在状态行注明「按 Dx 执行」。

### 队列总览

| ID | 目标一句话 | 对账锚点（W1-C §5/§6） | 依赖 | 优先级 |
| --- | --- | --- | --- | --- |
| W2-PLAN-T01 | 第二批草稿写工具 `write_scene_draft` + `upsert_bible_draft` | 工具 T4、T5 | TASK-P3-03/05 | P1 |
| W2-PLAN-T02 | 第二批检索工具 `search_script` | 工具 T6 | TASK-P3-05、W1-P4-T01 | P2 |
| W2-PLAN-T03 | SPEC-P3-01 一致性守卫（`consistency_check` 工具 + WF-03 巡检工作流） | 工具 T7、工作流 WF-03 | TASK-P3-05/06/07 | P1 |
| W2-PLAN-T04 | SPEC-P3-03 场景改写助手（WF-02 工作流落地） | 工作流 WF-02 | W2-PLAN-T01/T03、TASK-P3-03/06/09 | P1 |
| W2-PLAN-T05 | 第三批格式工具 `format_lint` | 工具 T8 | TASK-P3-05（宜后置 W1-P4-T02） | P2 |

### 任务明细

#### W2-PLAN-T01 · P1 · 第二批草稿写工具 `write_scene_draft` + `upsert_bible_draft`

- **目标**：按 P3 §2.1 实现两个 `draft_write` 工具——写入场景草稿并返回差异预览、提议设定集条目变更（同走草稿）；任何路径不触 M1 权威层，直到用户显式采纳（原则 P-3）。供 WF-01 采纳步与 WF-02 草稿步消费。
- **建议文件**：`src/agent/tools/write_scene_draft`、`src/agent/tools/upsert_bible_draft`（描述与实现同目录，注册进 TASK-P3-05 注册表）。
- **验收（二值）**：E3 测试：① 草稿写入后原稿哈希不变；② 差异预览与草稿内容一致；③ 两工具描述通过注册表 schema 校验（含 `side_effect: draft_write`、`preconditions`、`failure_modes`）；E4 一次经模型发起的 `draft_write` 调用 trace（含 `tool_call` 事件）。
- **依赖**：TASK-P3-03（受控输出）、TASK-P3-05（注册表）。采纳写入时刻建议叠加 W1-P4-T03 安全快照原语（协调项 D4，接口以 P4-T03 交付为准）。

#### W2-PLAN-T02 · P2 · 第二批检索工具 `search_script`

- **目标**：按 P3 §2.1 实现关键词/人物名检索剧本正文的只读工具；**建于 W1-P4-T01 内容索引层之上，不得自带解析器**（协调项 D3，P4-T01 为唯一取数面）。
- **建议文件**：`src/agent/tools/search_script`。
- **验收（二值）**：E3 测试：对测试剧本夹具的检索命中/漏检断言（关键词、人物名、别名归并各 ≥1 例）通过；工具描述通过注册表校验；E4 一次经模型发起的工具调用 trace。
- **依赖**：TASK-P3-05、W1-P4-T01。

#### W2-PLAN-T03 · P1 · SPEC-P3-01 一致性守卫（`consistency_check` 工具 + WF-03 巡检工作流）

- **目标**：按 SPEC-P3-01 行为契约实现：对指定范围（全本/场号区间/单场草稿）抽取事实断言并与 Story Bible `facts` 及前文比对，输出冲突报告（场号/描述/依据/置信度/修复建议），**只报告不改写**（F5）；单场抽取失败标注「未检查」，杜绝假阴性（未完成检查 ≠ 无冲突）。工具形态供 WF-02 后置步复用；工作流形态即 WF-03 巡检（全本扫描 → 冲突报告 → 逐条修复建议）。
- **建议文件**：`src/agent/tools/consistency_check`、`src/agent/orchestrator/plans/wf-03`、配套冲突列表 schema（`prompts/schemas/`）。
- **验收（二值）**：SPEC-P3-01 验收标准原文照抄执行——构造含 ≥3 个已知矛盾的测试剧本，报告命中全部预埋矛盾（E3/E4 存档）；对无矛盾文本高置信度误报 ≤1 条。另加：报告中含 ≥1 条「未检查」标注路径的测试（注入单场抽取失败）。
- **依赖**：TASK-P3-05（工具）、TASK-P3-06（Story Bible）、TASK-P3-07（工作流引擎，WF-03 形态需要）。与 W1-P4-T02 结构规则引擎的分工按协调项 D2 执行（本任务只做语义/事实类，不收结构可判定规则）。

#### W2-PLAN-T04 · P1 · SPEC-P3-03 场景改写助手（WF-02 工作流落地）

- **目标**：按 SPEC-P3-03 行为契约实现 WF-02：`scene_id` + 自然语言指令（缺 `scene_id` 触发澄清）→ 组装上下文 → `rewrite_scene` 技能产出受控草稿 → 自动 `consistency_check` 后置步（冲突以警示随差异呈现，不阻断交付）→ 差异预览 + 改动说明；原稿安全同 P-3。
- **建议文件**：`src/agent/orchestrator/plans/wf-02`、`prompts/skills/rewrite_scene.md` 及配套 schema。
- **验收（二值）**：SPEC-P3-03 验收标准原文照抄执行——对含既定事实的测试场景执行改写：草稿保留全部 `facts` 相关事实且体现指令要求（人工判定记录存档，E4）；连续 3 次运行无崩溃、原稿哈希不变（E4）。
- **依赖**：W2-PLAN-T01（草稿写工具）、W2-PLAN-T03（`consistency_check` 工具形态）、TASK-P3-03（受控输出）、TASK-P3-06（上下文组装）、TASK-P3-09（澄清）。

#### W2-PLAN-T05 · P2 · 第三批格式工具 `format_lint`

- **目标**：按 P3 §2.1 实现剧本格式规范检查工具（场头/角色名/对白缩进等）。实现取向按协调项 D2：**包装复用 W1-P4-T02 `sw check` 规则引擎的格式类规则**，工具层只做注册与调用适配，禁止第二套规则引擎。
- **建议文件**：`src/agent/tools/format_lint`（适配层）。
- **验收（二值）**：E3 正反例夹具测试：≥3 类格式违规检出、无违规文本零报告；工具描述通过注册表校验；E4 一次经模型发起的工具调用 trace。
- **依赖**：TASK-P3-05；宜后置 W1-P4-T02（复用其规则引擎）。若 P4-T02 长期未就绪需提前，须先在本条目追加修订记录登记「独立最小规则集 + 后续回收合并」的偏离决定，不得静默双立引擎。

### 领取与状态约定

沿用 P3 分区约定：领取任务的执行槽位在对应任务明细末尾追加一行 `> 状态：<领取|完成> —— <槽位> / <日期> / <分支或commit>`；完成判定以验收标准逐条核对为准，证据不合格视为未完成。涉及协调项（D2/D3/D4）的任务，状态行须注明「按 Dx 执行」。
<!-- END:WAVE02-PLAN -->
