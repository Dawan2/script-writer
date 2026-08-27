# Claude Agent 性能与质量优化方案

> 分析日期：2026-07-14
>
> 数据范围：34 个 Claude Code Job（Job #19-58），覆盖 2026-07-09 至 2026-07-13 的 `outline_rewrite`、`character_rewrite`、`trial_generate`、`full_generate`、`foreign_review`
>
> 原始数据：`data/zdebug/jobs/*.jsonl`、`data/workbench.sqlite3`
>
> 分析产物：`tmp/analyze-claude-agent-logs.mjs`、`tmp/claude-agent-log-analysis.json`
>
> 本文性质：基于执行证据的改造方案，不直接修改现有 Agent、Skill、业务代码或 `AGENTS.md`

## 一、执行结论

当前体系的主要问题不是单一的“Claude 太慢”，而是三类成本叠加：

1. **长篇内容仍由单个模型会话串行生成。** `full_generate` 占全部 Job 时长的 45.4%，3 个失败 Job 也全部发生在该阶段。较可信的 90 集基线 Job #55 用时 4,576 秒，其中模型等待/生成 3,037 秒，占 66.4%；工具等待只有 222 秒，占 4.8%。只优化 Bash、Read 或提示词，无法把 76 分钟降到可感知的新量级。
2. **质量门禁与内容协议存在冲突，制造了无效修订。** 合法的“本集核心情绪 / 开场钩子 / 结尾悬念”被扫描器判成生产说明泄漏；人物栏、动作行和英文括号台词又被当作对白角色标签。Agent 为消除误报修改了已批准试稿种子，随后陷入哈希无法恢复的状态机死路。
3. **大量确定性操作仍交给 LLM 决策和重试。** 34 个 Job 中出现 36 次 prepare、44 次 finalize、254 次 TodoWrite。Job #51 对同一批次的 `validate` 最多重复 16 次。模型在承担“调用脚本、理解非零退出、重组参数、决定是否再试”等本应由编排器完成的工作。

因此，优先级不是继续堆叠提示词，而是：

```text
先修正确性契约
-> 再把确定性流程下沉到后端状态机
-> 再拆小上下文并结构化错误
-> 最后用受控并发缩短模型主路径
```

建议将 **Job #55 视为当前质量方向较可信的性能基线**，但不能把单次样本当成稳定 P50。Job #51 虽快约 14 分钟，却用 Python 模板批量写正文并产生大量重复校验，不能作为合格基线。

## 二、分析方法与口径

### 2.1 第一性拆解

Agent 的有效吞吐不等于“Job 成功数”，而应定义为：

```text
质量调整后吞吐 = 通过正确质量门禁且未破坏已批准资产的有效产出 / 墙钟时间
```

墙钟时间进一步拆为：

```text
总耗时 = 模型生成与等待
       + 工具执行与外部排队
       + 确定性编排
       + 错误恢复
       + 误报导致的返工
```

这一区分很重要。Job #42 只用 407 秒生成 90 集，但历史审计已证明其第 11-90 集由模板脚本批量生成；它是“文件生成快”，不是“有效产出快”。

### 2.2 日志分析方式

分析器以流式方式逐行读取 JSONL，配对 `tool_use` 与 `tool_result`，并统计：

- Job、阶段、会话、启动与 `--resume` 次数；
- 工具调用、错误、目标文件、参数签名和结果摘要；
- 模型等待、工具等待和其他时间；
- 完全相同操作签名的重复调用；
- 同一文件的重复读取；
- 失败 Job 的最终 Claude 结果，而不只采用数据库中的概括错误。

### 2.3 数据限制

- 34 个 Job 是当前样本全集，不代表长期生产分布；90 集高质量方向的可比样本尤其少。
- Bash 的 145 次 `is_error` 包含质量门禁主动返回非零，并不等于 145 个基础设施故障。
- Job #49 有多次进程启动和并行 Task，部分语义时间会重叠；阶段总墙钟时间以数据库为准。
- “模型等待”由相邻语义事件估算，适合判断占比，不应当作计费级精确追踪。

## 三、量化基线

### 3.1 全量概况

| 指标 | 结果 |
| --- | ---: |
| Job 数 | 34 |
| 成功 / 失败 / 取消 | 30 / 3 / 1 |
| 总墙钟时间 | 24,656 秒（约 6.85 小时） |
| 原始日志 | 166.6 MB、474,962 行 |
| `stream_event` | 469,803 行 |
| 心跳 | 1,620 行 |
| partial + 心跳占比 | 99.25% |
| Claude 进程启动 | 37 次 |
| 使用 `--resume` | 17 次 |
| 工具调用前三 | Bash 479、Read 340、TodoWrite 254 |
| Read 错误 | 31 次，其中 17 次为超过 25k token 或 256 KB |

### 3.2 阶段分布

| 阶段 | Job | 成功 | 失败 | 总时长 | 占总时长 | 工具调用 | 成本记录 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `outline_rewrite` | 5 | 4 | 0 | 4,281 秒 | 17.4% | 138 | $13.014 |
| `character_rewrite` | 4 | 4 | 0 | 1,431 秒 | 5.8% | 87 | $5.138 |
| `trial_generate` | 4 | 4 | 0 | 2,370 秒 | 9.6% | 96 | $6.868 |
| `full_generate` | 8 | 5 | 3 | 11,193 秒 | 45.4% | 569 | $39.636 |
| `foreign_review` | 13 | 13 | 0 | 5,381 秒 | 21.8% | 368 | $21.939 |

