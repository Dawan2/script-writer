# Agent 智能化：现状基线与能力缺口

| 项 | 值 |
| --- | --- |
| 里程碑 / 槽位 | 周期 1 / 第 1 波 / W1 · 计划-Agent 智能化 |
| 仓库 | github.com/Dawan2/script-writer |
| 代码基线 | `main @ abb779e`（Next.js 前端 + FastAPI 后端 + `Agents/` Claude Code 子项目） |
| 工作分支 | `cursor/w1-agent-intelligence-plan-058e` |
| 产出性质 | 以真实代码为唯一依据的现状测绘 + 缺口台账；仅落地 2 处高置信小修复 |
| 同周期兄弟文档 | `交互可靠性-*.md`（服务端长任务与前端可靠性，本文不重复）、`../wave-01/W1-前端交互测绘.md`（界面层） |

---

## 0. 基线更正：三份历史 Agent 文档已不能作为实现依据

`docs/` 下已有三份 Agent 系统文档：`agent-system-audit-2026-07-12.md`、
`claude-agent-performance-optimization-2026-07-14.md`、`current-skill-inventory-2026-07-19.md`。
它们描述的目录结构与 `main @ abb779e` 上真实存在的 Agent 系统**不是同一套实现**：

| 历史文档描述 | `main @ abb779e` 真实情况 |
| --- | --- |
| `_shared/lib/` 下 15 个共享模块（`stage-runner`、`outline-canon`、`character-canon`、`script-quality`、`dialogue-review`、`narrative-review`…） | `_shared/` 只有 4 份 reference 和 2 个脚本；`lib/` 目录不存在 |
| 每阶段 `init-*` / `validate-*` 双工具 + Context Pack + 隐藏 Canon 草稿 | 每阶段 `init-*` / `check-*` + `执行规范.md` / `执行策略.md`，没有 Canon 与 Context Pack |
| `full-draft-tool.mjs` 小批次生成、批次 manifest、跨集重复与正文密度扫描 | 该文件不存在；`check-full.mjs` 只做结构、集数、试稿一致与字数下限检查 |
| 9 个 Skill | 14 个 Skill（`.claude/skills/`）+ 11 个后台知识 Skill（`skills/`） |
| `_shared/contracts/stage-contracts.json` 定义七个受管 Skill 与 `repair_limit` | 该文件不存在；修订次数由后端固定为 1 次 |

因此本文不引用上述文档的任何结论，只记录当前代码中可验证的事实。历史文档的价值仅在于
**它记录了曾经存在、现在已从运行链路上消失的防御能力**（见 G-16），这一点本身就是本波最重要的发现之一。

---

## 1. 结论速览

1. **Agent 系统的真实形态**：14 个创作/后台 Skill、18 个跨 Skill 通用工具、57 份 reference、
   56 个 Skill 脚本，加上一个 SQLite 剧本知识库（创作原则 + 策略公式），由 FastAPI 侧
   `agent_runner.py` 统一编排。运行契约设计清晰：后端只给"运行信封"，阶段 SOP 归 Skill
   （`agent_runner.py:3365-3369` 明确写了这条设计意图），这是当前架构最值得保留的部分。
2. **智能化链路已经建成，但闭环断在两头**。上游"知识库 → 执行策略 → 创作"已打通；
   下游"创作 → 校验 → 审稿 → 复盘 → 知识库"断了两处：创作原则的通过标准在校验与审稿两侧
   都不被使用（G-01），运行复盘 Skill 至今没有任何调用方（G-08）。结果是知识库里的原则
   只影响模型"自觉"，无法度量、无法证伪、无法迭代。
3. **验收规则在三处不一致**是本槽最核心的问题类别，共 6 项（G-01…G-06）。典型证据：
   `full_generate/references/全稿验收规则.md` 是一份从未被 `SKILL.md` 引用的孤儿文件，
   而它规定的规则有一部分被 `check-full.mjs` 强制、有一部分谁都不查。
