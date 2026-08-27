# W1-A 代码库结构盘点（第1波 / 周期W1 / 工作槽W1-A）

| 项目 | 内容 |
| --- | --- |
| 波次 / 槽位 | 第 1 波（wave-01）/ 周期 W1 / 工作槽 W1-A 代码库结构盘点 |
| 仓库 | github.com/Dawan2/script-writer |
| 盘点基线 | `main @ deda75a5245caf96d3ee1ac7b22109d0f421c333`（Initial commit，唯一提交） |
| 盘点日期 | 2026-08-27（UTC） |
| 工作分支 | `cursor/w1-a-codebase-inventory-bb07` |
| 文档性质 | 事实盘点（证据锚定 commit）+ 建议目标目录树（对齐 P1 方案，不另起炉灶） |
| 配套文档 | `docs/README.md`（wave-01 文档索引）、`docs/DISPATCH-receipt.md`（槽位回执） |

---

## 1. 结论速览（TL;DR）

1. **`main` 是空仓**：全库仅 1 个文件 `README.md`（16 字节、1 行，内容为标题 `# script-writer`），仅 1 个提交。**无包清单、无源码、无测试、无 CI、无 lint 配置、无 license、无 .gitignore、无 issue/PR 模板**。逐项证据见第 3 节。
2. **并行分支已有 4 份有效文档成果**（W1-D 基线、P1 易用性架构、P2 交互可靠性，均为 docs-only），本槽已逐一盘点（第 4 节），**未重做、未覆盖**任何既有成果。
3. **建议目标目录树见第 5 节**：完全对齐 P1 方案 §5.1/§6.1 的仓库 IA 与 W1-P1-T03 脚手架任务的文件范围（TypeScript/Node、CLI 优先，即假设 A1–A4 的默认执行），并吸收 W1-D 的 `docs/evidence/` 存档约定与 P2 的测试设施要求。**该树以 ADR-0001（W1-P1-T02）定案为准生效；本文不新增任何与 P1 相左的架构决策。**

---

## 2. 盘点方法

- 对象：远端全部分支（`git ls-remote --heads origin`），以 `main @ deda75a` 为主盘点对象，三个工作分支只做资产清点（fetch 只读，不合并、不改写）。
- 手段：`git ls-tree -r`、`git log`、`git cat-file -e` 逐项探测常见工程文件；输出原样存档于本文（满足 W1-D 基线的合格证据三要素：可复现命令、原始输出、锚定 SHA）。
- 证据类型（按 W1-D 基线编号）：本文全部为 **E1（代码存在性）** 证据；E2–E5 无采集对象（与 W1-D 自评一致）。

## 3. `main` 分支事实盘点（证据）

### 3.1 全量文件清单

```text
$ git ls-tree -r --name-only main
README.md

$ git show main:README.md | wc -c ; git show main:README.md | wc -l
16
1
# 内容为单行标题：`# script-writer`