`full_generate` 同时是耗时中心和失败中心，应当作为第一阶段性能改造对象。

### 3.3 90 集基线对比

| 指标 | Job #51 | Job #55 |
| --- | ---: | ---: |
| 墙钟时间 | 3,754 秒 | 4,576 秒 |
| 工具调用 | 241 | 146 |
| 显式工具错误 | 91 | 6 |
| 重复调用 | 112 | 13 |
| 成本 | $21.82 | $12.15 |
| 模型等待 | 2,214 秒 | 3,037 秒 |
| 工具等待 | 61 秒 | 222 秒 |
| 质量解释 | Python 模板化正文，反复修补 | 禁用 Task 后逐批生成，方向更可信 |

Job #55 的模型等待占 66.4%，工具等待占 4.8%，其他编排和事件间隔占约 28.3%。这意味着：

- 即使把工具等待完全消除，理论上也只减少约 5%；
- 若 66.4% 的模型主路径可被两路受控并发覆盖，按 Amdahl 定律计算的理论上限约为 1.50 倍，即 76 分钟降到约 51 分钟；
- 三路并发理论上限约为 1.79 倍，即约 42 分钟，但并发容量、跨批连续性和修订成本会让实际收益低于上限。

并发收益必须通过灰度实测，不能直接把理论值作为 SLA。

## 四、根因与优化项

### P0-1：修复剧本解析与质量门禁的契约冲突

**证据**

1. Job #55 的试稿种子包含合法结构行 `**本集核心情绪**`、`**开场钩子**`、`**结尾悬念**`，见 `data/zdebug/jobs/agent_job_55.jsonl:L512`。
2. 同一 Job 的批次校验在 `L7503` 和 `L9181` 报 `CREATIVE_BODY_EPISODE_META_REFERENCE`，称 15 行“生产说明”进入创作正文。
3. `script-quality.mjs` 的结构行规则没有兼容 Markdown 加粗标签，但生产说明规则又直接匹配“本集核心情绪”，见 `Agents/.claude/skills/_shared/lib/script-quality.mjs:L7-L12`、`:L391-L423`。
4. `人物 —伊芙琳、亨利、亚历克斯` 被纳入重复创作行，Agent 通过调整人物顺序规避扫描，见 Job #55 `L14039`、`L19257`、`L23238`、`L35073`。这不是内容质量改进，只是对误报的拟合。
5. Job #55 的一致性报告有 47 条 `UNKNOWN_CHARACTER_LABEL`；其中包括“蕾娜坐在前排，低头给同学发消息”“（Look up two words first”“他的手机突然震动，屏幕亮起”等明显非角色标签，见 `runtime/jobs/55/consistency-report.json` 和 Job #55 `L73763`。
6. 角色标签解析器允许冒号前 32 个字符并只排除少量固定词，见 `Agents/.claude/skills/_shared/lib/story-index.mjs:L108-L116`；一致性检查随后把所有未知项统一变成 warning，见 `Agents/.claude/skills/_shared/lib/character-consistency.mjs:L41-L57`。

**改法**

1. 建立共享的“剧本行分类器”，先把每行解析为 `episode_heading`、`episode_metadata`、`cast_header`、`scene_heading`、`action`、`dialogue_label`、`translated_dialogue`、`document_directive`，所有扫描器消费同一分类结果，不再各自用宽泛正则猜测。
2. `本集核心情绪 / 开场钩子 / 结尾悬念` 只有在行首、允许的 Markdown 标记和结构位置中才归为元数据；它们出现在角色对白或动作正文中时仍应报错，不能简单全局白名单。
3. 重复正文扫描排除 `cast_header`、场次标题、结构字段和目标语镜像行，只比较真正动作与对白。
4. 对白标签必须满足严格语法：行首、无动作标记、无句号类标点、无全角括号开头、标签长度受限；`人物 —A、B` 应解析为人物栏而不是一个角色名。
5. 将未知标签拆级：主角色使用英文名或错误显示名为 error；有对白的临时角色为 info 或可配置 warning；动作句、翻译句不得进入角色标签集合。
6. 用已批准试稿、动作冒号句、英文括号台词、临时角色、真实生产说明泄漏建立正反例测试集。扫描器上线前对现有 90 集样本做 shadow 对比。

**预期收益**

- 消除无意义改写和多轮 validate；
- 避免 Agent 为“通过规则”破坏人物栏、试稿格式或已批准内容；
- 提高质量报告信噪比，使真正的角色错误更醒目。

**验收指标**

- 已批准 Job #55 试稿回放时，合法结构行不产生 `CREATIVE_BODY_EPISODE_META_REFERENCE`；
- 人为在角色对白中加入“下一集我们再生成”仍被阻断；
- 47 条历史 unknown 中，动作句、翻译句、人物栏误判降为 0；
- 标注夹具上的阻断问题召回率 100%，precision 至少 95%；
- 同一正文哈希的扫描结果确定且可缓存。

**风险与回滚**

新解析器可能漏掉非标准剧本格式。先通过 `quality_scanner_v2` 特性开关双跑，只记录差异；标注集未达标时继续使用旧门禁，但立即对已确认的结构行误报打最小补丁。

