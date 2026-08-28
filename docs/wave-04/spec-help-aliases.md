# W4 计划槽：SPEC-07 help 系统与短别名（W2-GAP-T02 细化）

| 项目 | 内容 |
| --- | --- |
| 波次 / 槽位 | 第 4 波（wave-04）/ 周期 W4 落地 / 计划槽 W2-GAP-T02 help --all 与别名 |
| 仓库 | github.com/Dawan2/script-writer |
| 基线 | `main @ deda75a`（docs-only 槽按集成图 §5 约定基于 main；引用的实现在各分支，锚点见 §2） |
| 工作分支 | `cursor/w4-spec-help-aliases-0f4e`（已 push，未开 PR） |
| 文档性质 | 命令规格：SPEC-07 命令注册表驱动的 help 系统（`--help` / `sw help --all`）与集中短别名表——GAP-02 裁决（w2-gap §3.2）的可实现级细化 + 别名全集 v1 增补 |
| 硬边界 | **docs-only**：本槽零 `src/` 改动（集成分支 `cursor/w3-integrate-w2-f334` 收尾中，W3-PLAN-T04/T05 未完成前任何提前实现都会加宽冲突面） |
| 配套文档 | `docs/wave-04/ready-tasks.md`（新建，仅含 WAVE04-HELP 分区）、`docs/DISPATCH-receipt.md`（追加回执） |

> **给合并者的索引行**（并入 `docs/README.md` 时新建「波次工作文档（wave-04）」分区粘贴）：
> `| [\`wave-04/spec-help-aliases.md\`](./wave-04/spec-help-aliases.md) | W4 计划槽：SPEC-07 命令注册表驱动 help（默认渐进披露 / help --all 全集）与短别名全集 v1（i/o/d/r/x/s）、help 快照测试面、T09 用户文档互链 | \`cursor/w4-spec-help-aliases-0f4e\` |`
> `| [\`wave-04/ready-tasks.md\`](./wave-04/ready-tasks.md) | Wave-04 就绪任务队列（WAVE04-HELP 分区：W4-HELP-T01/T02；实现主体仍为 W2-GAP-T02，不重复立项） | \`cursor/w4-spec-help-aliases-0f4e\` |`

---

## 1. 结论速览（TL;DR）

1. W2-GAP-T02 已有裁决（GAP-02，w2-gap §3.2）与任务登记（`docs/wave-02/ready-tasks.md`），但距「拿到即开工」还差四件事：① 集成分支现状是 `program.ts` 内**手工维护的 ROADMAP_HELP 字符串**（GAP-02「禁止手工清单」尚未兑现，且路线图漏了 revise 行）；② 无 `help` 子命令、无 `--all` 视图；③ 零别名注册；④ help 快照测试（W1-P1-T10 快照半面）无载体。本文补齐为 SPEC-07，粒度对齐 SPEC-01…06「可直接开工」标准。
2. 关键裁定四条：① **命令注册表 `src/cli/registry.ts` 为单一数据源**（名称 / 别名 / 一句话 / 分组 / 状态 / 责任任务），`program.ts` 挂载循环、默认 help、`help --all`、路线图行全部由注册表生成，手工清单退役（§4.1）；② **别名全集 v1 扩为六只 `i/o/d/r/x/s`**——`d`/`x`/`r` 承 P1 §6.4 与 SPEC-04 既有裁定，`i`/`o`/`s` 为本 W4 调度指令增补，全部经中央表交付（GAP-02「新增别名必须改此表」的既定扩展路径，机制条款不变，§4.2）；③ `sw help [command] [--all]` 与 `--help` 同渲染出口，`--all` 才展示全集（渐进披露不回退，§4.4）；④ **零新错误码**——help 面只有 0/2 两档退出码，无运行期错误面（§4.7）。
3. 验收含快照测试：并入 W1-P1-T10 的 help 快照结构断言（只锁结构不锁全文，T10 既有风险缓解沿用），核心是「注册 ↔ 注册表 ↔ `--all` 输出」三向一致断言与六别名逐字节等价断言（§5）。
4. 与 T09 用户文档互链：`docs/user/commands.md`（人读、命令可用性唯一口径）与 `sw help --all`（注册表生成、机器口径）双口径划界 + URL 互链 + 「使能槽同一提交更新」责任落实（§6）。
5. 任务承接：**实现主体仍为 W2-GAP-T02，不重复立项**（先例：WAVE03-DRAFT 对 W2-GAP-T01 同法）；新增 W4-HELP-T01（注册表基建，前置）与 W4-HELP-T02（快照 + 互链收口），登记于 `docs/wave-04/ready-tasks.md` WAVE04-HELP 分区。
6. 本槽 docs-only：不做功能开发、不开 PR、不建子代理、不触碰任何测试与 CI 配置。

