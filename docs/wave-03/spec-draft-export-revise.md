# W3 计划槽：draft / export / revise 规格对齐（SPEC-05 / SPEC-06 / SPEC-04 增补）

| 项目 | 内容 |
| --- | --- |
| 波次 / 槽位 | 第 3 波（wave-03）/ 周期 W3 / 计划槽「draft/export/revise 规格对齐」 |
| 仓库 | github.com/Dawan2/script-writer |
| 基线 | `main @ deda75a`（docs-only 槽按集成图 §5 约定基于 main；引用的实现均在各分支，锚点见 §2） |
| 工作分支 | `cursor/w3-spec-draft-export-revise-193d`（已 push，未开 PR） |
| 文档性质 | 命令规格：SPEC-05 `sw draft`、SPEC-06 `sw export`（SPEC-02 粗粒度契约的细化）+ SPEC-04 `sw revise` 对齐增补（不改写 SPEC-04 原文） |
| 硬边界 | **docs-only**：本槽零 `src/` 改动（集成槽正在合并 error+engine+init，任何提前实现都会加宽集成图 §2 冲突面） |
| 配套文档 | `docs/wave-03/ready-tasks.md`（本分支新增 WAVE03-DRAFT 分区）、`docs/DISPATCH-receipt.md`（追加回执） |

> **给合并者的索引行**（并入 `docs/README.md` wave-03 分区时粘贴）：
> `| [\`wave-03/spec-draft-export-revise.md\`](./wave-03/spec-draft-export-revise.md) | W3 计划槽：SPEC-05/06 draft、export 命令契约（markdown v1 导出）与 SPEC-04 revise 对齐增补、错误码 E032–E034 编号预留、测试验收 | \`cursor/w3-spec-draft-export-revise-193d\` |`

---

## 1. 结论速览（TL;DR）

1. 五步主工作流（P1 §6.2）中 `outline` 已实现（`cursor/w3-outline-templates-5596`）、`status` 已实现（engine 分支）、`init` 已实现（init 分支）、`revise` 已有 SPEC-04（W2-GAP 裁决 §3.1）；**`draft` 与 `export` 只有 SPEC-02 的一行级契约，尚不够开工粒度**。本文补齐为 SPEC-05（draft）与 SPEC-06（export），粒度对齐 SPEC-01…04「可直接开工」标准。
2. 关键裁定三条：① draft 把「创建场文件」与「标记完成」拆为两个动作（`--done` 旗标），使 `3/5 场已完成` 的完成度语义成立（勘误 §9-1）；② export v1 只导出 **markdown**（ADR-0001 §3.6 既定，本文不重裁只落地），产物**确定性输出**（同输入同字节）且允许覆盖派生产物（与 EP-04 幂等条款的边界说明，勘误 §9-3）；③ revise 不新增规格，只做与已实现引擎/存储/渲染层的**对齐增补**（§6），实现任务仍为 W2-GAP-T01，不重复立项。
3. 新错误码编号预留三只：`SW-E032`（场编号非法）、`SW-E033`（导出格式不支持）、`SW-E034`（无可导出内容）。已核对全分支占用：E012 已被 GAP-04 预留（锁）、E013 已被 doctor 槽占用（红项聚合）、E030/E031 已用——**编号在此预留防并行撞号，登记仍按 SPEC-03 纪律随首个触达用例进注册表**（§7）。
4. 配套任务 W3-DRAFT-T01…T03 登记于 `docs/wave-03/ready-tasks.md` WAVE03-DRAFT 分区（draft 实现 / export 实现 / 主链 e2e + TTFS 基准），全部前置于集成分支就绪（W3-PLAN-T02/T03）。
5. 本槽 docs-only：不做功能开发、不开 PR、不建子代理、不触碰任何测试与 CI 配置。

---

## 2. 输入与依据（只引用，不重做）

