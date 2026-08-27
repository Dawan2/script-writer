# W3 集成槽落地说明：W2 三线实现分支集成（WAVE03-PLAN T01–T05）

> **槽位**：第 3 波 / 周期 W3 / 工作槽 WAVE03-PLAN T01–T05 三线集成
> **分支**：`cursor/w3-integrate-w2-f334`（不开 PR，不合并进 `main`）
> **基线**：`cursor/w2-error-framework-exit-codes-f4d4 @ e3aff95`（集成图裁定「底=error」）
> **执行依据**：[`integration-map.md`](./integration-map.md)（下称「集成图」）与
> [`ready-tasks.md`](./ready-tasks.md) WAVE03-PLAN 分区
> **日期**：2026-08-27（UTC）

---

## 1. 做了什么（合并梯队执行记录）

严格按集成图 §4 的梯队顺序执行，每梯队一次合并提交、全套验收门（lint / lint:errors /
typecheck / test / build / smoke / smoke:exit-codes）全绿后才进入下一梯队。

| 梯队 | 提交 | 内容 | 测试数 |
| --- | --- | --- | --- |
| 1 基线 | `e3aff95`（分支起点） | 从 error 头拉集成分支，基线门全绿复核 | 77 |
| 2 engine | `ce910ad` | merge `cursor/w2-workflow-engine-4cad @ a628de1`；语义冲突①②核销 | 145 |
| 3 init | `e2721d4` | merge `cursor/w2-init-wizard-87b4 @ 4be6a21`；语义冲突③④⑤⑥⑦核销 | 207 |
| 4 docs×6 | `874c783` `775f32e` `45d623a` `7c2ebcb` `fe80055` `a0236e5` | w2-q1 / w2-plan-backlog / w2-evidence / w1-b / w1-c / w1-p2 六游离 docs 分支纯并集收编 | 207（不变） |
| 5 收编集成图 | `02f0a6a` | merge `cursor/w3-integration-map-bf24 @ 43a6ecf`（集成图与 wave-03 任务队列本体入分支） | 207（不变） |

合并前已核对四条 W2 源分支头提交与集成图 §1.1 锚点逐一一致（scaffold `9f61b37` /
init `4be6a21` / error `e3aff95` / engine `a628de1`），未触发 merge-tree 复核条款（§6-6）。

## 2. 文本冲突如何解决

| 文件 | 冲突场次 | 解法 |
| --- | --- | --- |
| `docs/DISPATCH-receipt.md` | 每次合并均冲突（add/add 或内容） | 取我方全量回执 + 追加来方回执节（并集，零丢失；终态含全部历史回执） |
| `docs/README.md` | engine、init、docs 各次 | 索引行并集 + 状态标注（`sw init`/`sw status` 标可用） |
| `docs/wave-01/ready-tasks.md` | init、w2-plan-backlog、w1-p2 | 我方为底，只追加来方分区（WAVE02-PLAN、P2）与状态行，不覆盖既有分区 |
| `docs/wave-02/ready-tasks.md` | w2-q1 | 我方为底，追加 WAVE02-Q1 分区 |
| `src/cli/main.ts` | init | 取 error 版（`runCli` 顶层入口） |
| `src/cli/run.ts` | init | 取 error 版；`exitOverride`/`configureOutput` 上移至 `buildProgram`（注册子命令**之前**，保证继承） |
| `src/cli/program.ts` | init | 手工并集：注册 `init`+`status` 两命令、统一注入 `CliIo`、ROADMAP_HELP 两行标「可用」 |
| `src/infra/store/projectFile.ts` | init（add/add 双实现） | 取 engine 版为正典（yaml 库读写）；迁入 init 的 `inspectDir`/`materializeProjectDir`；新增 `serializeProjectFile` 统一序列化口 |

## 3. 语义冲突 ①–⑦ 核销表（集成图 §3，T05 验收③）

