# 快速开始

> **本页状态**：W1-P1-T09 补全版，取代 `docs/quickstart.md` 占位版（该路径保留为指针页，旧链接不断）。
> 命令可用性的**唯一权威口径**在[命令索引](./commands.md)：本页标注「规划中」的命令当前不可用，请勿按其操作。
> 素材来源：脚手架槽 README 路由页与 quickstart 占位页（`cursor/w2-scaffold-ci-ccbf`，W1-P1-T01/T03 交付）。

**script-writer 是一个结构化脚本创作 CLI 工具**：以「大纲 → 场景 → 台词」的层级组织
影视/短视频/播客脚本。项目就是一个纯文本目录（`project.yaml` + Markdown），可用任意编辑器直接改、
可 git 版本化；AI 是**可选**适配器，不配任何 API key 也能完整走通全部工作流
（技术决策见 [ADR-0001](../adr/0001-stack-and-product-shape.md)）。

主工作流五步，命令与步骤同词汇：

```text
sw init → sw outline → sw draft → sw revise → sw export
（初始化）  （写大纲）   （写场景）    （修订）     （导出成稿）
```

## 1. 安装（现在就能跑）

```bash
git clone https://github.com/Dawan2/script-writer.git
cd script-writer
npm ci && npm run build        # Node ≥ 20
node dist/cli/main.js --version   # 0.1.0
node dist/cli/main.js --help      # 帮助尾部有五步工作流路线图与各命令实现进度
```

想要全局 `sw` 命令：`npm link`（或将来发布后 `npm install -g script-writer`，**规划中**）。
下文示例均写作 `sw <cmd>`，未 link 时替换为 `node dist/cli/main.js <cmd>` 即可。

## 2. 当前能走通的路径

集成窗口期（W3）已可用的命令是 `sw --help` / `sw --version` 与 `sw status`（最小版）：

```bash
cd <你的项目目录>   # 项目 = 含 project.yaml 的目录
sw status           # 你在第几步、下一步敲什么命令（末行可直接复制执行）
```

在非项目目录运行会得到三段式报错（`SW-E011`，附「怎么办」与详情链接）——这是预期行为，
看不懂报错时先读[空态与错态导读](./errors-and-empty-states.md)。

`sw init`（初始化向导）、`sw outline`（大纲骨架）、`sw doctor`（项目体检）已在各自分支实现完毕、
**待并入集成分支**，并入后本节将扩为完整新手路径；进度与所在分支见[命令索引](./commands.md)。

## 3. 目标新手路径（TTFS ≤ 5 条命令）

全部命令并入后，从零到导出第一份成稿的路径如下（P1 方案 §4 指标；
draft/export 的行为契约见 SPEC-05/06，出处列在[命令索引](./commands.md)）：

```bash
sw init my-story                  # ① 初始化向导（≤ 4 问，--yes 可全默认零交互）
cd my-story
sw outline                        # ② 写大纲（空态时自动生成模板骨架）
sw draft 010 --title "开场"       # ③ 写第一场
sw export                         # ④ 导出成稿到 exports/
```

**中断恢复**：任意时刻中断后回到项目目录敲 `sw status`，输出末行就是下一步命令，复制执行即可。

## 4. 下一步去哪

| 想做什么 | 去这里 |
| --- | --- |
| 查某条命令的状态 / 用法出处 | [命令索引](./commands.md)；已可用命令直接 `sw <cmd> --help`（带可复制示例） |
| 看懂报错与空态提示 | [空态与错态导读](./errors-and-empty-states.md) → [`docs/errors/`](../errors/README.md) 逐码页 |
| 了解技术栈与产品形态决策 | [ADR-0001](../adr/0001-stack-and-product-shape.md) |
| 参与开发（跑测试 / CI 门） | 仓库根 [README](../../README.md)「开发」一节 |
