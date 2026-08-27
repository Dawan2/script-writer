# Wave-04 就绪任务队列（Ready Tasks）

> **追加约定（append-only）**：沿用 wave-01/02/03 同名文件的分区纪律——每个槽的内容包裹在
> `<!-- BEGIN:xxx -->` / `<!-- END:xxx -->` 标记之间；各槽**只在文件末尾追加自己的分区**，
> 不修改、不覆盖其他分区的有效内容。对已有分区的勘误由原槽负责人以追加「修订记录」小节完成。
> 任务 ID 格式 `W{波次}-{槽位}-T{序号}`，全库唯一，被引用后不得复用或改义。
>
> 说明：本文件在分支 `cursor/w4-spec-file-lock-a3e6` 上基于 `main @ deda75a`（无此文件）创建，
> 仅含 WAVE04-LOCK 分区，是 wave-04 队列的首个分区。wave-01/02/03 的队列文件各分区仍在各自分支，
> 本文件不携带其副本；四份文件是不同波次的队列，合并后并存，互相以任务 ID 引用。

---

<!-- BEGIN:WAVE04-LOCK -->
## WAVE04-LOCK 项目级文件锁实现任务（SPEC-07 落地）

- 来源规格：[`docs/wave-04/spec-file-lock.md`](./spec-file-lock.md)（下称「规格」；锁协议 §3、stale 接管 §4、`SW-E012` §5、锁矩阵 §6、doctor 四态 §7、验收 AT-L01…L15 §9、非目标 §10）
- 产出分支：`cursor/w4-spec-file-lock-a3e6`
- **与既有任务的承接映射**（沿用 W3-CHECK 先例：既有任务 ID 不复用不改义，实现槽提交信息同时引用两个 ID）：
  W4-LOCK-T01+T02 细化并核销 **W2-GAP-T04**（GAP-04 承接任务）。拆分理由：doctor 检查项接入依赖 doctor 分支并入集成线，与锁基元的前置不同，捆绑会让 T01 无谓等待。
  **draft / export / revise / check --fix / snapshot / restore 各行的锁接线不在本分区立项**——归各自实现任务（W3-DRAFT-T01/T02、W2-GAP-T01、W3-CHECK-T02/T03/T04）按规格 §6.1 矩阵执行（每命令一行包装器 + 加入 AT-L15 清单常量）。
- 公共约束：**基分支一律取集成分支头**（集成图 §5，禁止从 doctor / outline / 单个 W2 分支分叉）；CI 门不可降标（lint / lint:errors / typecheck / test / build / smoke / smoke:exit-codes 全绿 0 跳过）、测试只增不减、断言只迁移不删除；`SW-E012` 在实际触达的同一提交内登记 + `gen:errors`（禁止预填）；不合并进 `main`；不开 PR。
- 工作量为技术规模（S/M/L），非日历时间。
- 状态图例：`ready`＝直接前置就绪即可开工；`blocked`＝等待前置任务。

### 总览

| 任务 ID | 名称 | 对应依据 | 优先级 | 工作量 | 依赖 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| W4-LOCK-T01 | 锁基元 + 既有写命令接线 + `SW-E012` + stale 接管 | 规格 §3–§6、§9；承接 W2-GAP-T04 主体 | P1 | M | W3-PLAN-T02（已具备）；outline 分支并入集成线（outline 行接线的前置，未并入时该行随并入补接线） | ready（集成分支已就绪） |
| W4-LOCK-T02 | doctor 锁健康检查项四态接入（替换 `project-lock` 的「未实现」skip） | 规格 §7、§9 AT-L04/L05/L10；承接 W2-GAP-T04 doctor 联动 + doctor 槽交接项 | P1 | S | W4-LOCK-T01；doctor 分支并入集成线（含 §11-2 E013 撞号先行定案） | blocked(T01, doctor 并入) |

依赖图：`W3-PLAN-T02 →（已完成）→ T01 → T02`；`doctor 并入集成线 → T02`。T01 与 W3-DRAFT-T01/T02、W2-GAP-T01 并行不冲突（锁未落地时各命令空转不阻塞、锁先落地时未实现命令行自动跳过——规格 §6.1 双向条款）。

### 任务明细

