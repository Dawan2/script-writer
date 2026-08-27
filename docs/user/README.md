# 用户文档（docs/user/）—— 信息架构总览

| 项目 | 内容 |
| --- | --- |
| 槽位 | 第 3 波 / 周期 W3 / 工作槽 W1-P1-T09 用户文档 IA |
| 分支 | `cursor/w3-user-docs-ia-f6ca`（基于 `main @ deda75a`，docs-only，集成图 §5 纪律） |
| 性质 | 面向**使用者**的文档分区：上手、查命令、看懂报错。架构/规格正文不放这里——本分区只链接，不复制 |
| 权威口径 | 命令可用性以[命令索引](./commands.md)为唯一口径；错误文案以 [`docs/errors/`](../errors/README.md)（注册表生成物）为唯一口径 |

> **给合并者**：本分区四个文件均为本槽新建（`main` 无 `docs/user/`），并入集成分支时整目录直取，无冲突面。
> 正文中指向 `wave-03/`、`errors/` 等文件的相对链接在集成分支合并对应槽位后生效，链接旁均已注明所在分支。

---

## 1. 按你的问题找文档（三条路径）

| 你的处境 | 去这里 | 再深一跳 |
| --- | --- | --- |
| 「我是新手，想跑通第一个项目」 | [快速开始](./quickstart.md) | [命令索引](./commands.md)查每条命令的状态与用法出处 |
| 「我想查某条命令怎么用 / 有没有这个命令」 | [命令索引](./commands.md) | 各命令行内链接的规格 / 落地说明；未来 `reference/` 逐条页 |
| 「命令报错了 / 输出了空态提示，怎么办」 | [空态与错态导读](./errors-and-empty-states.md) | [`docs/errors/SW-Exxx.md`](../errors/README.md) 逐码页（错误输出末行的「详情」链接直达） |

设计目标（P1 方案 §6.6，出处见 [`docs/wave-01/P1-usability-architecture.md`](../wave-01/P1-usability-architecture.md)）：
**任何用户问题三跳可达**——报错/空态输出 → 导读或错误码页 → 修复命令；`--help` → quickstart / 命令索引 → 可复制示例。

## 2. 本分区结构（现状与规划）

```text
docs/user/
├── README.md                    # 本页：IA 总览与导航
├── quickstart.md                # 快速开始（T09 补全版；docs/quickstart.md 为兼容指针）
├── commands.md                  # 命令索引：全部命令的状态 / 一句话 / 规格出处
├── errors-and-empty-states.md   # 空态与错态导读（错误码正文在 docs/errors/，不复制）
├── concepts/                    # 【规划中】领域词汇表（项目 / 大纲 / 场景 / 五步工作流…）
└── reference/                   # 【规划中】逐命令 reference 页（每页 ≥1 条可复制示例）
```

`concepts/` 与 `reference/` 属 W1-P1-T09 原定范围（ready-tasks 见
[`docs/wave-01/ready-tasks.md`](../wave-01/ready-tasks.md) W1-P1-T09），其内容依赖已并入集成分支的
命令实现（reference 示例须可执行）；本槽处于集成窗口期（docs-only、禁触 `src/`），故与下述 src/CI
侧验收一并登记为 **T09 余项**，待集成分支就绪（W3-PLAN-T02，见
[`docs/wave-03/ready-tasks.md`](../wave-03/ready-tasks.md)，分支 `cursor/w3-integration-map-bf24`）后由实现槽收口：

1. `reference/` 逐命令页 + 「示例可执行」断言（T09 验收 ②）；
2. 链接检查脚本进 CI（T09 验收 ①「三跳可达 100%」的自动化）；
3. `--help` 尾部 URL 从 `docs/quickstart.md` 改指对应 reference 页（T09 验收 ③，涉 `src/cli/program.ts`）；
4. `concepts/glossary.md` 领域词汇表。

## 3. 互链约定（help ↔ docs ↔ 错误锚点闭环）

- **help → docs**：`sw --help` 尾部固定印 quickstart URL（当前指 `docs/quickstart.md`，该路径永久保留为指针页，入链不断）；各子命令 `--help` 携带可复制示例（既有纪律，见 P1 §4）。
- **docs → help**：本分区每处提到命令都给出「敲 `sw <cmd> --help` 看示例」的回路；命令索引标注每条命令的 help 是否已带示例。
- **错误输出 → docs**：每条 SW-Exxx 错误末行「详情」链接直达 `docs/errors/SW-Exxx.md` 锚点（SPEC-03 框架保证，本分区不重复实现细节）。
- **docs → 错误锚点**：[空态与错态导读](./errors-and-empty-states.md)只讲「怎么读、去哪查」，逐码正文一律链接 `docs/errors/`（注册表生成物，**手改会被 CI `lint:errors` 拦截**）。

## 4. 本分区的编写纪律

1. **不复制架构长文**：规格（SPEC-xx）、裁决（GAP-xx）、集成图等正文只链接、注明所在分支，不搬运段落——单一事实源在原文档。
2. **诚实进度（虚假可用性禁令）**：未并入集成分支的命令一律标「已实现·待并入」或「规划中」，绝不写成可用；口径与更新责任见[命令索引](./commands.md)头部说明。
3. **append-only 友好**：后续槽位新增用户文档时在本页 §2 树与 §1 表中**追加**条目，不改写他槽描述。
