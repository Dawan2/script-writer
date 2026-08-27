# W2 工作槽：SPEC-03 错误框架 + SPEC-03-EXT 退出码（W1-P1-T06 + W2-GAP-T06）

| 项目 | 内容 |
| --- | --- |
| 波次 / 槽位 | 第 2 波 / 周期 W2 / 工作槽「实现 W1-P1-T06 SPEC-03 错误框架 + W2-GAP-T06 退出码」 |
| 仓库 | github.com/Dawan2/script-writer |
| 基线 | `cursor/w2-scaffold-ci-ccbf @ 9f61b37`（脚手架 + CI，21 单测全绿；未重写任何脚手架产物） |
| 工作分支 | `cursor/w2-error-framework-exit-codes-f4d4`（已 push，未开 PR） |
| 规格依据 | P1 方案 §7 [SPEC-03](../wave-01/P1-usability-architecture.md)；[SPEC-03-EXT 退出码约定](./P-gap-adjudication.md)（GAP-06 裁决 §3.6，本槽已原样并入该文档） |
| 并行避让 | `sw init` 向导（W1-P1-T04）在并行分支开发：本槽未触碰其文件范围（`src/cli/commands/`、`src/app/workflow/init.ts`、`templates/`），`src/cli/program.ts` 零改动，冲突面收敛到 `main.ts`（4 行 → 9 行）与 `package.json` scripts |

---

## 1. 做了什么

### 1.1 错误码注册表（单一数据源，`src/app/errors/registry.ts`）

- **注册表 v1 收 4 码**（全部来自 SPEC-01/02 的实际触达路径，遵守 T06「禁止预填未用码」纪律）：

  | 码 | 段位 | 发生了什么 | 触达路径（责任任务） |
  | --- | --- | --- | --- |
  | `SW-E010` | E01x 项目/文件系统 | 目标目录非空，初始化已中止 | `sw init` 无 `--force`（T04） |
  | `SW-E011` | E01x 项目/文件系统 | 当前目录不是 script-writer 项目 | 项目命令缺 project.yaml（T05） |
  | `SW-E020` | E02x 状态/版本 | project.yaml 的 schema 版本不兼容 | 引擎读状态文件（T05） |
  | `SW-E030` | E03x 输入校验 | 场景 {sceneId} 不存在（附现有 id 列表） | `sw draft <id>`（T05） |

  SW-E04x（AI 供应商）**未登记**：AI 默认关闭、当前无触达路径，登记即违反纪律；待 AI 适配器落地时再登记。
- **每码一条三段式模板**（发生了什么 / 原因 / 怎么办）+ 按码强类型的 ctx 契约（`ErrorContexts`，`{key}` 占位符插值）+ 样例 ctx（供 docs 示例与 lint「占位符全解析」断言共用）。
- **`SwError` + `fail(code, ctx)`**：业务代码抛用户可见错误的唯一入口（SPEC-03 接口约定）；`fail` 的 ctx 参数按码强类型约束，漏传/错传字段在 typecheck 期失败。
- **空态注册表同库**：v1 收 P1 §6.3 点名的两个位点（`scenes-empty`、`outline-empty`），空态三要素（这里是什么 / 示例 / 下一步命令）与错误文案同库管理、同 lint 覆盖。

### 1.2 统一渲染层（`src/app/errors/render.ts`）

- `renderError()`：SPEC-03 消息模板逐字落地——`✖ 码 标题` / `原因：` / `怎么办：` / `详情：<docs/errors/ 锚点>` 四行，数组 ctx（如 E030 现有 id 列表）以「、」连接、空数组渲染「（无）」。
- `renderHint(slot, ctx)`：空态三要素三行（`○ 这里是什么` / `示例：` / `下一步：<整行可复制命令>`）。
- `renderUnexpectedError()`：未经 `fail()` 的裸异常兜底（渲染为可上报形态，退出码仍为 1）。
- 本层只产字符串、零 IO；打印与退出码归接口层。

