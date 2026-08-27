---
name: character_rewrite
description: 基于已完成的剧本大纲、执行规范和执行策略，为全部关键角色编写角色小传与阶段变化。用于剧本改写、小说改编和爆款复刻场景。
---

本 Skill 的目的，是根据 `3.1-outline.json`、当前任务事实和创作策略，生成 `4.1-character.json`；检查通过后生成 `output/角色小传.md`。

## 快速开始

后台明确的执行场景优先；未明确时，按下表选择。修复或修改时，不再执行完整的`生成流程`。

| 执行场景 | 判断依据 | 执行方式 |
| --- | --- | --- |
| 首次生成 | 后台要求生成角色小传，且未提供上一轮检查问题 | 按`生成流程`执行。 |
| 修复生成结果 | 后台提供上一轮检查问题 | 只修改 `4.1-character.json` 中问题命中的角色、关系或阶段变化，然后调用“检查角色小传”；未通过时继续定向修改并检查。 |
| 修改已完成内容 | 角色小传已通过，用户提出新的修改要求 | 若尚未回到本阶段，先调用“返修路由”；调用“记录用户要求”后重新调用“初始化角色小传”和“执行策略”，只修改受影响角色及必要的关系和后续阶段，最后调用“检查角色小传”。 |

## 生成流程

1. 按后台返回路径依次阅读`执行规范.md`和`执行策略.md`。执行规范缺失或失效时调用“初始化角色小传”；执行策略缺失或失效时调用“执行策略”。工具失败时修复前置状态后重试，不手写进度文件或执行文件。
2. 确认执行策略中的创作原则。只有四类标签都已确定时，执行策略才会包含原则和公式。公式表只列使用场景和公式名称；适合当前角色类型或关系设计时，按工具清单中的“读取策略公式”调用。公式用于丰满角色的驱动力、行动方式、关系弧光和阶段变化，不得替换大纲已确定的人设主线、剧情行为或结局。
3. 深度阅读 `3.1-outline.json`，确认故事主线、关键角色名称映射、各角色的出场位置、行动、关系和局面变化。阅读[角色小传编写原则](references/角色小传编写原则.md)。爆款复刻时，同时阅读`output/爆款分析报告.md`中与人物有关的内容，只转化明确的人物功能、权力位置和冲突作用，不沿用具体人名、地点或专有设定。
4. 以初始化工具已建立的角色名单为范围，逐人填写稳定资料：身份、阵营、人物关系、性别、国籍、主线年龄、外貌、穿着、性格、核心诉求、人物难题和关系弧光。所有内容都必须能由大纲中的行动解释。
5. 按“开篇”和剧情单元顺序填写阶段变化。只要身份与处境、人物形象或口吻发生变化，就增加对应阶段；不能提前写入后期才获得的身份、资源、认知或关系。
6. 逐条对照执行策略中原则的“通过标准”自查，再调用“检查角色小传”。未通过时按返回问题修改 `4.1-character.json` 并重复检查；通过后进入 `trial_generate`，完整剧本曾完成过时进入 `full_generate`。

收到本阶段新增用户要求时，按`快速开始`中的“修改已完成内容”执行。

## 资料文件清单

- `执行规范.md`：本次任务事实、用户要求、用户偏好、地区规则和改编上下文。
- `执行策略.md`：当前阶段的创作原则，以及只包含使用场景和公式名称的可用公式目录。
- `3.1-outline.json`：角色范围、名称、行动、关系、剧情单元和阶段顺序的唯一事实来源。
- `output/爆款分析报告.md`：仅爆款复刻时读取，用于转化人物功能、权力位置和冲突作用。
- [角色小传编写原则](references/角色小传编写原则.md)：编写角色稳定资料、人物关系、关系弧光和阶段变化时读取。
- [角色小传构建框架](references/character.json5)：仅在确认 `4.1-character.json` 字段含义时读取。
- `4.1-character.json`：本阶段唯一可写内容文件。
- `output/角色小传.md`：检查通过后自动生成，不手写。

## 工具清单

---
Tool name: 初始化角色小传
Tool description: 校验大纲、建立角色框架，并把用户需求、偏好、地区规则和改编上下文写入执行规范。
Usage:
node .claude/skills/character_rewrite/scripts/init-character.mjs --workspace <项目目录> --updated-by <用户>
---

---
Tool name: 执行策略
Tool description: 生成本阶段创作原则和公式目录；标签未确定时不获取知识。
Usage:
node .claude/skills/character_rewrite/scripts/get-execution-strategy.mjs --workspace <项目目录>
---

---
Tool name: 读取策略公式
Tool description: 按执行策略公式表中的名称读取完整公式；只在当前角色创作决策需要时调用。
Usage:
node .claude/tools/get-strategy-formula.mjs --workspace <项目目录> --stage character_rewrite --name <公式名称>
---

---
Tool name: 检查角色小传
Tool description: 检查执行文件、角色覆盖、人物画像、关系图谱和阶段变化；通过时生成用户可读角色小传。
Usage:
node .claude/skills/character_rewrite/scripts/check-character.mjs --workspace <项目目录> --updated-by <用户>
---

---
Tool name: 记录用户要求
Tool description: 记录本阶段新增要求；记录后必须重新初始化并生成执行策略。
Usage:
node .claude/tools/update-stage-preferences.mjs --workspace <项目目录> --stage character_rewrite --content <要求> --updated-by <用户>
---

---
Tool name: 返修路由
Tool description: 已通过角色小传需要实质调整时，回到最早受影响步骤；不删除现有文件。
Usage:
node .claude/tools/route-revision.mjs --workspace <项目目录> --stage character_rewrite --reason <返修原因> --updated-by <用户>
---
