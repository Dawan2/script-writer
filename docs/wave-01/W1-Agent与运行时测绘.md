# W1 Agent、Skill 与运行时测绘

| 项 | 值 |
| --- | --- |
| 里程碑 / 槽位 | 周期 1 / 第 1 波 / W1 · 工作-Agent/Skill/运行时测绘 |
| 仓库 | github.com/Dawan2/script-writer |
| 测绘基线 | `main @ abb779e`（Next.js 前端 + FastAPI 后端 + `Agents/` 子项目） |
| 工作分支 | `cursor/w1-agent-skill-runtime-mapping-058e` |
| 产出性质 | 现状测绘 + 智能化短板证据台账；仅落地 3 处高置信小修复 |
| 交接前提 | 承接 `docs/wave-01/W1-前端交互测绘.md`（分支 `cursor/w1-product-frontend-mapping-058e`）。前端已列出的 T-01/T-02/T-03 本文不重做，只在第 6 节补充 Agent 侧证据 |

---

## 0. 基线更正（本槽新增的第二处基线事实）

前端测绘已更正过一次基线：产品是 Web 应用「虎鲸｜剧本出海工作站」，不是 CLI。
本槽发现 Agent 侧还存在**第二处同类失效**——`docs/` 下两份既有审计文档描述的
Agent 架构在当前代码中已不存在：

| 文档 | 描述的架构 | 当前 `main` 实际情况 |
| --- | --- | --- |
| `docs/current-skill-inventory-2026-07-19.md` | 9 个 Skill；`_shared/contracts/stage-contracts.json` 定义「七个受管 Skill」；`_shared/lib/stage-runner.mjs` 等 49 个共享脚本 | 25 个 Skill；`_shared/` 只剩 4 份 reference + 2 个脚本，**没有 `contracts/`、没有 `lib/`、没有 `stage-runner.mjs`** |
| 同上「核验结果」 | `check-agent-contracts.mjs` 通过 9 项、`check-agent-project.mjs` 通过 202 项 | 两个脚本都已不存在，`npm run check` 现在只做 `node --check` 语法检查 |
| `docs/agent-system-audit-2026-07-12.md` | 引用 `vertical_drama_quality_gates.md`、`character-context.mjs`、`full-draft-tool.mjs`、`海外审稿规则.md`、`审稿评分与输出协议.md` 等 | 上述文件均已不存在；审稿改为 `references/` 下 17 份拆分文档 + `calculate-review-score.mjs` |

两份文档都没有失效标注。它们与已被前端测绘否定的 8 份规划文档属于同一类风险：
**文档描述的系统与运行的系统不是同一个**。后续任何基于这两份文档的结论都需要先复核。

本文只描述 `main @ abb779e` 上真实存在的 Agent 结构与行为。

---

## 1. 结论速览

1. **工程质量本身较高**：Agent 调起、写入边界、失败分类与自动恢复是全仓最成熟的部分。
   62 个命令行工具入口中 61 个统一返回 `ok` / `message` / `next_action` 的确定性 JSON，
   写入越界由快照-回滚强制拦截，失败按 16 组正则分流到不同重试策略。
2. **最严重的问题是创作知识层静默失效**（A-01）：「创作原则」与「策略公式」全部存放在
   `data/workbench.sqlite3`。该文件不存在时，加载函数返回空、快照仍标记
   `knowledge_status: "loaded"`、验收门禁判定通过。Agent 会在**零创作原则**下
   完成全部创作阶段，且用户与运维都看不到任何提示。
3. **第二严重的问题是进度可见性断层**（A-02）：后端发出 43 类执行事件，
   其中 **33 类前端从未引用**，被静默丢弃。剩余 7 类流程事件还要再通过一次
   关键词正则匹配才会显示。用户在长任务里看不到「正在写第几个剧情单元」这类阶段信息。
4. **验收规则一致性存在 3 处实证偏差**：全稿 Skill 误引用试稿阶段的验收工具（已修）、
   审稿准入的单集字数下限（240 字固定）与生成门禁（按时长推导，90 秒 600 字）不同源、
   两份 reference 文档从未被任何 Skill 或脚本读取。
5. **CI 不存在**：仓库没有 `.github/workflows`。`npm test` 在干净克隆下无法通过——
   本槽修复前 7 项失败（3 项因依赖未装、4 项因知识库缺失），修复后仍有 4 项
   受 A-01 的同一根因阻塞。

