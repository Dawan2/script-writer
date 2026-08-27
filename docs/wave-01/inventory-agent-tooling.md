# W1-C Agent / 工具 / 自动化链路盘点（第1波 / 周期W1 / 工作槽W1-C）

| 项目 | 内容 |
| --- | --- |
| 波次 / 槽位 | 第 1 波（wave-01）/ 周期 W1 / 工作槽 W1-C Agent/工具/自动化链路盘点 |
| 仓库 | github.com/Dawan2/script-writer |
| 盘点基线 | `main @ deda75a5245caf96d3ee1ac7b22109d0f421c333`（Initial commit，唯一提交） |
| 盘点日期 | 2026-08-27（UTC） |
| 工作分支 | `cursor/w1-c-agent-tooling-inventory-0ec2` |
| 文档性质 | 事实盘点（证据锚定 commit）+ 对照 P3 方案的「目标工具清单与调用链」缺口登记 |
| 对照依据 | `docs/wave-01/P3-agent-intelligence.md` @ `67e6670`（P3 分支）、`docs/wave-01/ready-tasks.md` P3 分区（TASK-P3-01…10） |

---

## 1. 结论速览（TL;DR）

1. **Agent/工具/自动化链路现状为零**：`main @ deda75a` 上不存在任何 Agent 模块、工具实现、提示词资产、trace 设施、CI/工作流或代理配置（逐项探测证据见第 3 节）。五个并行工作分支均为 docs-only，**任何分支上都没有代码**，故本盘点无「现有实现」可清点。
2. **目标链路已由 P3 方案定义完毕**：本文不重写 P3 架构，只把 P3 方案中的组件、工具与调用链**抽取成对账清单**（第 4–6 节），每项标注现状（均为缺失）、目标位置与承接任务（TASK-P3-01…10 / SPEC-P3-01…03），供实现波次与 W5 核验直接逐行对账。
3. **两个登记缺口**（本槽发现，不新增任务定义，仅登记）：P3 首批工具清单中**第二、三批共 5 个工具**（`write_scene_draft`、`upsert_bible_draft`、`search_script`、`consistency_check`、`format_lint`）在 ready-tasks P3 分区**没有独立任务 ID**，散落在 SPEC-P3-01/02/03 的依赖里；仓库级自动化（CI、证据归档流水线）在 P3 侧仅登记为依赖（R-3），责任在 P1/P2/基建槽（BLK-W1-03）。详见第 7 节。
4. **整条链路的启动前置未变**：BLK-W1-01（技术栈未选型）、BLK-W1-02（模型凭据未定）阻塞阶段一全部任务；BLK-W1-03（无 CI）使自动化链路的证据归档段无处挂接。本槽无新增阻塞。

---

## 2. 盘点方法与范围

- **对象**：`main @ deda75a`（主对象）+ 远端全部 5 个工作分支（只读 fetch，不合并、不改写）。
- **手段**：`git cat-file -e main:<path>` 逐项探测 P3 方案约定的目标目录与常见代理/自动化配置路径；`git ls-tree -r` 全量列举各分支文件。输出原样存档（满足 W1-D 基线证据三要素：可复现命令、原始输出、锚定 SHA）。证据类型均为 **E1（存在性）**。
- **分工边界（防重做）**：通用工程要件（包清单/测试/lint/.gitignore/LICENSE 等）的探测已由 W1-A `docs/wave-01/inventory-codebase.md` @ `92e19a4` 完成，本文**不重复**，仅引用其结论；本文只补充 **Agent/工具/自动化专属路径**的探测。
- **对照口径**：目标态一律以 P3 方案（`67e6670`）的章节为准，本文只引用章节号与最小必要摘录，**不复述架构正文**（原则：P3 是单一事实来源，本文是对账索引）。

## 3. 现状事实盘点（证据，锚定 `deda75a`）

### 3.1 Agent/工具/自动化专属路径逐项探测

```text
$ for p in src/agent src/agent/gateway src/agent/orchestrator src/agent/tools \
    src/agent/context src/agent/trace src/agent/prompts \
    prompts prompts/rules prompts/skills prompts/schemas \
    story-bible runs .github .github/workflows .cursor mcp.json .mcp.json \
    package.json Makefile scripts; do
    git cat-file -e "main:$p" 2>/dev/null && echo "EXISTS: $p" || echo "MISSING: $p"
  done
# 结果：全部 21 项 MISSING（无一 EXISTS）

$ git ls-tree -r --name-only main
README.md
```

