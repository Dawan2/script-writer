# W3 规格细化：`sw check` 内容一致性检查（F1）与 `.sw/history/` 版本快照（F2）

| 项目 | 内容 |
| --- | --- |
| 波次 / 槽位 | 第 3 波 / 周期 W3 / 计划槽「P4 F1/F2 规格细化」 |
| 仓库 | github.com/Dawan2/script-writer |
| 基线 | `main @ deda75a`（docs-only；集成进行中，按集成图 §5 纪律禁止触碰 `src/`） |
| 工作分支 | `cursor/w3-spec-check-snapshot-973a`（已 push，未开 PR） |
| 文档性质 | 可实现级规格（SPEC）：把 W1-P4 的 F1/F2 提案细化到「实现槽拿到即可开工」——命令面、目录布局、规则注册表、协议与验收测试逐条定死 |
| 上游依据 | `docs/wave-01/P4-major-experience-features.md` §4-F1/F2 与 §5.2 张力处置；`docs/wave-01/ready-tasks.md` W1-P4-T01…T04；SPEC-03 错误框架（`cursor/w2-error-framework-exit-codes-f4d4`）；GAP-06 退出码表；doctor 实现（`cursor/w3-doctor-3e3d`）；outline 模板语法（`cursor/w3-outline-templates-5596`）；集成图（`cursor/w3-integration-map-bf24`） |
| 配套文档 | `docs/wave-03/ready-tasks.md` WAVE03-CHECK 分区（W3-CHECK-T01…T05）、`docs/DISPATCH-receipt.md`（回执） |

> **给合并者的索引行**（并入 `docs/README.md` 时粘贴到 wave-03 分区）：
> `- [wave-03/spec-check-snapshot.md](./wave-03/spec-check-snapshot.md) — F1 sw check 与 F2 快照/diff 的可实现规格：SW-Cxxx 规则注册表、.sw/history/ 存储协议、四命令 CLI 面、doctor/check 划界、验收测试清单 AT-C/AT-S（W3 计划槽）`

---

## 1. 结论（TL;DR）

1. 本槽把 W1-P4 的 **F1（`sw check` 内容级 lint）** 与 **F2（快照 / history / diff / restore）** 从提案级细化为可实现级：命令旗标与退出码逐个定死（§4.1/§5.6–5.9）、`.sw/history/` 目录与 `index.yaml` schema 定死（§5.1–5.2）、**SW-Cxxx 规则注册表 v1 共 10 条**（编号、severity、判定条件、定位、fix 白名单逐条二值化，§4.6）、验收测试清单 **AT-C01…C16 + AT-S01…S15** 与 P4 原验收 ①–⑥ 的追溯矩阵（§6）。
2. **与 doctor 的划界正式化**（§3）：doctor 回答「项目能不能被工具正确处理」（环境 / 文件 / 状态字段），check 回答「剧本内容本身是否自洽」（内容 lint）。已实现的 doctor 七项检查全部留在 doctor 侧（含 `scenes-done`——那是 `progress` 状态字段 ↔ 磁盘的核对）；check 只消费内容索引层，不复述 doctor 红项。两命令输出互相引荐。
3. 关键细化决策 6 项（D1–D6，§8）：`sw snapshot` 的 label 从位置参数改为 `--label` 旗标（与 init/doctor/outline 的 `[dir]` 位置参数约定一致）；check 聚合错误码提案 `SW-E014`、快照段 `SW-E050…E053`（均由实现槽触达时登记，遵守「禁止预填未用码」）；漂移类规则默认 warn、经 `--profile export` 升级 error（避免「大纲先行、场景后建」的正常中间态被判红）；diff v1 行级渲染、台词/动作分类随台词语法 ADR 升级。
4. 实现路径已任务化为 **W3-CHECK-T01…T05**（`ready-tasks.md` WAVE03-CHECK 分区），与 W1-P4-T02/T03/T04 的承接映射见该分区；全部任务基于**集成分支头**开工（集成图 §5 纪律），本槽 docs-only、未动 `src/`、未开 PR、未建子代理。

---

## 2. 输入基线与一致性锚点

### 2.1 本规格向既有事实看齐的锚点（实现槽照此接线，不重造）

| 锚点 | 出处（分支 @ 位置） | 本规格的消费方式 |
| --- | --- | --- |
| 退出码 0/1/2 唯一表 | GAP-06；`src/cli/run.ts`（error 分支）：0 成功（含幂等无事可做）/ 1 运行期错误（含「检查类命令发现问题」）/ 2 用法错误 | check/snapshot 全部命令沿用；业务代码不触碰 `process.exitCode`（ESLint 拦截，唯一落点 `src/cli/main.ts`） |
| `fail(code, ctx)` 三段式注册表 | SPEC-03；`src/app/errors/registry.ts`（what/why/fix + example，`docs/errors/` 生成物，`lint:errors` 防漂移） | SW-Cxxx 规则文案采用同款三段式模板纪律与同款生成/防漂移管线（§4.5）；新错误码 E014/E05x 触达时登记 |
| 检查命令的聚合错误模式 | doctor：红项聚合 throw `SW-E013` → run.ts 顶层渲染 → 退出码 1；报告本体走 stdout | check 同构：error 级 finding 存在时聚合 throw `SW-E014`（§4.2） |
| 检查项三态 | doctor `DOCTOR_CHECKS`：pass / fail / **skip（未实现·前置未通过·不适用，不计红）** | check 规则同款三态；C04x 在角色卡（W1-P4-T05）交付前报 skip（§4.6） |
| 场景文件名 | `src/infra/store/layout.ts`：`padSceneId`（三位零填充）、`sceneFileName`（`010-opening.md`）；doctor `scenes-done` 匹配 `<id>-*.md` 或 `<id>.md` | §2.2 解析契约逐字沿用；C020/C021 判定依据 |
| 大纲条目语法 | outline 模板（三格式同构）：「一行一场，行首编号（010、020…留间隔便于插场）」；模板帮助注释为 HTML 注释块、首行以「这里是什么：」开头 | §2.2 解析契约；C01x 判定依据；C051 判定依据 |
| 原子写原语 | `src/infra/store/atomicFile.ts` `writeFileAtomic`（同目录临时文件 + fsync + rename） | 快照 index 提交点与 restore 逐文件写入复用（§5.4/§5.9）；`--fix --write` 落盘复用（§4.7） |
| 内容索引层 | W1-P4-T01（未实现）：outline/scenes/characters → core 只读索引，mtime 缓存，畸形文件产出结构化「不可解析」条目 | check 全部规则与 diff 的场景分节只从索引取数（§4.5 契约）；本规格把 T01 需要输出的最小字段定死 |
| 基分支纪律 | 集成图 §5：集成完成前并行槽 docs-only 基于 main；集成完成后的功能槽一律基于集成分支头 | 本槽 docs-only；W3-CHECK-T01…T05 全部标注基于集成分支头（依赖 W3-PLAN-T02） |