---

## 2. 测绘方法与边界

- 输入为 `main @ abb779e` 源码，不引用第 0 节所列的失效文档结论。
- 已实际执行：`npm install`（`Agents/`）、`npm test`、`npm run check`、`npm run precheck`，
  以及若干针对 Skill 结构的一致性脚本审计（工具声明、reference 引用、返回值约定）。
- **未启动前后端服务，未运行真实 Agent 任务**，因此没有运行时截图、录屏或真实 Job 日志。
  A-01、A-02 均为代码可判定；标注「需运行时复核」的条目已单独说明。
- 未安装 Python 依赖，`test:api` 未执行。
- 记号：`A` 智能化短板/问题项、`TA` 可交接任务。与前端测绘的 `U` / `T` 不冲突。

---

## 3. Agent 运行时

### 3.1 调起方式

后端 `apps/api/app/services/agent_runner.py`（13024 行）以子进程方式调起随仓库固定版本的
Claude Code CLI（`@anthropic-ai/claude-code` 2.1.204），工作目录为 `Agents/`。

能力边界用 `--tools` 而不是 `--allowedTools` 表达，代码注释说明了原因：
2.1.x 起 `--allowedTools` 在 bypass 模式下只是权限策略、不再是能力边界
（`agent_runner.py:193-211`）。按角色分了 5 套能力档：

| 能力档 | 工具集 | 用途 |
| --- | --- | --- |
| `CONTENT_WRITER_TOOLS` | `Skill,Read,Edit,Write,Bash` | 9 个创作阶段 |
| `FULL_CANDIDATE_CHECK_TOOLS` | 同上，另配 `--allowedTools` 白名单锁定到单条 `check-current-full.mjs` 命令 | 全稿候选自检 |
| `REPAIR_WRITER_TOOLS` | `Read,Edit,Write` | 定向修订 |
| `CONTENT_REPAIR_TOOLS` | `Read,Edit` | 只改不新建 |
| `STRUCTURED_WORKER_TOOLS` | `Read` | 结构化子进程 |

权限模式为 `bypassPermissions`（候选自检时为 `dontAsk`），
`ORCA_CLAUDE_DANGEROUS_SKIP_PERMISSIONS` 默认 `1`（`agent_runner.py:4456-4458`）。

### 3.2 写入边界：不靠权限，靠快照与回滚

因为权限已放开，真正的边界是执行前后的文件指纹比对：
`PROTECTED_WORKSPACE_FILES` 列出 24 个受保护路径（`agent_runner.py:262-287`），
`assert_authoring_write_scope()` / `assert_allowed_write_scope()` 在阶段结束时比对快照，
越界即 `restore_authoring_workspace()` 整体回滚并记录 `delivery_rejected`。
这个设计比依赖 CLI 权限更可靠，是本运行时最值得保留的约定。

### 3.3 失败分类与自动恢复

`classify_agent_failure()` 用 16 组正则把失败分流（模型冷却、网络抖动、容量、上下文超限、
质量门禁、输入契约、执行契约、计费、命令过长等），再由
`automatic_recovery_policy()` 给出有界重试：模型冷却 `(3,10,30)` 秒、
网络抖动 `(1,5,20)`、容量 `(5,15,45)`。自动质量修订上限为 1 次
（`MAX_AUTOMATIC_QUALITY_REPAIR_ATTEMPTS`），台词审读上限 1 次，
单范围硬门禁修复上限 2 次。并发上限：全稿场景审读 3、小说阅读 3。

执行归属由数据库租约保证（`claim_agent_execution` / `renew_agent_execution_lease` +
心跳监控），避免重启后同一 Job 被重复执行。

---

## 4. Skill 与工具清单

### 4.1 规模

| 项 | 数量 |
| --- | --- |
| `SKILL.md` 总数 | 25（`.claude/skills/` 13 个 + `skills/` 11 个 + `_shared` 无 SKILL） |
| AI 可调用工具入口（`Tool name:`） | 82 |
| `.mjs` 脚本 | 78 |
| `references/` 文档 | 57 |
| `agents/openai.yaml`（非 Claude 运行档） | 13 |
| `tests/*.test.mjs` | 19 |

