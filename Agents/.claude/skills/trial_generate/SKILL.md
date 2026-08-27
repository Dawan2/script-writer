---
name: trial_generate
description: 基于已确认的原剧事实、剧本大纲、角色小传、执行规范和执行策略，生成前十集或全部可用剧集的中文剧本试稿。
---

# 试稿生成

先按`快速开始`选择执行方式。按剧情单元依次生成或修改，完成符合用户和交付要求的`output/剧本试稿.md`。

## 快速开始

后台明确的执行场景优先；未明确时，按下表选择。修复或修改时，不再执行完整的`生成流程`。

| 执行场景 | 判断依据 | 执行方式 |
| --- | --- | --- |
| 首次生成 | 后台要求生成剧本试稿，且未提供上一轮检查问题 | 严格按`生成流程`执行，不可跳过任何一步。 |
| 修复生成结果 | 后台提供上一轮检查问题 | 只修改 `output/剧本试稿.md` 中问题命中的剧集，必要时同步修复相邻剧集承接；然后调用“检查剧本试稿”，未通过时继续定向修改并检查。 |
| 修改已完成内容 | 试稿已通过，用户提出新的修改要求 | 若尚未回到本阶段，先调用“返修路由”；调用“记录用户要求”后重新调用“初始化剧本试稿”和“执行策略”工具，只修改受影响剧集及必要的相邻承接，最后调用“检查剧本试稿”。 |

## 生成流程

先完成`### 开始前准备`的准备工作，再分轮次按`### 每轮执行`，完成每一个剧情单元的写作，每轮：

1. 只读这个剧情单元的输入，按`### 每轮执行`，写或改它的正文，并进行检查；
2. 落盘这个剧情单元，其余范围保持原样；
3. 报告已覆盖范围、剩余范围、未决决定和下一个要做的单元，直到完成所有剧情单元；

### 开始前准备

1. 确认执行要求：
   - 阅读`执行规范.md`，明确本次任务的事实和要求。执行规范缺失或失效时调用“初始化剧本试稿”。工具失败时修复前置状态后重试，不手写进度文件或执行文件。
   - 阅读`执行策略.md`，执行策略缺失或失效时调用“执行策略”，明确后续内容编写时要遵循的原则，以及可使用的公式。公式表只列使用场景和公式名称。需要时调用“读取策略公式”工具，不得一次性读取全部公式。

2. 按场景补充阅读必要信息：
   - 爆款复刻时读取`output/爆款分析报告.md`的对应内容，只转化已明确的功能和机制；
   - 小说改编只按“获取故事剧集信息”返回的高光索引读取原文。

3. 调用`获取故事剧集信息`工具，获取需要完成的剧情单元范围，确定执行轮次。
```bash
node .claude/skills/trial_generate/scripts/get-episode-info.mjs --workspace <项目目录> 
```

### 每轮执行

#### 1. 读取当前真相

调用`获取故事剧集信息`工具，获取当前单元的剧集、角色、前后承接和原剧相关范围。
```bash
node .claude/skills/trial_generate/scripts/get-episode-info.mjs --workspace <项目目录> --unit <单元名称>
```

#### 2. 先定场景功能，再写正文

对每个场景先回答：为什么必须存在、谁的议程对撞、哪个可见动作承载冲突、哪里发生方向性变化、退出状态给下游留下什么。需要场景与可见行动方法时读取：[剧本内容编写方法](../_shared/references/剧本内容编写方法.md)。

读取 [台词编写原则](../_shared/references/台词编写原则.md)，结合当前剧情单元中角色资料，尤其检查人物策略、潜台词、信息争夺和声音差异。

当`执行策略.md`中存在策略公式时，从`执行策略公式表`中按需读取公式；不得为了套用公式改变大纲，也不得读取公式表之外的知识。

#### 3. 以集为粒度，依次完成剧情单元下的正文

按集号顺序完成当前单元。每集写出可观察的目标、阻碍、主动选择、局面变化和下一集必须承接的问题；每场只写可拍动作和人物行动形成的中文台词。

当对本集内容存在疑问时，不要猜测，调用`获取故事剧集信息`工具，获取当前集的详细信息。
```bash
node .claude/skills/trial_generate/scripts/get-episode-info.mjs --workspace <项目目录> --episode <集数>
```

设计当前集的结构，基于当前集的`episodes`，阅读[单集冲突与连续性](references/单集冲突与连续性.md)，保证内容拥有足够吸引用户持续观看的冲突与连续性。

