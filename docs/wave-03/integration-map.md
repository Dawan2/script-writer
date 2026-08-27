# Wave-03 并行实现分支集成图（Integration Map）

> **槽位**：第 3 波 / 周期 W3 / 计划槽「并行实现分支集成图」
> **分支**：`cursor/w3-integration-map-bf24`（基于 `main @ deda75a`，docs-only）
> **性质**：只读盘点 + 集成规划。本槽未改写任何实现分支的一行代码；所有冲突结论
> 来自 `git merge-tree --write-tree` 实测与本地全量跑测（Node v22.14.0，vitest run），非目测推断。
> **给合并者的索引行**（并入 `docs/README.md` 时粘贴）：
> `- [wave-03/integration-map.md](./wave-03/integration-map.md) — W2 四实现分支集成顺序、文件级冲突面与语义冲突清单（W3 计划槽）`

---

## 1. 分支现状总览（2026-08-27 实测）

### 1.1 代码分支

| 分支 | 头提交 | 基 | 测试数（本地实测） | CI（头提交） |
| --- | --- | --- | --- | --- |
| `cursor/w2-scaffold-ci-ccbf` | `9f61b37` | `main @ deda75a` | 21 passed | 绿（run 33057519551） |
| `cursor/w2-init-wizard-87b4` | `4be6a21` | scaffold `@ 9f61b37` | **69 passed**（9 文件） | 绿（run 33059507608） |
| `cursor/w2-error-framework-exit-codes-f4d4` | `e3aff95` | scaffold `@ 9f61b37` | **77 passed**（8 文件） | 绿（run 33059843463） |
| `cursor/w2-workflow-engine-4cad` | `a628de1` | scaffold `@ 9f61b37` | **77 passed**（12 文件） | 绿（run 33059618720） |

- 测试数为 `npm ci && npx vitest run` 的运行时用例数（error 分支含 `it.each` 参数化，静态数
  行数会低估，以运行时为准）。四分支全部 0 失败 / 0 跳过。
- **拓扑关键事实**：init / error / engine 三分支的 merge-base 全部是 scaffold 头 `9f61b37`，
  即三者是从同一基线并行分叉的兄弟分支；scaffold 是共同祖先，**无需单独合并**（并入任一
  兄弟分支即自动包含）。

```text
main @ deda75a
  └── scaffold-ci @ 9f61b37  ← 共同祖先（21 测试，CI 基线）
        ├── init-wizard @ 4be6a21        （+48 → 69）
        ├── error-framework @ e3aff95    （+56 → 77，CI 闸门最严）
        └── workflow-engine @ a628de1    （+56 → 77，源码结构最多）
```

### 1.2 文档 / 计划分支（均基于 `main @ deda75a`，纯 docs）

| 分支 | 头提交 | 核心产出 | 吸收状态 |
| --- | --- | --- | --- |
| `cursor/w2-gap-adjudication-c82d` | `661b313` | `wave-02/P-gap-adjudication.md`、`wave-02/ready-tasks.md`（WAVE02-GAP） | **已吸收**进 error 分支头 `e3aff95`（并集并入） |
| `cursor/w2-q1-p2-cli-adaptation-1f96` | `b9966cd` | `wave-02/Q1-p2-cli-adaptation.md`、`wave-02/ready-tasks.md`（WAVE02-Q1 分区） | 游离，未吸收 |
| `cursor/w2-evidence-ci-conventions-a17c` | `09fbfb8` | `evidence/README.md`、`wave-02/evidence-and-ci-conventions.md` | 游离，未吸收 |
| `cursor/w2-plan-backlog-verification-f51f` | `c3c5e8e` | `wave-02/implementation-backlog.md`、自带 `wave-01/ready-tasks.md`（WAVE02-PLAN 分区） | 游离，未吸收 |
| `cursor/w1-a-codebase-inventory-bb07` | `92e19a4` | `wave-01/inventory-codebase.md` | **已吸收**进 scaffold `aa2c21e` |
| `cursor/w1-b-features-flows-9843` | `9ef7ea7` | `wave-01/inventory-features-flows.md` | 游离（error 分支只并了其回执，正文未并） |
| `cursor/w1-c-agent-tooling-inventory-0ec2` | `8553c7f` | `wave-01/inventory-agent-tooling.md` | 游离，未吸收 |
| `cursor/w1-d-maturity-baseline-b2eb` | `60c37e8` | `wave-01/maturity-baseline.md` | **已吸收**进 scaffold |
| `cursor/w1-p1-usability-architecture-5d0e` | `4612cdb` | `wave-01/P1-usability-architecture.md` | **已吸收**进 scaffold |
| `cursor/w1-p2-interaction-reliability-a3c2` | `7873b66` | `wave-01/P2-interaction-reliability.md` + ready-tasks P2 分区 | 游离（scaffold 的 ready-tasks 无 P2 分区） |
| `cursor/w1-p3-agent-intelligence-ca4d` | `67e6670` | `wave-01/P3-agent-intelligence.md` | **已吸收**进 scaffold |
| `cursor/w1-p4-major-experience-features-5fba` | `6ec86f8` | `wave-01/P4-major-experience-features.md` | **已吸收**进 scaffold |