### 2.2 解析契约（本规格定死的语法常量，索引层 W1-P4-T01 照此实现）

以下常量是 F1 规则可二值判定的前提，全部收敛在索引层一处实现（规则引擎与 diff 只消费解析结果，不各自摸文件）：

| # | 契约 | 定义 |
| --- | --- | --- |
| G1 | 场景文件名 | `scenes/` 直下、匹配 `^(\d{3})(?:-([a-z0-9-]+))?\.md$` 的文件；捕获组 1 = 场号（三位零填充）、组 2 = slug（可缺省）。不匹配的 `.md` 文件 → 索引产出「编号不可解析」条目（C021 消费）。非 `.md` 文件与子目录忽略 |
| G2 | 大纲场景条目 | `outline.md` 中、**HTML 注释块之外**、左侧去空白后匹配 `^[-*]?\s*(\d{3})[ \t]+(.+)$` 的行；捕获组 1 = 场号、组 2 = 条目文本。模板示例天然在注释内，不会被误识别 |
| G3 | 模板帮助注释块 | HTML 注释（`<!--` … `-->`）且注释体首个非空行以「这里是什么：」开头——这是三份模板 outline.md 内嵌空态注释的稳定标记（C051 消费；fix = 整块删除） |
| G4 | 占位符残留 | 任何内容文件（G6 范围）全文匹配 `\{\{[A-Za-z][A-Za-z0-9]*\}\}`（含注释内；init/outline 渲染后应零残留，出现即异常）（C050 消费） |
| G5 | 空场景 | 场景文件去除首个一级标题行（`# …`）与空白行后正文长度为 0（C030 消费） |
| G6 | 内容文件白名单 | `project.yaml`、`outline.md`、`scenes/**/*.md`、`characters/**/*.md`——check 的扫描范围与快照的收录范围**共用此白名单**（`exports/`、`.sw/`、`.gitignore` 及其余一切不进） |
| G7 | 台词署名 | **未定**——属跨槽对齐点（W1-P4 §5.4 唯一登记项），由台词语法 ADR 定案。C040 与 diff 的台词/动作分类在 ADR 定案前分别处于 skip / 行级降级状态（§4.6 / §5.8） |

> `scenes/` 目录整体缺失时，索引层按「0 个场景文件」处理并继续（目录缺失本身是 doctor `layout` 检查的红项，check 不复述，见 §3）。

---

## 3. 与 doctor 的划界（正式化）

**一句话判定准则**：问题出在**环境 / 文件存在性 / 状态字段**（项目能不能被工具正确处理）→ `sw doctor`；问题出在**剧本内容语义 / 结构自洽**（剧本写得对不对）→ `sw check`。

### 3.1 归属表（含全部边界案例）

| 检查对象 | 归属 | 依据 |
| --- | --- | --- |
| Node 版本、`project.yaml` 存在/可解析/schema/字段合法、目录布局齐备 | doctor（已实现：`runtime-node` / `project-file` / `meta-schema` / `layout`） | 环境与文件层 |
| `progress.scenes_done` ↔ 磁盘场景文件核对 | doctor（已实现：`scenes-done`） | **边界案例①**：比对的是 project.yaml 的**状态字段**与磁盘，属状态一致性，不是剧本内容 |
| 锁健康（`.sw/lock`）、AI key 有效性 | doctor（已预留：`project-lock` / `ai-key`） | 环境层 |
| 大纲条目 ↔ 场景文件双向漂移 | check（C010/C011） | **边界案例②**：比对的是 outline.md 的**内容**与 scenes/ 文件集，属内容自洽；与 doctor 的 `scenes-done` 三方对象各不相同（outline 内容 / progress 字段 / 磁盘文件） |
| 场景编号重复 / 文件名编号不可解析 / 编号间隔耗尽 | check（C020/C021/C022） | 编号是剧本结构语义（P1 IA 的间隔编号策略），非文件存在性 |
| 空场景、占位符残留、模板帮助注释未清理 | check（C030/C050/C051） | 内容质量 |
| 台词署名角色未建卡 | check（C040） | 内容连续性 |
| `.sw/history/` 存储损坏 | **两边都不做常驻检查**：history 命令自身触达时以 `SW-E052` fail（§5.10）。doctor 若未来纳入，属「文件层」新增检查项（`DOCTOR_CHECKS` 追加元素），本规格不占位 | 存档非状态（ADR-0002，§5.11），不应把存档健康度绑进主工作流诊断 |

### 3.2 前置与互荐协议