| 类别 | 探测路径（P3 约定目录 / 常见配置） | 结果 |
| --- | --- | --- |
| Agent 源码 | `src/agent/{gateway,orchestrator,tools,context,trace,prompts}` | 全部**缺失** |
| 提示词资产 | `prompts/{rules,skills,schemas}` | 全部**缺失** |
| 记忆/设定集 | `story-bible/` | **缺失** |
| 运行轨迹 | `runs/`（及 `.gitignore` 忽略项，W1-A 已证 `.gitignore` 本身缺失） | **缺失** |
| CI / 仓库自动化 | `.github/`（含 `workflows/`）、`Makefile`、`scripts/` | 全部**缺失** |
| 代理/IDE 配置 | `.cursor/`、`mcp.json`、`.mcp.json` | 全部**缺失** |
| 运行入口 | `package.json`（脚本入口，W1-A 已证其余栈清单同缺） | **缺失** |

### 3.2 并行分支复核（确认「无代码可盘」）

`git ls-tree -r --name-only` 逐分支列举（2026-08-27 采集），5 个工作分支相对 `main` 的新增**全部位于 `docs/` 下**（W1-D 3 文件、P1 3 文件、P2 3 文件、P3 4 文件、W1-A 3 文件），无任何 `src/`、`prompts/`、`.github/` 等代码或自动化资产。与 W1-D 基线（三维度 L0）、W1-A 结构盘点结论相互印证，无出入。

**结论**：Agent 链路、工具链路、自动化链路三者现状均为**空集**。以下各节即为对照 P3 方案的目标态清单，**「现状」列恒为缺失**，不再逐行重复证据。

---

## 4. 目标组件链路对账清单（对照 P3 §1.3 / §2.1–§2.9）

> 目标位置为 P3 约定的**目录契约**（扩展名随 ADR-0001 选型定，BLK-W1-01）。「承接任务」指 ready-tasks P3 分区任务 ID。

| # | 链路组件 | P3 依据 | 目标位置 | 现状 | 承接任务 | 前置 |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | 模型网关 Model Gateway（供应商适配/重试 F3/限额/脱敏） | §1.3、任务明细 | `src/agent/gateway/` | 缺失 | TASK-P3-01（P0） | BLK-W1-01/02 |
| C2 | 提示词库 Prompt Store（rules/skills/schemas 三层 + 加载校验 + 版本化） | §2.8 | `prompts/`、`src/agent/prompts/` | 缺失 | TASK-P3-02（P0） | C1 |
| C3 | 受控输出层 Output Guard（schema 校验 + F1 重试降级） | §2.4 F1 | `src/agent/orchestrator/output-guard` | 缺失 | TASK-P3-03（P0） | C1/C2 |
| C4 | 运行轨迹 Trace（JSONL 事件流 + 脱敏导出） | §2.7 | `src/agent/trace/`、`runs/` | 缺失 | TASK-P3-04（P0） | C1 |
| C5 | 工具注册表 Tool Registry（描述 schema + F2 前置校验 + 拒载非法工具） | §2.1 | `src/agent/tools/registry` | 缺失 | TASK-P3-05（P1） | C3；P1 侧「分场可寻址」 |
| C6 | Story Bible + 上下文组装器（四层记忆 M1–M4、槽位预算表、v1 确定性检出） | §2.3 | `story-bible/`、`src/agent/context/assembler` | 缺失 | TASK-P3-06（P1） | C5 |
| C7 | 工作流引擎 Workflow Engine（静态模板 + human 挂起续跑 + F4 预算硬顶） | §2.6 | `src/agent/orchestrator/workflow`、`…/plans/` | 缺失 | TASK-P3-07（P1） | C3/C4 |
| C8 | 意图澄清 Clarifier（3 触发规则、≤2 问、默认假设） | §2.5 | `src/agent/orchestrator/clarifier` | 缺失 | TASK-P3-09（P2） | C3 |
| C9 | 失败自修复策略表 Repair Policy（F1–F5 配置化） | §2.4 | `src/agent/orchestrator/repair-policy` | 缺失 | TASK-P3-10 前半（P2） | C3/C4 |
| C10 | 规划器 Planner（开放规划，plan schema + 修订规则） | §2.2 | `src/agent/orchestrator/`（planner） | 缺失 | 无独立任务 ID（§2.2 明确 **L2 后再引入**，第一波只跑 C7 静态工作流） | C 维度达 L2 |
| C11 | 层间契约 `AgentRequest` / `AgentResult` | §2.9 | 随 C7/接口层落地（P1/P2 消费方） | 缺失 | 随 TASK-P3-07 与 P1/P2 实现槽联合落地 | — |
| C12 | 输出质量抽检流程（人工抽检 + 存档） | §4 阶段五 | `docs/evidence/spot-checks/` | 缺失 | TASK-P3-10 后半（P2） | C4 |

