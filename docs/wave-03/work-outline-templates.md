# W3 工作槽：模板库 v1 + 最小 `sw outline`（W1-P1-T07）

| 项目 | 内容 |
| --- | --- |
| 波次 / 槽位 | 第 3 波 / 周期 W3 / 工作槽「实现 W1-P1-T07 模板库 v1 + 最小 `sw outline`」 |
| 仓库 | github.com/Dawan2/script-writer |
| 基线 | `cursor/w2-workflow-engine-4cad @ a628de1`（引擎 + `sw status`，未重写） |
| 工作分支 | `cursor/w3-outline-templates-5596`（已 push，未开 PR） |
| 任务 | W1-P1-T07 主体：内置模板三选一（screenplay / short-video / podcast）+ `sw outline` 最小可用（空态写骨架、幂等、末行可复制命令）；`hint()` 接线待 T06 错误框架（见 §4 范围裁剪） |
| 并行槽位 | init 向导（T04）在 `cursor/w2-init-wizard-87b4`；错误框架（T06）可能并行——本槽与两者的冲突面已刻意压缩（见 §5 合并注意） |

---

## 1. 做了什么

按 P1 §5.1 分层，全部为**基线上新增文件**；对既有文件只有四处最小改动
（`program.ts` 挂载 3 行、`project.ts` 追加可选字段与常量、`parseProject.ts` 追加可选字段解析/序列化、`templates/README.md` 表格更新）。

### 1.1 模板库 v1（`templates/`，三选一齐备）

- **`templates/short-video/`**：从并行 init 槽（`cursor/w2-init-wizard-87b4`）**字节级复制**
  （outline.md / characters/.gitkeep / scenes/.gitkeep / gitignore 四文件一字未改），合并时零冲突。
- **`templates/screenplay/`、`templates/podcast/`**（本槽新建）：与 short-video **完全同构**的文件树；
  `outline.md` 分别按三幕结构、单期播客节奏书写示例，内嵌空态三要素注释（这里是什么 / 示例长什么样 / 下一步敲什么命令，P1 §6.3）。
- **结构约定沿用 init 槽口径**（SPEC-01）：占位语法 `{{key}}`，变量全集 = `{{title}}` + `{{expectedSceneCount}}`（有单测锁定防拼写漂移）；
  模板内 `gitignore` 渲染为 `.gitignore`；**模板 id 集合 ≡ `SCRIPT_FORMATS` 枚举**（format 即模板 id，有单测锁定）。
- **`src/infra/store/templates.ts`**：模板读取与渲染器，同样从 init 槽**字节级复制**（含其单测 `tests/infra/templates.spec.ts`）——
  两分支共享同一实现，合并即去重成一份。

### 1.2 核心域（`src/core/model/`，零 IO）

- **`project.ts`**：追加 GAP-03 顶层可选字段 `expectedSceneCount?: number` 与
  `DEFAULT_EXPECTED_SCENE_COUNT = 5`——**逐字对齐 init 槽的同位置改动**（合并近零冲突）；
  `createProjectMeta` 未动（该函数的 expectedSceneCount/aiEnabled 入参扩展属 init 槽，合并时取其版本即可）。
- **`parseProject.ts`**：`parseProjectMeta` / `toProjectFileShape` 支持 `expectedSceneCount` **无损往返**
  （缺失合法＝旧式文件仍可读；存在必须正整数；落盘键=驼峰、紧随 `created`，与 init 槽 `serializeProjectMeta` 口径逐字一致）。
  动机：`sw outline` 会触发状态回写，若引擎解析丢弃该字段，合并后将出现「跑一次 outline 就吃掉向导写入的预计场数」的跨槽 bug——本槽以 5 条单测锁死往返。

### 1.3 基础设施（`src/infra/store/`）

- **`outlineFile.ts`**（新建，避免动 init 槽重写中的 `projectFile.ts`）：outline.md 的读侧三态探测
  （缺失 / 全空白 / 有内容——SPEC-02"为空"判定）+ 写侧 `writeFileAtomic` 原子落盘（与 project.yaml 同一中断安全语义）。

