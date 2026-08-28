# templates/ —— 脚本模板库 v1

本目录是内置脚本模板的家（P1 方案 §6.1 仓库 IA；模板库 v1 属 W1-P1-T07）。

| 模板 | 状态 | 责任任务 |
| --- | --- | --- |
| `short-video/` | **已交付** | W1-P1-T04（随 `sw init` 首个模板建立；本分支与 init 槽字节级同文件） |
| `screenplay/`、`podcast/` | **已交付** | W1-P1-T07（模板库 v1，三选一齐备） |

模板结构约定（SPEC-01）：`templates/<id>/` 下是一棵带变量占位（`{{key}}`）的文件树，由 `sw init`
渲染为用户项目（`project.yaml` 由元数据序列化产出，不走模板占位）。命名规约：模板内名为
`gitignore` 的文件渲染为 `.gitignore`（避免影响本仓库自身忽略规则，且 npm 打包不剥除）。
新增模板目录后无需改代码，`sw init --template <id>` 与「模板跟随脚本类型」解析自动生效。

每个模板的 `outline.md` 内嵌空态三要素引导（这里是什么 / 示例长什么样 / 下一步敲什么命令，
P1 §6.3），变量占位为 `{{title}}` 与 `{{expectedSceneCount}}`；`sw outline`（W1-P1-T07 最小版）
在项目内 `outline.md` 缺失或为空时按项目 `format` 渲染对应骨架。

> 勘误（SPEC-05 §9-6 登记）：v1 场文件骨架由代码生成（`sw draft`，SPEC-05 §4.3），模板不含 `scene.md`；
> 如后续按 format 差异化场骨架，属模板结构勘误（需同步结构单测与变量全集单测）。