- **check 的前置条件**：项目可加载（`project.yaml` 存在且 schema 兼容）。不满足时 check 以 `SW-E011` / `SW-E020` fail（退出码 1），**不产出任何规则结果**；两码的 fix 段末尾追加一句「先运行 `sw doctor` 排查项目文件与环境」。check 不复述 doctor 的其他红项（如目录缺失按 G6 空集处理）。
- **doctor → check 引荐**：doctor 全绿（零红项）时，结论行下追加一行「文件与环境正常。内容一致性请运行 `sw check`」。红项存在时不引荐（先修文件层）。
- **check → doctor 引荐**：仅在上述前置 fail 时出现（写进 E011/E020 的 fix 模板），规则 finding 中不出现——避免用户在内容问题上被误导去跑 doctor。
- **doctor 的既有检查项零改动**：本规格不从 doctor 移出任何已实现检查；`scenes-done` 永久归 doctor（状态字段核对），与 C010/C011 并存不重复（对象不同，见 §3.1）。

---

## 4. SPEC-F1：`sw check`

### 4.1 命令面

```text
sw check [dir] [选项]

  dir                  项目目录（可选位置参数，默认当前目录；与 init/doctor/outline 同约定）

选项：
  --format <text|json>   输出格式，默认 text
  --profile <default|export>
                          规则档位，默认 default；export 档位把 C010/C011/C030 升级为 error（§4.6），
                          供导出前置检查与 CI 使用（未来 sw export 内部以此档位调用引擎）
  --fix                   对白名单规则计算修复，默认 dry-run（只预览，不写盘）
  --write                 与 --fix 连用时把修复落盘（writeFileAtomic）；单独出现属用法错误（退出码 2）
  -h, --help              帮助（含 ≥2 条可复制示例与退出码说明，进 help 快照全集）
```

- 旗标全集就是以上 4 个。`--only <rules>`、`--severity` 阈值、项目级规则配置文件等一律不做（§7 非目标）。
- `--write` 不带 `--fix` 的拦截属旗标组合校验（argparse 层语义 → 退出码 2）；实现建议在 program 配置层完成（SPEC-03 的 `program.error()` 禁令针对业务错误，不适用于此处）。

### 4.2 退出码（GAP-06 表的逐字适用）

| 码 | 条件 |
| --- | --- |
| 0 | 无 error 级 finding（warn / info / skip 任意多均可）；含 `--fix --write` 成功落盘 |
| 1 | ≥1 条 error 级 finding（聚合经 **`SW-E014`** throw，由 run.ts 顶层渲染三段式到 stderr；报告本体已先行走 stdout——与 doctor 的 SW-E013 模式同构）；或前置 fail（SW-E011/E020）等任何运行期错误 |
| 2 | 用法错误（未知旗标、`--write` 无 `--fix`、`--format` 非法值等，未进入业务逻辑） |

`SW-E014` 提案文案（实现槽触达时登记进 `ErrorContexts` / `ERROR_REGISTRY`，段位 E01x 项目/文件系统之后的检查段沿用 doctor 先例）：what「剧本内容一致性检查未通过」；why「发现 {errorCount} 处 error 级问题（清单见上方报告）」；fix「按报告中每条的『怎么办』逐项处理后重跑 `sw check`；工作中态的漂移类警告不影响退出码」。

### 4.3 文本输出契约（结构可断言，全文不锁）

```text
sw check · 剧本内容一致性检查（profile: default）

✖ SW-C020 场景编号重复 — scenes/010-opening.md, scenes/010-hook.md
  原因：编号 010 对应 2 个场景文件，导出与进度统计将无法确定次序。
  怎么办：保留其一，另一场运行 `sw move`（W1-P4-T09 交付后）或手工改号后更新大纲。
  文档：docs/checks/SW-C020.md
⚠ SW-C010 大纲条目缺场景文件 — outline.md:14
  原因：大纲第 14 行列出场次 040（中点反转），scenes/ 下没有编号 040 的文件。
  怎么办：运行 `sw draft 040 --title "中点反转"` 建场；或从大纲删除该行。
  文档：docs/checks/SW-C010.md
○ SW-C040 台词署名角色未建卡 — 跳过（角色卡功能未交付：W1-P4-T05）

结论：1 错误 / 1 警告 / 0 提示（1 项跳过，不计入）。
```

- 图标与 doctor 对齐：`✖` error / `⚠` warn / `ℹ` info / `○` skip。每条 finding 三段式（原因 / 怎么办 / 文档锚点），与 SPEC-03 错误渲染同构。
- 排序确定性：finding 按（文件相对路径，行号，规则号）字典序；无行号的排在该文件末尾。同夹具两次运行输出字节一致。
- 零 finding 时输出单行「✔ 内容一致性检查通过：N 场 / 大纲 M 条，无问题。」（N/M 来自索引，供夹具断言）。

### 4.4 JSON 输出契约（`--format json`，schema 字段名即接口，v1 冻结）

```json
{
  "schema": 1,
  "profile": "default",
  "findings": [
    {
      "rule": "SW-C010",
      "severity": "warn",
      "file": "outline.md",
      "line": 14,
      "message": "大纲第 14 行列出场次 040（中点反转），scenes/ 下没有编号 040 的文件",
      "fixable": false,
      "docs": "https://github.com/Dawan2/script-writer/blob/main/docs/checks/SW-C010.md"
    }
  ],
  "skipped": [{ "rule": "SW-C040", "reason": "角色卡功能未交付：W1-P4-T05" }],
  "summary": { "error": 0, "warn": 1, "info": 0, "fixable": 0 }
}
```

- `line` 可为 `null`（问题定位到整个文件时）；`file` 为项目内 POSIX 相对路径；排序与文本输出一致。
- JSON 走 stdout 且**只有 JSON**（报告头、聚合错误渲染等人类面输出在 json 格式下抑制到 stderr 或省略），保证 `sw check --format json | jq` 可用。退出码语义不变。

