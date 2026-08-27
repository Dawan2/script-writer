# W2 工作槽：实现 SPEC-01 `sw init` 向导（W1-P1-T04）

| 项目 | 内容 |
| --- | --- |
| 波次 / 槽位 | 第 2 波 / 周期 W2 / 工作槽「实现 W1-P1-T04 SPEC-01 sw init 向导」 |
| 仓库 | github.com/Dawan2/script-writer |
| 基线 | `cursor/w2-scaffold-ci-ccbf @ 9f61b37`（脚手架 + CI，含 ADR-0001 与 wave-01 文档合并） |
| 工作分支 | `cursor/w2-init-wizard-87b4`（已 push，未开 PR） |
| 完成任务 | W1-P1-T04（SPEC-01 `sw init` 向导）；一并落地 GAP-03 `expectedSceneCount`（写入侧）与 GAP-06 退出码约定（接口层） |
| 执行依据 | P1 方案 §7 SPEC-01；ADR-0001 §3.6 勘误（默认导出 markdown）；W2 GAP 裁决 §3.3（GAP-03）/§3.6（GAP-06 SPEC-03-EXT），见 `cursor/w2-gap-adjudication-c82d @ 661b313` |

---

## 1. 做了什么

### 1.1 四层落点（消费脚手架既有词汇，未另起炉灶）

| 层 | 文件 | 职责 |
| --- | --- | --- |
| core | `src/core/model/project.ts`（扩展） | `ProjectMeta` 顶层可选字段 `expectedSceneCount`（GAP-03，正整数校验）；`CreateProjectMetaInput` 增 `expectedSceneCount`/`aiEnabled`；新增常量 `DEFAULT_EXPECTED_SCENE_COUNT = 5` |
| app | `src/app/workflow/init.ts`（新增） | 向导编排：四问计划（`planQuestions`，--yes/旗标跳问）、答案解析纯函数（序号/格式名、正整数、y/n，无法识别即重问）、模板解析与回退、SPEC-01 数据流（收集答案 → 模板渲染 → 原子写入） |
| app | `src/app/errors/sw-error.ts`（新增） | SW-Exxx 最小载体 + 三段式渲染（发生了什么/为什么/怎么办）。**暂行版**：文件头以 TODO 标记 W1-P1-T06 迁移义务（并入注册表 + `fail()`；`docs/errors/` 锚点在生成器就位前不印死链） |
| infra | `src/infra/store/projectFile.ts`（新增） | `serializeProjectMeta`（schema v1 全文，`scenes_done` 蛇形与 `expectedSceneCount` 驼峰按 GAP-03「引用后不改义」原样并存）；`inspectDir` 四态；`materializeProjectDir` 原子写 |
| infra | `src/infra/store/templates.ts`（新增） | 模板树读取（`gitignore` → `.gitignore` 映射，防污染本仓库忽略规则）与 `{{key}}` 占位渲染（未知占位原样保留） |
| cli | `src/cli/commands/init.ts`（新增） | 旗标全集（SPEC-01 签名 + 补 `--scenes`/`--ai`/`--no-ai`/`--force`，「所有问题都有对应旗标」）；readline 行缓冲适配（管道输入先于提问到达不丢答案；**EOF = 接受默认值**，管道/CI 不挂起）；`--help` 含 3 条可复制示例 |
| cli | `src/cli/run.ts`（新增）、`main.ts`/`program.ts`（改） | 顶层唯一退出码裁定点（GAP-06）：0 成功 / 1 运行期 SW-Exxx / 2 用法错误；`exitOverride` 在注册子命令前设置以被继承；业务代码零 `process.exit`；`buildProgram(io)` 支持流注入（T04 风险项「可注入 stdin 便于自动化测试」的落点） |
| templates | `templates/short-video/`（新增，首个模板） | `outline.md`（`{{title}}`/`{{expectedSceneCount}}` 占位 + 空态三要素注释，未实现命令均标注交付任务）、`characters/`、`scenes/`、`gitignore`（exports/ 不入库） |

### 1.2 向导行为（SPEC-01 对照）

- **四问**：①标题（默认=目标目录名）②脚本类型（`[1] screenplay [2] short-video [3] podcast`，默认 short-video）③预计场数（默认 5）④AI 辅助（默认否）。每问显示默认值，回车即接受；无法识别的输入提示后**重问同一问题**（问题总数不超过 4）。
- **`--yes` / 旗标跳问**：`--yes` 全默认零交互；`--title/--format/--scenes/--ai|--no-ai` 提供的问题自动跳过；`--yes` 模式的默认值 5 **显式写入** `expectedSceneCount`（GAP-03「文件自解释」要求）。
- **错态**：目标目录非空且无 `--force` → `SW-E010` 三段式（附 `sw init <dir> --force` 及其后果：同名脚手架文件覆盖、其余保留）；目标是文件同报 `SW-E010`；`--template` 指向不存在模板 → `SW-E031`（附可用模板列表）。两码均有触达用例，非预填。
- **原子写**：目标缺失 → 临时目录写完后整目录 rename（完全原子）；目标为既有空目录 → 逐顶层条目 rename（不 rmdir 目标，避免其为进程 cwd 时的悬挂）；`--force` → 逐文件「临时文件 + rename」原子覆盖。失败路径清理临时目录，无 `.sw-init-*` 残留（有测试断言）。
- **产出布局**（与 P1 §6.1 一致）：`project.yaml` + `outline.md` + `characters/` + `scenes/` + `exports/` + `.gitignore`。
- **退出码实测**：成功 0；`SW-E010`/`SW-E031` 为 1；`--format novel`、`--scenes 0`、未知旗标为 2（用法错误未进入业务逻辑，无落盘副作用——有测试断言）。