4. **历史防御能力已从运行链路上消失**：`agent_runner.py` 中以 `run_managed_full_generation`
   为入口的旧编排族已完全不可达，它调用的 3 个 `.mjs` 入口在 `Agents/` 树中已不存在。
   跨集重复、正文密度、场景审读、Canon 读取留痕这四类检测因此不再运行，`check-full.mjs`
   也没有补上等价能力（G-16）。
5. **基线不是绿的**。`Agents` 测试 81 项中 5 项失败，`apps/api` 测试 454 项中 4 项失败
   （已修掉 8 项由一个未定义函数名导致的失败）。失败集中在两处：创作原则/公式链路需要
   一个仓库里并不存在的生产知识库（G-09），以及阶段状态与产物脱钩（G-17）。
   这意味着**当前谁改动原则与公式链路，都没有可用的回归网**。

---

## 2. 测绘方法与证据口径

- 输入只有 `main @ abb779e` 的源码与可在本地执行的测试。
- 所有结论都给出文件路径与行号；凡结论来自脚本统计（如"未被引用的 reference"），
  在正文中说明统计方式，以便他人复现。
- 已实际执行：`Agents` 全量测试、`apps/api` 全量测试、`Agents` 语法检查覆盖率统计、
  `SKILL.md` 链接与工具路径完整性统计。
- 未执行：端到端跑一次真实剧本生成（需要模型凭据与生产知识库，两者均不在本环境）。
  因此本文对"生成质量"不作判断，只判断**规则、契约与闭环是否自洽**。
- 记号：`G` 能力缺口。严重度：`高` 直接导致质量门禁失效或无法回归；
  `中` 造成理解分歧或维护成本；`低` 一致性与清理项。

---

## 3. 真实的 Agent 系统构成

### 3.1 创作主链路（`Agents/.claude/skills/`，14 个 Skill）

| Skill | 阶段名 | 用户可见产物 | 校验工具 |
| --- | --- | --- | --- |
| `project_init` | 原始剧本 | `output/原始剧本.md` | `validate-project.mjs` |
| `novel_analysis` | 小说解读 | `2.1-novel-analysis.json` | `check-novel-analysis.mjs` |
| `world_view` | 世界观 | `2.1-world-view.json` | `check-world-view.mjs` |
| `outline_rewrite` | 故事梗概 | `output/剧本大纲.md` 或 `<剧名>-故事梗概.md` | `check-outline.mjs` |
| `character_rewrite` | 人物小传 | `output/角色小传.md` | `check-character.mjs` |
| `trial_generate` | 剧本试稿 | `output/剧本试稿.md` | `check-trial.mjs` |
| `full_generate` | 完整剧本 | `output/剧本全稿.md` 或 `<剧名>-剧本全稿.md` | `check-full.mjs` |
| `dialogue_translate` | 台词翻译 | `output/台词译稿.md` | `check-dialogue-translate.mjs` |
| `foreign_review` | 审稿报告 | `output/审稿报告.md` | `check-foreign-review.mjs` |
| `humanizer-zh` | 剧本润色 | `output/去AI味剧本.md` | `check-humanizer-zh.mjs` |
| `document-sync` | —（用户手工保存后回写后台资料） | 无独立产物 | 无 |
| `agent-retrospective` | —（运行复盘提案） | `memory/evolution/proposal-*.md` | `check-retrospective.mjs` |
| `preference-summary` | —（归档后提炼创作偏好） | 数据库待确认偏好 | `validate-preference-summary.mjs` |
| `system-agent-evolution` | —（管理员系统进化） | `report.md`、`execution.md` | `validate-evolution-*.mjs` |