两组 Skill 职责不同：`.claude/skills/` 是**项目创作链路**（用户可见交付物），
`skills/script-*` 是**知识蒸馏链路**（后台把已入库剧本蒸馏成案例卡、公式候选、原则观察，
产物进 `data/workbench.sqlite3`，即 A-01 里被消费的那个知识库）。
蒸馏链路 11 个 Skill 全部 0 个 `Tool name:`——它们由 `script_distillation_pipeline.py`
以「调用方提供 Schema」的方式编排，Skill 只写判断规则，不暴露工具。这与
`Agent设计规范`「工具清单」一节不完全对齐，但属于有意的编排差异，不是缺陷。

### 4.2 结构合规性（对照 `docs/Agent设计规范.md`）

| 规范要求 | 现状 | 判定 |
| --- | --- | --- |
| SKILL.md 含可执行 SOP | 25 份全部有「工作流程」或等价的分步流程 | 符合 |
| 渐进式阅读，不一次读完资料 | 各阶段 SKILL.md 按步骤点名 reference；`full_generate` 明确「不得一次性读取全部公式」，公式表只列使用场景与名称，按名取用 | 符合，设计质量高 |
| 工具返回确定性内容 + 下一步话术 | 62 个 CLI 入口中 61 个返回 `{ok, message, next_action}`；`check-full.mjs` 还按问题类型分派 3 种不同 `next_action` | 符合 |
| 唯一例外 | `check-novel-length.mjs` 无 `next_action`。核实后确认它**不是 AI 可调用工具**：不在任何 SKILL.md 工具清单中，只由 `novel_analysis_admission.py` 在建任务前调用。约定不适用 | 非缺陷 |
| 结构化写入先由工具生成空框架 | `init-*.mjs` 用 `references/*.json5` 模板生成骨架（如 `trial.json5`、`review-scorecard.json5`），模型只填内容 | 符合 |
| reference 一文件对应一动作、边界明晰 | 55/57 符合；2 份从未被引用，见 A-04 | 基本符合 |

### 4.3 入口文档与实际链路不一致（已修）

`Agents/CLAUDE.md` 的「SKILL说明」只列 9 个 Skill，缺少两个后台确实会调起的：

- `humanizer-zh`：**「剧本润色」任务类型的唯一生成阶段**，产出用户交付文件
  `output/去AI味剧本.md`（`workspace_service.py:54`、`:139`、`:198`、`:2084`；
  `agent_runner.py:253` 的 `STAGE_SKILL_PROMPTS` 确实发出 `Use \`humanizer-zh\` skill`）。
  剧本润色是 6 类用户任务之一，却不在 Agent 的入口清单里。
- `document-sync`：用户手工保存文档后由后台调起（`agent_runner.py:192`）。

同时「执行要求」写的是 ``skills/{{skill名称}}/scripts/`` 目录下脚本「只允许调用，不允许读取」，
而 9 个生产 Skill 实际在 `.claude/skills/` 下，该路径字面上不覆盖它们。
因为能力档已放开 `Read`，这条规则只靠提示词生效，路径不准会直接让规则对生产 Skill 失效。

两处已修，见第 7 节。

---

## 5. 上下文供给与知识层

### 5.1 分层

每个创作阶段有两份运行期上下文文件，由 `_shared/scripts/stage-execution-spec.mjs`（728 行）统一生成：

| 文件 | 内容 | 生成时机 |
| --- | --- | --- |
| `执行规范.md` | 本次任务的**确定事实**：用户需求、阶段偏好、地区规则、改编上下文、输出契约 | `init-*` 时 |
| `执行策略.md` | 本次任务应遵循的**创作原则**，以及可按需取用的**策略公式表**（只列使用场景 + 公式名称） | 单独的执行策略工具 |

两份文件都存 `sha256` 快照。任一被人工改动、或项目信息/偏好/标签在生成后变化，
`stageExecutionSpecIssues()` / `stageExecutionStrategyIssues()` 会要求重新初始化
（`stage-execution-spec.mjs:657-697`）。这套「事实与策略分离 + 指纹校验」是好设计。

「创作原则」与「策略公式」不写在 reference 里，而是从知识库按当前剧本标签
（主题/设定/背景/受众）动态检索，公式最多取 12 条。这正是知识蒸馏链路的下游消费点。

### 5.2 A-01 创作知识层缺失时静默放行（严重）

