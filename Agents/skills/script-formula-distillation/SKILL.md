---
name: script-formula-distillation
description: 根据全剧事实索引和案例卡，把少量具体写法抽象成使用边界清晰、能按名称调用、能指导完整创作任务的公式候选。用于剧本蒸馏的公式卡提炼；不重新读取原文，不比较公式库，不为凑数量生成内容。
---

本 Skill 的目的，是根据全剧事实索引和案例卡，生成能够进入公式表并按名称获取的公式候选。

公式不是口号、剧情摘要、固定桥段，也不是替换了原剧人名的同一套剧情。公式表只会向后续 Agent 展示“适用阶段｜使用场景｜公式名称”，因此这三项必须足以判断是否需要打开这张卡；完整公式卡必须足以指导打开后的创作。

## 工作流程

1. 从案例卡的 `key_observations` 中选择可以迁移的关键写法，不从剧情摘要中抽公式。
2. 先确定写法所属的创作阶段，再将它转换为“当该阶段需要完成什么任务，并希望什么状态发生变化时”的使用场景。
3. 按“使用场景 → 创作目标 → 核心公式 → 使用前确认 → 使用方法 → 完成标准 → 不适用情况与常见失效方式”组装公式。
4. 去掉原剧人名、地名、组织名、专属道具和不可替换的连续情节，保留可替换内容、因果、方法和边界。
5. 检查抽象粒度。世界观只谈世界运行，故事梗概只谈故事组织，人物小传只谈人物与关系，试稿与完稿只谈写作落地。不得让一张公式横跨不同粒度。
6. 根据本剧标签写出题材和受众差异。只有核心因果或使用方法改变时才拆分公式。
7. 每条候选保持 `unresolved` 和 `single_case`，等待后续与公式库比对。没有合格候选时返回空数组和原因。
8. 按调用方提供的 JSON Schema 返回完整对象，再按本 Skill 的准出标准自检。

多条观察的使用场景、核心因果、使用方法和失效方式一致时，应合并为一条候选。不要一条观察生成一张卡，也不要为每个分类硬生成一张卡。

## 什么是合格的公式

合格公式必须让 Agent 先根据阶段、使用场景和名称决定是否读取，读取后又能根据完整卡片直接完成当前创作任务。它要说清使用边界、不变因果、操作方法、生效原因和可检查结果。

## 公式粒度

- `world_view`：解决权力、资源、规则、限制和代价如何组成可运行的世界。
- `outline_rewrite`：解决主线、阶段、冲突、铺垫和兑现如何组织与推进。
- `character_rewrite`：解决人物欲望、筹码、关系动力和人物变化如何成立。
- `trial_generate`、`full_generate`：解决单集、场景、钩子、情绪、回报和对白如何落地。两个阶段在方法和完成标准一致时可共用。

其他阶段只有在存在对应的独立创作任务时才能标注。不使用 `global`，不为了表示“通用”而横跨阶段。

## 字段含义

- `name`：用“关键动作 + 目标变化”命名，与 `usage_scenario` 一起阅读时能判断是否值得调用。不使用原剧专名、题材口号或“黄金公式”等空名。
- `category`：公式的内容分类，用于知识管理，不用于代替使用场景。
- `stages`：适用阶段。世界观、故事梗概、人物小传分别单独使用；试稿与完稿可同时标注。
- `usage_scenario`：一句写清“当当前阶段需要完成什么任务，并希望什么状态发生变化时”。不写多个并列问题，不写只适用于某场戏的细节。
- `not_applicable`：打开公式前可以判定不应调用的情况。
- `creative_decision`：与 `usage_scenario` 保持同义的兼容字段，使用陈述句而不是“如何……”问句。
- `creative_problem`：与 `usage_scenario` 保持同义的兼容字段，不另外堆叠一组症状。
- `goal`：使用后需要建立的故事效果、观众理解或状态变化。
- `core_formula`：用简明的因果链表达公式的不变结构，不是标题的重复。
- `conditions`：使用前确认，包括人物、信息、关系、资源和规则条件。
- `variables`：换一部剧时可以替换的人物、关系、资源、秘密、场景或规则。
- `steps`：使用方法。每步要写当前阶段能完成的创作动作，不得把大纲动作写进世界观公式，也不得把场景操作写进人物公式。
- `mechanism`：解释每一步为什么会改变人物选择、故事状态或观众期待。
- `expected_effect`：与 `goal` 保持同义的兼容字段。
- `observable_checks`：完成标准，必须能在该阶段产出中直接检查。
- `failure_modes`：选择公式后执行不完整或执行错误时的常见失效方式，不与 `not_applicable` 重复。
- `rewrite_usage`：改写时以原剧已有人物、世界和主线为主，只用公式改善当前阶段的内容。
- `original_usage`：新创作时如何用新人物、新规则和新关系完成这套方法。
- `genre_adaptations`：本剧标签下的行动重点、回报重点和边界差异。`tags` 的每一项必须从本剧已选标准标签中逐字复制；多标签拆成多个数组元素，不拼接、概括或造词。
- `applicable_tags`：当前单剧证据已支持的主题、设定、背景和受众标签。
- `observation_refs`、`evidence_references`：案例卡观察和原文证据。
- `catalog_decision`：单剧蒸馏保持 `unresolved`；`maturity` 保持 `single_case`。