| 来源 | 分支 @ 提交 | 消费内容 |
| --- | --- | --- |
| P1 架构方案 | `cursor/w1-p1-usability-architecture-5d0e @ 5545c22` | §6.2 五步工作流（可恢复/可跳过/幂等）、§6.3 空态错态、§7 SPEC-02（draft/export 一行级契约）、§4 度量（TTFS/末行可复制） |
| SPEC-04 与 GAP 裁决 | `cursor/w2-gap-adjudication-c82d @ 661b313`（已吸收进 error 分支） | §3.1 SPEC-04 revise 全要点、§3.4 文件锁（E012 预留）、§3.6 SPEC-03-EXT 退出码表 |
| ADR-0001 | `cursor/w2-scaffold-ci-ccbf @ 8b2d9b9` | §3.6 v1 默认导出 markdown（默认值必须指向已实现格式）；§3.5 commander |
| 工作流引擎 | `cursor/w2-workflow-engine-4cad @ a628de1` | `engine.ts` 数据流 ①–⑤、`markSceneDone`（draft 状态回写原语，注释明言「供 sw draft 落地时复用」）、`progress.ts` 状态机、`statusReport.ts` 建议命令 |
| outline 实现 | `cursor/w3-outline-templates-5596 @ 425c44f` | `ensureOutline` 打开语义先例（确保就位 + 报告，不启动编辑器）、`outlineFile.ts` 三态探测 + 原子写先例、`expectedSceneCount` 无损往返先例、`scanProjectDisk` 场编号口径（`^(\d{3,})-.*\.md$`） |
| 错误框架 | `cursor/w2-error-framework-exit-codes-f4d4 @ e3aff95` | 注册表 v1（E010/E011/E020/E030）、`fail(code, ctx)`/`hint()`、`runCli` 退出码 0/1/2、`lint:errors` 纪律 |
| init 向导 | `cursor/w2-init-wizard-87b4 @ 4be6a21` | E031 已占用（模板不存在）、`expectedSceneCount` 写入侧 |
| doctor 实现 | `cursor/w3-doctor-3e3d @ 6fdc03c` | E013 已占用（红项聚合）、`scenesDoneCheck` 漂移检查（其修复文案待 draft 落地后更新的交接项） |
| 集成图 | `cursor/w3-integration-map-bf24 @ 43a6ecf` | §5 基分支纪律（集成完成后的功能槽一律基于集成分支头；docs 槽基于 main）、§3-⑥ expectedSceneCount 贯通（W3-PLAN-T03） |
| W1-B 路径盘点 | `cursor/w1-b-features-flows-9843 @ 9ef7ea7` | F-04/F-05、MP-01/05/06、EP-03/04/07/10、ES-04、ER 表（勘误落点） |

冲突处理沿用既定纪律：先落地者为准、追加勘误不删改他槽原文、任务/字段/错误码 ID 一经引用不复用不改义。

---

## 3. 三命令公共契约

以下条款对 SPEC-05/06 与 SPEC-04 落地一体适用，各命令小节不再重复。

1. **引擎数据流**：每条命令遵循 engine.ts 既定五步——①`loadProject` 读取校验 `project.yaml`（失败即 SW-E011/E020 或 malformed 三段式）②计算当前步骤与缺口（`scanProjectDisk` 等只读探测）③执行动作 ④`ensureStepAtLeast` 后**无变化不写盘**、有变化原子回写（temp+rename，EP-03 kill -9 安全）⑤结构化结果交渲染层输出，**末行 = 可直接复制执行的下一步命令（不含 `<占位符>`）**。
2. **错误与退出码**：错误只经 `fail(code, ctx)` 唯一入口（业务代码零 `process.exit`/`console.*`，lint 拦截）；退出码严格按 SPEC-03-EXT 三档——0 成功（含幂等式「无事可做」）、1 运行期错误（SW-Exxx）、2 用法错误（argparse 层，含旗标互斥冲突，用 commander 的 `conflicts` 实现以保持在解析层）。
3. **锁矩阵**（GAP-04 / W2-GAP-T04 落地后生效，实现前本行为空转不阻塞）：写命令 `draft`（创建/骨架/`--done`）、`export`（写 exports/ + 状态回写）、`revise`（无参数 / 带 id / `--done`）启动获取 `.sw/lock`、退出释放，占用报 `SW-E012`；只读命令 `revise --list` 不加锁（与既有 `status` 同档）。
4. **短别名**：`sw d` = draft、`sw x` = export、`sw r` = revise，**由 W2-GAP-T02 的集中别名表统一交付**，SPEC-05/06 实现槽不得散落注册（避免与别名表 lint 冲突）；本文只声明映射，不承载实现。
5. **help 纪律**：每条子命令 `--help` 含 ≥1 条可复制示例 + 尾部文档 URL（P1 §4 命令可发现性），进 W1-P1-T10 help 快照。
6. **虚假可用性禁令**：任何报告/引导文案不得引用未注册命令（对齐 W1-P1-T01 验收 ③ 与 GAP-05 过渡纪律）——引导行按命令注册表探测渐进出现（SPEC-04 引荐行同法）。
7. **场编号词汇**（draft/revise 共用）：磁盘口径沿用 `scanProjectDisk` 正则 `^(\d{3,})-.*\.md$`。CLI 入参接受 `^\d{1,3}$`（经 `padSceneId` 归一为 3 位零填充，`10` ≡ `010`）与 `^\d{4,}$`（原样）；其余形态在 draft 报 `SW-E032`、在 revise 沿用 SPEC-04「无新码」裁定报 `SW-E030`（附现有 id 清单——任何不在清单中的输入语义上就是「id 不存在」）。

