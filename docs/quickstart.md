# Quickstart（占位版）

> **状态**：本页为 W1-P1-T01 建立的占位页，随 W1-P1-T09（用户文档 IA 落地）补全。
> 下表"实现进度"是唯一权威口径：标注"规划中"的命令**当前不可用**，请勿按其操作。

## 现在就能跑的

```bash
git clone https://github.com/Dawan2/script-writer.git
cd script-writer
npm ci && npm run build
node dist/cli/main.js --version   # 0.1.0
node dist/cli/main.js --help      # 查看五步工作流路线图
```

想要全局 `sw` 命令：`npm link`（或将来发布后 `npm install -g script-writer`，**规划中**）。

初始化第一个项目（W1-P1-T04 已交付）：

```bash
sw init my-story          # 交互向导（≤ 4 问，回车接受默认值）
sw init my-story --yes    # 非交互：全部默认值（CI/脚本友好）
```

产出 `project.yaml + outline.md + characters/ + scenes/ + exports/`；目标目录非空时报
`SW-E010` 并提示 `--force` 及其后果。退出码约定：0 成功 / 1 运行期错误 / 2 用法错误。

## 目标命令序列（新手路径，TTFS ≤ 5 条命令）

```bash
sw init my-story                  # ① 初始化向导（≤ 4 问，--yes 可全默认）
cd my-story
sw outline                        # ② 写大纲
sw draft 010 --title "开场"       # ③ 写第一场
sw export                         # ④ 导出成稿到 exports/
```

任意时刻中断后，`sw status` 显示"你在第几步、下一步敲什么命令"（可直接复制执行）。

## 实现进度

| 命令 | 状态 | 责任任务 |
| --- | --- | --- |
| `sw --version` / `sw --help` | **可用** | W1-P1-T03（已交付） |
| `sw init` | **可用** | W1-P1-T04（已交付，见 [wave-02/work-init-wizard.md](./wave-02/work-init-wizard.md)） |
| `sw status` | **可用（最小版）**：项目内输出进度 + 末行可复制的下一步命令 | W1-P1-T05（引擎最小版已交付，见 [wave-02/work-workflow-engine.md](./wave-02/work-workflow-engine.md)） |
| `sw outline` / `sw draft` / `sw export` | 规划中（引擎原语已就绪） | W1-P1-T05 后续 |
| `sw doctor` | 规划中 | W1-P1-T08 |
| `sw check` / `sw snapshot` / `sw character` / `sw stats` 等 | 规划中 | W1-P4-T01…T09 |

## 相关文档

- [README（路由页）](../README.md)
- [文档索引](./README.md)
- [ADR-0001 技术栈与产品形态](./adr/0001-stack-and-product-shape.md)
- [P1 易用性架构方案（五步工作流与项目布局的出处）](./wave-01/P1-usability-architecture.md)
