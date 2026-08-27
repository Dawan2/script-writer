# templates/ —— 脚本模板库（占位）

本目录是内置脚本模板的家（P1 方案 §6.1 仓库 IA / W1-P1-T03 文件范围中的"templates/ 目录占位"）。

| 模板 | 状态 | 责任任务 |
| --- | --- | --- |
| `short-video/` | 规划中 | W1-P1-T04（随 `sw init` 首个模板交付） |
| `screenplay/`、`podcast/` | 规划中 | W1-P1-T07（模板库 v1） |

模板结构约定（SPEC-01）：`templates/<id>/` 下是一棵带变量占位的文件树，由 `sw init` 渲染为用户项目
（`project.yaml` + `outline.md` + `characters/` + `scenes/`）。在上述任务落地前，本目录仅含本说明文件。