### 1.4 应用层（`src/app/workflow/`）

- **`outline.ts`**：`ensureOutline(projectDir)`，数据流与引擎各入口同构（engine.ts ①–⑤）：
  ①`loadProject` 读取校验 → ②探测 outline.md 缺口 → ③缺失/为空时按 `meta.format` 渲染模板骨架并原子写入
  （`renderOutlineSkeleton`：变量 `title` ← 项目标题、`expectedSceneCount` ← 字段值或默认 5）→
  ④`ensureStepAtLeast(progress, 'draft')` 后原子回写（只进不退、无变化不写盘——避免 status 永远建议 `sw outline` 的死循环）→
  ⑤结构化结果交渲染层。**幂等约束**：outline.md 已有内容时只报告不覆盖（覆盖属 `--force` 语义，非最小版范围）。
- **`outlineReport.ts`**：成功态渲染（创建 or 幂等保留 + 填写引导 + **末行 = `nextActionCommand(status)` 可直接复制执行**，
  scenes/ 空态时即完整示例 `sw draft 010 --title "开场"`）；失败态复用 `renderProjectFailure` 三段式，
  `TODO(W1-P1-T06)` 标记沿用（错误框架合入后随 statusReport 一并迁移）。

### 1.5 接口层（`src/cli/`）

- **`commands/outline.ts`**（新增）：`runOutline(dir)` 纯执行体（测试与 action 共用）；项目内 exit 0、非项目 exit 1 + SW-E011 三段式；
  子命令 help 含可复制示例（P1 §4 命令可发现性）。
- **`program.ts`**（最小改动 3 处）：import + `registerOutlineCommand(program)` 挂载；
  路线图 `sw outline` 行改为 `[可用 · W1-P1-T07 最小版]`（其余命令仍如实标注）。

## 2. 如何跑测试（本地复现）

```bash
git clone https://github.com/Dawan2/script-writer.git
cd script-writer
git checkout cursor/w3-outline-templates-5596
npm ci               # Node ≥ 20
npm run lint         # ESLint，零警告
npm run typecheck    # tsc --noEmit
npm test             # Vitest：18 文件 / 132 用例（基线 77 + 本槽新增 55）
npm run build        # tsc → dist/
npm run smoke        # sw --version && sw --help
```

本槽实测（2026-08-27，Node v22.14.0 / npm 10.9.7）：lint ✅ 零警告；typecheck ✅；
**test ✅ 132 passed (132)，0 失败、0 跳过（基线 77 条全部保留未删未跳）**；build ✅；smoke ✅。
另做真实 CLI 端到端演示（临时目录，screenplay 项目）：`initProject(format: 'screenplay')` →
`sw outline` 首跑输出「已创建 outline.md」+ 末行 `sw draft 010 --title "开场"`（exit 0），
outline.md 变量已代入（`# 雨夜出租车 · 大纲`、`预计 5 场`）、无 `{{` 残留；
project.yaml 步骤补齐为 `draft`；重复运行输出「已存在且有内容，未改动」（exit 0，文件未动）；
`sw status` 与 outline 报告口径一致；非项目目录运行输出 SW-E011 三段式（exit 1）。

## 3. 验收对照（T07 验收标准 × 本槽范围）

| T07 验收标准 | 结果 |
| --- | --- |
| ① `sw init --template` 三选一均产出可 export 的项目 | **本槽范围内满足（结构级）**：三模板文件树同构且与 `SCRIPT_FORMATS` 同集（单测锁定）、每模板 outline.md 渲染无占位残留（单测）、引擎级 `initProject(format)` → `ensureOutline` 三 format 全链路跑通（单测）。**命令级联测待并行槽合流**：`sw init --template` 本体在 T04 分支（其模板解析「新增目录自动生效」，合并后即三选一）、export 属 T05 后续槽 |
| ② 空态覆盖率清单已知位点 100% 有引导且含可复制命令 | **已知两位点均有引导**：outline.md 空态——`sw outline` 写入骨架（内嵌三要素注释），且 `sw status` 在 step<draft 时末行建议 `sw outline`；scenes/ 空态——outline 报告与 status 末行复用 `FIRST_SCENE_COMMAND`（完整可复制示例）。**`hint()` 接线待 T06**（渲染层归一属错误框架职责，TODO 标记就位） |
| 模板渲染单测（任务文件范围） | 满足：模板库结构 15 条 + outline 应用层 17 条 + CLI 8 条 + outlineFile 6 条 + expectedSceneCount 往返 9 条，共 55 条新增 |
| 风险条款「验收聚焦结构完整与占位变量正确」 | 遵循：单测锁结构（文件树/变量全集/无残留），不锁文案全文；模板文案质量留给后续内容槽 |