### 1.3 模板解析规则（对 T07 的前向兼容）

默认模板 id 跟随脚本类型；专属模板未内置时回退 `short-video` 通用骨架并在摘要中如实标注（「screenplay/podcast 专属模板随 W1-P1-T07 交付」）。T07 落地 `templates/{screenplay,podcast}/` 后，同名解析自动生效，**本槽代码无需改动**。

## 2. 如何跑测试（本地复现）

```bash
git clone https://github.com/Dawan2/script-writer.git
cd script-writer
git checkout cursor/w2-init-wizard-87b4
npm ci               # Node ≥ 20
npm run lint && npm run typecheck && npm test && npm run build && npm run smoke
# 手工验证：
node dist/cli/main.js init /tmp/demo --yes && cat /tmp/demo/project.yaml
printf '我的短片\n3\n8\ny\n' | node dist/cli/main.js init /tmp/wizard
node dist/cli/main.js init /tmp/demo --yes; echo $?   # SW-E010，退出码 1
node dist/cli/main.js init /tmp/x --format novel; echo $?   # 用法错误，退出码 2
```

本槽实测（2026-08-27，Node v22.14.0）：lint ✅ 零警告；typecheck ✅；**test ✅ 69 passed（9 文件），0 失败、0 跳过**（基线 21 条全保留，新增 48 条覆盖 init 全路径）；build ✅；smoke ✅；另以 `script` 伪终端验证 TTY 交互、以 `/dev/null` 重定向验证 EOF 全默认路径、实测退出码 0/1/2。

## 3. 验收对照

### 3.1 SPEC-01 验收要点

| 验收 | 结果 |
| --- | --- |
| 全流程 ≤ 4 问 | 通过：`planQuestions` 结构上恰四问，重问不增加问题数（`tests/app/init.spec.ts` 断言） |
| `--yes` 模式零交互跑通 | 通过：零提问断言 + project.yaml 逐字节断言（`tests/cli/init.spec.ts`） |
| 生成目录结构与 §6.1 布局一致 | 通过：目录清单断言（app 与 cli 两层各一条） |
| 重复 init 幂等（报错不破坏现场） | 通过：第二次 `SW-E010`，project.yaml 字节不变、既有文件原样（app/cli 两层断言） |
| 目录非空无 --force 报 SW-E010 并提示 --force 后果 | 通过：三段式含「怎么办」与 `--force` 后果说明 |
| 原子写入（临时目录 + rename） | 通过：三种目标状态各有落位测试 + 无临时残留断言 |

### 3.2 GAP 裁决对照

| 裁决 | 结果 |
| --- | --- |
| GAP-03 `expectedSceneCount` | **写入侧完成**：交互与 `--yes` 两模式均写入且值正确（W2-GAP-T03 验收 ①）；字段在类型上可选（验收 ② 的读取侧与验收 ③ status 分母属 W1-P1-T05，未在本槽虚报完成） |
| GAP-06 退出码 0/1/2 | **接口层完成**：顶层 catch 唯一裁定点、业务代码零 `process.exit`、已注册错误码触达用例断言 =1、用法错误断言 =2 且无副作用（W2-GAP-T06 的 lint 拦截项仍归其任务承接） |

## 4. 与规格的偏差（如实登记）

1. **成功摘要末行**：SPEC-01 原文为「输出成功摘要 + 下一步命令（`sw status`）」。`sw status` 属 W1-P1-T05 未实现，按「禁止虚假可用性承诺」纪律，末行暂为「编辑 `<dir>/outline.md` 写大纲（`sw status` 引导随 W1-P1-T05 交付）」，代码处已留 TODO(W1-P1-T05) 切换点。
2. **错误框架**：T06 未落地，`SwError` 为暂行载体（三段式已按 SPEC-03 模板渲染，`docs/errors/` 锚点在生成器就位前不印死链）；`src/app/errors/sw-error.ts` 文件头登记迁移义务。
3. **新码 `SW-E031`**（模板不存在，E03x 输入校验段位）：由 `--template` 校验用例实际触达，符合「非预填」纪律；请 T06 建注册表时收录（连同既有触达码 `SW-E010`）。

## 5. 给后续槽位的交接

- **W1-P1-T05（引擎）**：`project.yaml` 由 `serializeProjectMeta` 产出（v1 全文样例见 `tests/infra/projectFile.spec.ts` 首条用例）；解析/校验器属 T05 范围（建议引入 YAML 解析依赖，本槽写侧为确定性模板故未引入）；落地后请：① init 摘要末行切回 `sw status`（TODO 已标）；② `sw`（无参数）改为等价 `sw status`（`program.ts` 注释已标）；③ status 分母消费 `expectedSceneCount`（缺省退化为 `scenes_done` 长度，GAP-03）。
- **W1-P1-T06（错误框架）**：迁移 `sw-error.ts` 进注册表 + `fail()`；已触达码 `SW-E010`/`SW-E031`；退出码裁定点已在 `src/cli/run.ts` 收口，`fail()` 渲染接上即可。
- **W1-P1-T07（模板库 v1）**：新增 `templates/{screenplay,podcast}/` 即自动被解析（§1.3）；模板文件树约定见 `templates/README.md`（`gitignore` 命名映射）。
- **W2-GAP-T02（别名/help --all）**：init 已注册为 commander 子命令，可直接进命令注册表全集。
- **阻塞**：无新增。BLK-W1-02（模型凭据）未动，与本槽无关（AI 问答仅落 `settings.ai.enabled` 布尔，未接任何供应商）。