共享层只有 4 份 reference（`剧本内容编写方法.md`、`剧本格式规范.md`、`剧本设定解析原则.md`、
`台词编写原则.md`）和 2 个脚本（`screenplay-format-validation.mjs`、`stage-execution-spec.mjs`），
外加 `.claude/tools/` 下 18 个跨 Skill 工具（批准阶段、返修路由、记录用户要求、读取策略公式、
地区规则、剧本标签、字数契约、双语格式等）。

### 3.2 知识工厂（`Agents/skills/`，11 个后台 Skill）

`script-distillation`、`script-case-card`、`script-evidence-extraction`、`script-fact-consolidation`、
`script-formula-distillation`、`script-principle-distillation`、两个 `*-batch-distillation`、
两个 `*-curation`、`script-distillation-review`。这 11 个 Skill 全部有调用方，
由 `script_distillation_pipeline.py`、`script_library_service.py`、`script_library_batch_service.py`
通过 `direct_skill_runner.py`（无工具的纯模型调用）驱动，产出写入 `script_library_principles`
与 `script_library_formulas` 两张表（`apps/api/app/db/session.py:653`、`:681`）。

### 3.3 智能化的实际数据流

```text
剧本同步/上传 → 蒸馏（案例卡、证据、事实、公式、原则）→ 候选入库
        → 管理员在后台策展（curation）→ status = 'active'
        → 项目侧：init-* 生成「执行规范.md」（事实与要求）
        → get-execution-strategy 生成「执行策略.md」（按阶段取原则，按剧本标签取公式，最多 12 条）
        → 创作 Agent 按 SKILL.md 的 SOP 写正文，按需 get-strategy-formula 读单条公式
        → check-*.mjs 机器校验 → 通过则进入下一阶段
        → foreign_review 六维评分 + 十项准入 → 审稿报告
        → 归档后 preference-summary 提炼个人偏好
```

其中"执行策略"是整套智能化的枢纽：`stage-execution-spec.mjs:347-363` 按阶段筛出 `active` 原则，
`:380-400` 按剧本标签筛出至多 12 条公式并只在策略文件里列"使用场景 + 公式名称"，
正文由 `get-strategy-formula.mjs` 按名称单条读取。这个"目录 + 按需展开"的设计是正确的，
问题全部出在它的**下游没有人使用它产出的验收标准**。

### 3.4 运行编排（`apps/api/app/services/agent_runner.py`）

现行生产路径是 `run_new_contract_stage`（`:11585-12037`）：
`init` 工具 → 剧本标签解析 → 执行策略 → 构造运行信封提示词 → 模型创作 → `check` 工具校验；
校验失败时在同一个任务内做**恰好一次**定向修订（`:11910-11954`），仍失败则整个阶段回滚
（`restore_stage_delivery`，`:11958`）并把问题写入任务错误详情；下一次重试任务通过
`retry_quality_repair_context`（`:3518-3549`）读回上一轮问题，只做定向修复。
这条链路的设计是自洽的，且提示词刻意保持"只描述运行态、不复述阶段规则"
（`:3365-3369` 的注释明确说明这是为了防止规则在三处漂移）——本槽的所有方案都建立在保留这条约定之上。

---

## 4. 能力缺口台账

### 4.1 A 类：验收规则在三处不一致（本槽核心）

判定口径按 `AGENTS.md` 原则 6：同一条验收规则在 **Skill 完成时**（`SKILL.md` 的要求与 `check-*.mjs`）、
**内容质量校验时**（阶段 `quality_check` 与返修分流）、**最后的 AI 审稿时**（`foreign_review`）
必须一致。逐条核对结果如下。

#### G-01 创作原则的"通过标准"没有任何一处判定（高）

- 知识库里每条原则都必须带 `review_criteria`（通过标准），缺失即报错：
  `stage-execution-spec.mjs:338-345`；渲染进执行策略：`:424-435`。
- **完成时**：`check-full.mjs:165-176` 把这些通过标准原样回填到 `quality_check.principle_review_criteria`，
  只做回显，不做任何判定。
