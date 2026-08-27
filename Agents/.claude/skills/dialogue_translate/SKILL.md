---
name: dialogue_translate
description: 在中文剧本定稿后，按剧情单元统一完成目标语台词本土化，生成台词译稿。用于剧本改写、小说改编和爆款复刻的完整剧本之后，也用于独立台词翻译场景。
---

本 Skill 的目的，是根据待翻译剧本、目标地区、用户要求和可用剧情资料，生成 `output/` 中以剧本名称命名的台词译稿。

## 工作流程

目标不是逐字替换，而是在不改中文母稿的前提下保留人物行动、信息边界、关系和情绪强度

### 第 1 步：初始化并阅读必备资料

1. 调用“初始化台词翻译”工具。工具提取全部台词、保留已有译文作为参考、生成按剧情单元拆分的 `7.1-lines-*.json`，并返回目标语和译稿路径；存在剧集名称时会一并写入。若后端已完成初始化，不重复执行。若失败，按错误修复前置项目状态后重试，不手写进度文件；
2. 调用“读取用户需求”工具，确认目标地区、主要交付语言、内容分级和用户额外要求；
3. 调用“读取用户偏好”，确认本步骤的新增要求；
4. 调用“获取地区规则”，读取目标地区的改编规则和翻译语境；
5. 若初始化返回故事梗概，先在指定单元的 `英文简介` 中完成一次目标语翻译，保留主线冲突、关键推进和结局回报，不改动中文梗概；
6. 快速浏览全部 `7.1-lines-*.json` 的统一用语、角色和中文台词，确定跨单元复用的人名、称谓、组织、地点和关键概念译法，并直接补入各单元的“统一用语”，不创建词表或分析文件；

### 第 2 步：分单元并行完成文件翻译

按工具返回顺序，对每个文件内容进行翻译，可将不同单元交给独立任务处理，但同时最多处理 3 个单元，每个任务只修改分配到的 JSON 文件。
每次进行文件翻译时遵循如下步骤：

1. 读取故事梗概、世界观、当前单元关键角色和阶段变化。前置资料为空时，阅读待翻译剧本的相关范围，在该文件中补充足够完成翻译的简要上下文，不新增项目设定。动笔前判断人物声音、语气、隐喻、双关和文化表达难点；
2. 阅读[台词翻译原则.md](references/台词翻译原则.md)；
3. 阅读[台词翻译验收规则](references/台词翻译验收规则.md)，确认翻译目标和要求；
4. 逐句填写“目标语台词”。存在“剧集名称”时，同时填写不带括号的“目标语剧集名称”，使其与本集冲突、钩子和人物策略一致。保留台词 ID、人物、集数、中文台词和中文剧集名称原文；已有目标语台词只作参考，仍需核对自然度、人物声音和语义等效；
5. 每个单元完成后，先把译文当作竞争对手交付稿，与中文母稿逐句核对准确性、自然度、统一用语、人物声音和剧集标题；
6. 按[台词翻译验收规则]检查：人物的目的、筹码、潜台词、称谓、专名、脏话强度和信息量不得漂移；不篡改原意来降级已有内容，也不在译文中新增超出 `maturity_target` 的粗口或露骨细节；目标语应自然、可演、便于字幕阅读，并使用项目指定的 locale。

### 第 3 步：合并并检查台词译稿

1. 全部单元完成后，抽查跨单元术语、称谓和主要角色声音是否一致；
2. 调用“合并台词译稿”，将目标语台词写回占位位置，并将目标语剧集名称写成中文标题后的括号内容；
3. 调用“检查台词译稿”，不通过时只按返回的台词 ID 或集数修复对应 JSON，重新合并并检查，直至通过。

收到本阶段新增用户要求时，先记录并重新读取用户偏好；已经完成的译稿需要实质调整时，先调用返修路由再重新执行。

## 资料文件清单

- `7.1-lines-*.json`：当前剧情单元的翻译工作文件；填写必要上下文、目标语台词和已有剧集名称的目标语名称，不得改动中文台词、台词 ID 或中文剧集名称。
- [台词单元格式](references/lines.json5)：不清楚 JSON 字段含义时读取。
- [台词翻译原则](references/台词翻译原则.md)：开始翻译前读取，用于语义等效、角色声音、文化表达和敏感内容处理。
- [台词翻译验收规则](references/台词翻译验收规则.md)：完成每个单元以及最终检查前读取。
- 工具返回的待翻译剧本：仅在上下文不足时按当前单元范围读取；中文正文不得改写。
- 工具返回的台词译稿：由合并工具生成，不直接手写。

## 工具清单

---
Tool name: 初始化台词翻译
Tool description: 选择待翻译剧本，提取台词和可用剧集名称；存在故事梗概时指定唯一的英文简介翻译单元；生成译稿占位文件并更新进度。
Usage:
node .claude/skills/dialogue_translate/scripts/init-dialogue-translate.mjs --workspace <项目目录> --updated-by <用户>
---

---
Tool name: 读取用户需求
Tool description: 返回当前项目已明确的任务、发行和素材要求；初始化后调用。
Usage:
node .claude/tools/get-user-requirements.mjs --workspace <项目目录>
---

---
Tool name: 读取用户偏好
Tool description: 读取当前步骤可用的用户要求与已启用偏好。
Usage:
node .claude/tools/get-user-preferences.mjs --workspace <项目目录> --stage dialogue_translate
---

---
Tool name: 获取地区规则
Tool description: 返回目标地区的改编规则和翻译语境；开始翻译前调用。
Usage:
node .claude/tools/get-region-rules.mjs --workspace <项目目录> --stage dialogue_translate
---

---
Tool name: 合并台词译稿
Tool description: 校验所有单元 JSON，并将目标语台词和剧集名称合并到用户译稿。
Usage:
node .claude/skills/dialogue_translate/scripts/merge-dialogue-translate.mjs --workspace <项目目录>
---

---
Tool name: 检查台词译稿
Tool description: 检查中文母稿和剧集名称未被改写、翻译完整、台词 ID 一致且占位符已清除，通过后更新进度。
Usage:
node .claude/skills/dialogue_translate/scripts/check-dialogue-translate.mjs --workspace <项目目录> --updated-by <用户>
---

---
Tool name: 记录用户要求
Tool description: 记录当前步骤新增的翻译要求。
Usage:
node .claude/tools/update-stage-preferences.mjs --workspace <项目目录> --stage dialogue_translate --content <要求> --updated-by <用户>
---

---
Tool name: 返修路由
Tool description: 已完成译稿需要实质调整时回到台词翻译步骤，不删除现有文件。
Usage:
node .claude/tools/route-revision.mjs --workspace <项目目录> --stage dialogue_translate --reason <返修原因> --updated-by <用户>
---