---

## 4. SPEC-05 `sw draft` 场景写作命令

**目标**：落地五步主工作流第三步（F-04）。把 SPEC-02 的一行级契约（「创建/续写 `scenes/<id>-<slug>.md`；完成后把 id 记入 `progress.scenes_done`」）细化为可实现、可验收的契约；核心裁定：**「完成」由用户显式声明（`--done`），创建场文件本身不算完成**——CLI 无编辑器集成，无从推断写作何时结束；若创建即记完成，`done ≡ total`，MP-02 的 `3/5 场已完成` 语义即被摧毁。该细化登记为 SPEC-02 勘误（§9-1）。

### 4.1 CLI 接口

```text
sw draft <scene-id> [--title <t>]   # 创建（缺失时）或幂等保留（已存在时）场文件
sw draft <scene-id> --done          # 把 id 记入 progress.scenes_done（幂等）
sw d …                              # 短别名（W2-GAP-T02 集中交付）
```

- `<scene-id>` 必填；缺失属 argparse 层用法错误（退出码 2）。归一规则见 §3-7。
- `--title <t>`：仅创建时消费（决定骨架标题与文件名 slug）；场已存在时给出 `--title` 不改名不改文件（幂等保留），报告中说明「已存在，`--title` 未消费」。
- `--title` 与 `--done` 互斥（commander `conflicts`，退出码 2，零副作用）。
- `--force` 覆盖语义**不在 v1 范围**（对齐 outline 最小版先例：幂等保留先行，覆盖随后续槽定夺）。

### 4.2 行为矩阵

| # | 前置状态 | `sw draft <id> [--title]` 行为 | 退出码 |
| --- | --- | --- | --- |
| D1 | 磁盘无编号 `<id>` 的场文件 | 创建 `scenes/<id>-<slug>.md` 骨架（§4.3；原子写）→ `ensureStepAtLeast('draft')` 回写 → 报告 `created` | 0 |
| D2 | 磁盘已有编号 `<id>` 的场文件（**按编号判定**，不看 slug） | 不写任何文件（幂等保留）→ 报告 `kept` + 文件路径 + 续写引导 | 0 |
| D3 | `outline.md` 缺失或全空白 | **先自动补大纲骨架**（复用 `ensureOutline`，MP-05「跳步直达」）再执行 D1/D2，报告含「已补大纲骨架」行 | 0 |
| D4 | `--done` 且磁盘有该场文件 | `markSceneDone`（引擎既有原语，幂等：已记录则不写盘） | 0 |
| D5 | `--done` 且磁盘**无**该场文件 | `fail('SW-E030', {sceneId, existingIds})`——禁止把不存在的场标记完成，防 `scenes_done` 与磁盘漂移（EP-10 是事后修复面，本条是事前防线） | 1 |
| D6 | `<scene-id>` 形态非法（如 `abc`） | `fail('SW-E032', …)`（§7） | 1 |
| D7 | 非项目目录 / schema 不符 | 既有 SW-E011 / SW-E020 路径 | 1 |

### 4.3 场文件骨架与命名

- **文件名** = `sceneFileName(id, slug)` 既有纯函数：`<3 位编号>-<slug>.md`。slug 来源：`--title` 归一（trim → lowercase → 空白转 `-`，中文原样通过，如 `010-开场.md`）；归一后为空或未给 `--title` 时回退 `scene`（如 `020-scene.md`）。**文件名以创建时 slug 冻结**——事后改标题不触发改名，重命名属 P4 F6 结构事务（`sw move/renumber`）范围。
- **缺省标题**（无 `--title`）= `场 <id>`（如 `场 020`）——保证 status 建议的 `sw draft 020`（无旗标）可直接粘贴执行（末行可复制纪律）。
- **骨架内容由代码生成，不扩模板文件树**。理由：outline 槽已用单测锁定模板结构与变量全集（`{{title}}`/`{{expectedSceneCount}}` 两只），扩 `templates/*/scene.md` 会同时动三个模板与结构单测，属模板槽勘误范围；v1 场骨架无每-format 差异诉求，代码生成最小。骨架形态（空态三要素内嵌为 Markdown 注释，对齐 outline 先例）：

```markdown
# 场 {id}：{title}

<!-- 这里是什么：第 {id} 场的正文（scenes/{fileName}）。
     示例长什么样：
       （场景说明）雨夜，出租车内。
       张三：今天不该出门的。
     写完本场后敲：sw draft {id} --done -->
```