### 4.5 规则引擎与注册表架构

| 部件 | 位置 | 规格 |
| --- | --- | --- |
| 规则注册表 | `src/app/check/registry.ts` | 与 `src/app/errors/registry.ts` 同款纪律的单一数据源：每条规则登记 `id`（SW-Cxxx）、`title`、`severity`、`exportSeverity?`（export 档位覆盖值）、三段式模板（what/why/fix，`{key}` 占位）、`example`（样例 ctx，供文档生成与 lint 断言占位符全解析）、`fixable`（是否在 --fix 白名单）、`requires?`（能力依赖，如 `'characters'`——未满足时引擎记 skip） |
| 规则实现 | `src/app/check/rules/`（每规则一文件） | 纯函数 `run(index: ContentIndex): RawFinding[]`；白名单规则另有 `fix(index): FileEdit[]`（`{ path, newContent }`，幂等）。规则**只读索引、零 IO**（依赖方向 lint 断言） |
| 引擎 | `src/app/check/engine.ts` | 载入索引 → 依注册表顺序执行 → 归并/排序 finding → 产出 `CheckReport`（findings + skipped + summary）。单条规则抛异常不中断整轮：转为该规则的 error 级 finding「规则执行失败」，报告仍完整产出（doctor 同款韧性） |
| CLI | `src/cli/commands/check.ts` | 渲染 + `--fix` 管线 + 聚合 throw `SW-E014`；不触碰 `process.exitCode` |
| 文档生成 | `docs/checks/SW-Cxxx.md` + `docs/checks/README.md` | 由注册表生成（`npm run gen:checks`，实现上可扩展 `scripts/gen-error-docs.ts`）；**`npm run lint:errors` 扩展覆盖 SW-Cxxx**（未注册码字面量拦截 + 生成物漂移拦截），脚本名不变、CI 工作流零改动 |

**索引层消费契约**（对 W1-P4-T01 的最小接口要求，字段名可由 T01 实现槽定稿、语义不得少于此）：

```ts
interface ContentIndex {
  outline: {
    entries: Array<{ sceneId: string; text: string; line: number }>; // G2，按出现顺序
    helpCommentBlocks: Array<{ startLine: number; endLine: number }>; // G3
  };
  scenes: Array<{
    id: string; slug: string | null; fileName: string;              // G1
    bodyEmpty: boolean;                                             // G5
    speakers: string[] | null;                                      // G7：语法 ADR 定案前恒为 null
  }>;
  characters: Array<{ name: string; aliases: string[] }> | null;    // W1-P4-T05 交付前为 null
  unparsableSceneFiles: Array<{ fileName: string }>;                // G1 不匹配的 .md
  placeholderHits: Array<{ file: string; line: number; token: string }>; // G4
}
```

### 4.6 规则集 v1（SW-Cxxx 注册表，10 条）

编号分段：**C01x 大纲↔场景漂移 · C02x 编号 · C03x 场景内容 · C04x 角色 · C05x 模板残留**。severity 设计原则：**「大纲先行、场景后建」的正常中间态不判红**——漂移与空场默认 warn，仅在 `--profile export` 升级 error；默认档位的 error 只留给真正的完整性破坏（重复编号、不可解析文件名、占位符残留）。

| 规则 | 名称 | 默认 severity | export 档位 | 判定（二值，基于 §2.2 契约） | 定位 | fix 白名单 |
| --- | --- | --- | --- | --- | --- | --- |
| SW-C010 | 大纲条目缺场景文件 | warn | **error** | 存在大纲条目（G2）其场号在场景文件集（G1）中无对应 | outline.md + 行号 | 否（建场属 `sw draft`，删行属人工决策） |
| SW-C011 | 场景文件未列入大纲 | warn | **error** | 存在场景文件（G1）其场号在大纲条目集（G2）中无对应 | 场景文件（无行号） | **是**：向 outline.md 末尾追加规范条目「`<id> <slug 连字符还原为空格> TODO：补一句话概述`」 |
| SW-C012 | 大纲条目顺序与编号不一致 | warn | warn | 大纲条目出现顺序与场号数值序存在逆序对 | outline.md + 首个逆序行号 | 否（重排语义属人工/F6） |
| SW-C020 | 场景编号重复 | **error** | error | 同一场号对应 ≥2 个场景文件 | 全部涉事文件（无行号） | 否（改号指向 `sw move`/人工） |
| SW-C021 | 场景文件名编号不可解析 | **error** | error | `scenes/` 直下存在 G1 不匹配的 `.md` 文件 | 涉事文件（无行号） | 否（改名指向 `sw renumber`/人工） |
| SW-C022 | 编号间隔耗尽 | info | info | 按数值排序的相邻场号差 = 1（无法在两场间插场） | 后一场文件（无行号） | 否（fix 文案指向 `sw renumber`，W1-P4-T09 交付前注明「即将交付」） |
| SW-C030 | 空场景 | warn | **error** | 场景文件 bodyEmpty（G5） | 场景文件（无行号） | 否（需要真实内容） |
| SW-C040 | 台词署名角色未建卡 | warn | warn | 场景 speakers 中存在既不匹配任何角色卡主名、也不匹配任何别名的名字（按名字聚合，定位首次出现文件） | 首次出现的场景文件 | 否（建卡指向 `sw character add <name>`） |
| SW-C050 | 模板占位符残留 | **error** | error | placeholderHits 非空（G4） | 文件 + 行号 | 否（需要真实内容） |
| SW-C051 | 模板帮助注释未清理 | info | info | 内容文件中存在 G3 注释块 | 文件 + 块起始行号 | **是**：删除整个注释块 |