## 4. 范围裁剪（按派工指令）

- 本槽聚焦：**模板三选一 + `sw outline` 最小可用**。
- **不含**：`sw init` 命令本体（并行槽 T04，本槽只保证模板与其结构约定/序列化口径一致）；
  `hint()`/`fail()` 框架（并行槽 T06，本槽沿用基线 TODO 标记 + 手写三段式）；
  `sw draft / export` 命令（T05 后续槽）；`outline --force` 覆盖语义（幂等最小版先行，覆盖随 revise 语义槽定夺）。
- 依 P1 §8 回退策略精神：模板数量未砍（三选一齐备），砍的是命令旗标面。

## 5. 给后续槽位的合并注意（并行冲突面）

1. **与 T04（`cursor/w2-init-wizard-87b4`）合并**：
   - **零冲突面（字节级一致，直接去重）**：`templates/short-video/` 全部 4 文件、`src/infra/store/templates.ts`、`tests/infra/templates.spec.ts`。
   - **近零冲突**：`src/core/model/project.ts` 的 `expectedSceneCount` 字段、`DEFAULT_EXPECTED_SCENE_COUNT` 常量与文件头注释行均按 init 槽原文逐字追加；`createProjectMeta` 的入参扩展仅 init 槽改动，合并取其版本。
   - **需要人工并集**：`src/infra/store/projectFile.ts`——init 槽基于无引擎基线重写了此文件（`inspectDir`/`materializeProjectDir`/`serializeProjectMeta`），本槽基线含引擎版（`readProjectFileRaw`/`writeProjectFile`/`scanProjectDisk`），两组函数**互不重名，取并集保留全部**；init 侧 `serializeProjectMeta` 与本槽 `toProjectFileShape` 的落盘口径已对齐（驼峰 expectedSceneCount 紧随 created），可在后续槽收敛为单一序列化出口。
   - **行级冲突**：`templates/README.md`（本槽版本已是 init 版的超集，取本槽版）、`src/cli/program.ts`（保留各自 import/register/路线图行）、`docs/quickstart.md`/`README.md`（按行合并，各命令行归各槽）。
2. **与 T06（错误框架）合并**：本槽新增的失败渲染全部走既有 `renderProjectFailure`，未新增错误出口；
   迁移点仍集中在 `statusReport.ts` + `engine.ts`（基线既有 TODO），外加 `outlineReport.ts`/`outline.ts` 两处同款 `TODO(W1-P1-T06)` 标记。
3. **`sw draft / export` 落地槽**：直接复用 `ensureOutline` 的同构数据流与 `nextActionCommand` 渲染出口即可自动满足「末行可复制命令」；
   `renderOutlineSkeleton(meta)` 亦可为 draft 的场文件骨架提供同款「模板渲染 + 原子写」范式（建议场骨架模板放 `templates/<id>/` 下并复用 `templates.ts`）。
4. **T09（用户文档）**：`sw outline` 的 reference 页素材可直接取本文件 §1.4–1.5 与 quickstart 对应行。

## 6. 阻塞状态更新

- 无新增阻塞；不触及 BLK-W1-02（AI 凭据，属 P3）。
- T07 在 ready-tasks 标记**领取**而非完成：验收 ① 的命令级三选一联测依赖 T04 合流（`sw init --template`）与 export 命令（T05 后续），
  验收 ② 的 `hint()` 接线依赖 T06；模板库与 `sw outline` 主体已交付，合流后补两处联测即可关账。