### P0-2：修复已批准试稿种子批次的哈希死路

**证据**

1. Job #55 初始化后，1-10 集状态为 `seeded_from_approved_trial`，见 `data/zdebug/jobs/agent_job_55.jsonl:L511`。
2. `validate` 遇到该状态直接返回成功，不读取当前文件，也不更新哈希，见 `full-draft-tool.mjs:L666-L675`。
3. `assemble` 又强制当前文件哈希必须等于 manifest 中的 `source_hash`，见 `full-draft-tool.mjs:L828-L838`。
4. Agent 因质量误报修改种子后，两次 assemble 均报“批次 1-10 在校验后发生变更”，见 Job #55 `L71662`、`L72027`。正常 validate 无法恢复，只能靠额外手工操作绕开。

**改法**

1. 将已批准试稿批次定义为不可变输入，不允许创作 worker 直接编辑；assemble 前始终从当前批准版本确定性重建种子文件。
2. 如果业务确实允许全稿阶段修正试稿，则不能继续沿用 `seeded_from_approved_trial`：显式转为 `modified_seed_requires_reapproval`，执行完整质量扫描、写入新哈希，并要求重新审批。
3. `validate` 不再对 seeded 状态无条件成功，至少校验文件哈希、批准版本和来源哈希；发现漂移时返回结构化 `APPROVED_SEED_DRIFT`，给出 `restore_from_approved_trial` 或 `request_reapproval` 两个明确动作。
4. manifest 更新与文件重建必须加锁并原子写入，避免并行 worker 竞争。

**预期收益**

- 消除不可恢复的状态机死路；
- 保护已批准资产，避免模型为通过扫描器静默修改用户确认内容；
- assemble 失败可以由后端确定性恢复，不再消耗新的模型轮次。

**验收指标**

- seeded 文件被篡改后，一次确定性恢复即可继续，且无模型参与；
- 未经重新审批的修改不能进入最终汇总；
- manifest、批准资产和汇总稿的来源哈希可追溯；
- 并发执行 100 次不出现 manifest 丢更新或部分写入。

**风险与回滚**

若历史项目依赖“全稿阶段吸收修正”，直接不可变化会改变行为。迁移时按项目保留旧路径，但必须进入显式再审批状态；通过 `approved_seed_guard_v2` 控制新旧逻辑。

### P0-3：拆分 Context Pack，消除与 Read 工具的硬冲突

**证据**

1. Read 共 340 次，31 次报错；其中 17 次明确因为超过 25k token 或 256 KB。
2. 当前 Skill 要求先读取完整 `context_pack_path`，例如 `full_generate/SKILL.md:L24-L25`。
3. 实际 `stage-context.json` 最大 309,816 字节；Job #55 为 270,902 字节，已经超过 Read 的 256 KB 上限。Job #42、#43 日志直接出现 273.9 KB、302.6 KB 超限。
4. Job #45 对同一 Context Pack 读取 4 次，并连续 4 次触发“episode 单次最多读取 10 集”的 Memory 错误，见 Job #45 `L496`、`L1274-L1295`。

**改法**

把单一 Context Pack 改为分层索引：

```text
runtime/jobs/<job>/context/
  context-index.json          # < 32 KB，只含任务、审批、来源角色、blocker、路径
  user-preferences.json       # 当前 Job 有效偏好
  story-index.json            # 集/段索引，不含全部正文
  source-overview.json        # 世界规则、时间机制、初始关系
  batch-context/011-015.json  # 当前批次剧情、角色状态、开放循环、风格样本引用
```

具体要求：

1. prepare 只返回 `context_index_path`、blocker 和首批任务，不输出大段上下文正文。
2. 后端按批次生成 `batch-context`，模型只读取当前 3-5 集需要的信息。
3. Memory 工具对超过 10 集的范围自动分片并聚合结果；调用方不需要理解错误后手工重组命令。
4. 每个上下文文件写入 `schema_version`、`source_hashes`、`generated_at`，并为引用源保留路径与行号。
5. 脚本负责读取和过滤数据，Skill 只说明读取哪个索引及何时停止，不把数据本身塞进提示词。

**预期收益**

- Read 超限错误归零；
- 减少上下文占用、重复读取和模型对无关全季信息的注意力消耗；
- 新会话可从小型状态文件恢复，不依赖越来越长的聊天历史。

**验收指标**

- `context-index.json` 小于 32 KB，单个 `batch-context` 小于 64 KB，任何模型必读文件小于 200 KB；
- 90 集任务 Read size/token 错误为 0；
- Memory 读取 1-90 集时由工具自动分片，调用者只发一次请求；
- 相同批次的上下文哈希稳定，重复准备直接命中缓存。

**风险与回滚**

拆分过程中可能漏传跨批伏笔。保留 `context_pack_v1` 作为诊断源，v2 在 shadow 模式比较来源覆盖率；跨批关键状态必须写入显式 `open_loops` 与 `boundary_state`，不能仅依赖摘要。

### P1-1：用后端受控批次编排替代自治 Task 和纯串行生成

**证据**

