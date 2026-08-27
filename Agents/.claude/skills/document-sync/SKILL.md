---
name: document-sync
description: 在用户手工保存剧本大纲、角色小传、剧本试稿或完整剧本后，将当前 Markdown 同步到同一阶段的后台资料。仅在 `1.2-project-progress.json` 显示待同步的用户改动时使用。
---

本 Skill 的目的，是根据当前用户 Markdown 和同阶段资料，更新该阶段的结构化或分阶段后台产物。用户 Markdown 是交付事实；本 Skill 不改写任何用户文档，不改变其他阶段内容或状态。

## 工作流程

1. 阅读 `1.2-project-progress.json`，只处理本次指定且 `document_sync.status` 为 `pending` 的阶段。逐个读取其修改摘要、当前用户 Markdown、同阶段模板及必要的上游结构化资料。
2. 以当前用户 Markdown 为唯一正文源更新后台资料：
   - `outline_rewrite`：根据当前故事梗概和 `references/outline.json5` 更新 `3.1-outline.json`；剧本名称仍不得沿用原剧本名称。保留并同步开头“关键角色名称”名单中的中文名称与英文名称；海外名单使用“中文名称（英文名称）”，国内仅显示中文名称；正文和各集关键角色列表只能使用中文名称。
   - `character_rewrite`：根据当前角色小传和 `references/character.json5` 更新 `4.1-character.json`。
   - `trial_generate`：不写入任何用户文档；只核对试稿范围、人物与双语结构对应的阶段事实。
   - `full_generate`：只将试稿范围之后的剧集同步到 `tmp/全稿分阶段/`；不得回写试稿，也不得合并生成全稿。审核项目的待审剧本没有分阶段产物时，只保留当前正文作为后续审稿事实。
3. 回读本步骤刚写入的后台资料，确认标题、集数、人物和结构与当前 Markdown 一致；不一致时只修复该阶段后台资料。
4. 完成后停止。后端会更新该阶段状态和同步记录；不得自行修改项目进度。

## 资料文件清单

- `1.2-project-progress.json`：识别本次待同步阶段及其保存摘要，开始时读取。
- `output/剧本大纲.md` 或当前命名的故事梗概：`outline_rewrite` 的正文事实来源。
- `references/outline.json5`：更新 `3.1-outline.json` 时读取的结构模板。
- `output/角色小传.md`：`character_rewrite` 的正文事实来源。
- `references/character.json5`：更新 `4.1-character.json` 时读取的结构模板。
- `output/剧本试稿.md`：`trial_generate` 的正文事实来源，仅用于核对。
- 当前命名的完整剧本：`full_generate` 的正文事实来源。
- `3.1-outline.json`、`4.1-character.json`：按需读取，用于核对剧集和人物对应关系。
- `tmp/全稿分阶段/`：仅在同步完整剧本后续剧集时写入。

## 工具清单

本 Skill 不调用初始化、检查、合并、批准或返修路由工具。后台会在本 Skill 结束后统一记录同步状态。

禁止修改 `output/` 下任何 Markdown、`1.1-user-input.json`、`1.2-project-progress.json`，以及本次未指定阶段的任何文件。
