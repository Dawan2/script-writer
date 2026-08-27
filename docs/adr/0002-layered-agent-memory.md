# ADR-0002：剧本 Agent 分层记忆、阶段 Session 与进化闭环

- 状态：已实施
- 日期：2026-07-10

## 背景

长篇剧本在单一 Claude Code session 中连续执行时，会同时积累对话、工具调用、原始文档和 token delta。近期项目已出现自动上下文压缩、同一大文件重复完整读取、运行成本上升和旧内容干扰当前阶段等问题。优化不能牺牲剧情连贯、人物一致、成长弧、人工修改语境和完整审计日志。

## 第一性约束

1. 剧情质量依赖可追溯事实、时间态角色状态和明确审批边界，不依赖无限聊天历史。
2. 原始与阶段 Markdown 是用户可编辑的事实源；任何派生 Memory 都必须能由事实源重建。
3. 未批准草稿不能成为后续生成的已确认事实。
4. 高频原始日志用于观测和复盘，不应进入正常推理上下文。
5. 成本优化只有在质量指标不退化时才能发布。

## 决策

### 记忆分层

```text
事实源 Markdown
    -> memory/：带哈希、源行号和审批状态的持久投影
        -> runtime/jobs/{job_id}/：当前阶段 Context Pack 与 working state
            -> 模型当前上下文

ZDebug raw JSONL -> 复盘证据，不进入正常模型上下文
```

- `story-map.json`：逐集或行号分段索引、摘要、钩子和角色标签。
- `character-canon.json`：稳定角色定义，明确 `candidate` / `approved`。
- `character-state.jsonl`：仅追加已批准、带正文证据的时间态变化。
- `decisions.jsonl`：阶段批准、人工语义修改和关键决策。
- `artifacts.json`：事实源 SHA-256 与 Memory revision。

不引入向量数据库。当前文档有稳定的文件、集号、标题、映射表和对白标签，确定性索引更容易审计，也避免语义近似召回错误角色或错误时间点。

### 生成介入

1. `prepare` 拒绝陈旧 Memory，更新阶段运行态并重建 revision。
2. 为 job 生成 `stage-context.json`；先读 Context Pack，再按集数/角色批量检索。
3. 试稿和全稿生成前写入 `character-access.jsonl`，保留本 job 角色 working state。
4. `finalize` 做格式质检、角色标签/集号校验和候选角色状态增量。
5. 阶段进入 `draft_ready`；只有显式审批接口能变为 `approved` 并提交非空、有证据的状态增量。

知识边界、关系、口吻和弧光仍保留人工复核项。确定性校验不伪装成完整语义理解。

### 人工编辑同步

保存采用一个文件系统事务：

1. 校验 `expected_hash`，阻止覆盖并发新版本。
2. 保存 Markdown，计算结构化 diff 和受影响集数/角色。
3. 语义修改将当前阶段降为 `draft_ready`，已有下游产物标记 `stale`；格式修改不改变审批状态。
4. 重建 Memory 和哈希，写入版本与变更审计。
5. 任一步失败则恢复 Markdown、进度和 Memory。

审批时重新校验当前文件；不得复用修改前的一致性报告。

### Session 与对话

- UI 保留一个项目级逻辑对话，消息持久化在 `agent_messages`。
- Claude Code 按阶段使用 `project_stage_sessions`；同阶段生成和对话修改复用，跨阶段新建。
- 阶段交接依赖已批准 Memory + Context Pack，不恢复上一阶段膨胀 session。
- `all` 每次最多运行一个未批准阶段，等待用户审批后继续。

### 日志与 ZDebug

- SQLite 保留 job、语义事件、消息和原始日志索引。
- 高频 stream delta 不写数据库。
- 每个 job 的 stdout/stderr 完整写入独立 JSONL，并记录路径、字节数和 SHA-256。
- ZDebug 打开历史 job 时优先选择该 job 的 runtime JSONL；界面可折叠内部事件，但原文件不裁剪。

### Agent 进化

海外审稿完成后生成 `memory/evolution/review-*.json`，汇总：

- job/失败/turns/cost/session 数；
- 上下文压缩和重复读取；
- 人工语义修改的阶段分布；
- 一致性 issue code 和待审批 delta。

`/agent-retrospective` 只能生成待人工评审提案。单项目偏好不得自动晋升全局规则；全局 Skill 修改必须通过历史样例、当前样例、质量、成本、人工批准和回滚验证。

## 后果

- 优点：上下文规模由任务相关事实决定；人工编辑可追溯；角色状态有时间与审批边界；日志仍完整；复盘数据可积累。
- 代价：增加 Memory 重建、审批和迁移步骤；部分语义一致性仍需要 Agent 与人工判断。
- 不采用：单一无限 session、把对话摘要当唯一事实源、自动把草稿写入 Canon、把 raw trace 塞回每次提示词。