- **内容质量校验时**：`workspace_service.py:2108-2111` 只读 `quality_check.passed` 与 `warnings`，
  不读 `principle_review_criteria`。
- **AI 审稿时**：`foreign_review` 目录内检索 `review_criteria`、`执行策略`、`principle` 命中 0 处；
  17 份审稿 reference 与 `评分表.json5` 里没有任何原则的位置。
- 后果：知识库中的原则只作用于"模型愿不愿意自觉遵守"。原则是否生效、哪条原则无效、
  策展改动有没有正向作用，系统全都无法回答。这是整个智能化投入中最大的一处空转。

#### G-02 全稿验收规则是孤儿文件，三处口径不统一（高）

- `full_generate/references/全稿验收规则.md` 从未被 `full_generate/SKILL.md` 引用
  （统计方式：解析每个 `SKILL.md` 的 Markdown 链接、反引号文件名与 `node .claude/...` 命令路径，
  与 `references/`、`scripts/` 实际文件求差集）。
- 该文件共 6 条规则：其中"全剧连续覆盖 + 每集四要素""试稿范围内容一致""不得混入阶段文件标题
  与创作说明"三条被 `check-full.mjs:119-148` 强制执行；"每集字数下限"一条同时写在
  `SKILL.md:100` 与本文件，两处措辞不同（`SKILL.md` 写"初始化工具返回的下限"，
  本文件补了"空缺时按 90 秒计算"）；"中文人物栏使用大纲名称映射"与
  "格式检查不代替后续海外审稿"两条没有任何执行点。
- 同类孤儿还有 `full_generate/references/剧本内容与格式规范.md`——`SKILL.md` 引的是
  共享层的 `剧本格式规范.md`，这份同名近义的本地文件谁都不读。

#### G-03 对抗性审稿原则的适用范围自相矛盾（中）

- `全稿对抗性审稿原则.md:3` 写"本文件只用于完成一个剧情单元后的定向自我审稿"，
  第 13 行进一步限定"只修订当前阶段文件中的命中内容，不修改试稿章节或其他阶段文件"。
- 但 `full_generate/SKILL.md:86` 在"合并并检查"步骤要求"整体回读完整剧本"时读取它。
- 结果：模型在整稿回读时拿到的是一份声明只适用于单元、且禁止跨文件修订的规则，
  两种读法都能自圆其说，实际执行范围不可预期。

#### G-04 审稿准入把"集数 ≥ 30"当成跨项目固定阈值（高）

- `foreign_review/references/准入标准.md:7`、`SKILL.md:24` 与
  `check-review-admission.mjs:82-88`（`episodeCount >= 30` 硬编码）：
  正式集数 ≥ 30 通过、10–29 部分通过、< 10 不通过，并明确"用户填写的目标集数仅用于交付规划，
  不作为本项准入条件"。
- 后果：一个发行任务书写明 20 集的合规项目，无论质量如何，准入第一项必然只能拿"部分通过"。
  用户看到的是自己按要求做的项目被系统判为不达标，且报告不解释这是固定阈值。
- 同时这与"发行任务书前置、平台/时长/集数是变量"的既有设计方向冲突：
  任务书里明明有 `episode_count`，审稿却刻意不用。

#### G-05 声明存在的"预审"能力没有调用方（中）

- `foreign_review/SKILL.md:3`、`:11`、`:13` 三处声明它支持"`full_generate` 调用的不落盘预审"，
  并为该模式定义了完整约束（不创建文件、不更新进度、不得调用初始化/台账/检查/返修工具）。
- 但 `full_generate/SKILL.md` 全文没有预审步骤，工具清单里也没有对应工具；
  `apps/api/app` 全量检索"预审"命中 0 处。
- 这段规则占据审稿 Skill 开头最显眼的位置，却是死规则，直接增加模型的判断分支。

#### G-06 六份 reference 从未被任何 SKILL.md 引用（低）