游离文档分支共 6 条：`w1-b`、`w1-c`、`w1-p2`、`w2-q1`、`w2-evidence`、`w2-plan-backlog`。
全部只涉及 docs 并集追加，无源码，排在代码集成之后并入（见 §4 第 3 梯队）。

---

## 2. 文件级冲突面（`git merge-tree --write-tree` 实测）

### 2.1 error × engine —— 冲突最小的一对（仅 2 个 docs 文件）

| 冲突文件 | 类型 | 解法 |
| --- | --- | --- |
| `docs/DISPATCH-receipt.md` | content | 回执并集追加（既定约定，机械可解） |
| `docs/README.md` | content | 索引行并集（机械可解） |

自动合并成功（无冲突）：`docs/wave-01/ready-tasks.md`、`package.json`（error +`tsx` devDep +4 scripts；
engine +`yaml` runtime dep，不同区段）、`package-lock.json`。**建议 lock 文件不信任自动合并，
合并后重跑 `npm install` 再提交。**

### 2.2 init × error —— 4 个冲突文件（2 docs + 2 源码）

| 冲突文件 | 类型 | 解法 |
| --- | --- | --- |
| `docs/DISPATCH-receipt.md` | content | 回执并集 |
| `docs/README.md` | content | 索引行并集 |
| `src/cli/main.ts` | content | **取 error 版**（唯一 `process.exitCode` 落点，eslint 豁免点即此文件） |
| `src/cli/run.ts` | add/add | **取 error 版**，init 版整体废弃（见 §3-④） |

### 2.3 init × engine —— 7 个冲突文件（4 docs + 3 源码/测试）

| 冲突文件 | 类型 | 解法 |
| --- | --- | --- |
| `README.md` | content | 进度描述并集（init 标 `sw init` 可用 / engine 标 `sw status` 可用） |
| `docs/quickstart.md` | content | 同上，两命令均标可用 |
| `docs/DISPATCH-receipt.md` | content | 回执并集 |
| `docs/README.md` | content | 索引行并集 |
| `src/cli/program.ts` | content | **两边并集**：init 注册 `init` 命令、engine 注册 `status` 命令，无语义竞争 |
| `src/infra/store/projectFile.ts` | add/add | **取 engine 版为 project.yaml 读写正典**；init 版的 `inspectDir`/`materializeProjectDir`（目录状态检查 + 原子物化）迁入同模块或拆 `materialize.ts`；init 版 `serializeProjectMeta`（手写 YAML）废弃，改走 engine 的 `toProjectFileShape` + `yaml.stringify`（见 §3-⑤） |
| `tests/infra/projectFile.spec.ts` | add/add | 随实现取舍重排：engine 版断言全保留，init 版中针对 materialize/inspect 的断言迁移保留，仅针对废弃 `serializeProjectMeta` 的断言随实现替换为对 engine 序列化路径的等价断言（**断言只迁移不删除**） |

### 2.4 三方共同冲突点

`docs/DISPATCH-receipt.md` 与 `docs/README.md` 三对全冲突——都是 append-only 并集，机械可解。
真正需要人脑的源码冲突只有 4 个文件：`src/cli/main.ts`、`src/cli/run.ts`、
`src/cli/program.ts`、`src/infra/store/projectFile.ts`（+其测试）。

---

## 3. 语义冲突清单（文本合并不报错、但 CI 会红或行为错的点）

这是本图最重要的一节：merge-tree 干净 ≠ 集成完成。以下 7 项每项都有明确出处，集成槽逐项过。

