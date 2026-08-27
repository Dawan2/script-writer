# docs 索引（本分支增量分区）

> **给合并者**：本分支（`cursor/w3-user-docs-ia-f6ca`）基于 `main @ deda75a`（无此文件）创建，
> 本文件**仅含 W1-P1-T09 槽的增量条目与两处指定更新**，不携带他槽条目副本；并入集成分支
> （`cursor/w3-integrate-w2-f334`，其 `docs/README.md` 为全量索引）时按既定「索引行并集」约定操作：
>
> 1. 下方「用户文档」分区整节**追加**为全量索引的新分区（放在「决策与用户文档」分区之后）；
> 2. 全量索引「决策与用户文档」表中 `quickstart.md` 一行，按下方 §2 给出的替换行**更新**
>    （该行原文标注「T09 补全」，本槽即 T09，属指定回填而非改写他槽条目）；
> 3. 全量索引末节「规划中的用户文档分区」按下方 §3 更新（`concepts/`、`reference/` 改挂
>    `docs/user/` 之下，仍为规划中）。

## 1. 用户文档（`docs/user/`，wave-03 · W1-P1-T09 起建立）

面向使用者的分区：上手、查命令、看懂报错；只链接架构/规格正文，不复制。分区自身的 IA 与编写纪律见其总览页。

| 文档 | 内容一句话 | 所在分支 |
| --- | --- | --- |
| [`user/README.md`](./user/README.md) | 用户文档 IA 总览：三条用户路径、分区结构与规划（concepts/reference 为 T09 余项）、help ↔ docs ↔ 错误锚点互链约定 | `cursor/w3-user-docs-ia-f6ca`（本分支） |
| [`user/quickstart.md`](./user/quickstart.md) | 快速开始（T09 补全版）：安装、当前能走通的路径、目标新手路径（TTFS ≤ 5 命令）、中断恢复 | 同上 |
| [`user/commands.md`](./user/commands.md) | 命令索引：全部命令的状态（可用 / 待并入 / 规划中 / 提案级）、一句话、规格出处链接与责任任务——命令可用性唯一口径 | 同上 |
| [`user/errors-and-empty-states.md`](./user/errors-and-empty-states.md) | 空态与错态导读：三段式怎么读、退出码 0/1/2、错误码段位速览、空态三要素与常见处境速查（逐码正文链接 `errors/` 不复制） | 同上 |

## 2. `quickstart.md` 行的替换文本（决策与用户文档表）

```text
| [`quickstart.md`](./quickstart.md) | 指针页 → 正文已迁 `user/quickstart.md`（T09 补全版）；路径保留保证根 README 与 `--help` 尾部 URL 入链不断 | W1-P1-T01 交付占位，T09 补全并迁移 |
```

## 3. 「规划中的用户文档分区」更新后的表述

```text
`user/concepts/`（T09 余项：领域词汇表）· `user/reference/`（T09 余项：逐命令页 + 示例可执行断言，
连同链接检查进 CI、--help 尾部 URL 改指 reference 页，均待集成分支就绪后由实现槽收口，
见 user/README.md §2）· `evidence/`（W1-D 基线约定的证据存档区，目录/命名约定见
`cursor/w2-evidence-ci-conventions-a17c` 分支）
（`user/` 分区已随 W3 T09 槽落地，移入上方「用户文档」分区。）
```