### 1.3 退出码约定落地（SPEC-03-EXT，`src/cli/run.ts` + `main.ts`）

- `runCli(argv, io)`：构建 program、`exitOverride()` 接管 commander 退出、顶层 catch 统一映射——**SPEC-03 唯一渲染出口**：
  - `CommanderError` exitCode 0（`--help`/`--version` 正常终止）→ **0**；其余（未知旗标/未知命令/多余参数/缺参）→ **2**（argparse 层用法错误，未进入业务逻辑）；
  - `SwError`（`fail()` 产物）→ 渲染三段式到 stderr → **1**；
  - 裸异常 → 兜底渲染 → **1**。
- `main.ts` 是退出码唯一设定点：`process.exitCode = await runCli(process.argv)`（不用 `process.exit`，避免截断未刷完的输出流）。
- `doctor`/`check` 未来语义（发现问题 → 1）是本表第 1 行的实例，届时经命令返回值 → `runCli` 传递，无需新机制。

### 1.4 lint 防线（GAP-T06 验收 ④ + P1 R1「绕过 UX 服务」防线）

`eslint.config.js` 新增三条规则（反例文件实测全部触发，见 §2）：

| 规则 | 范围 | 拦截内容 |
| --- | --- | --- |
| `no-restricted-properties` | `src/**` | 业务代码直接 `process.exit` |
| `no-restricted-syntax` | `src/**`（豁免 `src/cli/main.ts`） | `process.exitCode = …` 在唯一出口之外赋值 |
| `no-console` | `src/{core,app,infra}/**` | 散落 console 输出绕过 SPEC-03 渲染层 |

### 1.5 docs/errors/ 生成器 + 注册表 lint（`scripts/gen-error-docs.ts`）

- `npm run gen:errors`：从注册表生成 `docs/errors/`（每码一页含三段式模板 + 真实示例输出，README 索引含退出码表、错误码表、空态位点表），生成物已提交；码被移除时同步删页。
- `npm run lint:errors`（CI 步骤）：六项检查——L1 码格式/段位、L2 三段式与空态三要素非空、L3 样例渲染无未解析占位符、L4 空态「下一步」为可复制 sw 命令、L5 **业务代码出现未注册 SW-Exxx 字面量即失败**、L6 `docs/errors/` 与注册表逐字节零漂移（含手写多余文件拦截）。「未注册码 CI 失败」由 L5 + `fail()` 的 ErrorCode 类型双重保证。

### 1.6 CI 接线（步骤只增不减）

`.github/workflows/ci.yml` 追加 2 步：**错误码注册表 lint**（`npm run lint:errors`，置于 Lint 之后）与**退出码约定冒烟**（`npm run smoke:exit-codes`，build 之后对 `dist/cli/main.js` spawn 真实进程断言 0/2 档，5 用例）。既有五步（lint/typecheck/test/build/smoke）与 Node 20/22 矩阵原样保留。

### 1.7 测试（21 → 77，只增不减）

新增 3 个测试文件共 56 条用例：

| 文件 | 条数 | 覆盖 |
| --- | --- | --- |
| `tests/app/errors-registry.spec.ts` | 29 | 注册纪律回归锁（v1 恰为 4 码，E04x 未预填）、码格式/段位、三段式非空、样例渲染无未解析占位符、锚点与生成物同名、`fail()/SwError/isSwError/isErrorCode`、空态两位点三要素与可复制命令 |
| `tests/app/errors-render.spec.ts` | 13 | 三段式 4 行结构逐行断言、锚点 URL、ctx 插值、E030 id 列表（含空数组「（无）」）、模板工具、空态 3 行结构与 P1 §6.3 原句命令、裸异常兜底 |
| `tests/cli/run.spec.ts` | 14 | 退出码常量回归锁（0/1/2）、成功路径 ×3、用法错误 ×3（含「未触发业务副作用」断言）、**每个注册码经顶层 catch → 1 且 stderr 三段式 + 锚点**（it.each ×4）、裸异常 → 1、CommanderError 双向映射 |