`review-scorecard.json5`、`全稿验收规则.md`、`剧本内容与格式规范.md`、
`高光时刻剧本改编原则.md`、`小说剧情单元取舍原则.md`、`trial.json5`。
其中两份 `.json5` 是产物模板（按 `docs/Agent设计规范.md`，模板应有明确的"何时使用"说明），
另外三份是创作原则。它们既不会被读到，也不会被任何检查发现缺失或损坏。

### 4.2 B 类：智能化闭环缺口

#### G-07 原则与公式的使用不留痕，效果不可度量（高）

- `get-strategy-formula.mjs:56-83` 读取单条公式后只返回内容，不写任何记录；
  执行策略快照 `execution-strategy.json` 记录的是"本次可用哪些原则和公式"，
  不是"实际用了哪些"。
- 对比：小说解读链路有明确的原文读取留痕（`read-novel-source.mjs` 与阅读完成工具），
  说明"留痕"在本仓库不是新机制，只是没用在知识链路上。
- 后果：无法回答任何一个效果问题——某条公式被读过几次、读过它的项目审稿分数是否更高、
  某条原则上线后返修率是否下降。策展只能靠人拍板。

#### G-08 运行复盘 Skill 至今没有调用方，进化闭环缺最后一环（高）

- `agent-retrospective` 在 `apps/api/app` 全量检索命中 0 处（路由、服务、任务队列均无）。
  `current-skill-inventory-2026-07-19.md` 已记录过同一结论，一年后仍然如此。
- `system-agent-evolution` 只能由管理员在后台手工触发（`routers/admin.py:89`）。
- 结果：项目跑完之后，系统不会自动产生"这次哪里做得不好、对应哪条规则"的可评审提案。
  唯一自动跑的复盘类能力是 `preference-summary`，而它只提炼个人偏好，不改进 Skill。

#### G-09 创作原则/公式链路依赖一个仓库里不存在的知识库，无法回归（高）

- `stage-execution-spec.mjs:14` 默认读 `../data/workbench.sqlite3`；仓库中没有 `data/` 目录。
- `Agents/tests/world-view-execution-spec.test.mjs` 的 4 个用例直接断言真实原则文案
  （如"关键世界规则必须明确边界并保持一致"）与"能按名称读取公式"，
  在干净检出上必然失败——本槽实测确认：
  用例 77、78、80、81 全部失败，失败原因是"当前没有已启用的世界观创作原则"。
- 后果：**原则与公式链路是当前唯一没有回归网的关键链路**，而它恰恰是智能化的枢纽。

#### G-10 后台知识 Skill 全量注入 references，与按需读取的规范相反（中）

- `direct_skill_runner.py:40-49` 把 skill `references/` 下所有 `.md`/`.json`/`.json5`
  全部拼进 system prompt；`script-distillation/SKILL.md:36` 还要求调用方同时加载
  另外三个 Skill 的全文。
- `docs/Agent设计规范.md` 要求"渐进式阅读，而不是一次读完所有资料"。
  当前后台链路做的正好相反。
- 可缓解处：`load_direct_skill` 已支持 `exclude_references`（`:52-55`），
  说明按任务模式裁剪注入是现成能力，只是没有按 Skill 全面配置。

#### G-11 知识工厂的字段契约要求模型重复书写同一内容（中）

- `check-distillation.mjs:277-287` 与 `script-formula-distillation/SKILL.md:102` 要求
  `creative_decision` 与 `creative_problem` 必须与 `usage_scenario` **完全一致**、
  `expected_effect` 必须与 `goal` **完全一致**。这是让模型把同一句话写三遍，
  与 `docs/Agent设计规范.md`"让大模型只生成工具所需的变量参数"直接冲突：
  兼容字段应由工具复制，不该进入模型的输出契约。
- 同时两处阈值已漂移：`core_formula` 上限在 SKILL.md 写 600，在校验器写 800。
- 本槽实测：`Agents` 用例 34"单剧蒸馏工具初始化、连续读取并通过完整校验"失败，
  失败信息正是这批冗余字段缺失——即知识工厂的回归夹具与当前校验契约已经脱节。