**证据链**：

1. 知识库默认路径 `Agents/../data/workbench.sqlite3`（`stage-execution-spec.mjs:14`）。
   该路径命中根 `.gitignore` 的 `/data/` 与 `*.sqlite3`，不在仓库内。
2. `resolveKnowledgeDbPath()`（`:302-308`）：显式传入且文件不存在时**抛错**；
   走**默认路径**且文件不存在时**返回空字符串**。
3. `queryRows()`（`:310-318`）：`dbPath` 为空直接 `return []`。
   于是 `loadPrinciples()` 与 `loadFormulas()` 都返回空数组，不报错。
4. 快照写入 `knowledge_status: unresolvedFields.length ? "skipped_unresolved_profile" : "loaded"`
   （`:616`）——该状态**只取决于剧本标签是否齐备，与是否真的取到知识无关**。
   标签齐备而知识库缺失时，状态是 `"loaded"`，`principles: []`、`formulas: []`。
5. 验收门禁只校验状态字面值：`if (snapshot.knowledge_status !== "loaded")`（`:688`）。
   状态是 `"loaded"`，于是**判定通过**。

**后果**：知识库缺失、损坏或表为空时，Agent 会在零创作原则、零策略公式的条件下
完成世界观、大纲、人物、试稿、全稿全部阶段。`执行策略.md` 里写的是
「当前没有已启用的世界观创作原则；仍须执行 Skill 中的固定质量、格式与准出要求」，
Skill 又规定「当执行策略缺失时忽略」——整条链路把「知识库没接上」当作正常状态放行。
用户看不到任何提示，运维也没有告警；生成质量退化到只由 Skill 固定规则兜底。

**这也是 4 项测试失败的同一根因**。`tests/world-view-execution-spec.test.mjs` 中
断言「不加载知识」的用例全部通过，断言「加载到原则/公式」的 4 个用例全部失败：

```
not ok 77 - 世界观初始化只生成事实规范，执行策略单独加载原则且改写场景不加载公式
not ok 78 - 标签确定前执行策略不获取任何知识，重新初始化后可按名称读取公式
not ok 80 - 公式是否可用由当前场景策略决定，而不是由改写类型写死
not ok 81 - 旧执行策略快照含成立原因时要求重新生成
```

失败信息是 `The input did not match /关键世界规则必须明确边界并保持一致/`，
实际得到「当前没有已启用的世界观创作原则」。测试套件因此**无法在干净克隆下通过**，
也没有任何 seed 或 fixture 提供最小知识库。

**修复方向**（属 TA-01，本槽未改）：`knowledge_status` 应反映真实加载结果
（区分 `loaded` / `unavailable` / `empty`），知识库不可用时按策略选择阻断或显式告警，
并为测试提供最小知识库 fixture。这需要同时改动 Skill 文案、门禁与测试，超出小修复边界。

### 5.3 上下文超限与压缩

`agent_runner.py` 有完整的上下文压缩链路：检测到上下文超限时发
`session_compact` → 执行压缩 → `session_compacted`，压缩不可用时发
`context_compact_unavailable`「当前会话无法整理，正在从已保存内容继续处理。」
（`:4528`、`:4592`、`:4653`）。三个事件**前端都不渲染**，见 A-02。

---

## 6. 进度可见性

### 6.1 A-02 后端 43 类事件中 33 类被前端丢弃（严重）

后端通过 `add_event()` 写入 `agent_events`，`public_event()` 把
`event_type` / `message` / `raw_json` 原样通过 SSE 送到浏览器
（`agent_runner.py:1524-1534`）——**信息已经到达前端，是前端主动丢的**。

前端 `agent-panel.tsx` 的 `activityCandidate()`（`:309-346`）按固定分支识别事件，
`buildActivityItems()` 对无法识别的返回值直接 `continue` 丢弃（`:370-372`），
最后只保留最近 6 条（`:387`）。逐个核对 43 个后端事件类型在 `apps/web/src/` 中的引用，
**33 类完全没有出现过**：