- **C040 的 skip 语义**：`requires: 'characters'`——索引层 `characters === null`（W1-P4-T05 未交付）或 `speakers === null`（台词语法 ADR 未定案）时，引擎将其记入 `skipped`（理由注明依赖项），不产出 finding、不计红。与 doctor `project-lock`「未实现不崩溃」同款处置。
- 三段式文案与文档锚点每条规则都有（注册表模板强制），上表「fix 白名单」列为 `--fix` 语义，与文案里的「怎么办」建议是两回事。
- 规则准入纪律沿用 W1-P4-T02 风险条款：**只收结构可判定规则**，语义类规则（剧情连贯、节奏问题）一律不收（§7）。

### 4.7 `--fix` 白名单管线

- **白名单 v1 只有两条**：C011（追加大纲条目）、C051（删除模板帮助注释块）。判据：修复内容可从索引机械推导、修改幂等、单文件局部、不需要创作决策。其余规则永不进入白名单前必须先过本判据并追加规格修订。
- **dry-run 默认**（`--fix`）：输出每项将做的修改（文件 + 动作一句话 + ≤5 行预览），**不写任何文件**（字节级断言 AT-C08）；结论行注明「未写盘，确认后追加 --write」。
- **落盘**（`--fix --write`）：逐文件经 `writeFileAtomic` 应用；只触碰白名单修复涉及的文件（AT-C10）；输出已应用清单 + 建议重跑 `sw check`。应用后重跑，被修复的 finding 必须消失且不引入新 finding（幂等，AT-C09）。
- `--fix` 与 `--format json` 连用：findings 的 `fixable` 字段照常，另在顶层追加 `"fixes": [{ "rule", "file", "applied": bool }]`。

### 4.8 性能与确定性

- 50 场规模夹具（脚本生成：50 场景文件 + 50 行大纲 + 5 角色卡）全量 check **< 1s**（AT-C11，P4 F1 验收④原文阈值）。索引层 mtime 缓存（T01 验收②）负责重复运行加速，check 引擎自身不再造缓存。
- 输出确定性：排序规则见 §4.3；`docs` 锚点 URL 与 `ERROR_DOCS_BASE_URL` 同款常量管理。

---

## 5. SPEC-F2：`.sw/history/` 版本快照与 snapshot / history / diff / restore

### 5.1 存储布局（定稿）

```text
<project>/
└── .sw/                        # 本地存档区（存档非状态，ADR-0002；模板 .gitignore 收录整个 .sw/）
    ├── history/
    │   ├── index.yaml          # 快照元数据索引 = 唯一提交点（原子重写）
    │   └── objects/
    │       └── <hh>/           # 内容哈希前 2 位十六进制作子目录（防单目录过大）
    │           └── <sha256>    # 内容寻址对象：文件原始字节，文件名 = 64 位 sha-256 hex，不压缩不打包
    └── trash/                  # F6（W1-P4-T09）占位命名，本规格不定义其内部结构
```

- 对象**写前查存在**（同哈希已存在则跳过写入）——去重即由此获得；对象文件一经写入不再修改（AT-S02）。
- **v1 明确禁止**：GC、压缩、打包、加密、远端同步（W1-P4-T03 风险条款原文，过度设计防线；登记为后续任务方向，§7）。

### 5.2 `index.yaml` schema（v1 冻结）

```yaml
schema: 1
snapshots:                        # 追加式列表，按创建先后排列（新的在末尾）
  - id: 20260827T101530Z-a1b2     # UTC 紧凑时间戳 + 4 位十六进制随机后缀；字典序 = 时间序
    label: 初稿完成                # 可选，自由文本；缺省时键省略
    reason: manual                 # manual | auto-safety（restore/未来 F6 操作前的自动安全快照）
    createdAt: 2026-08-27T10:15:30Z
    files:                         # 收录范围 = G6 内容文件白名单在当时磁盘上的全部存在项
      - path: project.yaml         # 项目内 POSIX 相对路径
        hash: 3f9a…c2              # 64 位 sha-256 hex（示例截断）
        size: 812                  # 字节数（history 摘要与损坏校验用）
      - path: outline.md
        hash: …
        size: …
      - path: scenes/010-opening.md
        hash: …
        size: …
```

- 读写经引擎既有 `yaml` 库（集成分支已含），**不手写解析器**；`schema` 字段为 history 存储自身的版本号，与 project.yaml 的 schema 相互独立。
- `index.yaml` 每次全量重写（快照数量级为数百，全量重写成本可忽略；追加式列表保证 diff 友好）。

### 5.3 快照范围与哈希

- 收录 = **G6 白名单**（`project.yaml`、`outline.md`、`scenes/**/*.md`、`characters/**/*.md`）的磁盘现存文件。`exports/`、`.sw/` 自身、`.gitignore` 及其余一切永不入快照。
- 哈希 = 文件原始字节的 sha-256（不做换行归一——快照是字节级存档，AT-S01 往返字节一致依赖于此）。
- 空项目（仅 project.yaml）可快照；与上一快照内容完全一致时**仍创建**新条目（用户显式动作 + label 可能不同；对象层去重使成本仅为一条 index 记录），输出注明「内容与快照 <id> 相同」。

### 5.4 写入协议与崩溃语义（AT-S06 的判定依据）

1. 枚举白名单文件 → 逐个计算哈希 → **对象先行落盘**（write-if-absent；对象写入自身经临时文件 + rename，避免半个对象被当作完整对象）。
2. 全部对象就绪后，内存中追加新快照条目 → `writeFileAtomic` 重写 `index.yaml`——**rename 即提交点**。
3. 崩溃语义：提交点之前任意时刻中断（含 kill -9）→ 旧 `index.yaml` 完整可用，最多残留未被引用的孤儿对象（无害，v1 不清理）；提交点之后 → 新快照完整可见。**不存在中间态**。
4. 并发：本地单进程 CLI 假设（P4 §5.3），不做锁；GAP-04 文件锁落地后由其统一约束，本规格不预置。

