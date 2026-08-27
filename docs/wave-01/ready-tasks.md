# 就绪任务队列（第1波 / 周期W1）

> 本文件是各计划槽产出的**可直接领取执行**的任务队列，按槽位分区、**只追加不覆盖**：
> 后续槽位（P1/P2/…）在文件末尾新增自己的分区，不得修改已有分区的任务定义；
> 任务状态变更（领取/完成）由执行槽位在对应条目追加备注行。
> 任务编号格式 `TASK-<槽位>-<序号>`，验收标准必须二值可判定并标注证据类型（E1–E5，定义见
> `docs/wave-01/maturity-baseline.md` §2）。

---

## P3 分区：Agent 智能化（登记于 2026-08-27，来源 `docs/wave-01/P3-agent-intelligence.md`）

### 队列总览

| ID | 目标一句话 | 阶段 | 依赖 | 优先级 |
|----|-----------|------|------|--------|
| TASK-P3-01 | 模型网关最小实现，完成一次真实调用并脱敏存档 | 一 | BLK-W1-01、BLK-W1-02 解除 | P0 |
| TASK-P3-02 | 提示词库与技能注册（规则/技能/版本化） | 一(最小)→二(完整) | TASK-P3-01 | P0 |
| TASK-P3-03 | 受控输出层（schema 校验 + F1 重试降级） | 二 | TASK-P3-01/02 | P0 |
| TASK-P3-04 | 运行轨迹 trace 最小实现 | 一 | TASK-P3-01 | P0 |
| TASK-P3-05 | 工具注册表 + 首批只读工具 | 三 | TASK-P3-03；P1 的剧本存储可寻址 | P1 |
| TASK-P3-06 | Story Bible 数据结构 + 上下文组装器 v1 | 三 | TASK-P3-05 | P1 |
| TASK-P3-07 | 工作流引擎（静态计划执行 + 断点续跑） | 四 | TASK-P3-03/04 | P1 |
| TASK-P3-08 | WF-01 Logline→分场大纲工作流落地 | 四 | TASK-P3-07/09、SPEC-P3-02 | P2 |
| TASK-P3-09 | 意图澄清模块 v1 | 四 | TASK-P3-03 | P2 |
| TASK-P3-10 | 失败自修复策略表落地 + 输出质量抽检流程 | 二(前半)→五(后半) | TASK-P3-03/04 | P2 |

> 阶段编号对应 `docs/wave-01/P3-agent-intelligence.md` §4 实施顺序；P0 = 解锁 GOAL-W1-03 / C-L2 的关键路径。

### 任务明细

#### TASK-P3-01 模型网关最小实现

- **目标**：建立唯一的模型调用出口（供应商适配、超时、重试 F3、凭据从环境注入且永不落盘），并完成一次返回剧本相关内容的真实调用。直接对应 GOAL-W1-03。
- **建议文件**：`src/agent/gateway/`（客户端、供应商适配、配置）；`docs/evidence/` 下调用脱敏记录。扩展名按选型定（BLK-W1-01）。
- **验收（二值）**：E1 模块入主分支；E4 一次真实调用的请求/响应脱敏记录存档且内容与剧本创作相关；仓库全文检索不到任何凭据明文。
- **依赖**：BLK-W1-01、BLK-W1-02 解除。凭据未到位期间可先以录制/回放模式开发（方案 R-2），但验收必须有真实调用。

#### TASK-P3-02 提示词库与技能注册

- **目标**：建立 `prompts/rules|skills|schemas` 三层结构与加载器；最小版交付 1 条规则 + 1 个技能（建议 `generate_outline` 或 `rewrite_scene`）；完整版交付版本化（`id@version`）与注册时校验。
- **建议文件**：`prompts/rules/base.md`、`prompts/skills/<skill>.md`、`prompts/schemas/*.json`、`src/agent/prompts/`（加载器与注册表）。
- **验收（二值）**：E1 结构入库；E3 加载器测试：合法技能可加载、缺 `output_schema` 或槽位不匹配的技能被拒载；trace 中的技能引用含版本号（E4 一条运行记录佐证）。
- **依赖**：TASK-P3-01。

#### TASK-P3-03 受控输出层

- **目标**：所有 `skill:*` 调用输出经 JSON Schema 校验；F1 策略落地（带错误反馈重试 ≤2 次，仍失败降级为"纯文本草稿+需人工确认"），杜绝不受控输出进入业务逻辑。
- **建议文件**：`src/agent/orchestrator/output-guard`、`prompts/schemas/`。
- **验收（二值）**：E3 测试覆盖三种路径：一次通过 / 重试后通过 / 降级；E4 一次真实 F1 重试的 trace 记录（`repair_event` 含失败码与结果）。
- **依赖**：TASK-P3-01/02。

#### TASK-P3-04 运行轨迹 trace 最小实现