| # | 冲突 | 处置 | 核销提交 |
| --- | --- | --- | --- |
| ① | engine `status` 直赋 `process.exitCode`，违反 error 的 eslint 新规 | `runStatus` 改为成功返回渲染行 / 失败 throw `SwError`；退出码统一由 `runCli` 判定（0/1/2）；命令层零 `process.*`/`console` | `ce910ad` |
| ② | engine 的 E011/E020 报错未走 `fail()`，ad-hoc 文案 | 新建 `failProject(failure, projectDir)`：`not-a-project`→SW-E011、`schema-incompatible`→SW-E020，并**新登记** `invalid-yaml`→SW-E021、`malformed`→SW-E022；文案并入注册表模板，`gen:errors` 再生成 | `ce910ad` |
| ③ | init 使用 SW-E031 但未登记 | SW-E031（模板不存在：`templateId` + `available` 列表）登记入注册表并生成 `docs/errors/SW-E031.md`；init 现场改 `fail('SW-E031', …)` | `e2721d4` |
| ④ | 两套错误实现（init 自带 `sw-error.ts`） | 删除 `src/app/errors/sw-error.ts` 与 init 自版 `run.ts`；错误现场全部改 `fail()`。E010 双现场归并决策：目录非空保留 SW-E010，「目标是文件」**拆分新码 SW-E013**（语义不同、修复建议不同）；`rg 'sw-error' src/` 零命中 | `e2721d4` |
| ⑤ | 两套 projectFile（init `serializeProjectMeta` 手拼 vs engine yaml 库） | engine 版为正典；`serializeProjectMeta` 废弃，统一走 `serializeProjectFile`（`toProjectFileShape` + `yaml.stringify`）；init 侧字节级断言迁移为 yaml 库输出口径（引号/块风格），断言只迁不删 | `e2721d4` |
| ⑥ | **数据丢失级**：`expectedSceneCount` 往返静默丢字段 | 字段贯通 `ProjectFileShape` / `parseProjectMeta`（可选正整数校验）/ `toProjectFileShape`（有值才序列化）；`sceneCompletion(disk, expectedSceneCount?)` 以之为分母、缺省退化磁盘场数；端到端往返用例常驻（init 写入 → markSceneDone 重写 → 逐字保留），进程级走查证据见 §6 | `e2721d4` |
| ⑦ | IO 抽象双轨（init 流式 stdin/stdout vs error 函数式 out/err） | 统一为 `src/cli/io.ts` 的 `CliIo`：`out`/`err` 函数式为主（error 版注入口径）+ 可选 `stdin?: NodeJS.ReadableStream`（init 交互能力）；`processIo` 提供 `process.stdin`；全部命令经 `buildProgram(io)` 注入 | `ce910ad`（io.ts 建立）+ `e2721d4`（stdin 扩展） |

## 4. 测试对账（只增不减，T05 验收①④）

- **数目演进**：77（基线）→ 145（并 engine，+68）→ **207**（并 init，+62）；docs 收编不动代码，数目不变。目标 ≥160 **达成**。
- **四源分支增量断言存活核对**：

| 来源 | 增量断言 | 存活情况 |
| --- | --- | --- |
| scaffold `9f61b37` | 21 | 全存活（三兄弟分支共同祖先，随 error 基线进入） |
| error `e3aff95` | +56（→77） | 全存活；`errors-registry.spec.ts` 回归锁随新码登记同步（4→6→8 码，锁本身未删） |
| engine `a628de1` | +56 | 全存活；失败态断言经 `failProject`+`renderError` 迁移改写（期望文案随注册表模板），断言意图与数目不减 |
| init `4be6a21` | +48 | 全存活；序列化断言迁移为 yaml 库口径、错误断言迁移为 SwError 渲染口径，数目不减 |
| 并集小计 | 181 | — |
| 集成期净增 | +26 | SW-E021/E022/E013/E031 注册与渲染断言、runCli×status 退出码矩阵扩行、`expectedSceneCount` 端到端往返、materializeProjectDir/inspectDir 迁移补强等 |
| **终态** | **207** | 0 失败 / 0 跳过；**零删测** |

- **验收门终验**（锚定 `02f0a6a`）：lint（--max-warnings 0）/ lint:errors（8 码零漂移）/
  typecheck / test（207）/ build / smoke / smoke:exit-codes（6/6，0/1/2 三档各≥1 例进程级断言）全绿。

## 5. 错误码注册表现状（8 码）