1. Job #49 一次派出 8 个 Task，随后返回“并发 Session 超限：当前 8 个（限制 8 个）”，见 `agent_job_49.jsonl:L1387-L1424`。
2. Job #49 在失败前有 96 次工具调用、36 次显式错误；多个批次 validate 重复 5 次。
3. 当前运行器已对 `full_generate` 添加 `--disallowedTools Task`，见 `apps/api/app/services/agent_runner.py:L1028-L1040`；当前 Skill 也要求串行，见 `full_generate/SKILL.md:L26`。这解决了无界并发和 manifest 绕过，但把 Job #55 的模型主路径完全串行化。
4. Job #55 中模型等待占 66.4%，说明下一阶段的有效提速必须覆盖模型生成主路径。

**改法**

不是恢复通用 Task，而是在后端实现有界的 batch scheduler：

1. 默认并发 2，只有容量、错误率和质量稳定后才允许升到 3；并发上限由账号/模型容量动态计算，预留至少 1 个 session 给其他阶段。
2. 每个 worker 使用独立 Claude 会话、独立批次文件和只读 `batch-context`；禁止写试稿、Memory、manifest 和最终稿。
3. 父编排器是 manifest 的唯一写者，负责领取租约、校验、提交、重试、汇总和 finalize。
4. 并行的前提不是“集号不同”，而是每批都已经具备由批准梗概生成的 `boundary_state`：起始人物状态、必须承接的开放循环、目标结束状态和不可改事实。
5. 汇总前执行跨批边界检查；若第 N 批结尾与 N+1 批开头冲突，只重修边界相关批次，不重跑全季。
6. 遇到 `child_session_capacity` 自动把并发降为 1，不重新发起一轮 8 Task。

建议状态流：

```text
prepare
  -> build all batch contracts
  -> scheduler(max_workers=2)
       -> generate isolated batch
       -> deterministic validate
       -> targeted repair at most once
  -> ordered cross-boundary check
  -> assemble
  -> finalize
```

**预期收益**

- 在不恢复无界自治并发的前提下覆盖最大的模型等待区间；
- 单批失败只影响该批，不污染其他批次和共享状态；
- 理论上两路并发有机会把 76 分钟降到约 50-60 分钟，实际目标由 10 次以上灰度样本确认。

**验收指标**

- 首轮灰度并发固定为 2，`concurrent_sessions` 错误为 0；
- 10 个同规格 90 集 Job 后，质量合格样本 P50 小于 60 分钟，再评估小于 50 分钟的二阶段目标；
- 成本相对串行基线增加不超过 15%；
- 质量门禁通过率、跨批连续性错误率不得劣于串行基线；
- worker 无权修改批准资产、Memory、manifest 和最终稿。

**风险与回滚**

主要风险是跨批连续性和并发容量。使用 `batch_scheduler_v2` 开关按项目灰度；出现边界错误率上升或 429 时立即降为单 worker，保留已通过批次继续执行，不整季回滚。

### P1-2：把确定性阶段操作移出 LLM

**证据**

- 34 个 Job 中有 36 次 prepare、44 次 finalize、254 次 TodoWrite。
- Job #51 对 41-50、51-60、61-70、81-90 各 validate 16 次；对 71-80 validate 14 次。相同命令签名和目标批次被反复执行。
- Job #55 仍重复 4 次 assemble、3 次 finalize、2 次 prepare。
- 这些操作的选择和参数大多由阶段、workspace、job_id 和批次状态唯一决定，不需要文学判断。

**改法**

后端阶段执行器拥有下列确定性状态机：

```text
PREFLIGHT
-> MEMORY_SYNC_IF_NEEDED
-> PREPARE
-> INIT
-> CONTEXT_READY
-> MODEL_GENERATE
-> VALIDATE
-> REPAIR_REQUIRED | ACCEPTED | HUMAN_REVIEW
-> ASSEMBLE
-> FINALIZE
```

1. 后端直接执行 preflight、Memory 同步、prepare、init、validate、assemble、finalize，并解析结构化结果。
2. Claude 只接收两类任务：`generate_batch` 和 `repair_batch`。每次请求包含唯一输入路径、唯一输出路径、允许修改范围和完成条件。
3. quality gate 失败时，后端从 JSON 报告生成 `repair brief`：问题 code、证据行、受影响集、允许修改文件、最多一次修订。不要把 20 KB 报告全文重新塞给模型。
4. 相同正文哈希只验证一次；报告未变化时禁止再次调用模型或 validate。
5. Todo 状态由后端 Job/批次状态展示，不再要求 Claude 高频调用 TodoWrite。

这类重复链路应整理成**工具/编排器**，而不是新增 Skill。因为它们是可确定执行的状态转换；把它们包装成 Skill 仍会让 LLM决定是否调用、如何解析错误，无法消除根因。

**预期收益**

- 明显减少工具调用、提示 token 和非语义轮次；
- 重试策略一致，避免模型陷入“改一点、全量校验、再改一点”的循环；
- 恢复路径可以单元测试和故障注入。

**验收指标**

- 单个 90 集 Job 的 prepare、init、assemble、finalize 各最多执行一次；仅在输入哈希变化时允许重新执行；
- 同一批次、同一正文哈希的 validate 实际执行次数为 1；
- TodoWrite 从创作 Job 主路径移除；
- 非创作工具调用量相对 Job #55 至少下降 40%；
- 每个状态都有幂等测试、崩溃恢复测试和并发租约测试。

**风险与回滚**