## 公式分类

- `story_engine`：可重复产生冲突的回路。
- `world_rule`：权力、资源、规则、限制和代价。
- `character_relationship`：人物欲望、筹码、关系动力和变化。
- `long_arc`：跨阶段的状态运动和代价累积。
- `episode_structure`：单集目标、选择、回报与出口压力。
- `hook_information`：开篇或集末的信息差和未解压力。
- `audience_payoff`：观众等待的建立、加压和释放。
- `emotional_progression`：情绪与事件后果如何一起变化。
- `scene_conflict`：场景中的对抗目标、反制和状态交接。
- `dialogue_action`：对白如何完成争夺、试探、误导、拒绝或承诺。

## 公式迁移检验

删除原剧专名，换成新人物、新关系和新题材后，公式仍应保留清晰的使用条件、执行步骤、生效机制和可检查结果，并能分别说明改写和新创作用法。任一项只能通过复述原剧来解释时，降为案例观察，不生成公式。

## 拒绝生成

- 只是剧情摘要、题材口号或固定桥段。
- 使用场景只能指向某场戏、某个人设细节，或需要先阅读整张卡才能理解。
- 一张卡同时指导世界观、梗概、人物和场景写作。
- 无论采用什么写法都必须满足，实际应归入创作原则。
- 删掉专名后就不知道在说什么，或换人物、关系和题材后无法执行。
- 没有使用场景、不适用情况、核心公式、使用方法、完成标准或失效方式。

## 准出标准

- 使用场景和公式名称能单独完成调用判断。
- 每条公式只对应一个创作粒度，有明确阶段、不适用情况、核心因果、使用前确认和至少两步方法。
- 公式解释了为什么生效，也给出该阶段可直接检查的完成标准。
- 公式区分不适用情况和执行中的常见失效方式，并说明改写与新创作用法。
- 证据与关键写法观察有交集，公式已去除原剧专名，不强行超越单剧证据。

## 硬性输出要求

- 顶层只返回 `formula_candidates` 和 `no_formula_reason`。公式候选为 0-8 条；为空时，`no_formula_reason` 必须为 20-600 字符。
- 每条必须返回 `candidate_id`、`category`、`name`、`stages`、`usage_scenario`、`not_applicable`、`creative_decision`、`creative_problem`、`goal`、`core_formula`、`conditions`、`variables`、`steps`、`mechanism`、`expected_effect`、`observable_checks`、`failure_modes`、`rewrite_usage`、`original_usage`、`genre_adaptations`、`applicable_tags`、`observation_refs`、`evidence_references`、`catalog_decision`、`maturity`，不得增加 Schema 之外的字段。
- `candidate_id` 使用不重复的 `F01` 格式。`category` 只能从本 Skill 列出的十种分类中选择。
- `stages` 只能使用系统创作阶段；只有 `trial_generate` 与 `full_generate` 可同时出现，其余公式只允许 1 个阶段。
- `usage_scenario` 为 16-300 字符；`not_applicable` 为 1-6 项，每项至少 6 字符且意思完整；`core_formula` 为 16-600 字符。
- `creative_decision` 和 `creative_problem` 必须与 `usage_scenario` 完全一致；`expected_effect` 必须与 `goal` 完全一致。
- `name` 为 4-80 字符，`goal` 为 16-600 字符，`mechanism` 为 24-800 字符，`rewrite_usage` 和 `original_usage` 各为 24-800 字符。
- `conditions` 为 1-6 项，`variables` 为 2-10 项，`steps` 为 2-8 项，`observable_checks` 和 `failure_modes` 各为 1-6 项；除 `variables` 外，每项至少 6 字符且意思完整。
- `genre_adaptations` 为 1-6 条。每条的 `tags` 为 1-8 个且只能从当前剧本已选标签中取值，`difference`、`usage_adjustment`、`boundary_adjustment` 各为 8-600 字符，并写成意思完整的说明。
- `applicable_tags` 为 1-8 项，只能使用当前剧本已选标签；`observation_refs` 为 1-10 项，必须引用当前案例卡中真实存在的关键写法 ID。
- `evidence_references` 至少引用 1 个真实原文编号，并与 `observation_refs` 所引写法的证据至少有 1 个交集。
- `catalog_decision.action` 必须是 `unresolved`，`target_id` 必须为空字符串，`reason` 为 12-600 字符；`maturity` 必须是 `single_case`。
- 名称、使用场景、边界、因果、条件、方法、原因、标准和用法中都不得出现案例卡 `source_specific_terms` 中的原剧专名。