- **目标**：JSONL 事件流落盘（最小事件集：`run_start/run_end/llm_call/repair_event`），含 token、延迟、技能版本、上下文槽位引用；`runs/` 进 gitignore，脱敏摘要可导出到 `docs/evidence/`。
- **建议文件**：`src/agent/trace/`、`.gitignore` 追加 `runs/`。
- **验收（二值）**：E4 一次运行产出的 JSONL 文件包含全部最小事件且字段齐全；E3 脱敏导出测试：导出物中无凭据、无剧本正文全文（仅引用）。
- **依赖**：TASK-P3-01。

#### TASK-P3-05 工具注册表 + 首批只读工具

- **目标**：工具描述 schema（含 `side_effect/preconditions/failure_modes`）与注册表校验；实现首批只读工具 `read_scene / list_scenes / get_bible_entry`；F2 前置参数校验生效。
- **建议文件**：`src/agent/tools/registry`、`src/agent/tools/read_scene` 等、工具描述与实现同目录。
- **验收（二值）**：E3 注册表拒载非法描述的测试通过；三个工具对测试剧本返回正确结果的测试通过；E4 一次经模型发起的工具调用 trace。
- **依赖**：TASK-P3-03；P1 侧剧本存储满足"分场可寻址"（方案 §6 R-4）。

#### TASK-P3-06 Story Bible + 上下文组装器 v1

- **目标**：定稿人物卡/地点/伏笔 schema（`story-bible/`）；上下文组装器按方案 §2.3 预算表拼装（v1 确定性检出，不做向量检索），组装明细写入 trace。
- **建议文件**：`story-bible/README.md`（schema 说明）、`story-bible/characters/*.yaml`、`src/agent/context/assembler`。
- **验收（二值）**：E3 组装器测试：给定场号与人物，产物包含目标场全文、相邻场概要、对应人物卡，且各槽位不超预算；E4 trace 中 `context_slots` 字段与实际一致。
- **依赖**：TASK-P3-05。

#### TASK-P3-07 工作流引擎

- **目标**：静态计划模板实例化与执行（步骤类型 `tool/skill/human`）；`human:*` 节点挂起→序列化→续跑；预算硬顶（F4）生效。
- **建议文件**：`src/agent/orchestrator/workflow`、`src/agent/orchestrator/plans/`（模板）。
- **验收（二值）**：E3 测试：含 human 节点的模板可挂起并续跑、超预算计划被截停且返回断点句柄；E4 一次完整工作流 trace（含 `human_gate` 事件）。
- **依赖**：TASK-P3-03/04。

#### TASK-P3-08 WF-01 Logline→分场大纲落地

- **目标**：按 SPEC-P3-02 实现引导式大纲工作流（梗概→分幕→分场，每步人审，产出人物卡草稿）。
- **建议文件**：`src/agent/orchestrator/plans/wf-01`、`prompts/skills/generate_synopsis|generate_acts|generate_outline.md` 及配套 schema。
- **验收（二值）**：SPEC-P3-02 验收标准原文照抄执行（≥10 场大纲 + ≥2 张人物卡草稿 + 挂起续跑 1 次，E4 存档）。
- **依赖**：TASK-P3-07/09；规格 SPEC-P3-02。

#### TASK-P3-09 意图澄清模块 v1

- **目标**：按方案 §2.5 实现三条触发规则、≤2 问预算、超预算转显式默认假设；澄清问答落 trace 与会话层。
- **建议文件**：`src/agent/orchestrator/clarifier`。
- **验收（二值）**：E3 测试覆盖：必填槽位缺失触发澄清 / 槽位齐全不触发 / 超预算走默认假设且结果头部含假设声明；E4 一次真实澄清往返 trace（`clarify_event`）。
- **依赖**：TASK-P3-03。

#### TASK-P3-10 失败自修复策略表落地 + 抽检流程

- **目标**：前半（阶段二）：策略表 F1–F3 以配置落地并接入编排层；后半（阶段五）：建立输出质量抽检流程（抽样 run → 人工评定连贯性/事实一致 → 记录存档），产出 C-L3 所需抽检记录。
- **建议文件**：`src/agent/orchestrator/repair-policy`、`docs/evidence/spot-checks/`（抽检记录模板与存档）。
- **验收（二值）**：前半：E3 各失败码策略路径测试通过（可用注入故障方式）；后半：E5 首批 ≥5 条抽检记录存档，每条含 run_id、评定项、结论。
- **依赖**：TASK-P3-03/04。

### 领取与状态约定

- 领取任务的执行槽位在对应任务明细末尾追加一行：`> 状态：<领取|完成> —— <槽位> / <日期> / <分支或commit>`。
- 完成判定以验收标准逐条核对为准，证据不合格视为未完成（与基线 §2 证据三要素一致）。