#### W4-LOCK-T01 · P1 · 锁基元 + 既有写命令接线 + `SW-E012` + stale 接管

- **目标**：按规格 §3–§6 交付：`src/infra/store/lock.ts` 原语（`acquireProjectLock` / `releaseProjectLock` / `withProjectLock`，独占创建 `'wx'`、内容 schema §3.2、finally 释放 §3.4、锁原语可注入的测试缝）；stale 判定与自动接管全边缘（§4：同机 pid 存活探测、他机不接管、不可解析不接管、接管竞态单次重试）；`SW-E012` 注册表登记 + `docs/errors/SW-E012.md` 生成 + `smoke:exit-codes` 扩展（§5，随 AT-L01 触达同提交）；已实现写命令接线——`sw init`（特殊次序 §6.2）与 `sw outline`（若 outline 已并入集成线；未并入则该行接线义务随并入转交并在落地说明登记）；锁接线清单常量 + 表驱动覆盖度测试（§6.3 / AT-L15）；`LOCK_FILE` 常量迁至 `layout.ts`（规格 §11-1）。
- **文件范围**：`src/infra/store/lock.ts`（新）、`src/infra/store/layout.ts`（+`LOCK_FILE`）、`src/cli/commands/init.ts`（+包装器）、`src/cli/commands/outline.ts`（同上，视并入状态）、`src/app/errors/registry.ts` + `docs/errors/SW-E012.md`（生成物）、`scripts/smoke-exit-codes.mjs` 扩展、`tests/`（AT-L01/L02/L03/L06/L07/L08/L09/L10/L11/L12/L13/L14/L15）。
- **验收标准（二值）**：规格 AT-L01、L02、L03、L06、L07、L08、L09、L10、L11、L12、L13、L14、L15 全绿（L03 的 `revise --list` 分支与 L15 的未实现命令行按规格注明跳过，落地即纳入）；全套 CI 门通过；`lint:errors` 全绿（E012 非预填、生成物提交）。
- **风险**：跨平台差异——Windows 下 `'wx'` 独占创建与 `unlink` 语义已可移植（GAP-04 裁定的动机），但 `process.kill(pid, 0)` 的 EPERM 语义按「存活」处理需在 CI 双平台矩阵上核实（现 CI 为 Node 20/22 矩阵，如无 Windows runner 则登记为已知限制，不虚报覆盖）；锁文件写入不得误用 `writeFileAtomic`（temp+rename 摧毁 `O_EXCL` 互斥，规格 §3.3 红线）。
- **依赖**：W3-PLAN-T02（集成分支：错误框架 + 引擎 + init 已就位）；outline 并入为 outline 行接线的前置（非任务整体前置）。

#### W4-LOCK-T02 · P1 · doctor 锁健康检查项四态接入

- **目标**：按规格 §7 替换 `src/app/diagnostics/checks.ts` 的 `lockCheck`（id `project-lock`、title、`DOCTOR_CHECKS` 数组结构均不变）：无锁 pass / 活锁 pass（注明持有者）/ stale 红项 + 可复制修复命令（GAP-04 验收 ④）/ 不可解析红项 + 修复命令 / 他机锁 skip 如实登记；doctor 全程只读、永不删锁不接管；复用 T01 的锁读取与判定原语（不重写解析）。
- **文件范围**：`src/app/diagnostics/checks.ts`（lockCheck 替换 + `LOCK_FILE` 改从 layout 导入）、`tests/`（AT-L04、AT-L05、AT-L10 doctor 侧）。
- **验收标准（二值）**：规格 AT-L04、AT-L05、AT-L10（doctor 分支）全绿；doctor 既有 105 条测试零删除零跳过（「未实现」skip 的既有断言允许改写为四态断言，不允许删除）；全套 CI 门通过。
- **风险**：低。四态判定复用 T01 原语，本任务只做检查项组装与文案；唯一坑是 doctor 红项聚合码的 E013 撞号（规格 §11-2）须在 doctor 并入集成线时先行定案，本任务不裁决、只消费定案结果。
- **依赖**：W4-LOCK-T01、doctor 分支并入集成线（集成槽职责，任务号待其分区登记）。

### 修订记录

（暂无）
<!-- END:WAVE04-LOCK -->
