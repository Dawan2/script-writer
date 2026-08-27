---
name: script-formula-curation
description: 比较单剧公式候选与已有公式，在同一创作阶段和抽象粒度下决定复用、完善或新增。用于单剧蒸馏后的公式归档；不重读原剧，不生成案例卡或创作原则。
---

本 Skill 的目的，是将单剧公式候选关联到尽可能少且完整的公共公式，并保证公式表中的“适用阶段｜使用场景｜公式名称”足以支持调用判断。

## 工作流程

1. 对每个候选，只比较调用方为它提供的检索结果。
2. 先比较创作阶段和抽象粒度。粒度不同时不得复用或合并；只有试稿与完稿可在方法和完成标准一致时共用。
3. 再比较使用场景、核心公式、使用前确认、使用方法、生效原因、完成标准、不适用情况和常见失效方式。
4. 已有公式完整覆盖候选时选 `reuse`；核心因果和方法相同，但候选补充了有效边界、完成标准或题材差异时选 `improve`；已有公式无法解释时才选 `create`。
5. 同一张公式能承接多个候选时，将它们放入同一操作。
6. `improve` 和 `create` 返回完整公式；`reuse` 只返回归档决定。最后按调用方要求返回 `operations` JSON。

## 合并判断

- 名称相似不代表同一张公式。核心公式、使用方法或生效原因不同时不得合并。
- 人物、场景、题材、背景或受众不同，但使用场景、核心因果和方法相同时，优先复用或完善同一公式。
- 题材和受众的行动重点、回报重点与边界差异写入 `genre_adaptations`。
- 一张旧公式横跨多个创作粒度时，不能直接保留；应按各阶段任务、方法和完成标准拆分。
- 无论使用哪种写法都必须满足的是创作原则；只能解释某部剧的是案例观察。两者都不得新建为公式。
- `improve` 必须说明新增的有效内容，不得只因文字更长或标签更多而完善。

## 完整公式要求

- 使用场景和公式名称能单独完成调用判断。
- 一张公式只服务一个创作粒度，不使用 `global` 表示通用。
- `usage_scenario` 说明当前阶段的任务和希望完成的变化；`not_applicable` 说明调用前能识别的不适用情况。
- `core_formula` 说明不变因果链；`conditions` 说明使用前确认；`steps` 说明使用方法；`mechanism` 说明生效原因。
- `observable_checks` 是该阶段可直接检查的完成标准；`failure_modes` 是选对公式后的常见执行失效方式。
- `creative_decision`、`creative_problem` 和 `expected_effect` 由程序根据 `usage_scenario` 和 `goal` 补全，模型不返回。
- 公式不得残留原剧专名或连续剧情。改写用法服从原剧主线和已确定事实；新创作用法必须使用新人物、新规则和新关系。

## 硬性输出要求

- 只返回 `{"operations": [...]}`。每个输入 `candidate_id` 必须且只能出现一次；不同 `category` 的候选不得放入同一操作。
- 每个操作的 `candidate_ids` 为 1-8 项，`action` 只能是 `reuse`、`improve`、`create`，`reason` 为 12-600 字符。
- `reuse` 和 `improve` 只能选择调用方为该候选提供的已有公式。`create` 的 `formula_id` 必须为空字符串。
- `reuse` 不返回公共公式字段。`improve` 和 `create` 必须返回 `name`、`category`、`stages`、`usage_scenario`、`not_applicable`、`goal`、`core_formula`、`conditions`、`variables`、`steps`、`mechanism`、`observable_checks`、`failure_modes`、`rewrite_usage`、`original_usage`、`genre_adaptations`。
- `category` 只能使用 `story_engine`、`world_rule`、`character_relationship`、`long_arc`、`episode_structure`、`hook_information`、`audience_payoff`、`emotional_progression`、`scene_conflict`、`dialogue_action`，不得改写为同义词。
- `stages` 只有 `trial_generate` 与 `full_generate` 可同时出现，其余公式只允许 1 个阶段，不得使用 `global`。
- `usage_scenario` 为 16-300 字符；`not_applicable` 为 1-8 项；`core_formula` 为 16-800 字符；`conditions` 为 1-8 项；`variables` 为 2-12 项；`steps` 为 2-10 项；`observable_checks` 和 `failure_modes` 各为 1-8 项。边界、条件、步骤、标准和失效方式的每项至少 6 字符且意思完整。
- `name` 为 4-80 字符；`goal` 为 16-600 字符；`mechanism` 至少 24 字符；`rewrite_usage` 和 `original_usage` 各至少 24 字符。`genre_adaptations` 为 1-12 条，每条的 `tags` 为 1-8 项，其余三项说明各为 8-600 字符且意思完整。