| 分类 | 未被引用的事件类型 |
| --- | --- |
| 全稿生成 | `full_generation_start` `full_generation_ready` `full_generation_resume` `full_revision_start` `full_repair_resume` `full_scene_review_resume` |
| 剧情单元续写 | `continuation_write` `continuation_localize` `continuation_repair` `continuation_reconcile` `continuation_source_done` |
| 试稿续写 | `trial_continuation_start` `trial_continuation_ready` |
| 知识与标签 | `knowledge_strategy_start` `knowledge_strategy_ready` `script_profile_start` `script_profile_ready` |
| 审读 | `narrative_review` `narrative_review_done` `dialogue_review_done` |
| 会话与上下文 | `session_compact` `session_compacted` `context_compact_unavailable` |
| 文档同步 | `document_sync_start` `document_sync_done` `document_sync_rejected` |
| 其他 | `delivery_rejected` `model_fallback` `memory_sync_start` `preference_recorded` `repair` `service_recovery` `evolution_review` |

剩余 7 类流程事件（`info` `stage_start` `stage_done` `chat_start` `chat_done` `done` `warning`）
即使命中分支，还要再过一道**消息文本关键词正则**才显示（`:326`）：

```
/任务|计划|开始|完成|取消|ZDebug|阶段|对话式|正在处理|已同步|尚未达到交付/
```

不含这些词的后端消息同样被丢弃。状态行 `stepTitleFromEvent()`（`:543-591`）是同一套逻辑，
对上述 33 类返回 `null`，`latestStepTitle()` 于是回退到更早的通用标题。

**用户后果**：全稿阶段是耗时最长的阶段，后端会依次报告
「开始生成」→「写第 N 个剧情单元」→「本地化」→「定向修复」→「对账」→「场景审读」，
用户界面上一条都看不到，只能看到从原始流事件推断出的
「正在读取项目内容」「正在更新项目文件」这类通用话术在反复轮换。
会话压缩（可达数分钟）期间同样没有任何说明。这与前端测绘的 U-03（SSE 断线兜底）
是**两个独立问题**：U-03 是连接断了收不到，A-02 是收到了不显示。

**修复成本低**：事件已在客户端，只需补事件类型到用户话术的映射，不需要改后端。

### 6.2 管理员可观测性

`tools/zdebug` 提供零依赖的会话日志查看器，工作台 Agent 面板有调试入口
（需 `admin:jobs` 权限）。定位链路清晰：ZDebug URL 的 `logid=job-<任务号>`
对应 `agent_jobs.id`，权威日志路径是 `agent_jobs.raw_log_path`
（默认 `data/zdebug/jobs/agent_job_<任务号>.jsonl`）。`add_event()` 还会把
准备阶段事件补写进该 JSONL（`agent_runner.py:2324-2352`），写失败时静默忽略，
不阻塞任务——取舍正确。管理员侧观测能力明显强于普通用户侧。

---

## 7. 验收规则一致性

按 `AGENTS.md` 原则 6，同一条验收规则应在「Skill 完成时」「内容质量校验时」
「AI 审稿时」三处一致。逐条核对结果：

### A-03 全稿 Skill 误引用试稿阶段的验收工具（严重，已修）

`full_generate/SKILL.md` 有两处沿用了 `trial_generate` 的工具名：

| 位置 | 原文 | 问题 |
| --- | --- | --- |
| `:30` 开始前准备 | 执行规范缺失或失效时调用「**初始化剧本试稿**」 | 应为「初始化剧本全稿」 |
| `:92` 检查结果 | 调用「**检查剧本试稿**」工具 | 应为「检查剧本全稿」 |

两个名称都**不在本 Skill 的工具清单**中（清单只有初始化剧本全稿、合并剧本全稿、
检查剧本全稿等 8 项），且 `CLAUDE.md` 规定脚本只允许调用、不允许读取，
模型无法通过读源码自行纠正。等于**最贵的全稿阶段在「完成时」被指向了错误的验收工具**。

用脚本对全部 25 份 SKILL.md 做了「正文引用的工具名 ∉ 本 Skill 工具清单」审计，
全仓仅此一处，已修复。

### A-04 两份 reference 从未被读取（中）

审计 25 个 Skill 的 reference 引用关系（SKILL.md 与 reference 互引 + 脚本动态注入）后，
确认 2 份 `.md` 无任何引用方：