$ git log --oneline main
deda75a Initial commit
```

### 3.2 工程要件逐项探测（`git cat-file -e main:<path>`，锚定 `deda75a`）

| 类别 | 探测路径 | 结果 | 影响 / 承接项 |
| --- | --- | --- | --- |
| 包清单（Node） | `package.json` | **缺失** | 无法安装依赖、无法定义脚本入口 → W1-P1-T03；对应 W1-D 阻塞 BLK-W1-01 |
| 包清单（Python 备选栈） | `requirements.txt`、`pyproject.toml` | **缺失** | 同上（栈由 ADR-0001 定案，见 W1-P1-T02） |
| 其他栈探测 | `Cargo.toml`、`go.mod` | **缺失** | 排除既有 Rust/Go 工程的可能性 |
| 类型/编译配置 | `tsconfig.json` | **缺失** | → W1-P1-T03 |
| 测试 | 无任何 `test`/`tests`/`__tests__`/`*.spec.*` 路径 | **缺失** | 无测试可运行，也**无测试可删**（本槽合规声明的事实基础）→ W1-P1-T03 起步，P2 T10 补故障注入设施 |
| CI | `.github/`（含 workflows）、`.gitlab-ci.yml` | **缺失** | 无 CI 标准存在，也无可降低的 CI 标准 → W1-P1-T03；对应 BLK-W1-03 |
| Lint/格式化 | 无 eslint/prettier/editorconfig 任何形式 | **缺失** | → W1-P1-T03 |
| 忽略清单 | `.gitignore` | **缺失** | 首批构建产物有误提交风险 → W1-P1-T03 |
| 许可证 | `LICENSE` | **缺失** | 开源边界未定；建议随 ADR-0001 一并定案（属决策项，非本槽范围） |
| 构建/容器 | `Makefile`、`Dockerfile` | **缺失** | CLI 优先形态下非必需，暂不列入目标树 |
| 协作模板 | issue/PR 模板、`CODEOWNERS`、`CONTRIBUTING.md` | **缺失** | 低优先级，多代理协作场景可后补 |
| 文档 | `docs/` | **缺失**（仅存在于工作分支，见第 4 节） | 本槽与 W1-D/P1/P2 各自补齐，待合并 |

### 3.3 结构结论

- `main` 上**不存在任何目录**——连一层子目录都没有，谈不上"现有结构"，因此本盘点的结构部分只能是前瞻性的（第 5 节目标树）。
- 空仓事实与 W1-D 成熟度基线（三维度全 L0）、P1 方案 §2 七维度盘点表、P2 §0 基线审查结论**三方相互印证，无出入**。

## 4. 并行分支资产盘点（防重做清单）

远端共 4 个分支（`git ls-remote --heads origin`，2026-08-27 采集）：

| 分支 | HEAD | 资产（相对 main 新增） | 性质 |
| --- | --- | --- | --- |
| `main` | `deda75a` | —（基线） | 空仓 |
| `cursor/w1-d-maturity-baseline-b2eb` | `60c37e8` | `docs/wave-01/maturity-baseline.md`（L0–L5 量表、E1–E5 证据规则、BLK-W1-01/02/03、GOAL-W1-01/02/03）、`docs/templates/w5-verification-report.md`、`docs/DISPATCH-receipt.md` | 有效，勿重做 |
| `cursor/w1-p1-usability-architecture-5d0e` | `4612cdb`（方案 commit `5545c22`） | `docs/wave-01/P1-usability-architecture.md`（假设 A1–A4、七维度准则、SPEC-01/02/03、目标分层）、`docs/wave-01/ready-tasks.md`（W1-P1-T01…T10）、`docs/DISPATCH-receipt.md` | 有效，勿重做 |
| `cursor/w1-p2-interaction-reliability-a3c2` | `7873b66` | `docs/wave-01/P2-interaction-reliability.md`（12 维度审查、裁决 D1–D39、可靠性分层）、`docs/wave-01/ready-tasks.md`（P2 分区，W1-P2-T01…T10）、`docs/DISPATCH-receipt.md` | 有效，勿重做 |

注意事项（给后续槽位与合并者）：

1. `docs/wave-01/ready-tasks.md` 在 P1 与 P2 分支**各自存在且内容不同**（P1 版含 P1 分区，P2 版含 P2 分区）。两文件均声明"按槽位分区、只追加不改写他区"，合并到 main 时需**取并集**（保留双方分区与文件头约定），不能以任一方覆盖另一方。
2. `docs/DISPATCH-receipt.md` 在三个分支各有一份（W1-D 为表格单页式，P1/P2 为 append-only 追加式），合并时同样取并集追加，勿丢任何回执。本槽回执沿用 append-only 式（见本分支该文件）。
3. 三个分支的根 `README.md` 均与 main 相同（一行标题），无人改写——README 路由页改造留给 W1-P1-T01，本槽不动 README。

## 5. 建议目标目录树（对齐 P1 ADR/脚手架任务，非本槽实现）

> **地位声明**：本树是对 P1 方案 §5.1（分层）、§6.1（仓库侧 IA）、§6.6（docs IA）与 ready-tasks（T03/T06/T09/T10 文件范围）的**汇总具象化**，外加 W1-D 与 P2 已声明的目录约定；**不引入任何新架构决策**。栈按 A4 默认假设（TypeScript/Node）书写；若 ADR-0001（W1-P1-T02）修订栈选择，仅文件后缀与包清单相应调整，目录骨架不变。落地责任槽：W1-P1-T03（脚手架与 CI 基线）。

```text
script-writer/
├── README.md                       # 路由页：电梯陈述 + Quickstart + docs 链接（T01 改造）
├── package.json                    # 包清单 + npm scripts（lint/typecheck/test）（T03）
├── tsconfig.json                   # TS 编译配置（T03；栈按 A4 默认）
├── .gitignore                      # 至少忽略 node_modules/、dist/、exports/（T03）
├── .github/
│   └── workflows/
│       └── ci.yml                  # push+PR 触发：lint + typecheck + test（T03；解除 BLK-W1-03）
├── src/                            # ——仓库侧 IA，P1 §6.1；新增顶层目录必须有 ADR——
│   ├── core/                       # 核心域（零 IO）：领域模型 Project>Script>Act>Scene>Beat/Line
│   │   └── model/                  # （T05 文件范围）
│   ├── app/                        # 应用层
│   │   ├── workflow/               # 工作流引擎：init/status/outline/draft/export（T04/T05）
│   │   ├── errors/                 # SPEC-03：registry.ts + render.ts，fail()/hint() 唯一出口（T06）
│   │   └── diagnostics/            # sw doctor 检查项（T08）
│   ├── cli/                        # 接口层：sw 命令
│   │   └── commands/               # init/status/outline/draft/export/doctor（T04/T05/T08）
│   └── infra/                      # 基础设施适配器
│       └── store/                  # 项目存储：project.yaml + Markdown，原子写（T04/T05）
│                                   # （AI Provider 适配器、配置解析后续按 §5.1 追加于 infra/ 下）
├── templates/                      # 模板库：short-video（T04）→ screenplay/podcast（T07）
├── scripts/                        # gen-error-docs（T06）、ttfs-bench（T10）
├── tests/                          # 单测/端到端/help 快照（T04–T06、T10）；
│   └── help-snapshots/             #   P2 故障注入设施（W1-P2-T10）落地时亦挂于此层
└── docs/
    ├── README.md                   # 文档索引（本槽建立，见 docs/README.md）
    ├── quickstart.md               # T01 占位 → T09 补全
    ├── concepts/                   # 领域词汇表（T09）
    ├── reference/                  # 命令逐条，含可复制示例（T09）
    ├── errors/                     # SPEC-03 注册表生成物（T06；生成后提交）
    ├── adr/                        # ADR-0001 技术栈与产品形态（T02）；此后"新顶层目录须有 ADR"
    ├── evidence/                   # 核验证据存档（W1-D 基线第 2 节约定；配合 CI 归档）
    ├── templates/                  # 流程模板（已有 w5-verification-report.md，W1-D 分支）
    └── wave-01/                    # 波次工作文档（与用户文档隔离，P1 §6.6）
        ├── maturity-baseline.md    # W1-D（分支待合并）
        ├── P1-usability-architecture.md  # P1（分支待合并）
        ├── P2-interaction-reliability.md # P2（分支待合并）
        ├── ready-tasks.md          # P1+P2 分区并集（合并时注意第 4 节事项 1）
        └── inventory-codebase.md   # 本文档
