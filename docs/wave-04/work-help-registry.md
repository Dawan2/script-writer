# W4 实现槽落地说明：help 注册表与别名（W4-HELP-T01 + W2-GAP-T02 + W4-HELP-T02 一并交付）

| 项目 | 内容 |
| --- | --- |
| 波次 / 槽位 | 第 4 波（wave-04）/ 实现槽「help 注册表与别名」 |
| 仓库 | github.com/Dawan2/script-writer |
| 工作分支 | `cursor/w4-help-registry-impl`（基于 W3 集成分支头 `b99cb92`，并集合入 docs 槽 `cursor/w4-spec-help-aliases-0f4e`） |
| 开工依据 | SPEC-07 全文（`docs/wave-04/spec-help-aliases.md`）+ `docs/wave-04/ready-tasks.md` WAVE04-HELP 分区 |
| 编制日期 | 2026-08-28（UTC） |

## 1. 交付面

- `src/cli/registry.ts`（新）— 命令注册表单一数据源 + 唯一挂载循环 `mountCommands`（注册 available、注入 `.alias()` 与别名可见性尾注）。全库唯一 `.alias()` 调用点。
- `src/cli/helpText.ts`（新）— 默认 help 尾注 / 路线图 / `--all` 全集三视图同源渲染，全部自注册表生成。
- `src/cli/commands/help.ts`（新）— `sw help [command] [--all]` 显式子命令（commander 隐式 help 经 `addHelpCommand(false)` 停用）。
- `src/cli/program.ts`（改）— 挂载循环化；`ROADMAP_HELP` 手工字面量退役；`configureHelp.visibleCommands` 过滤 aux 组出默认 help 清单（commander v15 无 `hideHelp()` 实例方法，改走 Help 配置层，语义等价）。
- `eslint.config.js`（改）— `no-restricted-syntax` 追加 selector 拦截带参 `.alias(...)` 调用（setter 形态）于 `src/cli/registry.ts` 之外；零参 getter 读取（如 help 命令查别名）不拦截，属刻意收窄。
- `tests/cli/registry.spec.ts`（新）— 注册表结构单测 7 例。
- `tests/cli/help.spec.ts`（新）— SPEC-07 §5 验收断言 20 例（含 1 条 `it.todo` 占位：写命令别名 d/r/x 等价断言框架，随命令落地由使能槽补齐，§5-③ 渐进增强口径）。
- `scripts/smoke-exit-codes.mjs`（只加不改）— 6 条新用例（别名 s、help、help --all 非项目目录、help status、互斥、未知词条），12/12 通过。

## 2. 验收核销表（SPEC-07 §5 ①–⑨）

| # | 验收 | 结果 |
| --- | --- | --- |
| ① | 渐进披露：默认 help 四入口含 main 组 available 与别名、`--all` 提示行、尾部 URL；不含 aux 组命令词条 | 已核销（`help.spec.ts` ① 四入口断言 ×4） |
| ② | 三向一致：注册表 ↔ commander 注册 ↔ `--all` 输出两两双向相等；别名唯一且不撞主命令词 | 已核销（`help.spec.ts` ② ×3 + `registry.spec.ts` 结构断言） |
| ③ | 别名等价：已注册命令（i/s）逐字节等价；写命令（d/r/x）留 `it.todo` 断言位随落地补齐 | 已核销（渐进增强口径，§5-③ 原文授权） |
| ④ | 每条 available 命令 `--help` 含 ≥1 示例；有别名者含别名词条 | 已核销（`help.spec.ts` ④ ×3） |
| ⑤ | `sw help` ≡ `sw --help`、`sw help <cmd>` ≡ `sw <cmd> --help` 逐字节等价 | 已核销（`help.spec.ts` ⑤ ×3，进程级手测 diff 零差异） |
| ⑥ | `help draft --all` / `help <未知词条>` → 2 零副作用；`help --all` 非项目目录 → 0；进 smoke | 已核销（`help.spec.ts` ⑥ ×3 + smoke 12/12） |
| ⑦ | `program.ts` 无 ROADMAP_HELP 字面量；路线图（含 revise planned 行）自注册表生成 | 已核销（`grep ROADMAP_HELP src/` 零命中；路线图五行 + status 全量生成） |
| ⑧ | lint 防线：`.alias(` 在注册表外 → lint 失败 | 已核销（反例验证：向 `commands/status.ts` 临时注入 `new Command('x').alias('y')`，`npm run lint` 报 1 error；还原后全绿） |
| ⑨ | CI 门不降标；测试只增不减、断言只迁移不删除 | 已核销（207 → 234（233 过 + 1 todo 占位），0 失败 0 跳过；既有 `program.spec.ts` 4 条断言原文保留全部通过） |

