---
name: novel_analysis
description: 完整理解用户上传的小说，沿原著因果逐层提炼基础信息、核心卖点、故事主线、世界观、关键人物、剧情单元与高光原文索引，并结合短剧容量给出取舍建议。用于小说改编场景的小说解读步骤。
---

本 Skill 的目的，是根据用户上传的小说、发行任务书和用户偏好，生成 `2.1-novel-analysis.json`，作为后续故事梗概与剧本正文的原著事实底稿。

## 快速开始

后台明确的执行场景优先；未明确时，按下表选择。修复或修改时，不再执行完整的`生成流程`。

| 执行场景 | 判断依据 | 执行方式 |
| --- | --- | --- |
| 首次生成 | 后台要求生成小说解读，且未提供上一轮检查问题 | 按`生成流程`执行。 |
| 修复生成结果 | 后台提供上一轮检查问题 | 不调用“完整阅读小说”。只修改 `2.1-novel-analysis.json` 中问题命中的字段；原著事实或高光索引可疑时，定向读取原文。然后调用“检查小说解读”，未通过时继续定向修改并检查。 |
| 修改已完成内容 | 小说解读已通过，用户提出新的修改要求 | 若尚未回到本阶段，先调用“返修路由”；调用“记录用户要求”和“读取用户偏好”，只修改受影响内容，有事实疑问时定向读取原文，最后调用“检查小说解读”。 |

## 生成流程

1. 根据阶段入口的初始化结果继续；明确提示未初始化时，调用“初始化小说解读”。失败时按返回问题修复后重试，不手写项目状态。
2. 根据阶段入口的明确状态处理全文阅读：若已提示“小说全文已阅读完成”，不要调用“完整阅读小说”，直接进入第 3 步；否则调用该工具。工具返回已启动后，立即结束本轮，不等待、轮询或重复调用；系统完成全文阅读后会继续本 Skill。调用失败时按修复提示重试；不得由当前会话手动通读全文代替该工具。
3. 调用“读取用户需求”。若受众、主题、背景、设定仍有“自动适配”，阅读[剧本设定解析原则](../_shared/references/剧本设定解析原则.md)，基于全文解读草稿、完整主线与终局回报调用“解析剧本设定”。用户已明确选择的字段不得改写。
4. 阅读[小说全文解读原则](references/小说全文解读原则.md)，基于已生成的解读草稿复核全局因果、人物变化、故事主线、核心卖点、世界观和基础信息。仅把持续改变主线且有独立弧光或终局回报的人列入“关键人物”；单元内承担局部功能的人物保留在该单元，不因此扩充主要角色。后文推翻前文认知时，以最终成立的原著事实为准；只有发现具体事实、人物转变或高光索引可疑时才定向读取原文。
5. 阅读[剧情单元提炼原则](references/剧情单元提炼原则.md)，按原著顺序复核单元边界、主线推进、关键信息、高光索引和改编建议。“保留”“删除”“合并”只是依据目标集数和单集时长给出的建议，不能改变原著剧情单元的完整性。
6. 所有“已确认合并”保持为 `false`，等待用户决定。高光时刻只记录名称和精确原文索引；发现因果冲突、人物转变缺口或索引可疑时，调用“读取小说原文”定向核实。
7. 需要确认字段含义时，阅读[小说解读构建框架](references/novel-analysis.json5)。只修改 `2.1-novel-analysis.json`，不重新通读全文。
8. 调用“检查小说解读”。未通过时只修复返回的问题并重新检查；通过后进入 `outline_rewrite`。

收到本阶段新增的用户要求时，按`快速开始`中的“修改已完成内容”执行。

## 资料文件清单

- [小说全文解读原则](references/小说全文解读原则.md)：核对原著事实、人物变化与全局理解时读取。
- [剧情单元提炼原则](references/剧情单元提炼原则.md)：核对剧情单元边界、高光和改编建议时读取。
- [小说解读构建框架](references/novel-analysis.json5)：确认交付字段含义时读取。
- [剧本设定解析原则](../_shared/references/剧本设定解析原则.md)：存在自动适配标签时读取。
- `2.1-novel-analysis.json`：本阶段唯一可写产物。

## 工具清单

---
Tool name: 初始化小说解读
Tool description: 检查小说改编任务并准备小说解读；已有解读会保留。仅在阶段入口明确提示未初始化时调用。
Usage:
node .claude/skills/novel_analysis/scripts/init-novel-analysis.mjs --workspace <项目目录> --updated-by <用户>
---

---
Tool name: 完整阅读小说
Tool description: 完整阅读原著并生成小说解读草稿；仅在“首次生成”中调用，修复或修改已有解读时不调用。
Usage:
node .claude/skills/novel_analysis/scripts/complete-novel-reading.mjs
---

---
Tool name: 读取小说原文
Tool description: 按原文索引读取必要正文；只用于定向核实事实、人物转变或高光时刻。
Usage:
node .claude/skills/novel_analysis/scripts/read-novel-source.mjs --workspace <项目目录> --index <L起始行-L结束行>
---

---
Tool name: 读取用户需求
Tool description: 返回当前项目已明确的发行、素材与剧本设定要求；全文阅读完成后调用。
Usage:
node .claude/tools/get-user-requirements.mjs --workspace <项目目录>
---

---
Tool name: 解析剧本设定
Tool description: 将仍为自动适配的受众、主题、背景和设定写回发行配置；完成全文理解后调用。
Usage:
node .claude/tools/resolve-script-profile.mjs --workspace <项目目录> --stage novel_analysis --updated-by <用户> --audience <受众> --theme <主题，逗号分隔> --background <背景，逗号分隔> --setting <设定，逗号分隔>
---

---
Tool name: 读取用户偏好
Tool description: 读取当前步骤可用的用户要求与附件。
Usage:
node .claude/tools/get-user-preferences.mjs --workspace <项目目录> --stage novel_analysis
---

---
Tool name: 检查小说解读
Tool description: 检查交付结构、主要角色数量、剧情单元、改编建议和高光原文索引；通过后更新阶段状态。
Usage:
node .claude/skills/novel_analysis/scripts/check-novel-analysis.mjs --workspace <项目目录> --updated-by <用户>
---

---
Tool name: 记录用户要求
Tool description: 记录当前阶段新增的用户要求。
Usage:
node .claude/tools/update-stage-preferences.mjs --workspace <项目目录> --stage novel_analysis --content <要求> --updated-by <用户>
---

---
Tool name: 返修路由
Tool description: 已通过的小说解读需要实质调整时回到本阶段。
Usage:
node .claude/tools/route-revision.mjs --workspace <项目目录> --stage novel_analysis --reason <返修原因> --updated-by <用户>
---