---

## 2. 输入与依据（只引用，不重做）

| 来源 | 分支 @ 提交 | 消费内容 |
| --- | --- | --- |
| P1 架构方案 | `cursor/w1-p1-usability-architecture-5d0e @ 4612cdb` | §6.4 快捷操作（`sw d`/`sw x`、别名表集中声明、`--help` 中可见）、§6.5 渐进披露（默认 help 只展示五步 + `help --all` 全集）、§4 指标（命令可发现性：每条 `--help` ≥1 可复制示例）、W1-P1-T10（help 快照测试） |
| GAP 裁决 | `cursor/w2-gap-adjudication-c82d @ 661b313` | §3.2 GAP-02 全要点与验收 ①–③（本文细化对象）、§3.1 SPEC-04（`sw r` 出处）、§3.6 SPEC-03-EXT 退出码表 |
| W2 任务队列 | 同上 | W2-GAP-T02 登记行（目标 / 文件范围 / 依赖），本文为其开工依据 |
| W3 draft/export 规格 | `cursor/w3-spec-draft-export-revise-193d @ 017212c` | §3-4（别名由 W2-GAP-T02 集中交付、实现槽不得散落注册）、§3-5 help 纪律、§11 别名交接句（全集来源自本文 §4.2 起接管） |
| W3 check/快照规格 | `cursor/w3-spec-check-snapshot-973a @ f751d2e` | 「旗标组合校验属 argparse 层语义 → 退出码 2，实现建议在 program 配置层完成」先例（§4.4 消费）；check 的 help「进 help 快照全集」提法 |
| 集成分支（实现现状） | `cursor/w3-integrate-w2-f334 @ e2721d4` | `src/cli/program.ts`（手工 ROADMAP_HELP、`registerInitCommand`/`registerStatusCommand` 挂载形态、无参数 action = outputHelp 与切换点注释）、`src/cli/run.ts`（`runCli` 退出码通道、CommanderError → 2 映射）、`eslint.config.js`（no-restricted-syntax 防线形态，§4.2 别名 lint 复用）、`package.json`（bin：`sw` 与 `script-writer` 双入口已注册，P1 §6.4 首条已兑现） |
| T09 用户文档 IA | `cursor/w3-user-docs-ia-f6ca @ ee8e7fa` | `docs/user/commands.md`（命令可用性唯一口径、「使能槽同一提交更新本表」责任约定、全局约定第 3 条项目目录豁免清单）、T09 余项登记（`--help` 尾部 URL 改指 reference 页属 T09 余项，本文不越界） |
| 集成图 | `cursor/w3-integration-map-bf24 @ 43a6ecf` | §5 基分支纪律（功能槽一律基于集成分支头；docs 槽基于 main）、CI 门不可降标与测试只增不减纪律 |

冲突处理沿用既定纪律：先落地者为准、追加勘误不删改他槽原文、任务/字段/别名 ID 一经引用不复用不改义。

---

## 3. 现状差距（2026-08-27 集成分支头实测）