### 4.3 C 类：Agent 入口与契约漂移

#### G-12 主 Agent 说明书与真实 Skill 清单不符（中）

`Agents/CLAUDE.md` 只列 9 个 Skill、只描述"剧本改写"与"小说改编"两类场景。
真实情况是 14 个 Skill、6 类任务场景（改写、小说改编、爆款复刻、剧本审核、台词翻译、剧本润色，
见 `workspace_service.py:175-200`）。缺失的 5 个 Skill 中，`humanizer-zh` 与 `document-sync`
都是用户可直接触发的能力。主 Agent 的说明书是模型选择 Skill 的第一依据，此处漂移直接影响路由正确性。

#### G-13 阶段输出文件名存在一处仍未更新的默认值（中）

- `stage-execution-spec.mjs:68` 中 `full_generate.output_file` 仍是 `output/完整剧本.md`。
- 真实交付名是 `output/剧本全稿.md` 或 `<剧名>-剧本全稿.md`
  （`script-artifacts.mjs:83-86`、`workspace_service.py:51`）。
- 当前不出错，只是因为 `init-full.mjs:79`、`:122` 每次都显式传入正确路径。
  任何新调用方忘记传参就会把执行规范指向一个不存在的文件。

#### G-14 质量契约版本已退化为常量，Skill 改动不再使历史批准失效（高）

- `memory_sync_service.py:159-162`：只要 `.claude/config/region-rules.json` 存在
  （当前就存在），`current_quality_contract_version()` 直接返回常量 `"agents-new-v1"`。
- 其后 `:76-123` 那 47 个文件指纹全部不参与计算，其中至少 10 个文件
  （`_shared/lib/*.mjs`、`full-draft-tool.mjs`、`validate-world-view.mjs`、
  `_shared/schemas/*.json`）在当前树中已不存在——一旦短路条件失效，
  该函数会直接抛"质量契约文件缺失"。
- 后果：修改 Skill 或校验器之后，此前批准过的阶段不会被要求按新契约重新校验。
  这正是 2026-07 审计列为"已关闭旁路"的那一条，现在实际上已重新打开。

#### G-15 受保护文件清单仍是旧文件名（低）

`memory_sync_service.py:63-73` 的 `APPROVAL_PROTECTED_FILES` 列的是
`01-user-input.json`、`01-project-progress.json`、`02-故事梗概.md`、`99-剧本稿.md` 等旧名，
现行契约是 `1.1-user-input.json`、`1.2-project-progress.json`、`output/剧本大纲.md`、
`output/剧本全稿.md`。清单里的多数条目在真实工作区里不存在，保护也就不生效。

#### G-16 旧编排族整体不可达，四类生产完整性检测已从运行链路消失（高）

- `workspace_service.py:232-235`：`is_new_workspace()` 无条件返回 `True`。
- 因此 `run_claude_stage`（`agent_runner.py:12040-12053`）与
  `run_chat_edit_job`（`:12543-12563`）在第一个判断处就转走新链路，
  两个函数后半段以及只被它们调用的旧编排族全部不可达，包括：
  `run_managed_trial_generation`（`:8802`）、`run_managed_full_generation`（`:8856`）、
  `validate_stage_with_self_repair`（`:10554`）、连续剧本生成
  （`:8411`）、大场景并发审读（`:7049`）、台词语义审读（`:6156`）、
  叙事审读（`:5994`）、候选自检（`:5676`）。量级在四千行以上，精确边界需按调用图核定。
- 决定性证据：这些代码调用的三个入口在 `Agents/` 树中已不存在——
  `full-draft-tool.mjs`（`:4162`）、`continuous-screenplay-tool.mjs`（`:4209`）、
  `_shared/lib/script-quality.mjs`（`memory_sync_service.py:80`）。即使被调用也只会立刻失败。