### 5.5 快照引用解析（diff / restore 的 `<ref>` 参数）

优先级：**① id 精确匹配 → ② id 唯一前缀（≥8 字符）→ ③ label 精确匹配**。歧义（前缀或 label 命中多个）→ `SW-E051`（列出全部候选 id + label）；无命中 → `SW-E050`（列出最近 5 个快照供参考）。

### 5.6 `sw snapshot`

```text
sw snapshot [dir] [--label <text>]
```

- 位置参数 `[dir]` 与 init/doctor/outline 同约定（**决策 D1**：P4 一句话规格的 `sw snapshot [label]` 调整为 label 走旗标，词汇一致性优先，偏差登记 §8）。
- 成功输出（结构锁定）：`✔ 已创建快照 <id>（<label 或"未命名">）：<N> 个文件，新增对象 <M> 个`；末行给可复制命令 `sw history` 与 `sw restore <id>`。退出码 0。
- 非项目目录 → `SW-E011`（退出码 1）。

### 5.7 `sw history`

```text
sw history [dir] [--scene <id>] [--format <text|json>]
```

- 文本输出：时间线**新→旧**，每快照一行：`<id>  <createdAt 本地化>  <label 或 —>  <reason>  <文件数>`；`--scene <id>` 时只列**该场文件哈希相对前一快照发生变化**（含首次出现 / 消失）的快照，行尾追加变化标记（新增/修改/删除）。
- 空历史 → SPEC-03 `hint()` 空态三要素（这里是什么 / 示例 / 下一步），末行可复制命令 `sw snapshot --label "初稿完成"`。退出码 0。
- `--format json`：`{ "schema": 1, "snapshots": [{ "id", "label", "reason", "createdAt", "fileCount" }] }`，排序同文本。

### 5.8 `sw diff`

```text
sw diff <from> [to] [--scene <id>] [--dir <path>]
```

- `<from>`/`[to]` 为快照引用（§5.5）；**`to` 缺省 = 与工作区当前状态比较**。位置参数已被引用占用，项目目录改走 `--dir <path>`（默认当前目录）——凡位置参数被占用的命令均适用此约定（restore 同，**决策 D6 的一部分**）。
- 默认输出 = **变更摘要**，每个变化文件一行；场景文件以场分节头呈现：

```text
sw diff 20260827T101530Z-a1b2 ↔ 工作区

场 010 · opening      修改（+3 行 / -1 行）
场 030 · showdown     新增（快照中不存在）
outline.md            修改（+1 行 / -0 行）
project.yaml          无变化
```

- `--scene <id>` 输出该场**行级明细**：变更行前缀 `+`/`-`，行宽 ≤80 列（超宽以 `…` 截断）。**v1 按行渲染；台词/动作行分类随台词语法 ADR（G7）定案后升级**，升级只改行标注层、不改 diff 计算（决策 D6，登记 §8）。
- 测试锁**结构**（分节头、计数标签、前缀、列宽），不锁全文（W1-P4-T04 风险条款原文）。
- 快照中无指定场景且工作区也无 → `SW-E053`。文本 only（json 版 diff 列入 §7 非目标）。

### 5.9 `sw restore`

```text
sw restore <ref> [--scene <id>] [--dir <path>]
```

- **恢复前无条件自动安全快照**：`reason: auto-safety`、label 固定格式「`restore <目标 ref> 前自动快照`」——这是 restore 不需要确认交互的依据（操作自带撤销路径）。
- **全项目恢复**：快照内文件逐个经 `writeFileAtomic` 写回（单文件原子，无半成品）；**白名单（G6）范围内、当前存在但快照中没有的文件被删除**（安全快照已含它们）；白名单外文件永不触碰。原子性承诺 = 单文件级 + 会话级可撤销（安全快照），**不承诺**多文件恢复的整体事务（中断后混合态可用安全快照一步复原——此语义写入命令文档与 ADR-0002）。
- **单场恢复**（`--scene <id>`）：只写回该场文件，**不触碰 project.yaml 与其他文件**（进度状态不回退；场景文件存在性不变，doctor `scenes-done` 不受影响——AT-S04）。快照中无该场 → `SW-E053`。
- 成功输出（结构锁定）：

```text
✔ 已恢复快照 20260827T101530Z-a1b2（初稿完成）
  写回 7 个文件（scenes 5 · outline 1 · project.yaml 1），删除 1 个（scenes/030-x.md）
  恢复前已自动快照：20260827T113045Z-9f3e
  撤销本次恢复：sw restore 20260827T113045Z-9f3e
```

### 5.10 错误码（SW-E05x 快照/历史段 + E014，提案；实现槽触达时登记）

| 码 | what | 触达点 |
| --- | --- | --- |
| SW-E050 | 快照不存在 | §5.5 解析零命中（why 含所查引用；fix 列最近 5 个快照 + `sw history`） |
| SW-E051 | 快照引用歧义 | §5.5 多命中（why 列全部候选；fix 提示用完整 id） |
| SW-E052 | 历史存储损坏 | index.yaml 不可解析 / 引用对象缺失 / 对象哈希或 size 不符（fix：「删除 .sw/history/ 后重新开始快照——只丢历史存档，项目内容与进度不受影响」，措辞与 ADR-0002 一致） |
| SW-E053 | 快照中不含指定场景 | diff/restore 的 `--scene` 无命中（fix 列该快照实际收录的场号） |
| SW-E014 | check 发现 error 级问题 | §4.2 聚合 throw |

全部走 `fail(code, ctx)` + 注册表三段式；**本规格只提案不预填**——「禁止预填未用码」纪律要求由实际触达这些路径的实现槽（W3-CHECK-T01/T03/T04）在同一提交内登记 + `gen:errors`。已占用码规避核对：E010/E011/E013/E020/E030/E031 在用，E012 为 GAP-04 锁预留，E04x 为 AI 段预留——E014 与 E05x 段无冲突。

