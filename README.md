# script-writer

[![CI](https://github.com/Dawan2/script-writer/actions/workflows/ci.yml/badge.svg)](https://github.com/Dawan2/script-writer/actions/workflows/ci.yml)

**script-writer 是一个结构化脚本创作 CLI 工具**：以"大纲 → 场景 → 台词"的层级组织影视/短视频/播客脚本，
项目就是一个纯文本目录（`project.yaml` + Markdown），可用任意编辑器直接改、可 git 版本化；
AI 生成/改写是**可选**适配器——不配任何 API key 也能完整走通全部工作流（技术决策见
[ADR-0001](docs/adr/0001-stack-and-product-shape.md)）。

主工作流五步（命令与步骤同词汇）：

```text
sw init → sw outline → sw draft → sw revise → sw export
（初始化）  （写大纲）   （写场景）    （修订）     （导出成稿）
```

## Quickstart

> 当前处于主工作流落地阶段：CLI 入口（`sw --help` / `sw --version`）、`sw status` 与 `sw outline`（均最小版）
> 已可运行，其余子命令**规划中**（实现进度见 [docs/quickstart.md](docs/quickstart.md)）。

```bash
git clone https://github.com/Dawan2/script-writer.git
cd script-writer
npm ci && npm run build
node dist/cli/main.js --help   # 或 npm link 后直接运行：sw --help
```

创作一个脚本项目（`sw status` / `sw outline` 已可用；`sw init` / `sw export` **规划中**，随 W1-P1-T04/T05 落地）：

```bash
sw init my-story    # 交互向导（≤ 4 问），产出可续写的项目脚手架
sw outline          # 大纲缺失/为空时写入当前脚本类型的模板骨架（内嵌填写引导）
sw status           # 随时找回："你在第几步、下一步敲什么命令"（末行可直接复制执行）
sw export           # 导出成稿
```

## 开发

```bash
npm ci              # 安装依赖（Node ≥ 20）
npm test            # 单元测试（Vitest）
npm run lint        # ESLint（零警告过关）
npm run typecheck   # TypeScript 类型检查
npm run build       # 编译到 dist/
npm run smoke       # CLI 入口冒烟（--version / --help）
```

CI 在每次 push 与 PR 上跑同样五件套（[ci.yml](.github/workflows/ci.yml)）。

## 文档导航

| 去处 | 内容 |
| --- | --- |
| [docs/quickstart.md](docs/quickstart.md) | 上手指南（含各命令实现进度） |
| [docs/README.md](docs/README.md) | 全部文档索引（架构方案、任务队列、回执） |
| [docs/adr/](docs/adr/0001-stack-and-product-shape.md) | 架构决策记录（ADR-0001 技术栈与产品形态） |
| [docs/wave-01/P1-usability-architecture.md](docs/wave-01/P1-usability-architecture.md) | 易用性优先的目标架构与功能规格（SPEC-01/02/03） |
| [docs/wave-01/ready-tasks.md](docs/wave-01/ready-tasks.md) | 就绪任务队列（按槽位分区） |

仓库源码分层：`src/core`（领域，零 IO）、`src/app`（工作流 + UX 服务）、`src/cli`（`sw` 命令）、
`src/infra`（存储/AI/配置适配器）——依据 [P1 方案 §5.1/§6.1](docs/wave-01/P1-usability-architecture.md)。