编排器如果一次承担过多语义判断会变脆。边界必须保持清楚：后端只读结构化 code 和状态，文学修订仍由模型完成。通过 `stage_executor_v2` 切换，新旧执行器共享 manifest schema 或提供一次性迁移器。

### P1-3：建立结构化错误分类与差异化恢复

**证据**

1. Job #24 的数据库错误只有 `Claude Code exited with code 1`，原始结果却是余额预扣失败：剩余 $0.021162，需要 $0.413654，见 `agent_job_24.jsonl:L14644-L14645`。这是不可重试错误。
2. Job #50 的真实错误是 `context_limit`，见 `agent_job_50.jsonl:L24-L25`。继续 resume 原会话没有意义。
3. Job #49 是子 Session 容量问题，不应按普通模型冷却重启整轮任务。
4. 当前工作区已经增加上下文超限后旋转新会话的逻辑，见 `agent_runner.py:L1453-L1459`；也已禁止全稿 Task。这两项应标为“已修复待真实回归”，而不是再次重写。

**改法**

所有 CLI、工具和 Job 最终错误统一输出：

```json
{
  "code": "CONTEXT_LIMIT",
  "category": "runtime",
  "retryable": true,
  "retry_after_seconds": 0,
  "next_action": "rotate_session_and_resume_from_files",
  "user_message": "旧会话上下文已满，已从当前进度继续",
  "details": {}
}
```

至少覆盖：

| 错误码 | 行为 |
| --- | --- |
| `BILLING_EXHAUSTED` | 不重试；保留进度并提示处理额度 |
| `MODEL_COOLDOWN` | 指数退避，遵守 retry-after |
| `CHILD_SESSION_CAPACITY` | 降低 worker 并发，不重跑已完成批次 |
| `CONTEXT_LIMIT` | 仅一次新会话，从 manifest 和文件恢复 |
| `SESSION_IN_USE` | 清理确认属于本站的残留进程后重试一次 |
| `QUALITY_GATE` | 生成定向 repair brief，不归为基础设施失败 |
| `INPUT_CONTRACT` | 停止并要求用户或上游阶段补齐 |
| `APPROVED_SEED_DRIFT` | 确定性恢复或重新审批 |

数据库增加 `error_code`、`error_category`、`retryable`、`root_cause_excerpt`，UI 展示用户可行动的信息；完整原始错误留在诊断日志，不把 request id、路径和堆栈直接暴露给终端用户。

**验收指标**

- 上述错误夹具分类准确率 100%；
- `BILLING_EXHAUSTED` 自动重试次数为 0；
- `CONTEXT_LIMIT` 一次切换新会话并从文件继续，相关集成测试覆盖真实流式 result；
- quality gate 非零退出不再统计为“运行器故障”；
- UI 不再只显示 `exited with code 1`。

**风险与回滚**

上游代理可能更改错误文案。优先解析结构化 `error.type/code`，正则只作为兼容层；未知错误保持保守的单次失败，不做无限重试。

### P1-4：建立“失败差异驱动”的修订环，而不是盲目重试

**证据**

- Job #51 相同批次 validate 最高 16 次，说明“有报告”不等于“模型知道下一次只改什么”。
- Job #49 对 11-50 的四个批次各连续验证 5 次，且每次均失败。
- Job #55 因结构误报先修订合法元数据，后又为重复行调整人物顺序，修订目标被扫描器噪声带偏。

**改法**

1. validate 报告增加稳定的 `issue_id = code + file + episode + evidence_hash`。
2. 后端比较前后两次报告，只把新增、未解决和回归问题传给模型。
3. repair brief 必须包含：可修改范围、具体证据、期望变化、禁止改动项、剩余尝试次数。
4. 若正文哈希变了但 issue 集合和严重度没有改善，立即转人工复核，不继续微调。
5. 每批最多一次自动修订；第二版仍有阻断问题进入 `retry_exhausted`。解析器误报由 scanner shadow/豁免机制处理，不能让模型改内容迎合错误规则。

**验收指标**

- 单批自动生成最多 1 次、自动修订最多 1 次；
- 相同 issue 集合连续出现时不再发起第三轮；
- repair 请求 token 只包含必要证据，体积小于完整报告的 20%；
- 修订不得触碰批准种子和其他已通过批次；
- 报告可追踪每个 issue 的出现、解决和回归版本。

### P1-5：日志分层持久化，ZDebug 改为增量读取

**证据**

1. 474,962 行日志中，469,803 行是 `stream_event`，另有 1,620 行心跳；两者占 99.25%。
2. Job #55 单份日志约 25.9 MB、75,054 行；Job #51 约 27.4 MB、75,441 行。
3. 当前 CLI 使用 `--include-partial-messages`，见 `agent_runner.py:L1028-L1036`。
4. ZDebug 的 `readJsonlFile` 每次用 `fs.readFile` 读取整份文件，再 `split` 和逐行 `JSON.parse`，见 `tools/zdebug/src/logs.mjs:L98-L115`；`/api/files/:id` 每次请求都会执行该流程，见 `server.mjs:L308-L323`。
5. 不能直接删除 partial：当前 stall watchdog 仍依赖流式事件和心跳判断模型是否开始响应。

**改法**

采用两层日志：