### 5.11 ADR-0002 要点（「状态 vs 存档」，正式 ADR 随 W3-CHECK-T03 交付）

1. **判定标准**（W1-P4 §5.2 原文，一字不改）：删除 `.sw/` 后所有主工作流命令行为不变，只丢历史——满足者为**存档**，允许存在；不满足者为**状态**，必须收敛进 project.yaml（P1 §6.5 单一状态源不破）。
2. `.sw/history/`（本规格）与 `.sw/trash/`（F6）均按存档定性；`.sw/lock`（GAP-04）是**运行时临时物**而非状态，同目录共存不违反本 ADR（锁的语义由 GAP-04 自治）。
3. 模板 `.gitignore` 收录整行 `.sw/`：存档属本地，不强推进用户 git。
4. 任何命令**不得依赖** `.sw/` 内容改变主工作流行为（AT-S12 以测试锁死此边界）。

---

## 6. 验收测试清单（实现槽的测试对照表，全部二值判定）

### 6.1 AT-C：`sw check`（归属 W3-CHECK-T01/T02/T05）

| 编号 | 断言 | 归属 |
| --- | --- | --- |
| AT-C01 | 10 条规则各有**正例夹具**（触发）：finding 的 rule/severity/file（/line）逐字段断言 | T01（C040 在 T05） |
| AT-C02 | 10 条规则各有**反例夹具**（不触发）：健康结构下零 finding | T01（C040 在 T05） |
| AT-C03 | 健康项目：exit 0，输出「✔ 内容一致性检查通过」单行（含场数/条目数） | T01 |
| AT-C04 | 仅 warn/info finding：报告照常输出，exit 0 | T01 |
| AT-C05 | ≥1 error finding：报告走 stdout，SW-E014 三段式走 stderr，exit 1（进程级断言） | T01 |
| AT-C06 | 未知旗标 / `--write` 无 `--fix` / `--format` 非法值：exit 2 | T01 |
| AT-C07 | `--format json`：stdout 可被 JSON.parse，schema=1，字段名与 §4.4 逐字一致，排序稳定 | T01 |
| AT-C08 | `--fix` dry-run：运行前后项目目录**字节级不变**（全文件哈希对比），输出含预览 | T02 |
| AT-C09 | `--fix --write`：C011/C051 正例修复落盘，重跑 check 对应 finding 消失且无新增 finding（幂等） | T02 |
| AT-C10 | `--fix --write` 只触碰白名单修复涉及的文件（其余文件 mtime/字节不变断言） | T02 |
| AT-C11 | 50 场生成夹具全量 check 用时 < 1s（计时断言） | T01 |
| AT-C12 | project.yaml 缺失 → SW-E011、schema 不兼容 → SW-E020，均 exit 1 且 fix 段含「先运行 `sw doctor`」；不产出任何规则 finding | T01 |
| AT-C13 | 角色数据缺席时 C040 进入 skipped（含理由），不计红；T05 交付后本条替换为 C040 warn 正例断言 | T01→T05 |
| AT-C14 | 同一夹具连续两次运行输出字节一致（确定性） | T01 |
| AT-C15 | `--profile export`：C010/C011/C030 severity 升为 error 且退出码联动（同夹具 default=0 / export=1 对照断言） | T01 |
| AT-C16 | `lint:errors` 扩展覆盖：SW-Cxxx 未注册字面量拦截、`docs/checks/` 生成物漂移拦截（故意漂移的负例测试） | T01 |

### 6.2 AT-S：快照四命令（归属 W3-CHECK-T03/T04）

| 编号 | 断言 | 归属 |
| --- | --- | --- |
| AT-S01 | 快照 → 改动/删除若干白名单文件 → 全项目恢复：全部文件**字节级**等于快照时刻（含多字节 UTF-8 与空文件） | T03 |
| AT-S02 | 内容未变时二次快照：`objects/` 无新增文件（对象计数断言），index 新增 1 条 | T03 |
| AT-S03 | restore 前自动安全快照存在（reason=auto-safety、label 含目标 ref），且用它可一步撤销恢复（往返断言） | T03 |
| AT-S04 | 单场恢复：仅该场文件字节变化，他场 + outline + project.yaml 字节不变；恢复后 doctor 与 check 结论不劣化 | T04 |
| AT-S05 | 全项目恢复删除「白名单内、快照外」文件；白名单外文件（如 exports/ 下产物）不动 | T03 |
| AT-S06 | 原子性：注入式中断（对象已写、index rename 前抛错）→ 旧 index 完整、`sw history` 正常；进程级 kill -9 冒烟同断言 | T03 |
| AT-S07 | 引用解析：唯一 id 前缀命中；前缀多命中 → SW-E051 列候选；零命中 → SW-E050 列最近快照 | T03 |
| AT-S08 | label 精确引用命中；同 label 多快照 → SW-E051 | T03 |
| AT-S09 | history 排序新→旧；`--scene` 过滤只留该场哈希变化的快照（含新增/删除标记） | T04 |
| AT-S10 | diff 摘要与 `--scene` 明细的**结构快照测试**：分节头、计数标签、+/- 前缀、80 列截断（不锁全文） | T04 |
| AT-S11 | diff 省略 `to` = 与工作区比较（改一行后断言摘要计数） | T04 |
| AT-S12 | 删除整个 `.sw/` 后：init / outline / status / doctor / check 行为与删除前逐字节一致（存档非状态，ADR-0002 边界） | T03 |
| AT-S13 | 三份模板 `.gitignore` 均含 `.sw/` 行（模板单测） | T03 |
| AT-S14 | index.yaml 损坏 / 对象缺失 / 哈希不符三例 → SW-E052 三段式（fix 含「只丢历史」措辞），exit 1 | T03 |
| AT-S15 | `smoke:exit-codes` 扩展：E050/E051/E052/E053/E014 进程级各触达一例（0/1/2 三档齐备） | T03/T04 |