| # | 现状（`e2721d4`） | 与目标的差距 | 落点 |
| --- | --- | --- | --- |
| 1 | `program.ts` 内 ROADMAP_HELP 为手工字符串，且五步路线图**漏 revise 行**（首行「init → outline → draft → revise → export」与逐行清单不一致） | GAP-02「全集清单从命令注册表生成，禁止手工维护清单」未兑现 | §4.1 注册表；§4.3 路线图生成 |
| 2 | 无 `help` 子命令；commander 隐式 help 命令不支持 `--all` | `sw help --all` 全集视图缺失 | §4.4 |
| 3 | 零别名：`init`/`status` 均无 `.alias()` | 别名全集与集中表缺失 | §4.2 |
| 4 | 无 help 快照测试；`smoke` 仅跑 `--version`/`--help` | W1-P1-T10 快照半面无载体 | §5 |

挂载形态可直接复用：各命令 `registerXCommand(program, io)` 单挂载点 + `program.ts` 顺序调用——注册表化只是把「顺序调用」改为「遍历注册表」，不动各命令模块内部。

---

## 4. SPEC-07 正文

### 4.1 命令注册表（单一数据源）

新增 `src/cli/registry.ts`，条目形态（示意，字段名以实现为准、语义以本节为准）：

```ts
interface CommandSpec {
  name: string;                 // 主命令词（与文档/目录同词汇，P1 §6.1 词汇一致性）
  alias?: string;               // 短别名（§4.2 约束）；无别名则省略
  summary: string;              // 一句话（默认 help / --all / 路线图共用）
  group: 'main' | 'aux';        // main = 五步主命令 + status（默认 help 展示）；aux = 其余
  status: 'available' | 'planned'; // 诚实进度：planned 不注册命令，仅入路线图与 --all「规划中」段
  taskId: string;               // 责任任务 ID（诚实进度标注来源，如 W3-DRAFT-T01）
  register?: (program: Command, io: CliIo) => void; // available 必填；planned 禁填
}
```

**规则（均为验收断言对象）**：

1. **唯一挂载循环**：`buildProgram` 遍历注册表，对 `status: 'available'` 条目调用其 `register`，随后**在挂载循环内**（唯一位置）注入 `.alias()` 与别名可见性尾注——子命令模块内禁止出现 `.alias()`（lint 防线见 §4.2-4）。
2. **planned 条目零注册**：不产生可执行命令（虚假可用性禁令，W1-P1-T01 验收 ③），只进路线图与 `--all` 的「规划中」段，行内标注 `[规划中 · <taskId>]`。命令实现槽交付时把对应条目 `planned → available` 并填 `register`，**与命令落地同提交**（诚实进度纪律；同时履行 `docs/user/commands.md` 文件头的同提交更新责任，§6.2）。
3. **注册表内容以落地时点的实现现状为准**。当前时点（`e2721d4`）的对照示例：available = init、status；planned = outline（W1-P1-T07，待并入）、draft（W3-DRAFT-T01）、revise（W2-GAP-T01）、export（W3-DRAFT-T02）为 main 组，doctor（W1-P1-T08，待并入）为 aux 组——**revise 行为注册表化的顺带修正**（现 ROADMAP_HELP 漏行，§3-1）。help 自身作为 aux 组 available 条目入表（自举：`--all` 输出里能看到 help 自己）。
4. **排序**：main 组按五步工作流序（init → outline → draft → revise → export → status），aux 组按注册表数组序；渲染层不做二次排序（输出确定性）。

### 4.2 短别名表 v1（全集）

| 别名 | 主命令 | 出处 |
| --- | --- | --- |
| `sw i` | `sw init` | 本文增补（W4 调度指令） |
| `sw o` | `sw outline` | 本文增补（W4 调度指令「等」的展开：五步全覆盖） |
| `sw d` | `sw draft` | P1 §6.4 原文 |
| `sw r` | `sw revise` | SPEC-04 / GAP-01（GAP 勘误表 #4） |
| `sw x` | `sw export` | P1 §6.4 原文（保留 `x`，不因 export 首字母改 `e`——引用不改义） |
| `sw s` | `sw status` | 本文增补（W4 调度指令） |