| 文件 | 情况 |
| --- | --- |
| `full_generate/references/全稿验收规则.md` | 10 行，内容与 `check-full.mjs` 实际校验项一致（连续覆盖、单集字数下限、试稿一致性、禁止阶段文件标题混入）。SKILL.md 的「内容额外要求」重复了大部分，但**验收口径本身没有进入模型上下文** |
| `full_generate/references/剧本内容与格式规范.md` | 13 行，标题也叫「# 剧本格式规范」，经 diff 确认是 `_shared/references/剧本格式规范.md`（72 行）的**严格子集**。SKILL.md 实际读的是 `_shared` 那份，缺少「拍的写法」「画外音系统」「检清单」「反模式」四节 |

对照：`novel_analysis/references/高光时刻剧本改编原则.md` 看似孤立，实际由
`trial_generate/scripts/get-episode-info.mjs:67` 在工具返回值里注入读取指令——
这是跨 Skill 按需供给知识的正确做法，不是孤立文件。

前者建议在 SKILL.md 收口步骤显式引用，后者建议删除以消除同名歧义。均属 TA-03。

### A-05 单集字数下限在生成与审稿两处不同源（中）

| 环节 | 下限 | 来源 |
| --- | --- | --- |
| 生成（试稿 / 全稿） | 按单集时长推导：90 秒 600 字，120 秒 800 字 | `.claude/tools/screenplay-length.mjs:1-3`、`:28-30`；`check-trial.mjs:95`、`check-full.mjs:147` |
| AI 审稿准入「内容密度」 | **固定 240 字**，且要求非空行 ≥ 3 | `foreign_review/scripts/check-review-admission.mjs:25-26`、`:109-113` |

审稿准入完全不读项目自己的 `episode_duration`。后果分两种场景：

- 改写/改编/复刻：全稿检查先跑，600 字门禁已经拦过一遍，审稿的 240 字判定形同虚设，
  「内容密度」这一维在评分卡里几乎恒为「通过」，无法反映真实承载量。
- **独立「剧本审核」任务**（用户直接上传剧本、不经生成）：240 字是**唯一**的密度门禁。
  同一平台对自己生成的剧本要求 600 字，对送审剧本只要求 240 字，标准不一致。

建议让审稿准入复用 `screenplayLengthContract()`，属 TA-02。

### 7.1 已落地的三处修复

均为高置信、小范围、直接影响验收一致性的改动：

| 提交 | 内容 |
| --- | --- |
| `01b9fb7` | A-03：`full_generate/SKILL.md` 两处工具名改回本阶段的「初始化剧本全稿」「检查剧本全稿」 |
| `16cc256` | `tests/script-distillation.test.mjs` 夹具补齐 `usage_scenario`、`not_applicable`、`core_formula`，并按校验要求让 `creative_decision`/`creative_problem` 与 `usage_scenario` 同源、`expected_effect` 与 `goal` 同源 |
| `350124c` | 第 4.3 节：`CLAUDE.md` 补 `humanizer-zh`、`document-sync`，并把脚本路径改为覆盖 `.claude/skills/` 与 `skills/` |

关于 `16cc256`：`check-distillation.mjs:274-287` 早已按 `script-distillation/SKILL.md:28`
的归档边界（使用场景、不适用情况、核心公式……）收紧了字段契约，但测试夹具仍是旧字段集
（`creative_decision`/`creative_problem`/`expected_effect` 三者互不相同、且无新增字段），
导致校验必然失败——**这条用例长期不能真正验证契约**。修复后它开始验证现行契约，
属于提高而非降低标准。没有删除或跳过任何测试。

---

## 8. 验证结果

在 `Agents/` 执行（环境原本未安装依赖，本槽先按 `package.json` 装齐 4 个直接依赖，共 28 个包）：

| 检查 | 修复前 | 修复后 |
| --- | --- | --- |
| `npm test` | 81 项中 **5 失败**（未装依赖时表现为 49 项中 7 失败） | 81 项中 **4 失败**，全部为 A-01 同一根因 |
| `npm run check` | 通过（仅 `node --check` 语法检查，73 个脚本） | 通过 |
| `npm run precheck` | 通过 | 通过 |

未删除、未跳过、未放宽任何测试或检查。

**边界与遗留**：

- 剩余 4 项失败需要最小知识库 fixture，属 TA-01，不在小修复范围。
- 仓库**没有 `.github/workflows`**，上述命令目前只能人工执行。
- `npm run check` 只是语法检查：既有文档提到的 `check-agent-contracts.mjs`（契约一致性）
  与 `check-agent-project.mjs`（202 项项目检查）在当前代码中已不存在，
  Agent 侧目前**没有结构/契约层面的自动校验**。本文第 4.2、A-03、A-04 的三项审计
  都是临时脚本完成的，未固化。