| # | 冲突 | 事实依据 | 集成动作 |
| --- | --- | --- | --- |
| ① | **engine 的 status 命令违反 error 的 eslint 新规** | `src/cli/commands/status.ts:37` 直接赋值 `process.exitCode`；error 分支 `eslint.config.js` 规定该赋值只许出现在 `src/cli/main.ts`。合并后 `npm run lint` 必红 | status 命令改为经 `runCli` 返回码通道（error 的 `run.ts` 已内建「检查类命令发现问题 → 1」语义），命令层不再触碰 `process.exitCode` |
| ② | **engine 的错误路径未走 fail()** | engine 的 SW-E011（不是 script-writer 项目）/SW-E020（schema 不兼容）语义在 error 注册表**已预留登记**，但 engine 侧是 ad-hoc 渲染；error 的 `npm run lint:errors` 拦截未注册码字面量与漂移 | engine 的 parse/statusReport 错误路径改 `fail('SW-E011'/'SW-E020', ctx)`，ad-hoc 文案并入注册表模板 |
| ③ | **init 使用 SW-E031，注册表没有** | init `src/app/workflow/init.ts:225` 抛 `SW-E031`（模板不存在）；error 注册表 v1 只收 E010/E011/E020/E030 且「禁止预填未用码」 | init 并入的**同一提交**内在 `registry.ts` 登记 SW-E031（SW-E03x 输入校验段）+ `npm run gen:errors` 生成 `docs/errors/SW-E031.md`，否则 lint:errors 红 |
| ④ | **两套错误实现竞争** | init 自带 `src/app/errors/sw-error.ts`（自由文案构造式）+ 自版 `run.ts`；error 是注册表模板 + ctx 式（SPEC-03 正典，带 56 条配套测试与 CI 冒烟） | 废弃 init 的 `sw-error.ts` 与 `run.ts`，init 的错误现场改 `fail(code, ctx)`。注意 init 有**两个 E010 现场**（目录非空 / 目标是文件），文案不同：并入注册表 E010 模板（扩展 ctx）或拆新码，由集成槽按「禁止预填未用码」纪律定夺并登记 |
| ⑤ | **两套 project.yaml 存储实现竞争** | init `projectFile.ts` = 手写序列化 + 目录物化；engine `projectFile.ts` = `yaml` 库 + `parseProject.ts` 纯函数互转 + `writeFileAtomic`（SPEC-02 单一状态源适配器） | 存储正典取 engine 版；init 的 `inspectDir`/`materializeProjectDir` 是 engine 没有的能力，**迁移保留**；init 的 `serializeProjectMeta` 废弃 |
| ⑥ | **`expectedSceneCount` 往返丢字段（数据丢失级）** | init 按 GAP-03 把 `expectedSceneCount` 写入 project.yaml 顶层；engine 的 `ProjectFileShape`/`parseProjectMeta`/`toProjectFileShape` **均无此字段**——`sw init` 后任何 `markSceneDone` 重写文件都会把该字段**静默丢掉** | 集成时把可选字段 `expectedSceneCount` 贯通 engine 的 shape/解析/序列化三处，并补「有/无字段」双分支往返测试（即 W2-GAP-T03 的存储侧落地，init 已完成写入侧） |
| ⑦ | **IO 抽象双轨** | init `src/cli/io.ts`：`CliIo{stdout,stderr}` + 向导交互；error `run.ts` 内 `CliIo{out,err}`，接口不同名不同形 | 统一为一个 IO 抽象：以 error 版注入口径为基（其 run.spec 依赖它），把 init 的交互（提问/读行）能力并入或挂为扩展接口 |

无冲突的独占面（放心并集）：init 独占 `templates/short-video/**`、`src/app/workflow/init.ts`、
`src/cli/commands/init.ts`；engine 独占 `src/app/workflow/{engine,statusReport}.ts`、
`src/core/model/{parseProject,progress}.ts`、`src/infra/store/atomicFile.ts`；error 独占
`scripts/`、`docs/errors/`、`.github/workflows/ci.yml` 的 +2 步骤、eslint/tsconfig 强化。
init 对 `src/core/model/project.ts` 的修改（+`expectedSceneCount` 类型 +`DEFAULT_EXPECTED_SCENE_COUNT`）
engine 未触碰同文件，自动合并干净。

---

## 4. 建议合并顺序（谁先谁后 + 理由）

### 底分支裁定：`cursor/w2-error-framework-exit-codes-f4d4`

按「测试数最多且 CI 绿者为底」：error 与 engine 并列 77、双绿。决胜因素三条，取 **error**：