1. **实时层**：partial 事件继续驱动 watchdog 和实时 UI，但只保存在内存环形缓冲区或短期临时文件。
2. **语义层**：持久化 `job_start`、`model_start/end`、`tool_start/result`、`state_transition`、`retry`、`error`、`job_result`；心跳按 30-60 秒采样或只记录状态变化。
3. 原始 partial 日志在 Job 完成后 gzip，设置短期保留期；默认诊断 UI 读取语义日志，必要时才下载原始包。
4. ZDebug API 支持 `offset/cursor/limit`，按字节增量读取；live 文件只解析新增内容。前端保存 cursor，不再每 1.5 秒读取整份 26 MB 文件。
5. 为每个 Job 生成 `metrics.json`，直接记录 token、成本、时长、错误分类和阶段状态，复盘不再扫描全部 raw log 才能得出基础指标。

**预期收益**

- 显著降低磁盘写入、页面轮询 CPU、内存和诊断延迟；
- 日志信噪比提高，错误和状态转换更易定位；
- watchdog 行为不受影响。

**验收指标**

- 同规格 Job 的默认持久化语义日志小于当前原始日志的 10%；
- live 轮询只读取新增字节，服务端不再 `readFile` 整个日志；
- 26 MB 日志首次展示和后续刷新分别满足可设定的性能预算，建议 P95 < 2 秒和 P95 < 300 ms；
- stall、cooldown、context limit 检测回归测试全部通过；
- 原始日志压缩包仍能还原完整诊断证据。

**风险与回滚**

过滤错误会丢失关键证据。先双写语义日志和原始日志，连续两周确认语义层足以解释故障后再缩短原始保留期；通过 `semantic_log_v2` 切换 UI 数据源。

### P2-1：把“重复链路”从工具名 n-gram 升级为语义操作分析

**证据**

当前系统复盘只抽取工具名，并统计长度 2-4 的序列，见 `apps/api/app/services/system_agent_evolution_service.py:L249-L298`。因此 `Bash -> Bash` 会把以下完全不同的行为混在一起：

- 合理的不同批次并行验证；
- 同一命令在输入未变化时重复执行；
- 失败后有正文写入再重新验证；
- 质量 gate 的预期非零退出；
- 基础设施错误后的重试。

本次流式分析按“工具 + 规范化参数 + 目标文件”后，才识别出 Job #51 对相同批次最多 16 次 validate、Job #55 4 次 assemble 等真正可行动的重复。

**改法**

重复操作签名至少包含：

```text
tool_name
+ normalized_arguments
+ target_file_or_range
+ input_content_hash
+ result_code
+ intervening_write_hashes
```

分类输出：

- `cached_repeat`：相同输入已有结果，应直接复用；
- `repair_retry`：中间有目标文件写入，属于有效修订轮次；
- `blind_retry`：输入、参数和结果都未变化；
- `fan_out`：同类工具但不同目标，是并行批次而非重复；
- `infra_retry`：因 cooldown/session 等运行错误重试。

**Skill / 工具提炼标准**

| 重复模式 | 处理方式 |
| --- | --- |
| 跨至少 3 个 Job、步骤固定、低语义判断 | 做成后端工具或编排器 |
| 跨至少 3 个 Job、需要稳定语义判断 | 精简为现有 Skill 内的一个明确流程；只有边界独立时才新增 Skill |
| 单项目、单次事故 | 写测试或修工具契约，不新增 Skill |
| 只是同工具处理不同目标 | 不视为重复，不抽象 |

当前最值得工具化的是：阶段状态机、Memory 自动分片、repair brief 生成、语义日志汇总。**暂不建议新增更多创作 Skill**；现阶段问题不是缺少知识说明，而是工具契约和编排边界不够确定。

**验收指标**

- 复盘报告能区分 Job #51 的 blind retry 与正常批次 fan-out；
- 每条重复结论都带 job、调用行、目标、输入哈希、结果和中间写入证据；
- 不再只凭 `Bash -> Bash` 之类序列提出 Skill 建议；
- 重复分析本身采用增量/语义日志，不重新扫描全部 partial 事件。

### P2-2：为提示词、Skill、工具和门禁增加契约检查

**证据**

- Job #55 运行时读取到的旧版全稿规则要求把“创作原则锁定”写进成品顶部，见 `agent_job_55.jsonl:L266`；而当前工作区规则已经改为“只作为执行基准，不写入成品”，见 `full_generate/references/全稿生成规则.md:L18`。这说明历史上提示词与产出门禁确实发生过冲突，当前修改仍需回归验证。
- 当前 Skill 要求读取可能超过工具上限的 Context Pack，说明自然语言要求没有经过工具能力校验。
- “必须动作”只写在 Skill 中时，模型仍可能漏做、重复做或以错误参数执行。

**改法**

1. 建立轻量 `agent-contract-check`，在测试中检查：允许输出的结构字段是否会被 scanner 阻断、Skill 要求读取的文件是否超过预算、要求使用的工具是否被运行器禁用、同一产物规则是否互相冲突。
2. 强制动作放在后端状态机或 Hook；Skill 只保留模型必须理解的语义边界和创作质量要求。
3. 参考文档采用渐进披露：主 Skill 保持短小，批次需要时才读取对应规则；脚本应执行，不应整份读入上下文。
4. 每次修改 Skill、scanner、manifest schema 或 runner tool policy，必须运行同一套端到端契约夹具。

