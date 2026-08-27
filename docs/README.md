# docs 索引

> **性质与约定**：本文件是文档导航索引，由 W1-A 槽建立（此前任何分支均无 `docs/README.md`）。它**只做链接与一句话描述，不承载架构正文**——架构/方案正文的唯一权威来源是各槽位文档本身。后续槽位新增文档时在对应分区**追加条目**即可，不得改写他槽条目的描述与链接。
>
> 合并状态提示：wave-01 各文档目前分散在各工作分支（未合并进 main），下表"所在分支"列标明当前位置；全部合并进 main 后该列可移除，链接即时生效。

## 波次工作文档（wave-01）

| 文档 | 内容一句话 | 所在分支 @ commit |
| --- | --- | --- |
| [`wave-01/inventory-codebase.md`](./wave-01/inventory-codebase.md) | W1-A 代码库结构盘点：空仓事实证据（无包/无测试/无 CI）+ 对齐 P1 的建议目标目录树 | `cursor/w1-a-codebase-inventory-bb07`（本分支） |
| [`wave-01/maturity-baseline.md`](./wave-01/maturity-baseline.md) | W1-D 成熟度基线：L0–L5 量表、E1–E5 证据规则、阻塞登记（BLK-W1-01/02/03）、三维度自评（全 L0） | `cursor/w1-d-maturity-baseline-b2eb @ 60c37e8` |
| [`wave-01/P1-usability-architecture.md`](./wave-01/P1-usability-architecture.md) | P1 功能易用性：假设 A1–A4（CLI 优先、TS）、七维度准则、SPEC-01/02/03、目标分层 | `cursor/w1-p1-usability-architecture-5d0e @ 5545c22`（回执 `4612cdb`） |
| [`wave-01/P2-interaction-reliability.md`](./wave-01/P2-interaction-reliability.md) | P2 交互可靠性：12 维度审查、设计裁决 D1–D39、可靠性分层、后续规格 S1–S3 | `cursor/w1-p2-interaction-reliability-a3c2 @ 7873b66` |
| [`wave-01/ready-tasks.md`](./wave-01/ready-tasks.md) | 就绪任务队列（按槽位分区追加）：W1-P1-T01…T10 与 W1-P2-T01…T10 | P1 与 P2 分支各持一版，**合并时取分区并集** |

## 流程模板

| 文档 | 内容一句话 | 所在分支 @ commit |
| --- | --- | --- |
| [`templates/w5-verification-report.md`](./templates/w5-verification-report.md) | W5 核验报告模板（配合成熟度基线使用） | `cursor/w1-d-maturity-baseline-b2eb @ 60c37e8` |

## 槽位回执

| 文档 | 内容一句话 | 说明 |
| --- | --- | --- |
| [`DISPATCH-receipt.md`](./DISPATCH-receipt.md) | 各工作槽完工回执（append-only） | 三个既有分支各持一版 + 本分支一版，**合并时取并集追加，勿丢任何回执** |

## 规划中的用户文档分区（未建立，责任任务见括号）

`quickstart.md`（W1-P1-T01/T09）· `concepts/`（T09）· `reference/`（T09）· `errors/`（T06 生成物）· `adr/`（T02，ADR-0001 起）· `evidence/`（W1-D 基线约定的证据存档区）

以上分区随对应任务落地后，请将其从本节移入正式分区并附链接。