（台词署名语法未定案——P4 T01 风险条款，示例保持中性文本，语法 ADR 定案后只改注释文案。）

### 4.4 状态回写与 status 联动

- 创建路径：`ensureStepAtLeast(progress, 'draft')`（D3 经 `ensureOutline` 已含此语义）；**创建不写 `scenes_done`**。
- `--done` 路径：复用引擎 `markSceneDone`（内含幂等 + 步骤补齐 + 无变化不写盘）；应用层在调用前先做 D5 磁盘存在性防线（`markSceneDone` 本体不查磁盘，防线放 `src/app/workflow/draft.ts` 入口，不改引擎签名）。
- **报告末行**：D1/D2 末行 = `sw draft <id> --done`（本场的完成命令——创建后的自然下一步是写内容然后标记完成，而非立刻开下一场）；D4 末行 = `nextActionCommand(status)`（既有渲染函数，指向下一场 / export）。
- **`nextActionCommand` 的 draft 期细化**（随 T01 实现，statusReport 单测只锁结构、不锁全文，兼容既有断言纪律）：
  1. 磁盘无场 → `FIRST_SCENE_COMMAND`（既有）；
  2. 有场未标完成 → `sw draft <首个未完成编号> --done`；
  3. 全部已完成且 `total < expectedSceneCount`（字段缺省时分母退化为 `scenes_done` 长度，即视为已达，GAP-03 消费侧）→ `sw draft <suggestNextSceneId>`（既有步长 10 惯例）；
  4. 全部已完成且 `total ≥ expectedSceneCount` → 建议 `sw revise`；**revise 未注册前建议 `sw export`**（§3-6 虚假可用性禁令，切换与 W2-GAP-T01 命令注册同提交，见 §6.3）。

### 4.5 验收要点（二值）

① 空 `scenes/` 下 `sw draft 010 --title "开场"` 产出 `scenes/010-开场.md` 骨架、`project.yaml` 步骤 ≥ draft、退出码 0、末行逐字 `sw draft 010 --done`；② 同命令重复执行：场文件与 `project.yaml` 字节不变、报告 `kept`、退出码 0（EP-04）；③ `--done` 后 `scenes_done` 含该 id，重复 `--done` 后 `project.yaml` 字节不变；④ D5/D6 路径退出码 1、三段式输出、零写盘副作用（目录快照对比）；⑤ outline 缺失时 draft 自动补骨架且 `outline.md` 无 `{{` 残留（MP-05）；⑥ 写入中 kill -9 后重跑 `sw status` 状态一致（EP-03，沿用引擎原子写测试法）；⑦ `--title` 与 `--done` 同给退出码 2 且零副作用；⑧ `--help` 含 ≥1 可复制示例并进快照；⑨ `sw draft 10` 与 `sw draft 010` 行为逐字节等价（归一测试）。

---

## 5. SPEC-06 `sw export` 导出命令（markdown v1）

**目标**：落地五步主工作流第五步（F-05），使 MP-01 全链首次可产出交付物、TTFS 首次可测。**格式面按 ADR-0001 §3.6 执行：v1 只支持 markdown**（fountain 属 W1-P4-T06、pdf 属 W1-P4-T07，本文不重裁不预实现）。

### 5.1 CLI 接口

```text
sw export [--format <id>] [--out <path>]
sw x …                              # 短别名（W2-GAP-T02 集中交付）
```

- `--format`：接受 `markdown` 与别名 `md`（归一为 `markdown`）；其余值（`fountain`/`pdf`/任意串）→ `fail('SW-E033', …)`。缺省取 `settings.export.default`（引擎工厂初始值即 `markdown`，ADR-0001）；**该字段被用户改成不支持的值时同走 E033**（「怎么办」段指引改回 `project.yaml` 或显式 `--format markdown`）。
- `--out <path>`：产物文件路径（非目录），相对路径相对当前工作目录解析；父目录不存在时自动创建。缺省 `exports/<slug(title)>.md`（slug 归一规则与场文件同一实现；`exports/` 缺失时自动重建——init 会创建它，但用户可删）。

### 5.2 聚合与产物布局（markdown v1）

数据源 = 磁盘现状（`outline.md` + `scenes/*.md`），**不是** `scenes_done`——导出所见即所得，未标完成的场也导出（可跳过语义），报告提示完成度。产物结构（自上而下）：