**验收指标**

- CI 能复现并阻止“合法结构被 scanner 判错”“要求读取超大文件”“Skill 要求 Task 但运行器禁用”三类冲突；
- `CLAUDE.md`、主 Skill 和批次 prompt 的必读 token 预算可观测且不持续增长；
- 新规则必须关联至少一个真实事故或明确产品需求，不把个例直接堆成 few-shot。

## 五、目标架构

```text
用户触发阶段
    |
    v
后端 Stage Executor
    |- preflight / approval / billing
    |- memory sync
    |- prepare compact context index
    |- init manifest + batch contracts
    |
    v
Bounded Batch Scheduler (2 workers initially)
    |- Worker A: read-only batch context -> generate one batch file
    |- Worker B: read-only batch context -> generate one batch file
    |
    v
Deterministic Validator
    |- parser/scanner v2
    |- source and approval hashes
    |- cache by content hash
    |- structured issue delta
    |
    +--> one constrained repair -> validate
    |                         |
    |                         +--> still failed -> human review
    v
Ordered boundary check -> assemble -> finalize
    |
    v
Semantic log + metrics + compressed raw diagnostic log
```

职责边界：

| 组件 | 应负责 | 不应负责 |
| --- | --- | --- |
| Claude | 场面、对白、语义修订、有限判断 | prepare/finalize、重试分类、状态迁移、并发控制 |
| Skill | 创作边界、输入角色、输出契约 | 承载大段项目数据、用自然语言替代强制状态机 |
| 工具 | 参数校验、自动分片、结构化错误、幂等执行 | 让模型猜退出码含义 |
| 后端编排器 | 确定性流程、缓存、租约、重试、恢复 | 文学内容判断 |
| scanner | 可重复的结构/生产完整性判断 | 用宽泛正则替代剧本语法和语义审稿 |

## 六、实施路线图

### 0-2 周：先停止错误返工

1. 修复剧本行分类、元数据误报、人物标签误判；建立正反例夹具。
2. 修复 `seeded_from_approved_trial` 的哈希与再审批状态机。
3. 拆分 Context Pack，Memory 范围自动分片。
4. 完成错误码与数据库字段；对已有“context limit 换新会话”“全稿禁用 Task”做集成回归。
5. 固化 Job #55、#51、#49、#24、#50 为性能和故障回放样本。

退出条件：Read 超限为 0、批准种子不可被静默修改、scanner 标注集达标、关键错误可正确分类。

### 3-4 周：减少 LLM 编排开销

1. 上线 `stage_executor_v2`，后端执行 prepare/init/validate/assemble/finalize。
2. 上线 issue delta 和 repair brief；取消 blind retry 和 TodoWrite 主路径。
3. 上线语义日志双写、ZDebug cursor 增量接口。
4. 单 worker 跑通 10 个回归 Job，确认质量与恢复能力不退化。

退出条件：确定性步骤幂等、同哈希 validate 一次、非创作工具调用下降至少 40%、日志增量读取稳定。

### 5-8 周：受控并发与持续优化

1. `batch_scheduler_v2` 以 2 workers 对 10% 长季 Job 灰度。
2. 监控 429、成本、质量通过率、边界错误和人工返工；满足阈值再逐步扩大流量。
3. 引入语义重复分析和质量调整后吞吐看板。
4. 上线 Agent 契约检查，防止 Skill、工具、scanner 和 runner 再次漂移。
5. 只有在真实语义流程跨多个 Job 稳定重复后，才评估新增 Skill。

退出条件：至少 10 个同规格质量合格样本，P50 小于 60 分钟、容量错误为 0、成本增加不超过 15%、质量不劣于串行基线。

## 七、指标体系

### 7.1 北极星指标

```text
质量调整后成功率 =
通过正确质量门禁、未破坏批准资产、无需人工恢复的 Job 数 / 已结束 Job 数
```

不能再只使用 `process exit code == 0` 或“文件存在”作为成功定义。

### 7.2 运行指标

| 指标 | 当前证据 | 第一阶段目标 |
| --- | --- | --- |
| 90 集质量方向可信基线 | Job #55：76 分钟 | 先建立 10 次样本；受控并发后 P50 < 60 分钟 |
| Read 超限错误 | 17 次 | 0 |
| 同哈希重复 validate | Job #51 单批最高 16 次 | 1 次 |
| 全稿并发容量错误 | Job #49 触发 8/8 | 0 |
| 批准种子哈希死路 | Job #55 2 次 assemble 失败 | 0 |
| 非创作工具调用 | Job #55 仍有多次 prepare/assemble/finalize | 降低至少 40% |
| 默认日志体积 | Job #55 25.9 MB | 语义日志小于当前 10% |
| 成本 | Job #55 $12.15 | 同质量下不增加超过 15% |

### 7.3 质量指标

- scanner 标注夹具 precision、recall；
- 阻断错误、warning、info 的人工确认误报率；
- 跨批边界连续性错误数；
- 每集 Canon 覆盖、角色状态覆盖、开放循环兑现率；
- 近重复/模板化回归数；
- 自动修订后 issue 减少率；
- 人工批准前的返工轮次和返工分钟数。

## 八、灰度与回滚

建议使用五个独立特性开关：

