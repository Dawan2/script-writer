---
name: script-principle-batch-distillation
description: 根据多部剧本的案例卡和公共公式，提炼少量跨题材、可审稿的创作原则。用于剧本库初始化，不重新读取原文。
---

本 Skill 的目的，是把多部剧本反复出现的阶段质量要求提炼成执行层创作原则。原则不是公式的缩写，也不按题材、设定、背景或受众分类。

## 工作流程

1. 只阅读调用方提供的案例卡、公共公式和标签摘要，不重新读取原始剧本。
2. 按创作阶段和保护的质量目标分组，寻找多张公式、多部剧本共同支持的质量要求。
3. 只有换一种有效写法仍必须满足、能跨题材成立、能直接用于新文本审稿的内容才能成为原则。单剧技巧、具体解法和爽点偏好留在公式或案例卡。
4. 先与同阶段的候选和已有原则做包含关系检查。如果一条只是另一条在某种角色、关系或桥段中的具体应用，并入上位原则，不单独建立。
5. 说明原则何时适用、保护什么、何时需要调整，以及审稿时如何检查。
6. 原则要少而精。同一阶段、同一质量要求只保留一条，并合并来源观察。
7. 输出前按下方结构和准出标准自查；任一字段不合格时，修复后返回完整 JSON。

## 输出结构

- 顶层只能是 `{"principle_candidates": [...]}`，不得增加其他字段。
- 每条必须包含 `candidate_id`、`principle_id`、`title`、`stages`、`statement`、`rationale`、`applies_when`、`fails_or_changes_when`、`review_criteria`、`source_script_ids`、`related_formula_ids`、`evidence_references`。
- `candidate_id` 以英文字母开头，只使用英文字母、数字、下划线或连字号，总长度为 2–40 个字符，且不能重复。
- 候选收集时 `principle_id` 必须为空字符串，`source_script_ids` 至少包含 1 个输入剧本 ID。
- 跨批合并时 `source_script_ids` 至少包含 2 个不同的输入剧本 ID，`related_formula_ids` 至少包含 2 张真实公式。已有原则完整覆盖当前质量要求时，`principle_id` 填真实的已有 ID；否则留空。

## 合格原则的字段

- `title`：至少 4 个字符，用清楚的质量要求命名，不使用题材或剧名。
- `stages`：必须且只能填 1 项，只能使用 `global`、`novel_analysis`、`world_view`、`outline_rewrite`、`character_rewrite`、`trial_generate`、`full_generate`、`dialogue_translate`、`foreign_review`。
- `statement`：至少 20 个字符，用“当什么条件出现时，应该怎么做”写成可执行要求。
- `rationale`：至少 20 个字符，说明它保护的因果、人物可信度、观众理解或交付质量。
- `applies_when`、`fails_or_changes_when`、`review_criteria`：各1–6 项，每项至少 8 个字符。检查项必须能在新文本中直接定位。
- `related_formula_ids`：必须是数组，只能填输入中真实存在且确实支撑该原则的公式 ID。
- `evidence_references`：必须是非空数组，只填输入中能支撑该原则的观察或公式索引。

## 准出标准

- 原则跨题材成立，不依赖专名、特定人物、道具、桥段或单一回报类型。
- 原则可以直接审稿，不是“增强戏剧性”“人物要立体”这类口号。
- 不能因为标签不同重复建原则，也不能把上位原则的具体应用另立为原则。
- 正式原则必须由两张以上公式和两部以上剧本共同支持。证据不足时不生成，也不自动进入可用状态。

只返回调用方约定的 JSON 对象，不返回 Markdown 或解释文字。