- 根目录有一个被 git 跟踪的 0 字节文件 `.schema agent_events`（来自 `abb779e` 之前的
  `sqlite3 ".schema agent_events"` 误提交）。未删除，列入 TA-05 由维护者确认。

---

## 9. 可交接的实现任务

编号 `TA-` 以避免与前端测绘的 `T-` 冲突。前端已列的 T-01/T-02/T-03 不在此重复。

| ID | 任务 | 依据 | 影响面 | 验收 |
| --- | --- | --- | --- | --- |
| TA-01 | 创作知识层不可用时不再静默放行：`knowledge_status` 区分 `loaded` / `unavailable` / `empty`；不可用时按策略阻断或显式告警；补最小知识库 fixture 让测试可在干净克隆下通过 | A-01 | `_shared/scripts/stage-execution-spec.mjs`、各阶段 SKILL.md 对「执行策略缺失时忽略」的表述、`tests/world-view-execution-spec.test.mjs` | 知识库缺失时阶段不再判定通过；`npm test` 81/81；用户能看到「创作知识库未就绪」类提示 |
| TA-02 | 审稿准入的单集密度改用 `screenplayLengthContract()`，与生成门禁同源 | A-05 | `foreign_review/scripts/check-review-admission.mjs` | 同一项目的生成门禁与审稿准入下限一致；独立剧本审核也按时长推导 |
| TA-03 | 收口 `full_generate` 的 reference：`全稿验收规则.md` 在 SKILL.md 收口步骤显式引用；删除 `剧本内容与格式规范.md` 这份同名严格子集 | A-04 | `full_generate/SKILL.md`、`full_generate/references/` | 无孤立 reference；格式规范只有 `_shared` 一个来源 |
| TA-04 | Agent 面板补事件类型到用户话术的映射，覆盖第 6.1 节 33 类事件；去掉流程事件的关键词正则过滤，改为按类型判定 | A-02 | `components/workspace/agent-panel.tsx`（`activityCandidate`、`stepTitleFromEvent`） | 全稿阶段能看到剧情单元推进、审读与会话整理阶段；不再因文案不含关键词而丢事件 |
| TA-05 | 恢复 Agent 侧结构校验并接入 CI：把第 4.2、A-03、A-04 的三项审计（工具声明一致性、reference 引用完整性、返回值约定）固化成脚本，与 `npm test` / `npm run check` 一起在 `.github/workflows` 执行；顺带确认并清理根目录 `.schema agent_events` | 第 8 节 | 新增校验脚本、`Agents/package.json`、新增 CI 配置 | A-03/A-04 这类偏差能被自动发现；PR 上可见检查结果 |

优先级建议：TA-01 最高（直接决定生成质量是否有创作知识支撑，且阻塞 4 项测试）；
TA-04 次之（成本最低、用户感知最直接）；TA-02、TA-03 属规则收口；
TA-05 是防止本文这类偏差重新出现的机制保障。

---

## 10. 未做与边界

- 未运行真实 Agent 任务：无 Job 日志、无 ZDebug 实测、无 token/耗时/成本数据。
  A-01 与 A-02 均为代码可判定，但**「知识库缺失下的实际生成质量退化程度」没有实测证据**。
- 未测绘知识蒸馏链路（`skills/script-*` 11 个 Skill）的内部判断质量，只到编排与接口层。
- 未评估 `agent_runner.py` 13024 行的可维护性风险，也未测绘 `ai_skill_runner.py`、
  `direct_skill_runner.py` 与 `agent_runner.py` 三条执行路径的职责边界与重叠。
- 未测绘 `agent-retrospective`、`preference-summary`、`system-agent-evolution`
  三个后台 Skill 的实际接入状态（既有文档称 `agent-retrospective` 未接入生产编排，
  但该文档整体已失效，需重新核实）。
- 未安装 Python 依赖，`test:api` 未执行；本槽改动不涉及后端与前端代码。
- 未对第 0 节两份失效文档做处置裁决：本文只给出失效事实，是否加失效标注或重写由规划槽决定。
