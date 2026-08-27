# Wave-03 就绪任务队列（Ready Tasks）

> **追加约定（append-only）**：沿用 wave-01/wave-02 同名文件的分区纪律——每个槽的内容包裹在
> `<!-- BEGIN:xxx -->` / `<!-- END:xxx -->` 标记之间；各槽**只在文件末尾追加自己的分区**，
> 不修改、不覆盖其他分区的有效内容。对已有分区的勘误由原槽负责人以追加「修订记录」小节完成。
> 任务 ID 格式 `W{波次}-{槽位}-T{序号}`，全库唯一，被引用后不得复用或改义。
>
> 说明：本文件在分支 `cursor/w3-spec-check-snapshot-973a` 上基于 `main @ deda75a`（无此文件）创建，
> 仅含 WAVE03-CHECK 分区。同名文件的 WAVE03-PLAN 分区在 `cursor/w3-integration-map-bf24`；
> 两分支合并时按 BEGIN/END 分区标记取**并集拼接**（WAVE03-PLAN 在前、WAVE03-CHECK 在后），无内容冲突。

---

<!-- BEGIN:WAVE03-CHECK -->
## WAVE03-CHECK `sw check` 与版本快照实现任务（F1/F2 规格细化产出）

- 来源规格：[`docs/wave-03/spec-check-snapshot.md`](./spec-check-snapshot.md)（下称「规格」；命令面 §4.1/§5.6–5.9、规则注册表 §4.6、存储协议 §5.1–5.5、验收测试清单 §6 AT-C/AT-S）
- 产出分支：`cursor/w3-spec-check-snapshot-973a`
- **与 W1-P4 任务的承接映射**（W1 任务 ID 不复用不改义，实现槽提交信息同时引用两个 ID）：
  W3-CHECK-T01+T02 细化并核销 **W1-P4-T02**；W3-CHECK-T03 核销 **W1-P4-T03**；W3-CHECK-T04 核销 **W1-P4-T04**；
  **W1-P4-T01（内容索引层）不在本分区重复任务化**，仍以原任务号执行（其最小接口契约已在规格 §4.5 定死）。
- 公共约束：**基分支一律取集成分支头**（集成图 §5：功能槽禁止再从 scaffold 或单个 W2/W3 分支分叉），故全表 blocked 于 W3-PLAN-T02；CI 门不可降标（lint / lint:errors / typecheck / test / build / smoke / smoke:exit-codes 全绿 0 跳过）、测试只增不减；错误码（SW-E014/E050–E053）在实际触达的同一提交内登记 + `gen:errors`；不开 PR。
- 工作量为技术规模（S/M/L），非日历时间。

### 总览

| 任务 ID | 名称 | 对应依据 | 优先级 | 工作量 | 依赖 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| W3-CHECK-T01 | `sw check` 规则引擎 + 规则集 v1（10 条注册 / C040 运行期 skip）+ CLI + 文档生成 | 规格 §4；承接 W1-P4-T02 | P0 | M | W3-PLAN-T02、W1-P4-T01 | blocked(W3-PLAN-T02, W1-P4-T01) |
| W3-CHECK-T02 | `--fix` 白名单管线（dry-run 默认 / `--write` 落盘） | 规格 §4.7 | P1 | S | W3-CHECK-T01 | blocked(T01) |
| W3-CHECK-T03 | `.sw/history/` 快照存储 + `sw snapshot/restore` + ADR-0002 | 规格 §5.1–5.6、§5.9–5.11；承接 W1-P4-T03 | P0 | M | W3-PLAN-T02 | blocked(W3-PLAN-T02) |
| W3-CHECK-T04 | `sw history/diff` 时间线与单场恢复 | 规格 §5.7–5.8、§5.9 单场语义；承接 W1-P4-T04 | P1 | M | W3-CHECK-T03、W1-P4-T01 | blocked(T03, W1-P4-T01) |
| W3-CHECK-T05 | C04x 角色规则接入 + doctor/check 互荐接线 | 规格 §4.6 C040、§3.2 | P2 | S | W3-CHECK-T01、W1-P4-T05、台词语法 ADR | blocked(T01, W1-P4-T05, ADR) |

