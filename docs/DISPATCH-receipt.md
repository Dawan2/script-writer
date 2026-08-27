# DISPATCH 回执（append-only）

> **追加约定**：每个工作槽完成后在文件末尾追加一节回执，不得修改或删除既有回执。
>
> 注：本文件在各工作分支各有一版（W1 六分支及 `cursor/w2-plan-backlog-verification-f51f`、
> `cursor/w2-scaffold-ci-ccbf` 等）。本分支基于 `main @ deda75a` 新建，仅含本节回执；
> 合并进 main 时请取**并集追加**，保留全部历史回执。

---

## 回执：W2 / 计划槽「证据与 CI 约定」

- **日期**：2026-08-27（UTC）
- **槽位**：第 2 波 / 周期 W2 / 计划槽 证据与 CI 约定（推进 BLK-W1-03，承接 W1-C 缺口 G2 归档段）
- **分支**：`cursor/w2-evidence-ci-conventions-a17c`（基于 `main @ deda75a`，已 push，未开 PR）
- **输入依据**（全部只读引用，未改写）：W1-D 基线 `cursor/w1-d-maturity-baseline-b2eb @ 60c37e8`（E1–E5 定义、证据三要素、BLK-W1-03 登记）；W2 积压清单 `cursor/w2-plan-backlog-verification-f51f`（G2 分工、WAVE02-PLAN 分区）；脚手架槽 `cursor/w2-scaffold-ci-ccbf @ 39a0b30`（CI 五步基线快照，**尚未合入 main，本槽未动其任何文件**）；W1-C 盘点 `cursor/w1-c-agent-tooling-inventory-0ec2 @ 8553c7f`（L-E 证据链与 G2）；P3 方案 `cursor/w1-p3-agent-intelligence-ca4d @ 67e6670`（trace 脱敏原则、`docs/evidence/spot-checks/` 既有约定）。
- **产出**：
  - `docs/wave-02/evidence-and-ci-conventions.md` — 证据与 CI 约定正文：`docs/evidence/` 目录结构与波次归属规则（§1）、命名规范与冻结规则（§2）、E1–E5 逐类型落盘形态 + 通用文件头模板 + 输出体量规则（§3）、归档流程与 W5 衔接（§4）、五条脱敏规则 + 自查命令 + 违规处置（§5）、实现槽 CI 证据清单——必须项 C1–C8（lint 零警告 / typecheck / 单测通过数只增不减 / build / smoke / help 快照 / CI 覆盖面 / 证据落盘）+ help 快照专项（T10 前后两阶段口径）+ 禁止清单 7 条 + 例外登记通道 + CI 文件修改纪律（§6）。
  - `docs/evidence/README.md` — 证据目录操作速查（目录树、命名、归档五步、脱敏底线、CI 红线摘要），权威指回约定正文。
  - `docs/DISPATCH-receipt.md` — 本回执（追加式）。
- **关键结论**：
  1. **只定约定，未动实现**：脚手架（W1-P1-T03）尚未合入 main，本槽为 docs-only——未新建/修改任何 CI 文件、代码或测试；CI 清单以 `39a0b30` 快照为基线，约定“与合入版本不一致时取更严格者”。
  2. **未重做 W1-D 量表正文**：E1–E5 定义、三要素、评级规则的唯一权威仍是 `maturity-baseline.md` §1–§2，本文只规定落盘位置/命名/流程/脱敏与 CI 红线，并声明文档优先级（基线 ＞ 约定正文 ＞ evidence README）。
  3. **P3 既有约定原样保留**：`docs/evidence/spot-checks/`（TASK-P3-10）维持顶层长期滚动；`runs/*.jsonl` 永不入 evidence/git，只归档脱敏摘要（对齐 P3 §2.7 与 TASK-P3-04）。
  4. **BLK-W1-03 未宣布解除**：本槽交付其证据归档段约定；解除仍以基线登记条件（CI 合入 main 且状态可查）为准，由当事槽登记。G2 手工归档段即刻可用；CI 自动归档不立项，登记为开放方向留调度器裁决。
- **阻塞与开放问题**：无新增阻塞。沿用 BLK-W1-02（仍开放）、BLK-W1-03（待脚手架合入解除）；开放方向 1 项——evidence 文件名 lint（§2.1 已给正则）与 CI 自动归档是否立项，留调度器。
- **合并说明**：本分支文件面与各并行分支不相交（两份新建文档 + 本回执）；`docs/README.md` 由他槽持有，其“规划中分区”的 `evidence/` 条目迁移按该文件自身约定在合并时处理，本槽未代改。
- **合规声明**：未创建子代理；未创建 PR；未使用 Task；未删除测试、未跳过失败、未降低 CI 标准（本槽 docs-only，且约定正文 §6.4 将降标行为逐条列为红线）；未重做 W1-D 成熟度量表正文；未改写任何他槽已推送文档。
