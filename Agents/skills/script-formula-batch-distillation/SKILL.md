---
name: script-formula-batch-distillation
description: 根据多部剧本的案例卡或已有公式卡，按创作阶段重组、合并和拆分可按名称调用的公共公式。用于全库初始化或现有公式库重新梳理；不重新读取原剧。
---

本 Skill 的目的，是根据多部剧本案例卡或已有公式，生成少量、完整且调用边界清晰的公共公式。公式表只展示“适用阶段｜使用场景｜公式名称”，这三项必须能独立完成调用判断。

## 工作流程

1. 候选收集时，从案例观察中找出可迁移的写法；现有公式重组时，先审查每张旧卡的阶段粒度、使用场景、核心因果和使用方法。
2. 按创作阶段分组。世界观、故事梗概、人物小传必须独立；试稿与完稿只在使用方法和完成标准一致时可以合并。
3. 对每条候选执行一种决定：保留并改写、与其他公式合并、拆到正确阶段、上提为创作原则、下沉为案例观察或丢弃。只有保留、合并和拆分后仍是公式的内容进入输出。
4. 核心因果和使用方法相同时合并，题材、设定、背景或受众差异写入 `genre_adaptations`。只有核心因果或使用方法改变时拆成不同公式。
5. 输入包含 `existing_principles` 时，删除只是重述现有创作原则的候选。原则规定必须达到的质量底线，公式只保留其中一种可选写法。
6. 为每张公式组装使用场景、不适用情况、创作目标、核心公式、使用前确认、使用方法、生效原因、完成标准和失效方式。
7. 候选收集可以保留单剧线索，但不入库。跨批合并后，正式公式至少需要两部不同剧本支持。
8. 重组旧公式时，只需用 `observation_refs` 标明依据了哪些 `old:<formula_id>`。来源剧本由程序根据旧公式关系自动取并集，不要复制或猜测来源编号。
9. 按调用方给定的 JSON 合同返回结果，再按本 Skill 的准出标准自检。

## 判断边界

- 无论选择什么写法都必须满足的是创作原则，不作为公式输出。
- 只能说明某部剧具体怎么做、换一部剧便无法执行的是案例观察。
- 世界观公式解决世界运行；故事梗概公式解决故事组织；人物小传公式解决人物和关系；试稿与完稿公式解决单集、场景和对白落地。
- 不使用 `global` 表示通用。一个方法如果在多个阶段都有价值，应按各阶段的任务、方法和完成标准分别整理。

## 字段要求

- `usage_scenario`：一句写清当前阶段的任务和希望完成的状态变化，不堆叠多个症状或前提。
- `name`：使用关键动作与目标变化命名，与使用场景一起阅读即可判断是否调用。
- `not_applicable`：调用前就能识别的不适用情况。
- `core_formula`：简明而完整的因果链，说清方法的不变结构。
- `conditions`：使用前需确认的人物、信息、关系、资源和规则条件。
- `steps`：当前阶段能直接执行的使用方法。
- `mechanism`：说明步骤为什么会改变人物选择、故事状态或观众期待。
- `observable_checks`：当前阶段产出中可以直接检查的完成标准。
- `failure_modes`：选对公式但执行不完整或执行错误时的常见失效方式，不与 `not_applicable` 重复。
- `genre_adaptations.tags`：每一项都必须从当前输入的标准标签中逐字复制。多标签拆成多个数组元素，不拼接、概括或造词，不在 `tags` 中写题材说明。
- `creative_decision`、`creative_problem` 和 `expected_effect` 是旧存储的兼容字段，由程序根据 `usage_scenario` 和 `goal` 补全，模型不返回。

## 公式分类

- `story_engine`：可重复产生冲突的回路。
- `world_rule`：权力、资源、规则、限制和代价。
- `character_relationship`：人物欲望、筹码、关系动力和变化。
- `long_arc`：跨阶段的状态变化和代价累积。
- `episode_structure`：单集目标、选择、回报与出口压力。
- `hook_information`：开篇或集末的信息差和未解压力。
- `audience_payoff`：观众期待的建立、加压和释放。
- `emotional_progression`：情绪与事件后果如何一起变化。
- `scene_conflict`：场景中的对抗目标、反制和状态交接。
- `dialogue_action`：对白如何完成争夺、试探、误导、拒绝或承诺。

## 准出标准

- 仅阅读适用阶段、使用场景和公式名称，Agent 就能判断是否值得读取。
- 一张公式只服务一个创作粒度，不横跨世界观、故事、人物和剧本写作。
- 完整公式包含不适用情况、核心因果、使用前确认、使用方法、生效原因、完成标准和失效方式。
- 不是剧情摘要、固定桥段、题材口号或创作原则。
- 公式数量由跨剧本证据决定，不为填满分类而生成。
- 公共公式至少有两部不同剧本或两张有独立来源的旧公式支持，并保留支持关系。

## 硬性输出要求

- 顶层只能是 `{"formula_candidates": [...]}`。
- 每条必须包含 `candidate_id`、`formula_id`、`name`、`category`、`stages`、`usage_scenario`、`not_applicable`、`goal`、`core_formula`、`conditions`、`variables`、`steps`、`mechanism`、`observable_checks`、`failure_modes`、`rewrite_usage`、`original_usage`、`genre_adaptations`、`observation_refs`。候选收集和入库合并模式还必须返回 `source_script_ids`；旧公式重组模式不返回，由程序自动补全。
- `category` 只能使用本 Skill 列出的十种公式分类，不得使用同义词或自造分类。
- `stages` 只有 `trial_generate` 与 `full_generate` 可同时出现，其余公式只允许 1 个阶段，不得使用 `global`。
- `usage_scenario` 为 16-300 字符；`not_applicable` 为 1-8 项，每项至少 6 字符且意思完整；`core_formula` 为 16-800 字符。
- `name` 为 4-80 字符；`goal` 为 16-600 字符；`conditions` 为 1-8 项；`variables` 为 2-12 项；`steps` 为 2-10 项；`mechanism` 为 24-1000 字符；`observable_checks` 和 `failure_modes` 各为 1-8 项；`rewrite_usage` 和 `original_usage` 各为 24-1000 字符。条件、步骤、标准和失效方式每项至少 6 字符且意思完整。
- `genre_adaptations` 为 1-12 项，每项包含 `tags`、`difference`、`usage_adjustment`、`boundary_adjustment`。三项说明都要意思完整，各为 8-600 字符。
- 候选收集时 `formula_id` 为空，`source_script_ids` 至少 1 个。入库合并时 `source_script_ids` 至少 2 个；复用已有公式时填入真实 `formula_id`，否则留空。旧公式重组时以调用方给出的更具体要求为准。
- `observation_refs` 必须识别真实支持来源。公式正文不得残留剧名、人名、地点、组织和专属道具。

只返回调用方约定的 JSON 对象，不返回 Markdown 或解释文字。