```markdown
# {title}

> script-writer 导出 · 格式 markdown v1 · format: {format} · created: {created}

## 大纲

{outline.md 原文（首尾空白行修剪后原样，模板注释一并保留）}

## 场景

{场文件按编号升序原文拼接，场间以单行 --- 分隔；不额外生成场标题（骨架首行自带）}
```

确定性裁定五条：

1. **产物不含导出时间戳**——输出由输入内容完全决定，同输入重复导出**字节级相同**（验收可断言、产物可 git diff）。
2. `outline.md` 缺失或全空白 → 「## 大纲」节整体省略（不输出空节）；`scenes/` 无场 → 「## 场景」节整体省略。两者皆缺 → `fail('SW-E034', …)`，零产物落盘。
3. 场排序 = `scanProjectDisk` 的文件名升序口径；同编号多文件（如 `010-a.md` 与 `010-b.md`）属状态漂移（EP-10，doctor 检查面），export 不判警、按文件名升序确定性全部纳入。
4. 原文拼接**不做标题降级 / 注释剥离 / 台词格式化**——登记为 v1 已知限制，导出管线插件化（W1-P4-T06）接管后处理链。
5. 产物写入走 `writeFileAtomic`；**允许覆盖既有同名产物**——`exports/` 是派生产物目录（P1 §6.1 git-ignored），确定性重导出是刷新而非破坏，EP-04「只补缺不覆盖」适用于用户内容、不适用于派生物（边界说明登记为勘误 §9-3），故无需 `--force`。

### 5.3 状态回写与 status 联动

- 成功导出后 `ensureStepAtLeast(progress, 'export')` 原子回写（已在 export 步则无变化不写盘）。
- 报告：产物路径 + 场数与完成度（`导出 3 场（已标记完成 2/3）`）+ **`scenes_done` 未覆盖全部磁盘场时的提示行**（引导 `sw draft <id> --done` 或 revise，不阻塞导出）。末行 = 产物路径回显或 `sw status`（导出是链尾，给出可复制的收尾命令）。
- `sw status` 在 step=export 的既有建议 `sw export` 保持不变（重复导出合法、幂等刷新）。

### 5.4 验收要点（二值）

① `init --yes → outline → draft 010 → export` 后 `exports/<slug>.md` 存在、含大纲节与场景节、场序升序；② 同输入重复 `sw export` 产物**字节级相同**且退出码 0；③ `--format md` 与 `--format markdown` 产物字节相同；`--format fountain` → E033、退出码 1、零产物；④ 空项目（无 outline 无场）→ E034、退出码 1、`exports/` 无新文件；⑤ `settings.export.default` 被改为 `fountain` 时缺省导出报 E033（三段式指引改回）；⑥ `--out` 指定路径（含不存在的父目录）写入成功；⑦ outline 缺失但有场 → 大纲节省略、导出成功退出码 0；⑧ 未标完成场存在时导出成功且报告含完成度提示行；⑨ 导出后 `project.yaml` 的 step=export（从 draft/revise 进入），且已在 export 步时重复导出不改 `project.yaml` 字节；⑩ `--help` 含 ≥1 可复制示例并进快照。

---

## 6. SPEC-04 `sw revise` 对齐增补（不改写原文，实现任务仍为 W2-GAP-T01）

SPEC-04 全要点见 `docs/wave-02/P-gap-adjudication.md` §3.1，**本节只做与已实现代码的对齐增补**，供 W2-GAP-T01 承接者与本文 SPEC-05/06 同口径开工。原文与本节冲突时以原文为准并回报勘误。

### 6.1 打开语义对齐（SPEC-04「打开语义对齐 SPEC-02 `sw outline`」的落地口径）

outline 最小版已确立「打开」= **确保文件就位 + 报告路径与引导，不启动编辑器**。据此：`sw revise <scene-id>` = 校验场存在（否则 `SW-E030` 附现有 id 清单）→ `ensureStepAtLeast('revise')` 回写 → 报告场文件路径 + 修订引导 + 末行 `sw revise <id> --done`。**revise 不创建场**（创建属 draft 职责，步骤边界不重叠）。

### 6.2 `scenes_revised` 存储贯通（对齐 expectedSceneCount 往返先例）

- 落盘键 **`scenes_revised`**（snake_case，与 `scenes_done` 同风格，SPEC-04 yaml 原文即此）；领域模型 `scenesRevised: string[]`（camelCase，`parseProject.ts` 互转层负责，先例同 `scenes_done`）。
- 可选字段：缺失读作空数组（SPEC-04「缺省视为空数组」）；**序列化时空数组不写键**（空数组 ≡ 键缺失的规范化）——保证未用过 revise 的旧文件被任何命令重写后**字节稳定**，与 expectedSceneCount「往返无损」同一纪律（集成图 §3-⑥ 教训：字段贯通 `ProjectFileShape`/`parseProjectMeta`/`toProjectFileShape` 三处，缺一处即静默丢字段）。
- `recordSceneRevised` 原语进 `src/core/model/progress.ts`（对齐 `recordSceneDone`：trim、幂等、排序、返回新对象）；schema 仍为 1。