## 3. 验收门全量记录（工作分支头，Windows 本地）

- `npm run lint` ✔（零警告）
- `npm run lint:errors` ✔（8 错误码 / 2 空态位点，docs/errors 零漂移）
- `npm run typecheck` ✔
- `npm test` ✔ 20 文件 / 233 passed + 1 todo（SPEC-07 §5-③ 授权的断言占位）/ 0 失败 0 跳过
- `npm run build` ✔
- `npm run smoke` ✔
- `npm run smoke:exit-codes` ✔ 12/12（0/1/2 全三档，含 help 面 6 条新用例）
- 手测：`sw i --help` ≡ `sw init --help`、`sw s`（非项目目录）→ SW-E011 退出码 1、`sw help` ≡ `sw --help`（diff 零差异）

> 环境备注：Windows 下 `core.autocrlf=true` 会导致 `docs/errors/*.md` 与生成器输出（LF）产生假漂移；
> 本仓库工作副本已设 `core.autocrlf false` 并以 LF 重新检出，`.git` 内对象不受影响（git 对象库原本即 LF）。

## 4. 设计与规格的偏差登记（均为实现层决策，规格语义不变）

1. **aux 组隐藏实现于 `configureHelp.visibleCommands`**（program.ts）而非命令级 `hideHelp()`——commander v15 的 `Command` 实例无该方法。默认 help 四入口实测不含 aux 命令词条，验收 ① 达标。
2. **eslint selector 收窄为带参调用**（`[arguments.length>0]`）：help 命令需零参读取 `command.alias()`（getter）做词条解析；setter 形态（唯一注入点纪律的对象）仍被全量拦截，反例验证见 §2-⑧。
3. **help 命令经注册表自举注册**：`register` 字段以同模块闭包引用 `COMMAND_REGISTRY` 传入 help 渲染，无跨模块循环依赖。
4. **别名可见性尾注追加于命令模块自带 `addHelpText('after')` 之后**（挂载循环内统一注入），命令模块内部零改动（W4-HELP-T01 任务原文要求）。

## 5. 交接清单

- **给 outline/doctor 并行槽（rebase 自集成分支）**：`program.ts` 冲突面已缩为注册表条目一行——落地时在 `COMMAND_REGISTRY` 把对应条目 `planned → available` 并填 `register`（ROADMAP_HELP 冲突面随其退役消失）；若新增 aux 组 available 命令，默认 help 清单自动隐藏，无需额外处理。
- **给 W2-GAP-T01（revise）**：注册表已有 `revise/r` planned 条目，落地仅需转 available；别名等价断言位见 `tests/cli/help.spec.ts` ③ 的 `it.todo`。
- **给 T09 / user-docs 槽**：`docs/user/commands.md` 并入本实现基分支后，`--all` 尾部 URL 自动点亮（`helpText.ts` `userCommandsDocAvailable()`），届时把 `help.spec.ts` 的「不印 URL」断言翻转为「包含」并补 commands.md 别名标注（SPEC-07 §6.2/§7-4）。本分支未创建该文件（其权威版本在 `cursor/w3-user-docs-ia-f6ca`，避免双写冲突）。
- **给合并者**：本分支 = W3 集成分支头 + W4 文档槽并集 merge（DISPATCH add/add 冲突按并集解，零回执丢失）+ 实现提交；`docs/README.md` 索引已补 wave-04 分区三条目。

## 6. 阻塞与遗留

- 无新增阻塞。`--all` 尾部 URL 待 user-docs 并入（渐进增强，非阻塞，见 §5）。
- 后续波次仍待：W3-DRAFT-T01/T02（draft/export）、W2-GAP-T01（revise）、doctor、模型网关链（TASK-P3-01 起，BLK-W1-02 凭据仍开放）。