- **真正的影响不是死代码，而是能力缺失**：跨集重复与近重复扫描、正文密度坍缩检测、
  逐集 Canon 读取留痕、大场景语义审读这四类检测随之停止运行，
  而 `check-full.mjs` 只检查文档标题、集号连续、试稿一致、每集有场景标题/人物栏/动作行/
  至少一组中文台词、每集字数下限。**当前没有任何机器检测能发现"80 集正文互相高度重复"这类事故。**

#### G-17 阶段状态与产物脱钩（中）

`update-progress.mjs:78-99` 把 `output_files` 原样记入进度，从不校验这些文件是否存在，
因此进度可以把 `world_view` 标为 `completed` 而工作区里没有 `2.1-world-view.json`；
而 `init-trial.mjs` 经 `writeStageExecutionSpec` → `getAdaptationContext` 强依赖该文件存在，
于是报"世界观不存在或不是有效 JSON"——一句面向内部的解析错误。本槽实测：`apps/api` 中
`test_script_output_contracts` 的 4 个用例因此失败，覆盖的正是**试稿/全稿的字数下限与
可选目标语台词这两条验收规则**——即 A 类问题最需要回归的地方恰好跑不起来。

#### G-18 13 份 Agent 元数据是英文占位且无调用方（低）

`Agents/.claude/skills/*/agents/openai.yaml` 与 `Agents/skills/*/agents/openai.yaml`
共 13 份，内容形如 `short_description: "Help with Document Sync tasks"`，
全仓库没有任何读取方。

#### G-19 现有检查只覆盖语法，契约一致性没有任何自动防线（高）

- `Agents/package.json:62` 的 `check` 是一长串 `node --check`，只做语法解析；
  `precheck`（`:61`）没有被 `check` 串接，因此 `stage-execution-spec.mjs`
  与 `get-strategy-formula.mjs` 的语法检查在 `npm run check` 里根本不执行。
- 78 个 `.mjs` 中 73 个被语法检查覆盖，未覆盖的 5 个是
  `screenplay-format-validation.mjs`、`screenplay-length.mjs`、`script-artifacts.mjs`
  与两个 `preference-summary` 脚本——前三个恰好是格式与字数验收的实现。
- 本文 G-02、G-06、G-13 全部是脚本一次扫描就能发现的问题，
  说明缺的不是能力而是这道检查本身。

### 4.4 缺口汇总

| 编号 | 缺口 | 类别 | 严重度 |
| --- | --- | --- | --- |
| G-01 | 创作原则的通过标准三处均不判定 | 验收一致性 | 高 |
| G-02 | 全稿验收规则是孤儿文件，口径不统一 | 验收一致性 | 高 |
| G-03 | 对抗性审稿原则适用范围自相矛盾 | 验收一致性 | 中 |
| G-04 | 审稿准入用跨项目固定集数阈值 | 验收一致性 | 高 |
| G-05 | 声明的预审能力无调用方 | 验收一致性 | 中 |
| G-06 | 六份 reference 从未被引用 | 验收一致性 | 低 |
| G-07 | 原则与公式使用不留痕，效果不可度量 | 闭环 | 高 |
| G-08 | 运行复盘 Skill 无调用方 | 闭环 | 高 |
| G-09 | 知识库链路无法回归 | 闭环 | 高 |
| G-10 | 后台知识 Skill 全量注入 references | 闭环 | 中 |
| G-11 | 知识工厂字段契约强制重复书写且已漂移 | 闭环 | 中 |
| G-12 | 主 Agent 说明书与真实 Skill 清单不符 | 契约漂移 | 中 |
| G-13 | 全稿默认输出文件名未更新 | 契约漂移 | 中 |
| G-14 | 质量契约版本退化为常量 | 契约漂移 | 高 |
| G-15 | 受保护文件清单是旧文件名 | 契约漂移 | 低 |
| G-16 | 旧编排族不可达，四类生产完整性检测消失 | 契约漂移 | 高 |
| G-17 | 阶段状态与产物脱钩 | 契约漂移 | 中 |
| G-18 | 13 份 Agent 元数据为英文占位且无调用方 | 契约漂移 | 低 |
| G-19 | 只有语法检查，无契约一致性防线 | 契约漂移 | 高 |