1. **CI 闸门最严**：error 携带注册表 lint（`lint:errors`）、退出码进程冒烟（`smoke:exit-codes`）、
   eslint 三道拦截（process.exit / process.exitCode / no-console）与 ci.yml +2 步骤。以它为底，
   每一步合并都在最严标准下验证，语义冲突 ①②③ 会被 CI 当场拦下而不是漏进主干——
   反向（以 engine 为底后并 error）适配工作量相同，但违规代码会先“绿”一轮再变红，违反
   「禁止降低 CI 标准」的精神。
2. **docs 并集工作量最小**：error 已吸收 w2-gap 两份计划文档（P-gap-adjudication + WAVE02-GAP
   队列）与三份回执并集，是当前文档超集最大的代码分支。
3. **首步合并最便宜**：error × engine 实测文本冲突仅 2 个 docs 文件（§2.1），是三对中唯一
   零源码文本冲突的组合。

### 合并梯队

```text
第 1 梯队  以 error @ e3aff95 拉集成分支（如 cursor/w3-integrate-w2-*）
第 2 梯队  merge engine @ a628de1     —— 文本冲突 2 docs；语义适配 §3-①②；全套门通过后提交
第 3 梯队  merge init  @ 4be6a21      —— 文本冲突 §2.2+§2.3 剩余项；语义适配 §3-③④⑤⑥⑦
（scaffold @ 9f61b37 是三者共同祖先，随任一梯队自动包含，不单独合并）
第 4 梯队  docs 分支按纯并集追加并入（顺序无强依赖，建议：w2-q1 → w2-plan-backlog →
          w2-evidence → w1-b → w1-c → w1-p2；冲突面只有 DISPATCH-receipt / 两份
          ready-tasks / docs/README.md 的分区与索引行并集）
```

**engine 先于 init 的理由**：(a) 首步冲突最小（2 docs vs init 的 4–7 文件）；(b) init 同时
依赖两边——错误走 error 框架（§3-③④）、存储走 engine 层（§3-⑤⑥），最后并入可一次对齐，
避免先并 init 再并 engine 时 projectFile/run.ts 被解两次；(c) init 测试数 69 < 77，按
「测试多者先固化」原则排后风险最小。

### 每梯队合并后的验收门（不可降标）

`npm run lint` && `npm run lint:errors` && `npm run typecheck` && `npm test`（全绿、0 跳过）
&& `npm run build` && `npm run smoke` && `npm run smoke:exit-codes`。
测试数只增不减：第 2 梯队后 ≥ 77 且并集应显著多于 77；第 3 梯队后理论并集 ≈ 181
（21 基线 + error 56 增量 + engine 56 增量 + init 48 增量），允许因两套 projectFile 测试
归一而少量归并（断言迁移不删除，见 §2.3），但**不得低于 160**，且被保留实现的既有断言零删除。
lock 文件每梯队合并后重跑 `npm install` 验证再提交。

---

## 5. 下一工作槽基于哪条分支

| 场景 | 基分支 |
| --- | --- |
| **W3 集成槽（下一个实现槽，最高优先）** | 以 `cursor/w2-error-framework-exit-codes-f4d4 @ e3aff95` 拉集成分支，按 §4 梯队执行 |
| 集成完成后的功能槽（revise / 文件锁 / help --all / T05 余项等） | 一律基于**集成分支头**（禁止再从 scaffold 或单个 W2 分支分叉，避免制造第四路冲突面） |
| 集成完成前的并行槽 | 只允许 docs-only（基于 `main`），**禁止触碰 `src/`**；任何提前实现都会加宽 §2 冲突面 |
| docs / 计划槽 | 基于 `main`（沿用既定约定），产出由集成槽第 4 梯队并集收编 |

**不合并进 `main`**：本波所有集成动作都发生在集成分支上；main 的推进由调度器另行裁定。

---

## 6. 交接清单（给 W3 集成槽执行者）

1. 逐项核销 §3 语义冲突 ①–⑦，每项在集成分支提交信息中引用编号。
2. §2 的 docs 冲突全部按 append-only 并集解，禁止丢弃任何分支的回执/分区。
3. SW-E031 登记与 init.ts 并入必须同提交（③）；E010 双现场的归并决策写入落地说明。
4. `expectedSceneCount` 贯通后补「init 写入 → status 读出分母 → markSceneDone 重写不丢字段」
   的端到端往返断言（⑥ 是唯一的数据丢失级风险，优先级最高）。
5. 六条游离 docs 分支（§1.2）并入时同步回写 `docs/README.md` 索引与各 ready-tasks 状态行。
6. 集成期间四条 W2 源分支冻结（不再追加提交）；如源分支有新提交，本图的头提交锚点失效，
   需重跑 merge-tree 复核。
