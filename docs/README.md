# docs 索引

> **性质与约定**：本文件是文档导航索引，由 W1-A 槽建立（此前任何分支均无 `docs/README.md`）。它**只做链接与一句话描述，不承载架构正文**——架构/方案正文的唯一权威来源是各槽位文档本身。后续槽位新增文档时在对应分区**追加条目**即可，不得改写他槽条目的描述与链接。
>
> 合并状态提示：wave-01 各文档目前分散在各工作分支（未合并进 main），下表"所在分支"列标明当前位置；全部合并进 main 后该列可移除，链接即时生效。
>
> **W2 更新（2026-08-27，追加）**：W2 实现槽已将 W1-D / P1 / W1-A / P3 / P4 五分支文档并入分支
> `cursor/w2-scaffold-ci-ccbf`（正文原样保留；`ready-tasks.md` 取 P1+P3+P4 分区并集、`DISPATCH-receipt.md` 取五份回执并集），
> 在该分支及其合并目标上下表链接即时生效；**P2 文档尚未并入**，仍以其原分支为准。

## 波次工作文档（wave-01）

| 文档 | 内容一句话 | 所在分支 @ commit |
| --- | --- | --- |
| [`wave-01/inventory-codebase.md`](./wave-01/inventory-codebase.md) | W1-A 代码库结构盘点：空仓事实证据（无包/无测试/无 CI）+ 对齐 P1 的建议目标目录树 | `cursor/w1-a-codebase-inventory-bb07`（本分支） |
| [`wave-01/maturity-baseline.md`](./wave-01/maturity-baseline.md) | W1-D 成熟度基线：L0–L5 量表、E1–E5 证据规则、阻塞登记（BLK-W1-01/02/03）、三维度自评（全 L0） | `cursor/w1-d-maturity-baseline-b2eb @ 60c37e8` |
| [`wave-01/P1-usability-architecture.md`](./wave-01/P1-usability-architecture.md) | P1 功能易用性：假设 A1–A4（CLI 优先、TS）、七维度准则、SPEC-01/02/03、目标分层 | `cursor/w1-p1-usability-architecture-5d0e @ 5545c22`（回执 `4612cdb`） |
| [`wave-01/P2-interaction-reliability.md`](./wave-01/P2-interaction-reliability.md) | P2 交互可靠性：12 维度审查、设计裁决 D1–D39、可靠性分层、后续规格 S1–S3 | `cursor/w1-p2-interaction-reliability-a3c2 @ 7873b66` |
| [`wave-01/ready-tasks.md`](./wave-01/ready-tasks.md) | 就绪任务队列（按槽位分区追加）：W1-P1-T01…T10 与 W1-P2-T01…T10 | P1 与 P2 分支各持一版，**合并时取分区并集** |
| [`wave-01/P3-agent-intelligence.md`](./wave-01/P3-agent-intelligence.md) | P3 Agent 智能化：8 子系统设计、量表映射、SPEC-P3-01/02/03（W2 追加条目） | `cursor/w1-p3-agent-intelligence-ca4d @ 67e6670` |
| [`wave-01/P4-major-experience-features.md`](./wave-01/P4-major-experience-features.md) | P4 重大工具体验功能：F1–F6 提案与去重/可实现性核验（W2 追加条目） | `cursor/w1-p4-major-experience-features-5fba @ 6ec86f8` |

## 波次工作文档（wave-02）

| 文档 | 内容一句话 | 所在分支 @ commit |
| --- | --- | --- |
| [`wave-02/work-scaffold-ci.md`](./wave-02/work-scaffold-ci.md) | W2 实现槽：脚手架 + CI 落地说明（做了什么 / 如何跑测试 / 验收对照 / 阻塞更新） | `cursor/w2-scaffold-ci-ccbf`（本分支） |
| [`wave-02/work-workflow-engine.md`](./wave-02/work-workflow-engine.md) | W2 实现槽：SPEC-02 工作流引擎最小版落地说明（恢复式引擎 / 原子写 / sw status / 并行槽合并注意） | `cursor/w2-workflow-engine-4cad` |

## 波次工作文档（wave-03）

| 文档 | 内容一句话 | 所在分支 @ commit |
| --- | --- | --- |
| [`wave-03/work-outline-templates.md`](./wave-03/work-outline-templates.md) | W3 实现槽：模板库 v1（三选一）+ 最小 `sw outline` 落地说明（模板结构约定 / 空态引导 / 并行槽合并注意） | `cursor/w3-outline-templates-5596`（本分支） |

## 决策与用户文档（W2 起建立）

| 文档 | 内容一句话 | 说明 |
| --- | --- | --- |
| [`adr/0001-stack-and-product-shape.md`](./adr/0001-stack-and-product-shape.md) | ADR-0001：确认 A1–A4，定栈（TS/Node/npm/Vitest/ESLint/commander）与导出格式首选项 | W1-P1-T02 交付；此后"新增顶层目录须有 ADR" |
| [`quickstart.md`](./quickstart.md) | 上手指南占位：当前可用命令 + 目标命令序列 + 逐命令实现进度 | W1-P1-T01 交付，T09 补全 |

## 流程模板

| 文档 | 内容一句话 | 所在分支 @ commit |
| --- | --- | --- |
| [`templates/w5-verification-report.md`](./templates/w5-verification-report.md) | W5 核验报告模板（配合成熟度基线使用） | `cursor/w1-d-maturity-baseline-b2eb @ 60c37e8` |

## 槽位回执

| 文档 | 内容一句话 | 说明 |
| --- | --- | --- |
| [`DISPATCH-receipt.md`](./DISPATCH-receipt.md) | 各工作槽完工回执（append-only） | 三个既有分支各持一版 + 本分支一版，**合并时取并集追加，勿丢任何回执** |

## 规划中的用户文档分区（未建立，责任任务见括号）

`concepts/`（T09）· `reference/`（T09）· `errors/`（T06 生成物）· `evidence/`（W1-D 基线约定的证据存档区）

以上分区随对应任务落地后，请将其从本节移入正式分区并附链接。
（`quickstart.md` 与 `adr/` 已随 W2 槽落地，移入上方"决策与用户文档"分区。）