写对白前读取 [台词编写原则](../_shared/references/台词编写原则.md)，角色口吻可以伴随剧情中对话对象、情绪、环境等的变化，在角色当前故事阶段中的口吻基础上，进行合理的调整。

进行编写时，可以按场景获得写作辅助信息：
- 剧本改写：从`output/原始剧本.md` 中对应剧情范围，参照叙事结构、人物台词、环境等，进行合理的调整；
- 爆款复刻：读取`output/爆款分析报告.md`的对应内容；
- 小说改编：调用“读取小说高光原文”工具，按返回的高光索引读取原文。
辅助信息只做参考，不可直接当做正文内容使用。

严格按照[剧本格式规范](../_shared/references/剧本格式规范.md)，完成剧本正文的编写。

正文落定后做一次量级粗测：
- 字数是否满足`单集字数要求`
- 核对时空、人物关系、已知信息、关键物件和结尾问题是否连续
如果不满足需要获取当集的详细信息，并重新编写当前集。

## 检查结果

当完成所有剧情单元的生成、修改后，都需要进行检查。

1. 阅读[试稿自我审稿原则](references/试稿自我审稿原则.md)，将当前试稿当作竞争对手稿件进行对抗性审稿，只修改命中的场景、动作或台词。
2. 调用“检查剧本试稿”。未通过时按返回问题修改并重复检查。

## 内容额外要求

- 试稿只覆盖大纲前 10 集；总集数不足 10 集时覆盖全部剧集。标题必须连续并与大纲一致。
- 每集至少包含一个场景、人物栏、可拍动作和中文台词；动作、表情、道具和空间调度单独成行并以 `△` 开头。
- 每集中文可拍正文字数不得低于初始化工具返回的下限；字数不包含标题和人物栏。
- 人物、地点、信息边界和剧情结果以原始剧本、大纲和角色小传为准。公式和原则不能成为新增剧情事实的依据。
- 用户文件只包含正式剧本标题、场景、动作和台词，不得包含梗概、创作说明、检查结果或内部推理。
- 生成过程中，保留初始化工具生成的剧集标题。

## 工具清单

---
Tool name: 初始化剧本试稿
Tool description: 校验大纲和角色小传、建立试稿框架，并把用户需求、偏好、地区规则和改编上下文写入执行规范。
Usage:
node .claude/skills/trial_generate/scripts/init-trial.mjs --workspace <项目目录> --updated-by <用户>
---

---
Tool name: 执行策略
Tool description: 生成本阶段创作原则和公式目录；标签未确定时不获取知识。
Usage:
node .claude/skills/trial_generate/scripts/get-execution-strategy.mjs --workspace <项目目录>
---

---
Tool name: 读取策略公式
Tool description: 按执行策略公式表中的名称读取完整公式；只在当前剧集或单元决策需要时调用。
Usage:
node .claude/tools/get-strategy-formula.mjs --workspace <项目目录> --stage trial_generate --name <公式名称>
---

---
Tool name: 获取故事剧集信息
Tool description: 返回指定剧集或剧情单元的大纲信息、相关角色资料、前后承接和原剧读取指引。
Usage:
node .claude/skills/trial_generate/scripts/get-episode-info.mjs --workspace <项目目录> (--episode <集数> | --unit <单元名称>)
---

---
Tool name: 读取小说高光原文
Tool description: 小说改编按“获取故事剧集信息”返回的索引读取高光原文；没有索引时不调用。
Usage:
node .claude/skills/novel_analysis/scripts/read-novel-source.mjs --workspace <项目目录> --index <L起始行-L结束行>
---

---
Tool name: 检查剧本试稿
Tool description: 检查执行文件、试稿范围、剧集标题、场景、动作、台词格式和每集字数；通过后等待用户确认。
Usage:
node .claude/skills/trial_generate/scripts/check-trial.mjs --workspace <项目目录> --updated-by <用户>
---

---
Tool name: 批准阶段
Tool description: 用户明确认可通过检查的试稿后，批准进入全稿阶段。
Usage:
node .claude/tools/approve-stage.mjs --workspace <项目目录> --stage trial_generate --approved-by <用户>
---

---
Tool name: 记录用户要求
Tool description: 记录本阶段新增要求；记录后必须重新初始化并生成执行策略。
Usage:
node .claude/tools/update-stage-preferences.mjs --workspace <项目目录> --stage trial_generate --content <要求> --updated-by <用户>
---

---
Tool name: 返修路由
Tool description: 已通过试稿需要实质调整时，回到最早受影响步骤；不删除现有文件。
Usage:
node .claude/tools/route-revision.mjs --workspace <项目目录> --stage trial_generate --reason <返修原因> --updated-by <用户>
---
