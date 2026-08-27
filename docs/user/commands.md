# 命令索引

> **口径与更新责任**：「状态」列以集成分支 `cursor/w3-integrate-w2-f334 @ ce910ad`
> （2026-08-27，第 2 梯队 error+engine 已并入）为基准；**把某命令变为可用的那个槽位**，
> 须在同一提交中更新本表对应行（与 `--help` 路线图、quickstart 同步，诚实进度纪律）。
> 本表只做一句话与链接，命令的完整契约见「规格 / 出处」列——不在此复制正文。
> 「所在分支」注明该文档当前所在的未合并分支；合并进集成分支后链接即时生效。

## 状态图例

| 状态 | 含义 |
| --- | --- |
| **可用** | 已在集成分支头，按行内说明可直接使用 |
| **待并入** | 已在某分支实现完毕（测试绿），排队并入集成分支（梯队见集成图，任务 W3-PLAN-T02/T04） |
| **规划中·规格就绪** | 有可开工规格，实现任务已登记，命令当前不可用 |
| **提案级** | 仅有功能提案（P4 文档），规格未细化 |

## 主工作流五步

| 命令 | 一句话 | 状态 | 规格 / 出处（所在分支） | 责任任务 |
| --- | --- | --- | --- | --- |
| `sw init [dir]` | 初始化向导（≤ 4 问；`--yes` 全默认；所有问题均有对应旗标） | **待并入** | SPEC-01（[P1 方案 §7](../wave-01/P1-usability-architecture.md)）；落地说明 `wave-02/work-init-wizard.md`（`cursor/w2-init-wizard-87b4`） | W1-P1-T04（已完成）；并入 = W3-PLAN-T02 |
| `sw outline` | 写大纲：空态时按项目类型生成模板骨架，已有内容只报告不覆盖（幂等） | **待并入** | 落地说明 [`wave-03/work-outline-templates.md`](../wave-03/work-outline-templates.md)（`cursor/w3-outline-templates-5596`） | W1-P1-T07（已完成）；并入 = W3-PLAN-T04 后续梯队 |
| `sw draft <场编号>` | 起草场景：创建场文件；`--done` 才标记完成（创建 ≠ 完成） | 规划中·规格就绪 | SPEC-05（[`wave-03/spec-draft-export-revise.md`](../wave-03/spec-draft-export-revise.md)，`cursor/w3-spec-draft-export-revise-193d`） | W3-DRAFT-T01 |
| `sw revise <场编号>` | 修订既有场景并登记修订记录 | 规划中·规格就绪 | SPEC-04（[`wave-02/P-gap-adjudication.md`](../wave-02/P-gap-adjudication.md) §3.1，集成分支已含）+ 对齐增补（同 SPEC-05 文档 §6） | W2-GAP-T01 |
| `sw export` | 导出成稿到 `exports/`（v1 仅 markdown，确定性输出） | 规划中·规格就绪 | SPEC-06（同 SPEC-05 文档，`cursor/w3-spec-draft-export-revise-193d`） | W3-DRAFT-T02 |

## 随时可敲的辅助命令

| 命令 | 一句话 | 状态 | 规格 / 出处（所在分支） | 责任任务 |
| --- | --- | --- | --- | --- |
| `sw --help` / `sw -h` | 帮助 + 五步路线图 + 各命令实现进度；各子命令 `--help` 带可复制示例 | **可用** | 脚手架落地说明 [`wave-02/work-scaffold-ci.md`](../wave-02/work-scaffold-ci.md)（集成分支已含） | W1-P1-T03（已完成） |
| `sw --version` / `sw -V` | 输出版本号 | **可用** | 同上 | W1-P1-T03（已完成） |
| `sw status` | 你在第几步、下一步敲什么命令（末行可复制执行） | **可用**（最小版） | SPEC-02（[P1 方案 §7](../wave-01/P1-usability-architecture.md)）；落地说明 [`wave-02/work-workflow-engine.md`](../wave-02/work-workflow-engine.md)（集成分支已含） | W1-P1-T05（最小版已交付） |
| `sw doctor [dir]` | 项目体检：七项检查，红项必附可复制修复命令（全绿 0 / 有红项 1） | **待并入** | 落地说明 `wave-03/work-doctor.md`（`cursor/w3-doctor-3e3d`） | W1-P1-T08（已完成）；并入 = W3-PLAN-T04 后续梯队 |

## 内容质量与版本快照（W3 规格就绪）

| 命令 | 一句话 | 状态 | 规格 / 出处（所在分支） | 责任任务 |
| --- | --- | --- | --- | --- |
| `sw check` | 剧本内容一致性 lint（SW-Cxxx 规则集 v1 共 10 条；`--fix` 白名单默认 dry-run） | 规划中·规格就绪 | [`wave-03/spec-check-snapshot.md`](../wave-03/spec-check-snapshot.md) §4（`cursor/w3-spec-check-snapshot-973a`） | W3-CHECK-T01/T02 |
| `sw snapshot` | 手动版本快照（`--label` 加标签）到 `.sw/history/` | 规划中·规格就绪 | 同上 §5.6 | W3-CHECK-T03 |
| `sw history` | 列出快照历史 | 规划中·规格就绪 | 同上 §5.7 | W3-CHECK-T03 |
| `sw diff <ref>` | 对比工作区与某快照（v1 行级） | 规划中·规格就绪 | 同上 §5.8 | W3-CHECK-T04 |
| `sw restore <ref>` | 恢复到某快照（恢复前自动再快照） | 规划中·规格就绪 | 同上 §5.9 | W3-CHECK-T04 |

## 提案级（规格未细化，仅列防遗漏）

`sw character`（角色卡）、`sw stats`（统计）、`sw move / renumber / remove`（结构重构事务）等，
提案见 [`wave-01/P4-major-experience-features.md`](../wave-01/P4-major-experience-features.md) F3–F6，
任务号 W1-P4-T05…T09。**本表不为其立行**，规格细化后由对应槽位追加。

## 全局约定（所有命令一致）

- **退出码**：`0` 成功（含幂等「无事可做」）/ `1` 运行期错误（SW-Exxx；含检查类命令发现问题）/ `2` 用法错误。权威表在 [`docs/errors/README.md`](../errors/README.md)，裁决正文 [`wave-02/P-gap-adjudication.md`](../wave-02/P-gap-adjudication.md) §3.6。
- **报错格式**：三段式（发生了什么 / 原因 / 怎么办）+ 详情锚点链接，见[空态与错态导读](./errors-and-empty-states.md)。
- **项目目录**：除 `init` / `--help` / `--version` 外，命令须在项目目录（含 `project.yaml`）内运行，否则报 `SW-E011`。