### 1.8 文档并入（并集约定，未改写正文）

- 原样并入 `cursor/w2-gap-adjudication-c82d @ 661b313` 的 `docs/wave-02/P-gap-adjudication.md`（SPEC-03-EXT 正文所在）与 `docs/wave-02/ready-tasks.md`（追加 W2-GAP-T06 状态备注行）；
- `docs/DISPATCH-receipt.md` 追加 W1-B、W2-GAP 两份回执原文（取并集）+ 本槽回执；
- `docs/wave-01/ready-tasks.md` 为 W1-P1-T06 追加状态备注行（既定格式）；`docs/README.md` 追加 wave-02 条目并把 `errors/` 从「规划中」移入正式分区。
- 证据约定分支 `cursor/w2-evidence-ci-conventions-a17c` 本槽仅参考、未并入其文件（其回执仍在原分支，后续合并取并集）。

## 2. 如何跑测试（本地复现）

```bash
git clone https://github.com/Dawan2/script-writer.git
cd script-writer
git checkout cursor/w2-error-framework-exit-codes-f4d4
npm ci                    # Node ≥ 20
npm run lint              # ESLint 零警告（含 process.exit / no-console 拦截规则）
npm run lint:errors       # 注册表 lint：4 码 / 2 位点，docs/errors/ 零漂移
npm run typecheck         # tsc --noEmit（含 scripts/）
npm test                  # Vitest：8 文件 / 77 用例
npm run build             # tsc → dist/
npm run smoke             # sw --version / --help
npm run smoke:exit-codes  # 真实进程断言退出码 0/2 档（5 用例）
```

本槽实测结果（2026-08-27，Node v22.14.0 / npm 10.9.7）：以上全部 ✅；**test 77 passed (77)，0 失败、0 跳过**（基线 21 → 77）。
lint 防线反例验证：临时向 `src/app/` 写入含 `console.error` / `process.exitCode=` / `process.exit()` / `SW-E999` 字面量的文件，
`npm run lint` 报 3 错、`npm run lint:errors` 报 L5 未注册码，均非零退出（验证后删除反例）；
向 `docs/errors/SW-E011.md` 追加一行手改，`npm run lint:errors` 报 L6 漂移并非零退出（已复原）。

## 3. 验收对照（W1-P1-T06 / SPEC-03）

| 验收标准 | 结果 |
| --- | --- |
| ① 注册表 lint 进 CI | `npm run lint:errors` 为 CI 独立步骤（L1–L6，见 §1.5） |
| ② `docs/errors/` 由注册表生成且提交 | 5 个生成物已提交；L6 漂移检查保证「消息与文档永不漂移」；生成物页头标注禁止手改 |
| ③ 抽查任意错误输出符合三段式 + 锚点 | 非抽查而是全量断言：`tests/cli/run.spec.ts` 对每个注册码 it.each 断言 stderr 含 `✖ 码`、`原因：`、`怎么办：`、`docs/errors/<码>.md` 锚点 |
| `fail(code, ctx)` 为抛错唯一入口 + 顶层 catch 统一渲染 | `fail()` 落地；`src/cli/run.ts` 顶层 catch 为唯一渲染出口；lint 三防线拦截绕行（console/process.exit/exitCode） |
| 空态 `hint(slot, ctx)` 同库同 lint | `HINT_REGISTRY` 与错误码同文件；L2/L3/L4 同脚本覆盖；`renderHint` 三要素结构有测试 |
| 「T04 错误输出已迁移到本框架」 | **转记为 T04 合并前对接项**：T04 在并行分支开发、尚未合入基线，本槽无迁移对象；对接清单见 §5（本条目自身即注明「与 T04 可并行开发、合并前对接」） |