### 6.3 与 P4 原验收的追溯矩阵

| P4 原验收 | 覆盖 AT |
| --- | --- |
| F1① ≥8 条规则、正反例夹具 | AT-C01、AT-C02（10 条） |
| F1② 三段式 + 锚点、经 SPEC-03 渲染 | AT-C05、AT-C16 |
| F1③ --fix 白名单 + dry-run 默认 + write 后全绿 | AT-C08、AT-C09、AT-C10 |
| F1④ 50 场 < 1s | AT-C11 |
| F1⑤ 退出码语义 | AT-C03、AT-C04、AT-C05、AT-C06 |
| F2① 往返字节一致 | AT-S01 |
| F2② 单场恢复不影响他场、doctor/check 全绿 | AT-S04 |
| F2③ 安全快照可查 | AT-S03 |
| F2④ kill -9 无半成品 | AT-S06 |
| F2⑤ diff 快照测试锁结构 | AT-S10 |
| F2⑥ 删 .sw/ 行为不变 | AT-S12 |

---

## 7. 范围裁剪与非目标（v1 明确不做，防蔓延）

| 项 | 处置 |
| --- | --- |
| 规则配置文件（.swcheckrc 之类）、`--only`/`--severity` 旗标 | 不做。P1 配置分层「禁止第四层」；规则档位只有 default/export 两档 |
| 语义类规则（剧情连贯、节奏、文风） | 不收。规则准入 = 结构可判定（W1-P4-T02 风险条款） |
| C040 的模糊名字匹配（拼写近似、昵称推断） | 不做。只按角色卡主名 + 显式别名表精确归并（W1-P4-T05 风险条款） |
| 快照 GC / 压缩 / 打包 / 加密 / 远端同步 | 禁止（W1-P4-T03 风险条款）。登记为后续任务方向，不占任务号 |
| diff 的 json 输出、跨快照三方合并、快照重命名/删除子命令 | 不做。v1 时间线为追加式只读 |
| 台词/动作行分类渲染 | 降级为行级（G7 未定案）；ADR 定案后升级，仅改行标注层 |
| `sw export --check` 接线 | 本规格只交付 `--profile export` 档位；export 侧调用属 F5（W1-P4-T06）范围 |

---

## 8. 开放决策与偏差登记（供调度器与实现槽核对）

| # | 决策/偏差 | 内容与理由 |
| --- | --- | --- |
| D1 | `sw snapshot [dir] --label <text>`，偏离 P4 一句话规格的 `sw snapshot [label]` | 与 init/doctor/outline 已定型的 `[dir]` 位置参数约定一致（P1「词汇一致」约束优先于提案速记） |
| D2 | check 聚合码取 **SW-E014** | E013 已被 doctor 占用、E012 被锁预留；模式与 doctor 全同构。实现槽触达时登记 |
| D3 | 快照段取 **SW-E05x**（E050–E053 四码） | 沿用 P4 F2「建议段 SW-E05x」原文；触达时登记 |
| D4 | 快照 id = `UTC 紧凑时间戳 + 4 位十六进制随机`；引用解析 id 精确 > 唯一前缀(≥8) > label 精确 | 字典序即时间序、人类可读、无中央计数器 |
| D5 | --fix 白名单 v1 = {C011, C051} 两条 | 判据（机械推导/幂等/单文件/无创作决策）见 §4.7；扩白名单须过判据 + 规格修订 |
| D6 | 漂移类规则（C010/C011/C030）默认 warn、export 档位 error；diff v1 行级渲染 | 「大纲先行、场景后建」正常中间态不判红；台词分类等 G7 ADR，不阻塞 T04 交付 |

**风险**：R1 台词语法 ADR 仍未定案（承 P4 §5.4）——C040 与 diff 分类按 skip/降级设计，交付不被阻塞；R2 索引层（W1-P4-T01）未实现且未任务化到具体槽——§4.5 已给最小契约，T01 实现槽照此可独立开工；R3 集成分支尚未建立（W3-PLAN-T01…T05 进行中）——本规格全部任务显式 blocked 于 W3-PLAN-T02，不允许从旧基线抢跑（集成图 §5 纪律）。

---

## 9. 交接（给实现槽的开工清单）

1. **基分支**：一律取集成分支头（W3-PLAN-T02 完成后）；开工前核对错误框架（`fail`/registry/lint:errors）、引擎（`yaml`、`writeFileAtomic`、`layout.ts`）均已在基分支就位。
2. **开工顺序建议**：W3-CHECK-T03（快照，不依赖索引层，集成后即 ready）与 W1-P4-T01（索引层）并行 → W3-CHECK-T01（check 引擎）→ T02（--fix）与 T04（history/diff）并行 → T05（C04x + 互荐，另需 W1-P4-T05 与台词语法 ADR）。
3. **错误码登记纪律**：E014/E050–E053 在**实际触达的同一提交**内登记 + `gen:errors`，否则 `lint:errors` 红（集成图 §3-③ 同款教训）。
4. **doctor 侧唯一改动**：全绿结论行下追加引荐 `sw check` 一行（§3.2），归 T05；doctor 检查项零迁移。
5. **验收对照**：实现槽落地说明按 §6 的 AT 编号逐条打勾；测试只增不减、CI 门不可降标（lint / lint:errors / typecheck / test / build / smoke / smoke:exit-codes 全绿 0 跳过）。

---

*W3 P4-F1/F2 规格细化槽产出 · 分支 `cursor/w3-spec-check-snapshot-973a` · 基线 `main @ deda75a`*