```

与他槽方案的对齐说明：

- **P2 可靠性分层的落点**：P2 §2 的"请求层/状态层"以 Web 前端（`src/lib/api/`）表述，属后续 Web 形态（P1 假设 A3 的第二形态）；在 CLI 优先阶段，其对应约束（原子写、幂等、错误信封）由 `src/infra/store/` 与 `src/app/errors/` 承接，目录树无需为此新增顶层目录。Web 形态启动时按 P2 任务范围在 ADR 中扩展，此处不预建空目录。
- **不预建空目录**：上表中标注任务号的目录随对应任务创建，本槽不提交任何占位目录/文件（避免与实现槽产出冲突）。

## 6. 差距摘要（结构视角）

| # | 差距 | 现状 | 目标（依据） | 责任项 |
| --- | --- | --- | --- | --- |
| 1 | 无包清单/构建配置 | 缺失 | `package.json` + `tsconfig.json` 入库，`npm run lint/test` 可跑 | W1-P1-T03（前置 T02） |
| 2 | 无测试 | 缺失（0 条） | 最小测试套件进 CI；后续故障注入设施 | W1-P1-T03 → W1-P2-T10 |
| 3 | 无 CI | 缺失 | `.github/workflows/ci.yml` push+PR 触发三件套 | W1-P1-T03（解除 BLK-W1-03） |
| 4 | 无源码结构 | 缺失 | `src/{core,app,cli,infra}` 四层 IA | W1-P1-T03（依 ADR-0001） |
| 5 | 无文档 IA | 仅工作分支各自持有 docs | 第 5 节 docs/ 树；README 路由页 | W1-P1-T01/T09 + 本槽索引 |
| 6 | 无忽略清单/许可证 | 缺失 | `.gitignore` 随 T03；LICENSE 随 ADR-0001 定案 | W1-P1-T02/T03 |

## 7. 阻塞与交接

- 本槽为纯盘点，无新增阻塞；既有阻塞沿用 W1-D 登记的 **BLK-W1-01/02/03** 与 P1 登记的 **B1（假设 A1–A4 待确认）**，本文目标树即按"B1 未答复则按默认假设执行"的既定策略书写。
- 给实现槽（承接 W1-P1-T03）：开工前先以 ADR-0001 结论核对第 5 节目标树；若栈改选，只改后缀与包清单，不改四层骨架。
- 给合并者：第 4 节"注意事项"1、2 是合并 wave-01 各分支时的必读项（`ready-tasks.md` 与 `DISPATCH-receipt.md` 均须取并集）。
