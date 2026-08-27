---
name: project_init
description: 在用户发起剧本任务项目时创建工作区，归档源文件与附件，建立发行任务书、用户输入和项目进度文件。用于新建项目或需要补齐发行任务书的场景。
---

本 Skill 根据项目名称、源文件、目标地区、可选发行要求和附件，创建后续 Skill 可直接使用的项目工作区。

## 工作流程

1. 确认项目名称、源文件路径、任务场景和目标地区。剧本改写、小说改编、爆款复刻还需接收受众、主题、背景、设定；未明确选择时均记录为“自动适配”。审核、翻译、润色不记录这四项。具体市场与主交付 locale 由地区规则自动确定；其余发行要求可不填。
2. 调用“初始化项目”工具。源文件和附件由工具归档；PDF、DOCX、EPUB、TXT 和 Markdown 会转换为可读文本。
3. 读取工具返回的发行任务书状态。地区规则可解析时可直接进入创作；`requires_translation` 为 false 时标记台词翻译为跳过，后续全稿直接进入审稿；可选发行要求为空时不得要求用户补填。
4. 调用“校验初始化项目”工具。通过后按场景进入世界观或小说解读；未通过时只按返回问题修复项目输入。

## 资料文件清单

- --script-file：用户上传的原材料。工具将原件归档到 references/，并生成场景对应的内部可读文本。
- --attachment：可重复传入的补充附件。工具保留原件；可提取文本的附件会在 references/ 中保留可读副本，后续步骤按需读取。

## 工具清单

---
Tool name: 初始化项目
Tool description: 根据确认后的用户输入创建项目工作区、发行任务书和初始化文件。
Usage:
node .claude/skills/project_init/scripts/init-project.mjs --project-name <名称> --script-file <剧本路径> --target-region <地区> [--audience <受众>] [--theme <主题>] [--background <背景>] [--setting <设定>]
Example:
node .claude/skills/project_init/scripts/init-project.mjs --project-name "示例剧本" --script-file "/tmp/source.docx" --target-region "北美" --created-by "admin" --attachment "/tmp/人物设定.pdf"
---

---
Tool name: 完善发行任务书
Tool description: 更新项目的可选发行配置；地区派生的市场与主交付语言不会由此工具改写。
Usage:
node .claude/skills/project_init/scripts/update-distribution-brief.mjs --workspace <项目目录> --updated-by <用户>
Example:
node .claude/skills/project_init/scripts/update-distribution-brief.mjs --workspace "workspaces/2026-07-20_admin_示例剧本" --maturity-target "PG-13 级影片，允许中等暴力、少量裸露、频繁脏话、轻度吸毒镜头" --updated-by "admin"
---

---
Tool name: 校验初始化项目
Tool description: 校验当前项目工作区和发行任务书是否可进入下一步。
Usage:
node .claude/skills/project_init/scripts/validate-project.mjs --workspace <项目目录>
Example:
node .claude/skills/project_init/scripts/validate-project.mjs --workspace "workspaces/2026-07-20_admin_示例剧本"
---
