---
name: humanizer-zh
description: 对中文剧本进行去AI味修订，识别并消除模板化、空泛、机械的 AI 写作痕迹，同时保留故事事实、角色策略、可拍动作和分集结构，生成自然可演的中文剧本。用于独立“剧本润色”任务。
---

本 Skill 的目的，是根据 `output/原始剧本.md`、用户额外要求、该阶段用户偏好和目标地区规则，生成 `output/去AI味剧本.md`。它保留 Humanizer-zh 的 AI 痕迹识别方法，但把“人味”落实为角色声音、行动、反应和潜台词，而不是编剧的作者腔。

## 工作流程

1. 调用“初始化剧本润色”，确认原始剧本已准备，并取得待编辑的 `output/去AI味剧本.md`。已有润色剧本时以它为底稿，不覆盖用户已保存的内容。
2. 调用“读取用户需求”工具，确认任务初始要求、目标地区、目标市场、主要交付语言和内容分级。仅在返回“用户额外要求”时落实；未返回时不虚构额外限制。
3. 调用“读取用户偏好”，只采用 `humanizer_zh` 和全局偏好。调用“获取地区规则”，读取改编规则；地区规则只用于尊重既有语言设定、称谓和文化边界，不把中文剧本强行翻成目标语，也不凭空添加方言、地域标签或现实细节。
4. 阅读[台词编写原则](../_shared/references/台词编写原则.md)。
5. 逐集对照阅读 `output/原始剧本.md` 和待编辑的 `output/去AI味剧本.md`。先为每场确认人物目标、阻碍、策略、已知信息、可拍动作和集尾承接，形成不可改变的事实边界。
6. 阅读[剧本去AI味原则](references/剧本去AI味原则.md)和[剧本去AI味模式库](references/剧本去AI味模式库.md)。先诊断实际存在的 AI 痕迹，再改写命中的句子；不因某个词、破折号、三段式或停顿出现，就机械替换。角色口头禅、故意重复、碎句、夸张和强记忆点台词，只要服务人物策略、冲突或节奏，应当保留。
7. 逐场修订命中的内容。优先删去填充、空泛拔高、宣传式形容、模板化转折、解释性旁白和交付元话语；把无依据的概括落回可见的动作、选择、反应、关系压力和潜台词。对白应保留角色的身份、情绪和当下策略，不能统一成“自然口语”。
8. 不得改变故事事实、人物关系与目标、因果、时间地点、分集顺序、可拍动作、专名、既有外语台词或语言设定；不得新增剧情、删减有效信息、加入第一人称作者观点、修改说明或任何交付元话语。原剧已有旁白、口音、方言或格式时，除非本身是无事实依据的 AI 套话，否则保持其功能与信息。
9. 完成后，以朗读和表演的方式把结果当作竞争对手的剧本稿逐集复核：每场是否仍可拍，人物是否仍在主动行动，对白是否有可辨认的声线，信息是否由戏而非解释承担，集尾问题是否仍能承接。按[剧本去AI味验收规则](references/剧本去AI味验收规则.md)完成五维评分；低于交付线时，只重写命中的场景、动作或台词。
10. 调用“检查剧本润色”。若未通过，只根据返回的问题修复 `output/去AI味剧本.md`，重复检查直至通过。

收到本阶段新增要求时，先记录并重新读取用户偏好；已完成剧本需要实质调整时，先调用返修路由，再重新执行本 Skill。

## 资料文件清单

- `output/原始剧本.md`：原始剧本事实和结构基线；逐集处理时对照读取。
- `output/去AI味剧本.md`：本阶段唯一用户交付文件；直接修订此文件。
- [剧本去AI味原则](references/剧本去AI味原则.md)：在开始诊断前读取；说明剧本修订的事实边界、逐场方法和台词例外。
- [剧本去AI味模式库](references/剧本去AI味模式库.md)：诊断和改写命中的 AI 痕迹时按需读取；保留并剧本化 Humanizer-zh 的核心方法论。
- [剧本去AI味验收规则](references/剧本去AI味验收规则.md)：自审、五维评分和最终检查前读取。
- [台词编写原则](../_shared/references/台词编写原则.md)：在开始修订前读取；说明台词的格式、内容和风格。

## 工具清单

---
Tool name: 初始化剧本润色
Tool description: 基于原始剧本准备润色剧本，保留已有用户内容，并更新当前阶段进度。
Usage:
node .claude/skills/humanizer-zh/scripts/init-humanizer-zh.mjs --workspace <项目目录> --updated-by <用户>
---

---
Tool name: 读取用户需求
Tool description: 返回当前项目已明确的任务、发行和素材要求；初始化后调用。
Usage:
node .claude/tools/get-user-requirements.mjs --workspace <项目目录>
---

---
Tool name: 读取用户偏好
Tool description: 读取本阶段可用的用户要求与已启用偏好。
Usage:
node .claude/tools/get-user-preferences.mjs --workspace <项目目录> --stage humanizer_zh
---

---
Tool name: 获取地区规则
Tool description: 返回当前目标地区的改编规则，用于保护语言与文化边界。
Usage:
node .claude/tools/get-region-rules.mjs --workspace <项目目录> --stage humanizer_zh
---

---
Tool name: 检查剧本润色
Tool description: 检查用户交付文件、分集结构和交付元话语；通过后更新进度。
Usage:
node .claude/skills/humanizer-zh/scripts/check-humanizer-zh.mjs --workspace <项目目录> --updated-by <用户>
---

---
Tool name: 记录用户要求
Tool description: 记录当前步骤新增的润色要求。
Usage:
node .claude/tools/update-stage-preferences.mjs --workspace <项目目录> --stage humanizer_zh --content <要求> --updated-by <用户>
---

---
Tool name: 返修路由
Tool description: 已完成剧本需要实质调整时回到本步骤，不删除现有交付文件。
Usage:
node .claude/tools/route-revision.mjs --workspace <项目目录> --stage humanizer_zh --reason <返修原因> --updated-by <用户>
---
