---
name: outline_rewrite
description: 基于当前场景已确认的改编资料、执行规范和执行策略，重构连续剧情单元与分集大纲，并生成故事梗概。用于剧本改写、小说改编和爆款复刻场景。
---

本 Skill 的目的，是根据当前任务事实、改编资料和上游世界观，生成 `3.1-outline.json`；检查通过后生成用户可读的故事梗概。

## 快速开始

后台明确的执行场景优先；未明确时，按下表选择。修复或修改时，不再执行完整的`生成流程`。

| 执行场景 | 判断依据 | 执行方式 |
| --- | --- | --- |
| 首次生成 | 后台要求生成剧本大纲，且未提供上一轮检查问题 | 按`生成流程`执行。 |
| 修复生成结果 | 后台提供上一轮检查问题 | 只修改 `3.1-outline.json` 中问题命中的名称映射、开篇、剧情单元或分集内容，然后调用“检查剧本大纲”；未通过时继续定向修改并检查。 |
| 修改已完成内容 | 大纲已通过，用户提出新的修改要求 | 若尚未回到本阶段，先调用“返修路由”；调用“记录用户要求”后重新调用“初始化剧本大纲”和“执行策略”，只修改受影响内容及必要的后续承接，最后调用“检查剧本大纲”。 |

## 生成流程

1. 按后台返回路径依次阅读`执行规范.md`和`执行策略.md`。执行规范缺失或失效时调用“初始化剧本大纲”；执行策略缺失或失效时调用“执行策略”。工具失败时修复前置状态后重试，不手写进度文件或执行文件。
2. `执行策略.md`的公式表只列使用场景和公式名称。与当前大纲决策相关时，按工具清单中的“读取策略公式”调用；公式不得改写原剧主线事实。
3. 阅读[原剧事实读取与改编边界](references/原剧事实读取与改编边界.md)、[剧本大纲编写原则](references/剧本大纲编写原则.md)和[关系推进与伏笔编排](references/关系推进与伏笔编排.md)。
4. 根据任务场景读取资料并完成事实提取：
   - 剧本改写场景：阅读[剧本改写场景执行步骤](references/剧本改写场景执行步骤.md)，**严格执行**其中的`操作步骤`，阅读相关材料，并完成相关文件操作；
   - 小说改编场景：阅读[小说改编场景执行步骤](references/小说改编场景执行步骤.md)，**严格执行**其中的`操作步骤`，阅读相关材料，并完成相关文件操作；
   - 爆款复刻场景：阅读[爆款复刻场景执行步骤](references/爆款复刻场景执行步骤.md)，**严格执行**其中的`操作步骤`，阅读相关材料，并完成相关文件操作；
5. 先完成关键角色名称映射，再完成新的剧本名称、故事梗概、第 1 集开篇、连续剧情单元和逐集梗概。每集写清开场冲突、主要转折、结尾承接和剧集梗概；总集数与执行规范一致。
6. 逐条对照执行策略中原则的“通过标准”自查，再调用“检查剧本大纲”。未通过时按返回问题修改 `3.1-outline.json` 并重复检查；通过后进入 `character_rewrite`。

收到本阶段新增用户要求时，按`快速开始`中的“修改已完成内容”执行。

## 资料文件清单

- `执行规范.md`：本次任务事实、用户要求、用户偏好、地区规则和改编上下文。
- `执行策略.md`：当前阶段的创作原则，以及只包含使用场景和公式名称的可用公式目录。
- [小说改编场景执行步骤](references/小说改编场景执行步骤.md)：仅小说改编时读取。
- [爆款复刻场景执行步骤](references/爆款复刻场景执行步骤.md)：仅爆款复刻时读取。
- [剧本大纲构建框架](references/outline.json5)：仅在确认 `3.1-outline.json` 字段含义时读取。
- `output/原始剧本.md`：仅剧本改写时作为事实来源深度阅读。
- `2.1-world-view.json`：已确认的世界观与概念映射。
- `3.1-outline.json`：本阶段唯一可写内容文件。

## 工具清单

---
Tool name: 初始化剧本大纲
Tool description: 幂等准备大纲文件，并把用户需求、偏好、地区规则和改编上下文写入执行规范。
Usage:
node .claude/skills/outline_rewrite/scripts/init-outline.mjs --workspace <项目目录> --updated-by <用户>
---

---
Tool name: 执行策略
Tool description: 生成本阶段创作原则和公式目录；标签未确定时不获取知识。
Usage:
node .claude/skills/outline_rewrite/scripts/get-execution-strategy.mjs --workspace <项目目录>
---

---
Tool name: 读取策略公式
Tool description: 按执行策略公式表中的名称读取完整公式；只在当前创作决策需要时调用。
Usage:
node .claude/tools/get-strategy-formula.mjs --workspace <项目目录> --stage outline_rewrite --name <公式名称>
---

---
Tool name: 检查剧本大纲
Tool description: 检查执行文件、名称映射、开篇、剧情单元、分集连续性和总集数；通过时生成用户可读故事梗概。
Usage:
node .claude/skills/outline_rewrite/scripts/check-outline.mjs --workspace <项目目录> --updated-by <用户>
---

---
Tool name: 记录用户要求
Tool description: 记录本阶段新增要求；记录后必须重新初始化并生成执行策略。
Usage:
node .claude/tools/update-stage-preferences.mjs --workspace <项目目录> --stage outline_rewrite --content <要求> --updated-by <用户>
---

---
Tool name: 返修路由
Tool description: 已通过大纲需要实质调整时回到最早受影响步骤；不删除现有文件。
Usage:
node .claude/tools/route-revision.mjs --workspace <项目目录> --stage outline_rewrite --reason <返修原因> --updated-by <用户>
---
