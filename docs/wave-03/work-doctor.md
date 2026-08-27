# W3 工作槽：实现 `sw doctor` 配置诊断命令（W1-P1-T08）

| 项目 | 内容 |
| --- | --- |
| 波次 / 槽位 | 第 3 波 / 周期 W3 落地 / 工作槽「实现 W1-P1-T08 sw doctor」 |
| 仓库 | github.com/Dawan2/script-writer |
| 基线 | `cursor/w2-init-wizard-87b4 @ 4be6a21`（脚手架 + CI + `sw init` 向导） |
| 工作分支 | `cursor/w3-doctor-3e3d`（已 push，未开 PR） |
| 完成任务 | W1-P1-T08（`sw doctor`，验收对照见 §3）；一并预留 GAP-04 锁健康检查承接位（可注册检查项数组，见 §1.2 与 §4） |
| 执行依据 | P1 方案 §6.7（doctor 一句话规格）；ready-tasks W1-P1-T08（验收①②③）；W2 GAP 裁决 §3.4（GAP-04：doctor 预留锁检查项、`SW-E012` 已被锁占用预留）与 §3.6（GAP-06 退出码）；调度指令「锁未实现则检查项报『未实现』但不崩溃」 |

---

## 1. 做了什么

### 1.1 四层落点（消费既有词汇与基础设施，未重做 init/脚手架）

| 层 | 文件 | 职责 |
| --- | --- | --- |
| infra | `src/infra/store/projectMetaRead.ts`（新增） | `project.yaml` 读侧最小实现：四态读取（missing / not-file / invalid / parsed）+ `serializeProjectMeta` 产出子集的解析器（两级缩进、JSON 双引号标量、inline map/array，容忍空行与整行注释）。超出子集一律返回结构化失败（含行号），不抛裸异常。**T05 引擎的严格解析器落地后可整体替换**（诊断层只消费 `RawMap` 结构） |
| app | `src/app/diagnostics/validate.ts`（新增） | 字段级校验纯函数（零 IO）：逐条问题清单（不首错即停），并在字段自身合法时输出下游视图（`scenes_done` → 场景一致性检查；`ai.enabled` → AI key 检查）。校验词汇全部取自 core（`SCHEMA_VERSION`/`SCRIPT_FORMATS`/`WORKFLOW_STEPS`） |
| app | `src/app/diagnostics/checks.ts`（新增） | **可注册检查项数组 `DOCTOR_CHECKS`**（ready-tasks 风险注记的落点）：七项检查，后续槽新增检查（如 GAP-04 stale 锁判定）只需追加数组元素。状态三值：pass（绿）/ fail（红，必附可复制修复命令）/ skip（未实现·前置未通过·不适用，不计红） |
| app | `src/app/diagnostics/doctor.ts`（新增） | 编排：预读 `project.yaml` 一次（多检查共享，避免重复 IO）→ 依序执行注册表 → 汇总 `DoctorReport`（绿/红/跳过计数 + ok）。单项检查抛出异常（如权限/磁盘故障）转红项，报告仍完整产出——诊断命令本身不崩溃 |
| cli | `src/cli/commands/doctor.ts`（新增） | `sw doctor [dir]`：报告渲染（✔/✖/○，红项附「修复：」行）+ 退出码接线——零红项正常返回（退出码 0）；有红项 throw `SW-E013` 由 `run.ts` 顶层统一裁定为 1（GAP-06，业务代码零 `process.exit`）。`--help` 含 2 条可复制示例与退出码说明 |
| cli | `src/cli/program.ts`（改） | 注册 doctor 子命令；路线图追加 `sw doctor [可用 · W1-P1-T08]` 行（诚实进度，其余命令标注不变） |

### 1.2 七项检查（执行顺序即报告顺序）