**约束**：

1. 别名仅小写、长度 1–2 字符、全表唯一且不得与任何主命令词冲突（结构单测断言，§5-2）。
2. **别名随命令注册才生效**：planned 条目的 alias 字段可先声明（如 revise 的 `r`），但命令未注册时别名同样不可执行——不存在「别名先行」。
3. **不预占未裁决别名**：check / snapshot / character 等未来命令的别名（如 `c`）由其实现槽经此表增补，本表不预填（对齐 SPEC-03「禁止预填未用码」同款纪律）。
4. **散落注册防线**（GAP-02「散落注册在 CI lint 中失败」的落地形态）：eslint `no-restricted-syntax` 追加 selector 拦截 `.alias(` 调用出现在 `src/cli/registry.ts` 之外（豁免仅注册表模块，形态对齐既有 process.exitCode 防线）；再加结构单测双向断言（§5-2）兜底。
5. **等价性契约**（GAP-02 验收 ③）：`sw <别名> …` 与 `sw <主命令> …` 同参数下 stdout / stderr / 退出码 / 盘面副作用**逐字节等价**（commander `.alias()` 分派同一 action 天然满足，验收仍需进程级断言，§5-4）；一切报告与建议输出（含 status 末行可复制命令）一律印**主命令全词**，不回显别名——教学一致性 + 快照单份。

### 4.3 默认 help（渐进披露）

`sw --help`、`sw -h`、`sw help`（无参数）、`sw`（无参数）四入口同一渲染出口，内容自注册表生成：

1. 用法行 + 一句话描述（既有 manifest 来源不变）。
2. **main 组 available 命令清单**（含别名列，如 `draft|d`）——不含任何 aux 组命令（渐进披露不回退，GAP-02 验收 ②）。
3. 提示行：`运行 sw help --all 查看全部命令与别名`（`--all` 的可发现性入口）。
4. 路线图段（替代手工 ROADMAP_HELP，语义等价、来源改注册表）：五步 + status 逐行，available 标 `[可用 · <taskId>]`、planned 标 `[规划中 · <taskId>]`；首行五步示意与逐行清单由同一数据生成，**不可能再出现漏行**（§3-1 缺陷类别就此关闭）。
5. 尾部文档 URL 维持 `docs/quickstart.md` 路径（T09 指针页已保住该路径；改指 reference 页属 T09 余项，本文不越界）。

**非目标**：`sw`（无参数）从 outputHelp 切换为等价 `sw status`（P1 §6.4 首条）**不属本规格**——切换点条件（非项目目录也有引导）见 `program.ts` 既有注释，归 SPEC-02 后续槽（§8-1）。

### 4.4 `sw help [command] [--all]` 子命令

```text
sw help                 # = sw --help（同一渲染出口）
sw help --all           # 全集视图：全部已注册命令 + 别名 + 「规划中」段
sw help <command>       # = sw <command> --help（逐字节等价）
sw h、sw help -a        # 不提供：help 不设别名与短旗标（低频入口，避免占用命名空间）
```

- 实现形态：停用 commander 隐式 help 命令（`helpCommand(false)`），以注册表 aux 条目显式注册 `help`（否则 `--all` 无处挂载）。
- **`--all` 视图内容**（全部生成自注册表，禁手工）：三段分组输出——「主工作流」（main 组 available，含别名列）、「辅助命令」（aux 组 available，含别名列）、「规划中」（planned 条目 + 责任任务标注）；每行 = 命令、别名（有则显示）、一句话。尾部印 `docs/user/commands.md` 的 main 路径 URL（人读口径互链，出现条件见 §6.3——目标文件未并入前该行不印，渐进增强断言，同 SPEC-04 引荐行先例）。
- **旗标组合**：`--all` 与 `<command>` 参数互斥——`sw help draft --all` 属 argparse 层用法错误 → 退出码 2、零副作用。实现建议在 program 配置层校验抛 CommanderError（SPEC-F1「`--write` 不带 `--fix`」先例：`program.error()` 禁令针对业务错误，不适用于解析层）。
- `sw help <未知词条>` → 用法错误，退出码 2（CommanderError 通道，`run.ts` 既有映射）。
- 退出码全集：成功输出 help/`--all` → 0；用法错误 → 2。**help 面无运行期错误（1 档）**：不读 `project.yaml`、不触盘。