## 5. 目标工具清单对账（对照 P3 §2.1 首批工具表）

> 工具描述 schema（`side_effect/preconditions/failure_modes` 等强制字段）与「`destructive` 第一波不提供、写操作一律 `draft_write`」的规则见 P3 §2.1，此处不复述。

| # | 工具 | side_effect | 批次（P3 优先级） | 现状 | 承接任务 / 规格挂接 | 登记状态 |
| --- | --- | --- | --- | --- | --- | --- |
| T1 | `read_scene` | none | 第一批 | 缺失 | TASK-P3-05 | 已有任务 ID |
| T2 | `list_scenes` | none | 第一批 | 缺失 | TASK-P3-05 | 已有任务 ID |
| T3 | `get_bible_entry` | none | 第一批 | 缺失 | TASK-P3-05 | 已有任务 ID |
| T4 | `write_scene_draft` | draft_write | 第二批 | 缺失 | SPEC-P3-02/03 依赖（WF-01 采纳步、WF-02 草稿步） | **无独立任务 ID**（见 §7 缺口 G1） |
| T5 | `upsert_bible_draft` | draft_write | 第二批 | 缺失 | SPEC-P3-02 步骤 3（人物卡草稿） | **无独立任务 ID**（G1） |
| T6 | `search_script` | none | 第二批 | 缺失 | 无规格显式挂接 | **无独立任务 ID**（G1） |
| T7 | `consistency_check` | none | 第三批 | 缺失 | SPEC-P3-01（WF-03 主体、WF-02 后置步） | **无独立任务 ID**（G1；SPEC-P3-01 为立项单元） |
| T8 | `format_lint` | none | 第三批 | 缺失 | 无规格显式挂接 | **无独立任务 ID**（G1） |

## 6. 目标调用链对账（对照 P3 §1.3 / §2.2 / §2.6 / §2.9）

以下 5 条链是 P3 方案定义的全部运行时链路，本文按「链」的粒度对账；每条链的详细行为契约见括号内 P3 章节，不复述。**现状：5 条链全部缺失（0 段已建）。**

| 链 | 链路（→ 为数据/控制流向） | P3 依据 | 依赖组件 | 最早可建阶段 |
| --- | --- | --- | --- | --- |
| L-A 主请求链 | 接口层（P1/P2）→ `AgentRequest` → 编排层（Clarifier → 计划实例化 → 步骤执行 → Repair）→ `AgentResult`（含 `need_clarify/suspended/failed` 中间态）→ 接口层 | §1.3、§2.9 | C7/C8/C9/C11 | 阶段四 |
| L-B 技能调用子链 | 步骤 `skill:*` → 上下文组装器（rules/skill/bible/script/session/output_spec 六槽位按预算拼装）→ 模型网关 → 受控输出层（schema 校验，F1 重试/降级）→ 步骤产物 + trace `llm_call` | §2.3、§2.4、§2.8 | C1/C2/C3/C4/C6 | 阶段一（最小版：无 bible 槽）→ 阶段三（完整） |
| L-C 工具调用子链 | 模型发起工具调用 → 注册表前置校验（F2）→ 工具执行（只读 / draft_write 草稿+差异预览）→ 结果回填 + trace `tool_call` | §2.1、§2.4 | C4/C5 | 阶段三 |
| L-D 工作流链 | 模板（WF-01/02/03）→ 静态计划实例化 → `tool/skill/human` 步骤序列 → `human:*` 挂起（状态序列化）→ 用户回复续跑 → 采纳后写入 M1 权威层 | §2.6、SPEC-P3-01/02/03 | C5/C6/C7/C8 + T1–T7 | 阶段四–五 |
| L-E 观测与证据链（自动化链路核心） | 运行事件 → `runs/*.jsonl`（gitignore）→ 脱敏摘要导出 → `docs/evidence/` 存档 →（CI 归档，待 BLK-W1-03 解除）→ W5 核验消费 | §2.7、R-3 | C4/C12 + CI（P1/P2/基建槽） | 阶段一起步（trace 落盘）；CI 段受 BLK-W1-03 阻塞 |

**三条工作流实例**（L-D 的具体化，均缺失）：