依赖图：`W3-PLAN-T02 → { T01 ∥ T03 }`；`T01 → T02`；`T01 → T05`（另需 W1-P4-T05 与台词语法 ADR）；`T03 → T04`（另需 W1-P4-T01）。T03 与 W1-P4-T01 可并行开工（快照不消费内容索引）。

### 任务明细

#### W3-CHECK-T01 · P0 · `sw check` 规则引擎 + 规则集 v1 + CLI + 文档生成

- **目标**：按规格 §4 交付：`src/app/check/`（registry.ts 单一数据源 + rules/ 每规则一文件 + engine.ts 三态归并）、CLI `sw check [dir] [--format text|json] [--profile default|export]`、`SW-E014` 聚合与退出码 0/1/2、`docs/checks/` 生成（`gen:checks`）与 `lint:errors` 扩展覆盖 SW-Cxxx。规则注册 10 条（§4.6），其中 C040 以 `requires: 'characters'` 注册、运行期恒 skip（数据依赖未交付）；`--fix` 旗标本任务只做解析与「白名单管线随 T02 交付」的诚实提示。
- **文件范围**：`src/app/check/**`、`src/cli/commands/check.ts`、`src/cli/program.ts`（挂载 + 路线图行）、`scripts/`（gen/lint 扩展）、`docs/checks/`（生成物）、`tests/`（规则正反例夹具 + 引擎 + CLI + 进程级退出码）。
- **验收标准（二值）**：规格 AT-C01…C07、AT-C11…C16 全绿（AT-C01/02 的 C040 例外随 T05）；全套 CI 门通过；`sw check --help` 含 ≥2 条可复制示例。
- **风险**：50 场 <1s（AT-C11）依赖索引层 mtime 缓存质量——引擎自身不造缓存，性能不达标时先查 T01（索引层）而非在 check 内加层。
- **依赖**：W3-PLAN-T02（集成分支头：错误框架 + 引擎 + yaml 均就位）、W1-P4-T01（内容索引层，接口契约=规格 §4.5）。

#### W3-CHECK-T02 · P1 · `--fix` 白名单管线

- **目标**：按规格 §4.7 交付白名单 v1 = {C011 追加大纲条目, C051 删除模板帮助注释块}：dry-run 默认（零写盘 + ≤5 行预览）、`--fix --write` 经 `writeFileAtomic` 落盘、幂等（重跑无新 finding）、`--write` 单独出现退出码 2；json 格式追加顶层 `fixes` 数组。
- **文件范围**：`src/app/check/fix.ts`（或并入 engine）、两条规则的 `fix()` 实现、CLI 旗标接线、`tests/`（字节级 dry-run 断言 + 落盘幂等 + 只触碰白名单文件）。
- **验收标准（二值）**：规格 AT-C08、AT-C09、AT-C10 全绿；扩白名单未发生（发生即需规格修订，本任务不得夹带）。
- **风险**：C011 追加条目的插入位置（末尾 vs 按编号序插入）——按规格取**末尾追加**（机械、无歧义），排序问题交给 C012 提示人工处理，不做聪明插入。
- **依赖**：W3-CHECK-T01。

#### W3-CHECK-T03 · P0 · `.sw/history/` 快照存储 + `sw snapshot/restore` + ADR-0002