### 6.3 status 修订期口径切换（与命令注册同提交）

引擎分支现状有两处以 `sw draft <id> --force` 充当修订建议的占位：`status.ts` 的 `STEP_COMMANDS.revise` 与 `statusReport.ts` 的 `nextActionCommand` revise 分支。W2-GAP-T01 落地时**在注册 `sw revise` 命令的同一提交内**把两处切换为 `sw revise`（无参数，输出修订清单）——早切是虚假可用性（§3-6），晚切是文案漂移。revise 期建议命令细化：有未修订场 → `sw revise <首个未修订 id>`；`scenes_revised` ⊇ `scenes_done` → `sw export`（SPEC-04 完成判定，按 id 集合比较）。draft→revise 的建议时机由 §4.4-4 承接（分母 = `expectedSceneCount`，GAP-03 消费侧）。

### 6.4 修订清单的取数面

清单（每场：id、标题、未修订/已修订）标题来源 = 场文件首行 `# ` 标题的轻量解析（读首行即可，不引入 P4 T01 内容索引层依赖——对齐 SPEC-04「与 P4 互相引荐而不硬依赖」；T01 落地后切换取数面登记为对齐点，接口不变）。`--list` 纯只读：不写盘、不加锁、输出稳定可供脚本消费。无参数 `sw revise` 在输出清单外把步骤补齐到 revise（写路径，见 §3-3 锁矩阵）。

---

## 7. 错误码与空态汇总

### 7.1 编号占用核对（2026-08-27 全分支实测）

E010（init 目录非空）、E011（非项目）、E012（**GAP-04 预留**：锁占用，勿挪用）、E013（**doctor 已占用**：红项聚合）、E020（schema）、E030（场 id 不存在）、E031（**init 已占用**：模板不存在）、E040/E041（AI 段，未登记）。**本文预留 E032/E033/E034**；预留 ≠ 登记——注册表登记仍按 SPEC-03「禁止预填未用码」纪律，随首个触达用例在实现提交内完成（`registry.ts` + `gen:errors` + `lint:errors` 同提交），本表只锁编号防并行槽撞号。

### 7.2 新码规格（三段式要点，供登记时成文）

| 码 | 段位 | 触发 | 「怎么办」段要点 | 登记提交 |
| --- | --- | --- | --- | --- |
| SW-E032 | E03x 输入校验 | `sw draft <id>` 的 id 非 `^\d{1,3}$` / `^\d{4,}$` 形态（§3-7） | 给出合法形态示例（`sw draft 010`）+ 现有 id 清单（ctx 复用 existingIds 形态） | W3-DRAFT-T01 |
| SW-E033 | E03x 输入校验 | `--format` 或 `settings.export.default` 非 markdown/md | 指明 v1 仅 markdown；fountain 属 W1-P4-T06、pdf 属 W1-P4-T07（规划中，不承诺时点）；给 `sw export --format markdown` 可复制命令 | W3-DRAFT-T02 |
| SW-E034 | E03x 输入校验 | export 时 outline 缺失/空白 **且** 无任何场文件 | 空态错态合一（ES-05 先例）：引导 `sw outline` 与 `sw draft 010 --title "开场"` 两条可复制命令 | W3-DRAFT-T02 |

既有码在三命令中的触达矩阵：E011/E020（三命令共通，loadProject 层）；E030（draft `--done` 不存在场 §4.2-D5、revise 引用不存在场 §6.1——revise 侧维持 SPEC-04「无新码」裁定）；E012（GAP-04 落地后按 §3-3 锁矩阵触达）。

### 7.3 空态位点

- `scenes/` 空 × revise → **ES-07**（SPEC-04 已登记，`hint()` 引导 `sw draft`；错误框架已在集成分支，无前置缺口）。
- `scenes/` 空 × export → **不是新空态位点**：与 outline 同缺时是错态 E034（§5.2-2）、仅 scenes 空时导出大纲照常成功。ES-04（`exports/` 空）维持 W1-B 原结论——由 status 在 export 步建议导出命令承接，无独立空态。
- `scenes/` 空 × draft → 非空态（draft 正是创建第一场的命令），空 scenes 下的引导由 status 的 `FIRST_SCENE_COMMAND` 既有实现承接（ES-01）。