| 工作流 | 步骤链概要 | 规格 | 承接任务 |
| --- | --- | --- | --- |
| WF-01 Logline→分场大纲 | 澄清(≤2问) → 梗概草稿(人审) → 分幕结构(人审) → 分场大纲草稿(人审采纳) → 人物卡草稿一并采纳 | SPEC-P3-02 | TASK-P3-08 |
| WF-02 场景改写 | 澄清 → 组装上下文 → `rewrite_scene` 草稿 → `consistency_check` → 差异预览(人审采纳) | SPEC-P3-03 | 无独立任务 ID（G1；规格即立项单元） |
| WF-03 一致性巡检 | 全本扫描 → 冲突报告（只报告不改写，F5） → 逐条修复建议 | SPEC-P3-01 | 无独立任务 ID（G1；规格即立项单元） |

## 7. 缺口登记与差距摘要

### 7.1 登记缺口（本槽发现，供后续计划槽补登记，本文不新增任务定义）

| 编号 | 缺口 | 影响 | 建议处置 |
| --- | --- | --- | --- |
| G1 | 第二、三批工具（T4–T8）与 WF-02/03 落地在 ready-tasks P3 分区**无独立任务 ID**，仅以 SPEC 依赖形式存在 | 实现波次无法按「领取与状态约定」认领这些工作；W5 对账时无任务锚点 | 后续计划槽在 ready-tasks **P3 分区之外追加分区**登记（遵守「只追加不改写他区」约定），以 SPEC-P3-01/02/03 为立项单元拆解 |
| G2 | 自动化链路的 CI 段（L-E 末端）在 P3 侧仅登记为依赖 R-3，落地责任在 P1 侧 W1-P1-T03（`.github/workflows/ci.yml`） | trace→evidence 归档在 CI 建立前只能手工执行，核验成本高（P3 R-3 原文已预警） | 沿用既有分工：CI 由 W1-P1-T03 承接（解除 BLK-W1-03），P3 侧 C4/C12 只需保证脱敏导出物可被归档 |

### 7.2 差距摘要（链路视角）

| # | 差距 | 现状 | 目标（依据） | 责任项 |
| --- | --- | --- | --- | --- |
| 1 | 无模型调用能力 | 缺失 | C1 网关 + 一次真实调用脱敏存档（GOAL-W1-03 / C-L1） | TASK-P3-01（前置 BLK-W1-01/02） |
| 2 | 无提示词/受控输出设施 | 缺失 | C2+C3，达 C-L2 准入 | TASK-P3-02/03 |
| 3 | 无可观测性 | 缺失 | C4 trace 最小事件集落盘 + 脱敏导出 | TASK-P3-04 |
| 4 | 无工具层 | 缺失（8/8 工具缺失） | 第 5 节工具清单，首批 3 只读工具先行 | TASK-P3-05（T4–T8 见 G1） |
| 5 | 无记忆/上下文层 | 缺失 | C6 Story Bible + 组装器 v1（确定性检出） | TASK-P3-06 |
| 6 | 无编排层 | 缺失 | C7 工作流引擎 + C8 澄清 + C9 修复策略表（开放规划 C10 按 §2.2 缓建） | TASK-P3-07/09/10 |
| 7 | 无运行链路 | 缺失（5/5 链缺失） | 第 6 节 L-A…L-E | 随组件分阶段成链（§4 实施顺序） |
| 8 | 无仓库自动化 | 缺失（无 CI/workflows/scripts） | CI 三件套 + 证据归档段 | W1-P1-T03（BLK-W1-03）+ G2 分工 |

## 8. 阻塞与交接

- **无新增阻塞**。沿用 W1-D 登记的 BLK-W1-01/02/03 与 P1 登记的 B1；本文所有「最早可建阶段」均以 BLK-W1-01/02 解除为起点（与 P3 §4 一致）。
- **给实现槽**：领取 TASK-P3-01…10 时，可用第 4/5/6 节三张对账表作为完工自查清单（组件 12 项、工具 8 项、链路 5 条），逐行把「缺失」翻为「已建 + 证据锚点」；勿改本表定义，状态更新按 ready-tasks「领取与状态约定」在任务侧追加。
- **给后续计划槽**：G1（T4–T8 与 WF-02/03 无任务 ID）是本盘点唯一需要计划侧动作的缺口，登记方式见 §7.1。
- **给 W5 核验槽**：本文全部断言为 E1 存在性证据，复核命令在 §3.1 原样可复现；「现状=缺失」的全称断言以 `main @ deda75a` 与五分支 `ls-tree` 输出为界，此后任何新提交不在本盘点范围内。
- **给合并者**：本分支基于 `main @ deda75a`，仅新增本文件与 `docs/DISPATCH-receipt.md`（追加式）；`DISPATCH-receipt.md` 与 `ready-tasks.md` 的多分支并集合并注意事项见 W1-A 盘点 §4（本文不重复）。