| 开关 | 灰度顺序 | 回滚点 |
| --- | --- | --- |
| `quality_scanner_v2` | 双跑 -> 只提示 -> 阻断 | 回到旧 scanner，同时保留差异报告 |
| `context_pack_v2` | 单阶段 -> 全创作阶段 | 回读 v1 pack，不删除 v2 文件 |
| `stage_executor_v2` | 单 worker -> 全量 | 回到 Claude 编排，沿用同一 manifest |
| `batch_scheduler_v2` | 2 workers、10% 流量 -> 扩大 | 降为 1 worker，保留已通过批次 |
| `semantic_log_v2` | 双写 -> UI 切换 -> 缩短 raw 保留 | UI 回读 raw，语义日志继续保留 |

任何并发优化都必须排在 scanner、种子状态机和 Context Pack 修复之后。否则只是更快地产生误报、冲突和返工。

## 九、已修复待回归与尚未修复

### 当前工作区已出现、需要回归验证

- `full_generate` 已通过 `--disallowedTools Task` 禁止自治 Task 绕过 manifest：`agent_runner.py:L1037-L1040`。
- `context_limit` 已增加一次旋转新会话并从项目文件继续：`agent_runner.py:L1453-L1459`。
- 当前全稿规则已改为“创作原则不写入成品”：`full_generate/references/全稿生成规则.md:L18`。

建议补充真实流式集成测试，而不只测试路由参数或正则：

- resume 会话返回 context limit -> 新 session -> 从已有 manifest 继续；
- full_generate 命令确实不向模型暴露 Task；
- 新旧全稿规则、scanner 与最终成品结构端到端一致。

### 仍需立即修复

- 合法分集元数据被当作生产说明；
- 人物栏、动作句和括号翻译被当作对白标签；
- seeded 批次 validate/assemble 哈希契约冲突；
- Context Pack 超过 Read 上限；
- Memory 大范围读取需要模型手工分片；
- Job 最终错误仍可能退化为 `exited with code 1`。

### 架构性改造

- 后端阶段执行器；
- 有界批次 scheduler；
- issue delta 修订环；
- 语义日志与增量 ZDebug；
- 语义重复链路分析和 Agent 契约检查。

## 十、证据索引

| 结论 | 主要证据 |
| --- | --- |
| 全量统计 | `tmp/claude-agent-log-analysis.json` |
| 分析方法 | `tmp/analyze-claude-agent-logs.mjs` |
| Job #55 基线 | `data/zdebug/jobs/agent_job_55.jsonl:L75053` |
| Job #55 元数据误报 | 同文件 `L7503`、`L9181` |
| Job #55 种子哈希死路 | 同文件 `L71662`、`L72027` |
| Job #55 标签噪声 | 同文件 `L73763`、`runtime/jobs/55/consistency-report.json` |
| Job #49 并发超限 | `data/zdebug/jobs/agent_job_49.jsonl:L1424` |
| Job #51 模板与重复验证 | `data/zdebug/jobs/agent_job_51.jsonl:L7204`、`:L12700`、`:L37506` 及分析 JSON 的 duplicate evidence |
| Job #24 余额失败 | `data/zdebug/jobs/agent_job_24.jsonl:L14644-L14645` |
| Job #50 上下文超限 | `data/zdebug/jobs/agent_job_50.jsonl:L24-L25` |
| scanner 规则冲突 | `Agents/.claude/skills/_shared/lib/script-quality.mjs:L7-L12`、`:L391-L423` |
| seeded 状态冲突 | `Agents/.claude/skills/full_generate/scripts/full-draft-tool.mjs:L666-L675`、`:L828-L838` |
| 角色标签解析 | `Agents/.claude/skills/_shared/lib/story-index.mjs:L108-L116`、`character-consistency.mjs:L41-L57` |
| 禁用 Task | `apps/api/app/services/agent_runner.py:L1028-L1040` |
| context limit 恢复 | `apps/api/app/services/agent_runner.py:L1453-L1459` |
| ZDebug 整文件解析 | `tools/zdebug/src/logs.mjs:L98-L115`、`server.mjs:L308-L323` |
| 旧重复链路算法 | `apps/api/app/services/system_agent_evolution_service.py:L249-L298` |

## 十一、行业最佳实践校准

方案参考了以下官方资料，但所有优先级仍以本项目日志证据为准：

1. [Claude Code Best Practices](https://code.claude.com/docs/en/best-practices)：上下文是有限资源；项目指令应保持精简，按需加载参考资料；脚本应执行而不是整份读入对话。
2. [Claude Code Subagents](https://code.claude.com/docs/en/sub-agents)：子 Agent 的价值是隔离上下文和处理独立工作；需要清晰 description、工具限制和上下文边界，并不等于越多并发越好。
3. [Claude Code CLI Reference](https://code.claude.com/docs/en/cli-reference)：`--include-partial-messages` 会输出流式 partial 事件；`--resume`、`--disallowedTools` 的行为应由运行器明确管理。
4. [Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents)：确定流程适合 workflow，开放判断适合 agent；并行只适用于可独立拆分的子任务；工具定义、参数和错误边界需要像提示词一样认真设计，并通过参数让错误更难发生。

这些最佳实践与日志结论一致：本项目应减少 LLM 对确定性流程的控制，把上下文和工具边界做小、做清楚，再对真正可独立的生成主路径实施受控并发。