---

## 8. 引擎步骤映射与文件面（供任务「文件范围」引用）

### 8.1 三命令 × 引擎数据流

| 数据流 | draft（SPEC-05） | export（SPEC-06） | revise（SPEC-04，W2-GAP-T01） |
| --- | --- | --- | --- |
| ① 读取校验 | `loadProject`（既有） | `loadProject`（既有） | `loadProject`（既有） |
| ② 缺口计算 | `scanProjectDisk` + 场文件探测（新 `sceneFile.ts`）+ outline 三态（既有 `outlineFile.ts`） | `scanProjectDisk` + outline 读取 + 场文件全量读取 | `scanProjectDisk` + `scenes_done`/`scenes_revised` 差集 |
| ③ 执行动作 | 骨架渲染 + 原子写（D1）/ 无操作（D2）/ `ensureOutline` 前置（D3） | 聚合纯函数 `renderMarkdownExport`（零 IO）→ 原子写产物 | 清单渲染 / 路径报告 / 记录修订 |
| ④ 状态回写 | `ensureStepAtLeast('draft')`；`--done` 走 `markSceneDone`（既有） | `ensureStepAtLeast('export')` | `ensureStepAtLeast('revise')`；`--done` 走新 `recordSceneRevised` |
| ⑤ 渲染输出 | `draftReport.ts`（末行规则 §4.4） | `exportReport.ts`（完成度提示 §5.3） | SPEC-04 清单 + 引荐行 |

### 8.2 新增/触碰文件清单（全部基于集成分支头，禁止从单个 W2 分支分叉——集成图 §5）

- **infra**：`src/infra/store/sceneFile.ts`（场文件探测 + 原子写，对齐 `outlineFile.ts` 形态）；export 产物写入复用 `atomicFile.ts`（不新建模块）。
- **app**：`src/app/workflow/draft.ts` + `draftReport.ts`；`src/app/workflow/export.ts`（IO 编排）+ `exportRender.ts`（聚合纯函数，零 IO——**不新建 core 顶层目录**，「新增顶层目录须有 ADR」纪律）+ `exportReport.ts`；`statusReport.ts` 的 draft/revise 期建议细化（§4.4-4 / §6.3）。
- **cli**：`src/cli/commands/draft.ts`、`src/cli/commands/export.ts`；`program.ts` 挂载 + 路线图行改「可用」（诚实进度先例）。
- **errors**：`registry.ts` 登记 E032/E033/E034 + `docs/errors/` 生成（各自实现提交内，§7.1）。
- **core**：`progress.ts` + `recordSceneRevised`、`project.ts`/`parseProject.ts` + `scenesRevised` 往返（属 W2-GAP-T01 文件范围，此处只标注不重复立项）。
- **doctor 交接**：draft 落地后更新 `checks.ts` 的 `scenesDoneCheck` 修复文案（doctor 槽 §5 既有交接项，随 W3-DRAFT-T01 顺手完成）。

---

## 9. 对齐点与勘误登记（append-only，不改写他槽原文）

合并者按下表回写；回写前，本表即勘误的权威记录。

| # | 对象文档（分支） | 勘误/对齐内容 | 来源 |
| --- | --- | --- | --- |
| 1 | P1 §7 SPEC-02 draft 契约行 | 「完成后把 id 记入 progress.scenes_done」细化为：创建与完成两动作分离，完成 = 显式 `sw draft <id> --done`（幂等）；创建不记 `scenes_done` | §4 裁定 |
| 2 | P1 §7 SPEC-02 export 契约行 / MP-06（W1-B §4.2） | `--format fountain\|md\|pdf` 的可用集 v1 收敛为 markdown（ADR-0001 §3.6 既定的命令面落实）；不支持值报 E033 | §5.1 |
| 3 | W1-B §4.3 EP-04 | 追加边界注记：「只补缺不覆盖」适用于用户内容；`exports/` 派生产物允许确定性覆盖（重复导出 = 幂等刷新，无需 `--force`） | §5.2-5 |
| 4 | W1-B §4.5 ER 表 | 追加 SW-E032（draft 场编号非法，EP 触发路径：本文 §4.2-D6）、SW-E033（导出格式不支持，触发：§5.1）、SW-E034（无可导出内容，触发：§5.2-2）；责任任务 W3-DRAFT-T01/T02 | §7 |
| 5 | engine 分支 `status.ts`/`statusReport.ts` | revise 期建议命令 `sw draft <id> --force` 为占位，W2-GAP-T01 注册 `sw revise` 的同一提交内切换（§6.3）；draft 期建议按 §4.4-4 细化（随 W3-DRAFT-T01） | §4.4/§6.3 |
| 6 | `templates/README.md`（outline 槽） | 追加一句：v1 场文件骨架由代码生成，模板不含 `scene.md`；如后续按 format 差异化场骨架，属模板结构勘误（需同步结构单测与变量全集单测） | §4.3 |
| 7 | SPEC-04（w2-gap §3.1） | 增补三点（原文不动）：打开语义落地口径 §6.1；`scenes_revised` 空数组不落键 §6.2；draft→revise 建议阈值消费 `expectedSceneCount` §4.4-4/§6.3 | §6 |