| 码 | 语义 | 来源 |
| --- | --- | --- |
| SW-E010 | init 目标目录非空 | error 基线 |
| SW-E011 | 当前目录不是 sw 项目 | error 基线 |
| SW-E013 | init 目标路径是文件 | **本槽新登记**（④ 拆分） |
| SW-E020 | project.yaml schema 版本不兼容 | error 基线 |
| SW-E021 | project.yaml 不是合法 YAML | **本槽新登记**（②） |
| SW-E022 | project.yaml 字段不合法 | **本槽新登记**（②） |
| SW-E030 | 模板渲染变量缺失 | error 基线 |
| SW-E031 | 模板不存在 | **本槽新登记**（③） |

## 6. 证据落盘（T05 验收，路径按 evidence 约定）

- `docs/evidence/wave-03/W3-PLAN-T05/E2-gates-lint-typecheck-build.md` — 静态质量四步门原始输出
- `docs/evidence/wave-03/W3-PLAN-T05/E3-vitest-suite.md` — 207 测试 + 退出码冒烟 6/6 原始输出与对账
- `docs/evidence/wave-03/W3-PLAN-T05/E4-init-status-walkthrough.md` — 五步链互通走查（含 ⑥ 往返不丢字段的逐字输出）

## 7. 给后续 rebase 的接口（doctor / outline 并行槽交接清单）

doctor / outline 槽若基于 W2 旧基线开发，rebase 到本集成分支时按以下接口对齐（预期冲突面：
`program.ts` 注册行与 ROADMAP_HELP、`registry.ts` 码表、回归锁测试）：

1. **命令注册**：在 `src/cli/program.ts` 的 `buildProgram(io)` 内调用
   `registerXxxCommand(program, io)`；`exitOverride`/`configureOutput` 已在注册**之前**统一设置，
   子命令自动继承，不要在命令内重复设置；同时更新 ROADMAP_HELP 对应行（规划中 → 可用）。
2. **退出码与输出纪律**：业务代码禁止 `process.exit`/`process.exitCode`/`console.*`
   （eslint 硬拦截）。成功输出走注入的 `CliIo.out`；用户可见错误一律
   `fail(code, ctx)`（throw `SwError`）；`src/cli/run.ts` 的 `runCli` 统一映射：正常 0、
   `SwError` 1、`CommanderError`（用法错）2。交互式命令用 `io.stdin ?? process.stdin`。
3. **新错误码**：在 `src/app/errors/registry.ts` 登记（`ErrorContexts` + `ERROR_REGISTRY`
   三段式模板）→ `npm run gen:errors` 生成 `docs/errors/` → 同步更新
   `tests/app/errors-registry.spec.ts` 的回归锁（码数 + 清单）。禁止预填未用码。
4. **项目存取唯一入口**：`src/app/workflow/engine.ts`（`loadProject` / `saveProject` /
   `readStatus` / `markSceneDone` / `initProject`）；序列化只走
   `serializeProjectFile`/`writeProjectFile`（yaml 库正典，禁止手拼 YAML）；目录检查与落盘用
   `inspectDir`/`materializeProjectDir`（`src/infra/store/projectFile.ts`）；引擎失败态
   （`ProjectFailure`）交 `failProject(failure, projectDir)` 映射为注册码。
5. **`expectedSceneCount` 不变量**：任何重写 `project.yaml` 的新代码必须经
   `toProjectFileShape` 全量序列化（字段有值必须保留，禁止手挑字段写盘）；完成度分母用
   `sceneCompletion(disk, meta.expectedSceneCount)`。字段名逐字 `expectedSceneCount`（GAP-03）。
6. **docs 合并约定**：`DISPATCH-receipt.md` / 各波 `ready-tasks.md` / `docs/README.md`
   一律 append-only 并集，不覆盖他槽正文。

## 8. 阻塞与未做

- **阻塞**：无新增。集成图提示的「源分支冻结」约束在本槽执行期内成立（锚点核对通过）。
- **未做（按指令）**：未开 PR；未合并进 `main`；未创建子代理；未等待 doctor/outline 并行槽
  （其 rebase 接口见 §7）。
- **偏差登记**：无降标、无删测、无 skip；断言改写仅限 fail() 化与 yaml 序列化口径迁移，
  均在集成图「允许改写、不允许删除」授权范围内。
