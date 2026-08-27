---
name: world_view
description: 根据当前任务的源材料、执行规范和目标地区，构建新剧本的世界观及关键概念映射。用于剧本改写、爆款复刻和新剧本创作的世界观阶段。
---

本 Skill 的目的，是根据当前任务事实、执行策略和源材料，生成 `2.1-world-view.json`。

## 快速开始

后台明确的执行场景优先；未明确时，按下表选择。修复或修改时，不再执行完整的`生成流程`。

| 执行场景 | 判断依据 | 执行方式 |
| --- | --- | --- |
| 首次生成 | 后台要求生成世界观，且未提供上一轮检查问题 | 按`生成流程`执行。 |
| 修复生成结果 | 后台提供上一轮检查问题 | 只修改问题命中的世界观字段，然后调用“检查世界观”；未通过时继续修改命中字段并检查，直到通过。 |
| 修改已完成内容 | 世界观已通过，用户提出新的修改要求 | 若尚未回到本阶段，先调用“返修路由”；调用“记录用户要求”后重新调用“初始化世界观”和“执行策略”，只修改受影响字段，最后调用“检查世界观”。 |

## 生成流程

1. 按后台返回路径依次阅读`执行规范.md`和`执行策略.md`。执行规范缺失或失效时调用“初始化世界观”；执行策略缺失或失效时调用“执行策略”。工具失败时按错误修复前置状态后重试，不手写进度文件或执行文件。
2. `执行策略.md`的公式表只列使用场景和公式名称。当前创作决策需要时，按工具清单中的“读取策略公式”调用。
3. 阅读[世界观构建原则](references/world-view-principles.md)。
4. 根据任务场景完善 `2.1-world-view.json`：
   - 剧本改写：深度阅读 `output/原始剧本.md`，结合原剧事实和执行规范完善世界观。关键概念映射必须保留原概念的剧情功能、权力关系或冲突作用；不得用公式或外部案例改变原剧基础设定。
   - 爆款复刻：深度阅读 `output/爆款分析报告.md`，保留已确认的剧情功能、权力关系和冲突作用，不沿用原作具体人名、地点或专有设定。
   - 新剧本创作：深度阅读执行规范“原始材料”指向的灵感或残稿，先保留必须保留的内容，再按执行策略补全世界运行方式。
5. 先逐条对照执行策略中每条原则的“通过标准”自查，再调用“检查世界观”。未通过时按工具返回的修复动作处理并重复检查；通过后进度进入 `outline_rewrite`。

收到本阶段新增用户要求时，按`快速开始`中的“修改已完成内容”执行。

## 资料文件清单

- `执行规范.md`：本次任务已经确定的事实、用户要求、用户偏好和地区规则。
- `执行策略.md`：创作开始前生成的创作原则，以及只包含使用场景和公式名称的可用公式目录。
- [世界观构建原则](references/world-view-principles.md)：世界观的固定质量、改写边界、格式和准出要求。
- [世界观构建框架](references/world-view.json5)：仅在需要确认 `2.1-world-view.json` 字段含义时阅读。
- `output/原始剧本.md`：剧本改写的事实来源；仅在剧本改写时深度阅读。
- `output/爆款分析报告.md`：爆款复刻的事实与机制来源；仅在爆款复刻时深度阅读。
- `2.1-world-view.json`：本阶段唯一可写交付文件。

## 工具清单

---
Tool name: 初始化世界观
Tool description: 幂等准备世界观文件，并把当前任务事实和要求写入执行规范；知识库内容不在此时获取。
Usage:
node .claude/skills/world_view/scripts/init-world-view.mjs --workspace <项目目录> --updated-by <用户>
---

---
Tool name: 执行策略
Tool description: 重新生成世界观执行策略。后台准备的文件缺失、失效或剧本标签被重新解析时调用；任一标签缺失或仍为自动适配时返回空策略，不读取知识库。
Usage:
node .claude/skills/world_view/scripts/get-execution-strategy.mjs --workspace <项目目录>
---

---
Tool name: 读取策略公式
Tool description: 按执行策略公式表中的公式名称，读取本次任务冻结的完整公式内容；只有执行策略列出该公式且当前创作决策需要时调用。
Usage:
node .claude/tools/get-strategy-formula.mjs --workspace <项目目录> --stage world_view --name <公式名称>
---

---
Tool name: 解析剧本设定
Tool description: 将缺失或仍为自动适配的受众、主题、背景和设定写回发行配置；后台预处理未完成时调用，完成后重新初始化。
Usage:
node .claude/tools/resolve-script-profile.mjs --workspace <项目目录> --stage world_view --updated-by <用户> --audience <受众> --theme <主题，逗号分隔> --background <背景，逗号分隔> --setting <设定，逗号分隔>
---

---
Tool name: 检查世界观
Tool description: 检查执行规范、执行策略、剧本标签和世界观交付结构；通过后更新进度。
Usage:
node .claude/skills/world_view/scripts/check-world-view.mjs --workspace <项目目录> --updated-by <用户>
---

---
Tool name: 记录用户要求
Tool description: 记录本阶段新增要求；记录后必须重新初始化以刷新执行规范。
Usage:
node .claude/tools/update-stage-preferences.mjs --workspace <项目目录> --stage world_view --content <要求> --updated-by <用户>
---

---
Tool name: 返修路由
Tool description: 已通过的世界观需要实质调整时，回到最早受影响步骤；不删除已有文件。
Usage:
node .claude/tools/route-revision.mjs --workspace <项目目录> --stage world_view --reason <返修原因> --updated-by <用户>
---