---

## 10. 测试验收总表（实现槽的完成定义）

1. **单命令验收**：§4.5 ①–⑨（draft）、§5.4 ①–⑩（export）逐项二值通过；revise 按 SPEC-04 验收 ①–⑤ + §6 增补（`scenes_revised` 空数组不落键往返断言、`--list` 零写盘断言、建议命令切换与注册同提交的历史核查）。
2. **主链 e2e（W3-DRAFT-T03）**：`sw init --yes` → `sw draft 010 --title "开场"` → `sw draft 010 --done` → `sw export`（4 条命令，outline 由 D3 自动补齐——MP-05）产出 `exports/*.md`，进程级断言每步退出码 0 且每步末行可整行粘贴为下一步；TTFS ≤ 5 条命令达标（P1 §4，W1-P1-T10 基准雏形）。**跳过 revise 直接 export 合法**的回归断言（SPEC-04 可跳过条款）。
3. **退出码冒烟**：三命令各至少一例进 `smoke:exit-codes`（0/1/2 三档全覆盖：幂等成功 0、SW-Exxx 1、旗标冲突或缺参 2）。
4. **注册纪律**：`lint:errors` 全绿（E032/E033/E034 登记与首个触达用例同提交、`docs/errors/` 生成物提交、无未注册码字面量）。
5. **CI 门不可降标**：`lint / lint:errors / typecheck / test / build / smoke / smoke:exit-codes` 全绿 0 跳过；**测试只增不减、断言只迁移不删除**（statusReport 建议细化允许改写期望文案，不允许删断言——集成图既定纪律）。
6. **GAP-04 落地后的回归**（时序上后置，不阻塞 T01/T02）：三命令写路径受锁（双进程并发后者 E012）、`revise --list` 在锁被持时可执行。

---

## 11. 交接与阻塞

- **给实现槽（W3-DRAFT-T01/T02/T03 承接者）**：基分支一律取集成分支头（集成图 §5 纪律，禁止从 scaffold 或单个 W2 分支分叉）；T01/T02 可并行（文件面仅 `program.ts` 挂载行相邻，冲突面 ≤ init×engine 先例的并集解法）；开工前确认 W3-PLAN-T02 已交付（error+engine+init 归一，`fail()`/存储正典就位）、W3-PLAN-T03 已贯通 `expectedSceneCount`（§4.4-4 的分母消费依赖它）。
- **给 W2-GAP-T01 承接者（revise）**：SPEC-04 原文为准 + 本文 §6 增补为对齐口径；与 W3-DRAFT-T01 有一处顺序耦合——§4.4-4 的「建议 `sw revise`」分支在 revise 未注册时必须落 `sw export`，两任务先后交付均不破坏该断言（渐进增强测试法，SPEC-04 验收 ④ 同型）。
- **给 W2-GAP-T02 承接者（别名）**：`sw d`/`sw x`/`sw r` 三只映射以本文 §3-4 与 SPEC-04 声明为全集来源，集中表交付后 draft/export/revise 的 help 快照补别名断言。
- **给合并者**：本分支三文件全部新增（`spec-draft-export-revise.md`、`ready-tasks.md` 仅 WAVE03-DRAFT 分区、回执仅本槽一节），按既定并集约定收编（集成图 §4 第 4 梯队同法）；`docs/README.md` 索引行见文首。
- **阻塞**：无新增。本文全部契约以集成分支交付（W3-PLAN-T01…T03）为前置，属正常任务依赖非阻塞；E032–E034 编号预留已核对无撞号（§7.1），若并行槽在本文合并前占用了这三只编号，以先登记进注册表者为准、本文顺延并追加修订记录。

---

*W3 计划槽产出 · 分支 `cursor/w3-spec-draft-export-revise-193d` · 基线 `main @ deda75a` · 引用锚点见 §2 · SPEC-05/06 编号自本文启用（SPEC-01/02/03 属 P1 §7、SPEC-03-EXT 与 SPEC-04 属 w2-gap §3，无撞号）*