### 4.5 子命令 `--help` 的别名可见性与示例

- **别名可见**（GAP-02 原句落实）：挂载循环为每条有别名的命令统一追加尾注行（如 `短别名：sw d ≡ sw draft`）；连同 commander 清单列的 `draft|d` 形态，构成双重可见。可见性断言 = 子命令 help 文本包含别名词条（结构断言，不锁全文）。
- **≥1 可复制示例**纪律延续（P1 §4 命令可发现性，既有 init/status 已达标）：示例一律用主命令全词书写（可复制性 + 词汇一致），不用别名书写示例。

### 4.6 状态、存储与锁

- help / `help --all` / 各命令 `--help` **零状态写入**、不读 `project.yaml`、非项目目录可运行（与 `--version` 同档）。
- 锁矩阵（GAP-04）：纯只读，不加锁；`.sw/lock` 被持有时 help 照常可用。
- `docs/user/commands.md` 全局约定第 3 条「除 init / `--help` / `--version` 外，命令须在项目目录内运行」的豁免清单需追加 `help` 子命令与别名说明——append 勘误，落点 §7-4。

### 4.7 错误码

**零新错误码，零登记动作**。help 面退出码只有 0/2 两档（§4.4）；SPEC-03「禁止预填未用码」自然满足。E01x–E05x 现有占用（E010/E011/E012 预留/E013/E020/E030/E031 + E032–E034 预留 + E05x 提案段）均不受本规格影响。

---

## 5. 快照测试与验收要点（W1-P1-T10 快照半面的完成定义）

结构断言优先、不锁全文（W1-P1-T10「快照易碎」既有缓解沿用）；如用 vitest 快照，只锁「命令词条集合」的序列化形态。测试落点建议 `tests/cli/help.spec.ts` + 进程级用例进 `smoke:exit-codes`（T10 文件范围写的 `tests/help-snapshots/` 目录按既有 `tests/` 布局勘误为此落点，§7-5）。TTFS 半面已由 W3-DRAFT-T03 承接，本文不重复。

**验收要点（二值）**：

① **渐进披露**：默认 help（四入口逐一）包含全部 main 组 available 命令行与其别名、包含 `help --all` 提示行与尾部 URL；**不含任何 aux 组命令词条**（GAP-02 验收 ②）。
② **三向一致**：注册表条目 ↔ commander 实际注册（`program.commands` 的 name/alias 集合）↔ `--all` 输出词条，两两双向相等——「注册未入 help 即失败」（GAP-02 验收 ①）与「表里有必注册、注册必在表」同一断言组；别名全表唯一且不与主命令词冲突。
③ **别名等价**：六别名逐条进程级断言——同 fixture 下 `sw <别名> …` 与 `sw <主命令> …` 的 stdout / stderr / 退出码逐字节相等；写命令（落地后的 d/r/x）用「双份相同 fixture 目录各跑一次 + 产物目录逐字节对比」法（GAP-02 验收 ③）。v1 时点至少覆盖已注册命令（i/s），其余别名断言随对应命令落地由使能槽补齐（渐进增强，断言框架本任务交付）。
④ **别名可见 + 示例**：每条 available 命令 `--help` 含 ≥1 可复制示例；有别名者含别名词条（§4.5）。
⑤ **等价入口**：`sw help` ≡ `sw --help`、`sw help <cmd>` ≡ `sw <cmd> --help` 逐字节等价。
⑥ **用法错误档**：`sw help draft --all` 与 `sw help <未知词条>` 退出码 2、零副作用；`sw help --all` 在非项目目录退出码 0。以上两档进 `smoke:exit-codes`（真实进程断言，既有 0/2 档矩阵扩行）。
⑦ **手工清单退役**：`program.ts` 无 ROADMAP_HELP 字面量；路线图行（含 revise planned 行）自注册表生成。
⑧ **lint 防线**：`.alias(` 出现在 `src/cli/registry.ts` 之外 → lint 失败（反例验证进落地说明，对齐错误框架槽先例）。
⑨ **CI 门不可降标**：lint / lint:errors / typecheck / test / build / smoke / smoke:exit-codes 全绿 0 跳过；测试只增不减、断言只迁移不删除（既有 `program.spec.ts` 对 ROADMAP_HELP 的断言允许随注册表化改写期望文案，不允许删除）。