- **目标**：按规格 §5 交付：内容寻址存储（`objects/` 写前查存在 + `index.yaml` 原子提交点，schema v1 冻结）、G6 白名单收录、引用解析（id 精确 > 唯一前缀 ≥8 > label 精确）、`sw snapshot [dir] --label` 与 `sw restore <ref> [--dir]`（恢复前无条件 auto-safety 快照 + 白名单内删除语义 + 撤销命令输出）、错误码 E050/E051/E052 登记、三份模板 `.gitignore` 加 `.sw/`、`docs/adr/0002-state-vs-archive.md`（要点=规格 §5.11，含「删 .sw/ 行为不变」判定标准与 .sw/lock 例外说明）。
- **文件范围**：`src/infra/history/`（存储适配器）、`src/app/history/`（快照/恢复用例）、`src/cli/commands/{snapshot,restore}.ts`、`src/cli/program.ts` 挂载、`templates/*/gitignore`、`docs/adr/0002-*.md`、`scripts/smoke-exit-codes.mjs` 扩展、`tests/`（含注入式中断与 kill -9 冒烟）。
- **验收标准（二值）**：规格 AT-S01、AT-S02、AT-S03、AT-S05、AT-S06、AT-S07、AT-S08、AT-S12、AT-S13、AT-S14 全绿；AT-S15 中 E050/E051/E052 三码触达；ADR-0002 合入且 `docs/README.md` ADR 分区追加索引行。
- **风险**：过度设计（W1-P4-T03 风险条款原文）——GC/压缩/打包/加密一律禁止，出现即验收失败；对象写入的临时文件+rename 细节复用 `writeFileAtomic` 模式，不另起炉灶。
- **依赖**：W3-PLAN-T02（不依赖 W1-P4-T01——快照按 G6 白名单枚举文件，不消费内容索引）。

#### W3-CHECK-T04 · P1 · `sw history/diff` 时间线与单场恢复

- **目标**：按规格 §5.7–5.9 交付：`sw history [dir] [--scene id] [--format text|json]`（新→旧时间线、场级过滤=哈希变化、空态 hint 三要素）、`sw diff <from> [to] [--scene id] [--dir]`（缺省 to=工作区；默认变更摘要 + 场分节头；`--scene` 行级明细 80 列；v1 行级渲染、台词分类留 G7 升级位）、`restore --scene <id>` 单场恢复（不触碰 project.yaml 与他场）、错误码 E053 登记。
- **文件范围**：`src/app/history/` 扩展（时间线查询 + diff 计算 + 渲染器）、`src/cli/commands/{history,diff}.ts`、restore 命令 `--scene` 旗标、`tests/`（结构快照测试 + 单场恢复隔离断言）。
- **验收标准（二值）**：规格 AT-S04、AT-S09、AT-S10、AT-S11 全绿；AT-S15 中 E053 触达；diff 测试只锁结构（分节头/计数标签/前缀/列宽）不锁全文。
- **风险**：diff 渲染打磨无底（W1-P4-T04 风险条款原文）——验收锁结构断言即止，视觉细节不进验收；`--scene` 过滤的「变化」定义严格取哈希不等（含出现/消失），不做内容相似度。
- **依赖**：W3-CHECK-T03、W1-P4-T01（场分节头需索引的场号/slug；若索引层晚于本任务就绪，允许先交付按文件路径分节的降级版并在落地说明登记，索引就绪后补场分节）。

#### W3-CHECK-T05 · P2 · C04x 角色规则接入 + doctor/check 互荐接线

- **目标**：台词语法 ADR 定案且 W1-P4-T05（角色卡 + 出场索引）交付后：C040 从 skip 转为运行（按主名+显式别名精确归并，未建卡署名 warn，按名字聚合定位首次出现），AT-C13 从 skip 断言替换为 warn 正例断言、补 AT-C01/02 的 C040 正反例；doctor 全绿结论行下追加「内容一致性请运行 `sw check`」引荐行（doctor 检查项零迁移，规格 §3.2）。
- **文件范围**：`src/app/check/rules/c040.ts` 激活、`src/app/diagnostics/`（或 doctor CLI 渲染层）追加一行、`tests/`（C040 正反例 + 别名归并边界 + doctor 引荐行断言）。
- **验收标准（二值）**：AT-C01/02 含 C040 全绿；AT-C13 新形态全绿；doctor 全绿输出末尾含引荐行、有红项时不含（双分支断言）；模糊名字匹配零出现（规格 §7 非目标）。
- **风险**：低。归并逻辑属 W1-P4-T05 的索引层职责，本任务只消费（speakers × characters 求差集），不实现归并。
- **依赖**：W3-CHECK-T01、W1-P4-T05、台词语法 ADR（跨槽对齐点，先开工者定案——承 W1-P4 §5.4）。

### 修订记录

（暂无）
<!-- END:WAVE03-CHECK -->