## 4. 验收对照（W2-GAP-T06 / SPEC-03-EXT）

| 验收标准 | 结果 |
| --- | --- |
| ① 每个已注册错误码的触达用例断言退出码 = 1 | `tests/cli/run.spec.ts` it.each(4 码)：经顶层 catch 映射断言 = 1 且 stderr 三段式；进程级 e2e 断言待首个可触发 SW-Exxx 的业务命令（T04/T05）落地后并入 `smoke:exit-codes` |
| ② 用法错误用例断言 = 2（且未触发业务逻辑副作用） | 单测（未知旗标/未知命令 → 2，stdout 零业务输出）+ 真实进程冒烟（`smoke:exit-codes` 2 用例） |
| ③ doctor/check 原验收不回退 | 两命令尚未实现、无可回退对象；其「发现问题 → 1」语义已被三档表回归锁（`EXIT_*` 常量断言）与顶层 catch 唯一出口预先保证 |
| ④ 业务代码直接调用 `process.exit` 被 lint 拦截 | `no-restricted-properties` 全 src 生效，反例实测触发（§2）；另加 `process.exitCode` 唯一出口与 `no-console` 两道加固防线 |
| 「禁止自定义其他退出码」 | `ExitCode` 类型收窄为 0\|1\|2；常量回归锁测试锁值；新增细分须先勘误 SPEC-03-EXT 表 |

## 5. 给后续槽位的交接

**给 T04（`sw init` 向导，并行分支）——合并前对接清单**：

1. 目录非空报错改为 `fail('SW-E010', { dir })`（注册表已备好三段式与 `--force` 后果说明）；删除自带的临时错误输出（若有）。
2. 命令 action 内不要 try/catch 吞错、不要 `process.exit`/`process.error`——直接让 `fail()` 抛出，顶层 catch 负责渲染与退出码（lint 会拦截绕行）。
3. 向导交互输出（问答提示）属接口层，可用 stdout；但错误一律走 `fail()`（`src/cli/commands/` 不在 no-console 范围内，纪律靠评审 + 注册表 L5）。
4. 若新增错误码：`registry.ts` 的 `ErrorContexts` + `ERROR_REGISTRY` 各加一条 → `npm run gen:errors` → 提交生成物（CI L6 会拦截漏提交）。

**给 T05（工作流引擎）**：`SW-E011/E020/E030` 已备好；空态位点 `scenes-empty`/`outline-empty` 的文案在 `HINT_REGISTRY`，
由 `renderHint(slot, ctx)` 渲染——**接线前不得在用户可见输出中渲染**（其文案引用 `sw draft`/`sw outline`，须与命令同槽落地，
避免虚假可用性承诺）。检查类命令（doctor/check）「发现问题 → 1」经命令返回值传递给 `runCli`，勿另设退出机制。

**给 W2-GAP-T01/T04**：错误框架前置（依赖 W1-P1-T06）就此解除；T04 文件锁的 `SW-E012` 按 §5 第 4 条流程登记（段位 E01x 已在 `errorSegment` 中定义）。

**给合并者**：本分支基于脚手架分支 `cursor/w2-scaffold-ci-ccbf`，与 T04 并行分支的预期冲突面只有
`src/cli/main.ts`（以本分支为准——退出码唯一出口）、`package.json` scripts（取并集）与 `docs/` 追加区（按既定并集约定）。
`docs/wave-02/ready-tasks.md`、`docs/wave-02/P-gap-adjudication.md` 为 GAP 分支原文 + 状态备注行追加，与其分支合并时内容为超集。

## 6. 阻塞状态更新

- 无新增阻塞。
- W1-P1-T06 完成 → W2-GAP-T01（revise）、W2-GAP-T04（文件锁）、W1-P4 各任务的「错误框架」前置解除（其余前置 T05 等仍在）。