---

## 6. 与 T09 用户文档互链（双口径与责任）

### 6.1 口径划界

| 口径 | 载体 | 性质 | 覆盖 |
| --- | --- | --- | --- |
| 人读口径 | `docs/user/commands.md` | 命令可用性**唯一口径**（T09 既定），含提案级命令与规格链接 | 全部已知命令（含未入注册表的提案级） |
| 机器口径 | `sw help --all` | 注册表生成，随代码走 | 已入注册表的 available + planned 条目 |

两口径不互相替代：`--all` 永不展示提案级命令（注册表无其条目）；commands.md 永不被生成物覆盖。一致性由 ⑴ 使能槽同提交更新责任（§6.2）与 ⑵ help 快照三向一致断言（§5-②）分别看住两侧。

### 6.2 同提交更新责任（commands.md 文件头约定的落实）

- W2-GAP-T02 使 `sw help --all` 可用的那个提交，须同步更新 `docs/user/commands.md`：辅助命令表追加 `sw help [command] [--all]` 行（状态「可用」）；全局约定第 3 条豁免清单追加 help（§7-4）。
- 各主命令行的「一句话」与注册表 `summary` 语义对齐（不要求逐字节相同——两侧受众不同，但不得语义冲突）。
- commands.md 各命令行增补别名标注（如 `sw draft <场编号>`（别名 `sw d`））属 T09 文档面，由 W4-HELP-T02 收口（§7-4）。

### 6.3 URL 互链

- `--help` 尾部 URL：维持 `docs/quickstart.md`（指针页保路径，T09 既定）；改指 reference 页的切换点归 T09 余项，本规格不动。
- `help --all` 尾部 URL：指 `docs/user/commands.md` 的 main 路径。**出现条件 = 该文件已并入实现所基于的分支**（当前 user-docs 产出尚在 `cursor/w3-user-docs-ia-f6ca`，未并入集成分支）；未并入前该行不印（虚假 URL 禁令，渐进增强断言同 SPEC-04 引荐行先例），并入后随 W4-HELP-T02 点亮并补断言。

---

## 7. 对齐点与勘误登记（append-only，不改写他槽原文）

合并者按下表回写；回写前，本表即勘误的权威记录。

| # | 对象文档（分支） | 勘误/对齐内容 | 来源 |
| --- | --- | --- | --- |
| 1 | P1 §6.4 别名表 | 追加 `sw i` = init、`sw o` = outline、`sw s` = status（GAP 勘误表 #4 已追加 `sw r`，本行续录三只） | §4.2 |
| 2 | GAP-02（w2-gap §3.2）「当前全集：`sw d`/`sw x`/`sw r`」 | 全集 v1 扩为六只，权威表移交本文 §4.2（GAP-02 机制条款——集中表、注册表生成、CI lint——原样有效不改义） | §4.2 |
| 3 | `docs/wave-02/ready-tasks.md` W2-GAP-T02 行 | 追加备注行：开工依据 = 本文 SPEC-07；依赖列追加 W4-HELP-T01（注册表基建前置）；基分支按集成图 §5 取集成分支头 | §4.1、ready-tasks |
| 4 | `docs/user/commands.md`（`cursor/w3-user-docs-ia-f6ca`） | 全局约定第 3 条豁免清单追加 `help`；辅助命令表追加 `sw help [command] [--all]` 行（使能提交同步）；各命令行增补别名标注（W4-HELP-T02 收口） | §4.6、§6.2 |
| 5 | W1-P1-T10（wave-01 ready-tasks） | 快照半面的完成定义细化为本文 §5（结构断言清单）；文件范围 `tests/help-snapshots/` 按既有 `tests/` 布局勘误为 `tests/cli/help.spec.ts`；TTFS 半面已由 W3-DRAFT-T03 承接（既有事实，重申防重做） | §5 |
| 6 | W3 规格 §3-4 / §11 别名交接句（`cursor/w3-spec-draft-export-revise-193d`） | 「`sw d`/`sw x`/`sw r` 三只映射」的全集来源自本文 §4.2 起接管（原声明不失效，是子集） | §4.2 |
| 7 | 集成分支 `program.ts` 路线图 | ROADMAP_HELP 漏 revise 行的既有事实：注册表化时以 planned 条目补齐（W2-GAP-T01 落地前 status=planned），不单独出修复提交 | §3-1、§4.1-3 |