| # | id | 检查 | 绿 | 红（附修复命令） | 跳过 |
| --- | --- | --- | --- | --- | --- |
| 1 | `runtime-node` | Node 版本 ≥ 20（与 package.json engines 一致） | 版本达标 | 低版本 / 不可解析 → 附 `nvm install 22` / nodejs.org | — |
| 2 | `project-file` | `project.yaml` 存在且可读 | 存在 | 缺失 → 附 `sw init <dir>`；被同名目录占用 → 附移走后 `--force` 重建 | — |
| 3 | `meta-schema` | 子集解析 + 字段级校验（schema=1、title/format/created、GAP-03 `expectedSceneCount` 可选正整数、settings.ai/export、progress.step/scenes_done） | 全部合法 | 无法解析（含行号）或逐条问题清单 → 附手工修正与 `sw init <dir> --force` 重建两条路径 | 前置红项（项目文件）未通过 |
| 4 | `layout` | `outline.md` + `characters/ scenes/ exports/` 齐备（§6.1 布局） | 齐备 | 列全缺失/占用项 → 附 `mkdir -p <缺失目录>`、`--force` 重建 outline.md | — |
| 5 | `scenes-done` | `progress.scenes_done` 与磁盘一致（每个编号须有 `scenes/<id>-*.md` 或 `<id>.md`） | 全部有对应文件（空列表=无需比对） | 只列缺失编号 → 附补文件 / 编辑 project.yaml 移除两条路径（`sw draft` 修复路径注明随 T05 交付，不虚假承诺） | 前置字段非法/文件缺失 |
| 6 | `project-lock` | 锁健康（GAP-04：`.sw/lock` stale 判定） | —（未实现） | —（未实现） | **「未实现」**：锁机制属 W2-GAP-T04 尚未交付；若发现 `.sw/lock` 文件如实注明「暂不判定健康度」。T04 落地后本检查项接入 stale 判定 + 修复命令 |
| 7 | `ai-key` | AI key 有效性（若启用） | 未启用 → 无需检查 | —（未实现） | AI 已启用时报「未实现」：供应商网关属 TASK-P3-01（BLK-W1-02 凭据未定），key 校验随其交付；前置字段非法时亦跳过 |

### 1.3 退出码与错误码（GAP-06 / SPEC-03 对齐）

- **全绿（红项 = 0）→ 0；任一红项 → 1**；用法错误（未知旗标等）→ 2（commander 解析层，未进入业务逻辑）。skip 不计红、不影响退出码。
- 红项聚合经 **`SW-E013`**（三段式：红项清单 + 「按修复命令逐项处理后重跑」）由顶层唯一裁定点渲染。**编号说明**：E01x 段中 `SW-E012` 已被 GAP-04 预留给「并发锁占用」（W2-GAP-T04），故顺延取 E013；该码由三类损坏用例实际触达，符合「非预填」纪律，请 W1-P1-T06 建注册表时收录（连同既有触达码 `SW-E010`/`SW-E031`）。

## 2. 如何跑测试（本地复现）

```bash
git clone https://github.com/Dawan2/script-writer.git
cd script-writer
git checkout cursor/w3-doctor-3e3d
npm ci               # Node ≥ 20
npm run lint && npm run typecheck && npm test && npm run build && npm run smoke
# 手工验证（验收①②③）：
node dist/cli/main.js init /tmp/demo --yes && node dist/cli/main.js doctor /tmp/demo; echo $?   # 全绿，退出码 0
rm /tmp/demo/project.yaml && node dist/cli/main.js doctor /tmp/demo; echo $?                    # 损坏①：红项 + sw init 修复命令，退出码 1
node dist/cli/main.js init /tmp/demo --yes --force >/dev/null \
  && sed -i 's/^schema: 1/schema: 9/' /tmp/demo/project.yaml \
  && node dist/cli/main.js doctor /tmp/demo; echo $?                                            # 损坏②：期望 1/实际 9，退出码 1
sed -i 's/^schema: 9/schema: 1/; s/scenes_done: \[\]/scenes_done: ["001"]/' /tmp/demo/project.yaml \
  && node dist/cli/main.js doctor /tmp/demo; echo $?                                            # 损坏③：缺失编号 001，退出码 1
```

本槽实测（2026-08-27，Node v22.14.0）：lint ✅ 零警告；typecheck ✅；**test ✅ 105 passed（12 文件），0 失败、0 跳过**（基线 69 条全保留，新增 36 条覆盖解析/校验/检查项/工作流/CLI 全路径）；build ✅；smoke ✅；另按上述脚本实测三类损坏各得红项 + 修复命令、修复后回归全绿退出码 0、无参数在非项目目录运行产出完整报告不崩溃。

## 3. 验收对照（ready-tasks W1-P1-T08）