---

## 5. 基线可验证性实测

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| Agent 测试 | `cd Agents && npm test` | 81 项，76 通过，**5 失败** |
| API 测试 | `cd apps/api && python3 -m unittest discover -s tests -p 'test_*.py'` | 454 项，**4 失败**（修复前为 4 失败 + 9 错误） |
| Agent 语法检查 | `cd Agents && npm run check` | 通过（覆盖 73/78 个 `.mjs`） |

失败明细与归因：

| 失败用例 | 归因 | 对应缺口 |
| --- | --- | --- |
| 世界观初始化只生成事实规范… | 依赖生产知识库中的真实原则文案 | G-09 |
| 标签确定前执行策略不获取任何知识… | 依赖生产知识库中的公式 | G-09 |
| 公式是否可用由当前场景策略决定… | 依赖生产知识库中的公式 | G-09 |
| 旧执行策略快照含成立原因时要求重新生成 | 依赖生产知识库（快照里没有原则可改） | G-09 |
| 单剧蒸馏工具初始化、连续读取并通过完整校验 | 夹具缺少校验器强制的冗余兼容字段 | G-11 |
| `test_script_output_contracts` 4 项 | 进度标 `completed` 但缺 `2.1-world-view.json` | G-17 |

另有一项环境事实：`Agents/` 与 `apps/api/` 的依赖都不在预置镜像里。
`Agents` 缺 `jszip` / `mammoth` / `pdf-parse` 时另有 3 项失败，安装后消失；
`apps/api/requirements.txt` 缺 `httpx`，导致 `test_openclaw_api` 整个模块无法加载。

---

## 6. 本槽已落地的修复

只动两个文件，都是高置信、可被测试证明的修复：

1. **`apps/api/app/services/script_sync_service.py:2113`**：
   剧本同步成功后的返回值调用了未定义的 `utc_now_iso()`（同文件定义的是 `_utc_now_iso()`）。
   这是后台"剧本同步"成功路径上的必然崩溃，管理员每次同步成功都会拿到失败结果。
   修复后 `test_script_sync_service` 的 45 项全部通过（修复前 8 项 `NameError`）。
2. **`apps/api/requirements.txt`**：补 `httpx==0.28.1`。
   `fastapi.testclient` 依赖它，缺失会让 `test_openclaw_api` 整个模块无法导入。
   补齐后 API 测试从 450 项可执行变为 454 项。

验证：`cd apps/api && python3 -m unittest discover -s tests -p 'test_*.py'` → 454 项，4 失败，
剩余 4 项失败即 G-17，属于需要方案的契约问题，不在本次修复范围。

---

## 7. 未做与边界

- 未跑真实剧本生成：缺模型凭据与生产知识库（`data/workbench.sqlite3`），
  因此本文不评价生成质量，只评价规则与契约自洽性。
- 未改任何 `SKILL.md`、reference 或校验工具：A 类问题都涉及"哪一处才是唯一来源"的裁决，
  必须先有方案再动手，否则只是把不一致挪个位置。
- 未清理死代码：G-16 的精确边界需按调用图核定，误删会影响仍在使用的
  `run_full_worker` 等函数，属于需要独立工作项的改造。
- 未测绘后台"剧本蒸馏""Agent 进化"两个管理页的界面细节，只到能力与接线层级。
- 与交互可靠性槽的边界：本文不讨论租约、恢复、事件游标、额度幂等、草稿保护、
  会话失效等服务端与前端可靠性问题，那些已由 `交互可靠性-*.md` 立项，不重复。