---

## 8. 非目标（边界外，防散焦）

1. `sw`（无参数）→ 等价 `sw status` 的切换（P1 §6.4 首条；切换点条件见 `program.ts` 注释，归 SPEC-02 后续槽）。
2. `--help` 尾部 URL 改指 reference 逐命令页（T09 余项 ①③）。
3. Web 命令面板（P1 §6.4 未来形态）。
4. shell 补全（completion）与 man page。
5. 未来命令（check/snapshot/character/…）的别名预占（§4.2-3）。

---

## 9. 交接与阻塞

- **给 W4-HELP-T01 承接者（注册表基建）**：基分支一律取集成分支头（集成图 §5）；改造面 = `src/cli/registry.ts`（新）+ `program.ts`（挂载循环化、ROADMAP_HELP 退役）+ help 渲染模块（默认/全集/路线图三视图同源）；init/status 的 `registerXCommand` 模块内部零改动。W3-DRAFT-T01/T02 与 W2-GAP-T01 落地时只需在注册表把对应条目 planned→available 并填 `register`——先交付注册表可让后续命令槽的 `program.ts` 冲突面从「挂载行 + 路线图行」缩为「注册表条目一行」。
- **给 W2-GAP-T02 承接者（别名 + help --all）**：SPEC-07 全文即开工依据；别名全集 §4.2 六只一次交付（planned 命令的别名声明先入表、随命令注册生效）；`--all` 与互斥校验按 §4.4；使能提交同步更新 `docs/user/commands.md`（§6.2）。
- **给 W4-HELP-T02 承接者（快照 + 互链收口）**：验收断言全集 = §5 ①–⑨；`--all` 尾部 URL 的点亮条件 = user-docs 文档并入实现基分支（§6.3）；等价性断言框架先行、写命令别名断言随命令落地补齐（§5-③）。
- **给合并者**：本分支三文件全部新增（本文、`docs/wave-04/ready-tasks.md` 仅 WAVE04-HELP 分区、回执仅本槽一节），按既定并集约定收编；`docs/README.md` 索引行见文首（wave-04 分区首建）；§7 勘误表在各来源分支合并后逐条回写。
- **阻塞**：无新增。W4-HELP-T01 前置的 W3-PLAN-T02（集成分支 error+engine+init 归一）已在 `e2721d4` 交付；W3-PLAN-T04/T05（docs 收编与终验）未完成不阻塞本规格消费，但实现槽开工前应确认集成分支头稳定。SPEC-07 编号已核对无撞号（SPEC-01/02/03 属 P1 §7、SPEC-04 属 w2-gap §3.1、SPEC-05/06 属 W3 规格、SPEC-F1/F2 属 check/快照规格）。

---

*W4 计划槽产出 · 分支 `cursor/w4-spec-help-aliases-0f4e` · 基线 `main @ deda75a` · 引用锚点见 §2 · SPEC-07 编号自本文启用*