| 验收 | 结果 |
| --- | --- |
| ① 在健康项目输出全绿 | 通过：`sw init --yes` 产出的项目 6 绿 / 0 红，退出码 0（app 与 cli 两层断言；锁检查项按调度指令报「未实现」跳过，不计红——见 §4 偏差 1） |
| ② 三类损坏各得含修复命令的红项 | 通过：删 project.yaml → `✖ 项目文件` + `sw init <dir>`；改坏 schema → `✖ 元数据 schema`（期望/实际）+ 手工修正或 `--force` 重建；scenes_done 与磁盘不符 → `✖ 场景一致性`（只列缺失编号）+ 补文件/改字段两条路径。每类均有 app 层与 cli 层测试 |
| ③ 退出码全绿 0 否则 1 | 通过：健康 0、三类损坏各 1（cli 层退出码断言）；另断言 `--help` 为 0、报告在多红项/非项目目录下仍完整产出 |
| 风险注记「可注册检查项数组」 | 通过：`DOCTOR_CHECKS` 数组组织，新检查项只需追加元素（GAP-04 锁检查已按此预留承接位） |

## 4. 与规格的偏差（如实登记）

1. **任务原文的检查范围 vs 依赖现状**：T08 原文含「`progress.scenes_done` 与磁盘一致性、AI key 有效性（若启用）」且依赖 T05/T06。本槽按调度指令提前落地：scenes_done 一致性已完整实现；**AI key 有效性无从校验**（供应商网关属 TASK-P3-01，BLK-W1-02 未解除），启用 AI 时如实报「未实现」跳过而非虚假绿/红。同理**锁检查**（GAP-04 要求 doctor 预留）报「未实现」——两处均不计红，故验收①的「全绿」= 零红项（跳过项在结论行单独计数并注明「不计红」，不隐藏）。
2. **schema 校验用子集解析器**：T05 引擎的严格解析/校验器未落地，本槽在 infra 实现 `serializeProjectMeta` 产出子集的解析器（超出子集 → 结构化失败转红项）。T05 落地后可整体替换（建议届时引入 YAML 依赖），诊断层接口不变。
3. **错误框架仍为暂行 `SwError`**（T06 未落地）：红项聚合码取 `SW-E013`（`SW-E012` 已被 GAP-04 预留给锁占用），迁移义务沿用 `src/app/errors/sw-error.ts` 文件头 TODO；请 T06 注册表收录 E013。
4. **Node 版本阈值常量**：`REQUIRED_NODE_MAJOR = 20` 与 package.json `engines.node` 手工同步（代码注释已标注两处同步义务）；未做运行时读取以保持检查项零配置可测。

## 5. 给后续槽位的交接

- **W2-GAP-T04（文件锁）**：doctor 侧承接位已留好——替换 `src/app/diagnostics/checks.ts` 的 `lockCheck`（id `project-lock`）为真实检查：读 `.sw/lock`（`LOCK_FILE` 常量已导出）、判定持锁 pid 存活、stale 锁出红项 + 修复命令（GAP-04 验收④）；锁占用错误码用已预留的 `SW-E012`。
- **W1-P1-T05（引擎）**：`src/infra/store/projectMetaRead.ts` 的子集解析器可被严格解析器替换或吸收（四态 `ProjectFileReadResult` 语义建议保留）；`validate.ts` 的字段规则可并入引擎校验（`SW-E020` 迁移指引场景与 doctor 的 schema 红项同源）；`sw draft` 落地后请更新 `scenesDoneCheck` 修复文案（移除「随 W1-P1-T05 交付」标注）。
- **W1-P1-T06（错误框架）**：注册表请收录已触达码 `SW-E010`/`SW-E031`/`SW-E013`，并注意 `SW-E012` 为 GAP-04 预留（勿挪用）。
- **TASK-P3-01（模型网关）**：网关落地后替换 `aiKeyCheck` 的「未实现」分支为真实 key 校验（E04x 段错误码按 SPEC-03 注册）。
- **W1-P1-T10（help 快照）**：doctor 已注册为 commander 子命令且 `--help` 含 ≥1 可复制示例，可直接进快照全集。
- **阻塞**：无新增。BLK-W1-02（模型凭据）未动，本槽 AI 检查仅消费 `settings.ai.enabled` 布尔。
