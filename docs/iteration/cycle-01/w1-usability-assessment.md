# W1 功能易用性：现状判断与架构级迭代方案

| 项目 | 内容 |
| --- | --- |
| 里程碑 | 周期 1 / 第 1 波 / W1 架构与方案 |
| 槽位 | 计划槽 · 功能易用性 |
| 仓库 | github.com/Dawan2/script-writer |
| 检查基线 | `main @ abb779e`（虎鲸｜剧本出海工作站：Next.js 前端 + FastAPI 后端 + Claude Code Agent 子项目） |
| 工作分支 | `cursor/w1-usability-architecture-058e` |
| 配套文档 | [就绪任务与验收标准](./w1-usability-backlog.md) |
| 本槽范围 | 只出方案与核验清单，不做大范围代码改动 |

---

## 1. 结论先说

产品已经是一个**成熟度不低的真实系统**：9 个创作阶段、6 种任务场景、额度与并发管控、权限与回收站、文档评论、版本历史、批量任务、管理台。界面文案的绝大部分（331 条服务端提示中的 298 条）已经是中文用户视角，交互禁用态还配了逐条解释性 tooltip，这是明显高于平均水平的基础。

问题不在"缺功能"，而在**同一件事有多套做法**：错误提示有 4 种承载（全局横幅 `workspace/page.tsx:2152`、组件内联 `new-project-form.tsx:511`、管理台提示条 `admin-console.tsx:129`、弹窗各自的局部状态），弹窗可达性分 3 档（第 4.5 节表），加载态只有 1 种粒度却被用在所有场景。易用性缺口因此集中在三个结构性位置：

1. **错误与会话**——33 条纯英文工程文案直达用户界面（`Unknown stage`、`Session expired`），前端已经出现"用字符串匹配翻译错误信息"的补丁（`landing-page.tsx:683`），说明缺少"错误码 → 用户文案"的契约层。
2. **未保存内容会静默丢失**——切换阶段文件不校验草稿、全库没有离开页面守卫，编辑长剧本的核心场景存在真实的数据丢失路径。
3. **长任务与加载反馈**——单次生成动辄 15–90 分钟，界面却只有写死的估时和轮换的趣味文案；后端已经在发进度事件，前端把它们当普通日志显示。

本文给出 6 项架构级统一决策（第 5 节）和 17 项可独立领取的就绪任务（见配套 backlog）。

---

## 2. 已有成果核对与裁定

远端存在 26 个历史分支（w1-\* / w2-\* / w3-\* / w4-\*），其中 `cursor/w1-p1-usability-architecture-5d0e` 与本槽同名。已逐一核对：

**这些分支全部基于 `deda75a Initial commit`（空仓）**，与当前 `main @ abb779e`（真实产品）不在同一条历史上。它们的正文自述"全库仅一个文件 README.md"，并在假设 A1–A4 中把产品定义为"TypeScript CLI 工具 `sw`，Web UI 作为第二形态"。当前产品实际是 Next.js + FastAPI 的 Web 工作站，Agent 用 Claude Code 子项目承载。

因此裁定：

| 历史成果 | 裁定 | 理由 |
| --- | --- | --- |
| 七维度易用性检查框架（信息架构/路径/空错态/快捷操作/心智负担/文档可发现性/配置成本） | **复用** | 与产品形态无关，本文沿用并补充"可达性"与"功能缺口"两维 |
| 可度量易用性指标的思路（错误自解释率、空态覆盖率、文档三跳可达） | **复用** | 已转化为本方案第 6 节的核验门槛 |
| `sw` 命令规格、init 向导、doctor、退出码框架、文件锁规格、CLI help 与短别名 | **作废** | 目标产品无 CLI，这些规格没有落地对象 |
| 基于空仓的"功能清单 F-01…13 / 主路径 MP×6 / 空态 ES×6" | **作废** | 描述的是虚构产品，与真实 9 阶段流程不对应 |
| `docs/evidence/` 证据与 CI 约定、脱敏五条 | **待定，建议保留** | 与产品形态无关的工程约定，但需由集成槽核对后再并入 `main` |

> **给调度器的处理建议**：不要把上述分支的 `docs/wave-01/` 与 `docs/errors/` 直接并入 `main` 当作产品基线，否则后续工作槽会按不存在的 CLI 去实现。建议由一个集成槽单独裁定"保留证据约定 / 归档其余内容"，本槽不代为处置他人分支。

本槽产出为**基于真实代码的全新检查**，不重做上述任何有效成果。

---

## 3. 检查方法与覆盖范围

- **代码走查**：`apps/web/src` 全量（132 个文件，约 41200 行），`apps/api/app/routers` 与 `app/services` 的用户可见错误路径，`Agents/skills` 的用户可见输出约定。
- **取证方式**：每条发现都锚定到 `文件:行号` 或可复现的统计命令，便于实现槽验证与后续回归。
- **未覆盖**（交由其他槽或后续核验）：真机浏览器实测（本槽无运行环境凭据）、对比度数值实测、Agent 生成内容质量、额度与计费模型合理性。

覆盖维度与结论概览：

| 维度 | 现状 | 主要缺口数 |
| --- | --- | --- |
| 信息架构 | 中 | 3 |
| 关键用户路径 | 偏弱（含数据丢失路径） | 4 |
| 空态 / 错态 / 加载态 | 偏弱 | 5 |
| 文案 | 中（中文覆盖好，工程黑话残留成片） | 4 |
| 可达性 | 中下（同类组件水平不齐） | 4 |
| 学习成本 | 偏弱（产品内零引导） | 3 |
| 功能缺口 | 中 | 5 |

---

## 4. 现状发现（逐条带证据）

### 4.1 信息架构

**IA-1 顶层导航只藏在头像菜单里，且存在一个已死的导航组件。**
工作台 / 偏好 / 批量任务 / 管理台之间的跳转全部收在左下角头像菜单（`components/workspace/project-list.tsx:430-460`）。同时 `components/workspace/top-nav.tsx` 全库无任何引用（死代码），其内部还有三处会误导用户的实现：铃铛按钮 `aria-label="通知"` 但没有点击行为、头像按钮 `aria-label="用户菜单"` 实际点击直接退出登录、默认头像首字写死为 `"赵"`。`lib/mock-data.ts` 同样无引用。

**IA-2 6 种场景 × 9 个阶段的流程规则没有单一出处，用户也看不到全貌。**
阶段可运行性、需人工确认的阶段、归档前置条件分散在 `app/workspace/page.tsx:74-87` 的常量、`primaryStageActionState()` 的分支、以及 `components/workspace/file-rail.tsx:264-500` 的场景判断中。用户侧只有一条线性文件栏，看不到"我这个场景要走哪几步、当前在第几步、后面还有什么"。上游变更导致下游失效（`stale`）只体现在一行状态文字"上游已变更"。

**IA-3 检索只覆盖项目名。**
`project-list.tsx:680` 的搜索框限定"搜索项目名称"，无法按剧本内容、角色名、集数检索，也没有跨项目的全局搜索入口。对一个会累积几十个长剧本项目的工具，这是明显的规模天花板。

### 4.2 关键用户路径

**P-1 未保存的修改会静默丢失（最高优先级）。**
`app/workspace/page.tsx:1435-1450` 的 `handleSelectFile()` 直接 `setDraft(nextDocument.content)`，不检查 `dirty`；点击文件栏另一个阶段就会覆盖草稿，没有任何确认。全库检索无 `beforeunload` 监听，关闭标签页或从头像菜单跳到 `/preferences` 同样静默丢弃。系统在"推进阶段""归档""恢复版本"这些动作上都正确地做了 dirty 拦截，唯独漏掉了最频繁的"切换文件"和"离开页面"。

**P-2 会话过期后用户被英文卡住。**
`apps/api/app/dependencies.py:54-64` 返回 `Not authenticated` / `Invalid token` / `Inactive user` / `Session expired`；`apps/api/app/core/config.py:15` 设置有效期 7 天。前端 `lib/api-client.ts` 没有任何状态码分支，401 会被当作普通错误显示原文。结果是：长期使用的用户某天回到工作台，所有操作都提示英文 `Session expired`，界面上没有重新登录入口，此时未保存的编辑也一并处于风险中。

**P-3 新建任务这条首次路径有四处摩擦。**
`components/workspace/new-project-form.tsx`：项目名由文件名推导且以隐藏字段提交（`:318`），创建时无法修改，只能事后在项目列表重命名；无文件时回落为"未命名剧本"（`:159-162`）。`handleDrop()`（`:307-312`）不做类型与大小校验，`accept` 属性对拖拽无效，用户拖入图片会在上传结束后才收到服务端的"源文件格式不正确"。上传走 `fetch` + `FormData`，整本小说（EPUB/PDF）没有上传进度。提交按钮的禁用原因写在 `title` 里（`:420`），且 `hasRequiredInput` 把 `!busy` 也算进去，提交过程中 tooltip 会显示"请先完成必要输入"这种不成立的说法。

**P-4 切换文件会把整个工作台替换成全页加载。**
`app/workspace/page.tsx:686`：`pageLoading = !userLoaded || ... || contentLoading`。`contentLoading` 是"正在读取某个阶段文件"，一旦为真，`:2204` 就用 `<PageLoading variant="workspace" label="正在加载工作台" />` 顶掉整个中间区，项目列表、文件栏、Agent 面板全部消失，文案还说"正在加载工作台"。用户每点一次文件栏都会经历一次上下文丢失。

### 4.3 空态 / 错态 / 加载态

**S-1 主编辑区空态只有一行标题。**
`app/workspace/page.tsx:2298-2300`：`<section class="empty-document"><h1>选择或新建一个创作项目</h1></section>`。没有说明、没有"新建任务"按钮，也没有指向操作手册。这是新用户登录后最可能看到的第一屏。

**S-2 "筛选无结果"和"真的没有项目"用同一句话。**
`components/workspace/project-list.tsx:830` 只按 `projectView` 分支输出"暂无进行中项目 / 暂无已归档项目"。用户输入搜索词或开了场景/进度筛选后看到同一句话，会误判为项目丢失，且没有"清空筛选"的出口。

**S-3 错误提示是一条会自己消失的横幅，且大量透传服务端原文。**
`app/workspace/page.tsx:2151-2167`：全局单条 `error-banner`，`role="status"`（礼貌级，读屏软件可能不及时播报错误）、带倒计时自动关闭、没有"重试"动作。页面内共 77 处 `setError`，其中相当一部分形如 `setError(err.message)`（如 `:916`、`:1174`、`:2182`、`:2195`），把服务端 `detail` 原样呈现。同一时刻只能显示一条，后一个错误会覆盖前一个。

**S-4 文件加载失败时界面什么都不说。**
`handleSelectFile()` 只有 `try/finally`、没有 `catch`，而调用点是 `void handleSelectFile(file)`（`:2373`）。`getFile` 抛错时变成未处理的 Promise 拒绝：选中态已经切走，内容还是上一个文件的，用户得不到任何提示。

**S-5 长任务没有真实进度。**
`app/globals.css` 中没有任何进度条相关样式；Agent 面板没有"已用时长/剩余时间"的显示。唯一的时间信息来自写死的静态估时 `src/config/agent-loading-estimates.json`（小说解读 90 分钟、完整剧本 40 分钟），配 `components/ui/agent-loading-message.tsx` 每 3 秒轮换一句趣味文案。而后端其实已经在发 `novel_reading_plan` / `novel_reading_checkpoint` / `novel_reading_progress` / `novel_arc_progress` 等进度事件（`components/workspace/agent-panel.tsx:15-28`），前端只把它们当普通日志文本铺在活动列表里（`:310`、`:544`）。90 分钟的任务里，用户无法判断"它到哪了、还要多久、是不是卡住了"。

### 4.4 文案

**C-1 33 条纯英文工程文案直达用户界面。**
统计命令：`rg -o 'detail="[^"]*"' apps/api/app/routers/*.py apps/api/app/services/*.py | rg -v '[\x{4e00}-\x{9fff}]'`。结果：`Unknown stage` × 12、`Stage file not found` × 7、`Unsupported stage` × 2、`Unsupported stage for review task` × 2，以及 `Unsupported task type`、`Unsupported stage for translation task`、`Unsupported file type`、`Unknown delivery stage`、`Project not found`、`Progress file not found`、`Job not found`、`Job already finished`、`Invalid workspace path`、`Incorrect username or password` 各 1。`lib/api-client.ts:51-52` 的 `apiErrorMessage()` 对字符串 `detail` 原样返回，这些内容会出现在错误横幅里。

**C-2 界面文案靠匹配后端字符串拼出来，共 5 处。**
`components/home/landing-page.tsx:683`：
```ts
setLoginError(message.includes("Incorrect username or password") ? "账号或密码不正确" : message);
```
`components/workspace/agent-panel.tsx:553-556` 是同一类做法，用匹配事件文本（`Agent 任务已启动`、`计划执行`、`正在开始处理当前内容`、`已同步当前阶段进度`）来决定界面上显示哪句话。

这类补丁本身就是缺少契约的证据：每新增一条需要改写的文案，就要在前端加一次字符串匹配；后端或 Agent 改动措辞会静默破坏界面显示，且不会有任何测试报警。

**C-3 兜底文案把 HTTP 状态码暴露给用户。**
`lib/api-client.ts:72`：`return \`请求失败（${status}）\`;`。用户看到"请求失败（409）"，既不知道发生了什么，也不知道下一步做什么。

**C-4 Agent 活动列表暴露工具名、文件路径和模型名。**
`components/workspace/agent-panel.tsx`：`准备使用 ${block.name}`（`:252`）、`正在使用 ${tool.name}：${detail}`（`:278`，`detail` 取自 `file_path` / `command` / `pattern`，见 `:212-224`）、`开始回复，模型 ${model}`（`:247`）、`参数：file_path, ...`（`:223`）、`正在调用 ${toolName}`（`:540`）。终端用户是编剧，`Bash`、`Grep`、`/workspaces/.../progress.json`、`claude-...` 对他们没有意义，只会制造"这东西很脆"的观感。

### 4.5 可达性

**A-1 弹窗行为分三档，最低一档连 Escape 都不能关。**
逐个组件核对 `role="dialog"` / `aria-modal` / 焦点环 / Escape / 焦点还原：

| 弹窗 | 焦点环 | Escape 关闭 | 焦点还原 |
| --- | --- | --- | --- |
| `ui/text-input-dialog.tsx` | 有 | 有 | 有 |
| `workspace/change-password-dialog.tsx` | 有 | 有 | 有 |
| `workspace/quality-issues-dialog.tsx` | 有 | 有 | 有 |
| `workspace/stage-approval-notice-dialog.tsx` | 有 | 有 | 有 |
| `workspace/project-permissions-dialog.tsx` | 有 | 有 | 有 |
| `workspace/project-trash-dialog.tsx` | 有 | 有 | 有 |
| `workspace/file-version-dialog.tsx` | 无 | 有 | 无 |
| `workspace/credit-center-dialog.tsx` | 无 | 有 | 无 |
| `workspace/system-notification-dialog.tsx` | 无 | 有 | 无 |
| `workspace/distribution-brief-dialog.tsx` | 无 | **无** | 无 |
| `admin/admin-dialog.tsx` | 无 | **无** | 无 |
| `batch-tasks/batch-tasks-page.tsx` 内联弹窗 | 无 | **无** | 无 |
| `admin/script-distillation-view.tsx` 内联弹窗 | 无 | **无** | 无 |
| `app/workspace/page.tsx` 内联"重新生成"弹窗（`:2589-2670`） | 无 | 无（仅点遮罩） | 无 |

**A-2 减少动效的偏好只覆盖 1 个动画。**
`app/globals.css:11483` 的 `@media (prefers-reduced-motion: reduce)` 块只处理 `.document-lock-loader`，而 `globals.css` 另有 14 处 `animation:`、`landing.css` 有 17 处。

**A-3 小于 12px 的文字共 317 处，其中不少用在需要读数的地方。**
按文件统计 `font-size: 9px|10px|11px`：`app/globals.css` 88 处（9px 11 / 10px 22 / 11px 55）、`components/admin/admin.module.css` 190 处、`app/landing.css` 26 处、`components/batch-tasks/batch-tasks.module.css` 13 处。多数搭配 `--muted` 弱对比色，位置包括额度余额来源、价目表、额度流水的时间与说明（`globals.css:8315`、`:8329`、`:8349`、`:8354-8364`）。管理台几乎整体运行在 10–11px 上。这些都是用户需要核对数字的地方。

**A-4 管理台仍在用浏览器原生确认框。**
`components/admin/script-distillation-view.tsx:450`、`:466` 使用 `window.confirm`，与产品内 `ConfirmationDialog`（有标题/说明/危险态/忙碌态）风格和可达性都不一致。

### 4.6 学习成本

**L-1 产品内零引导，帮助只有一个外链。**
`lib/constants.ts:2` 的 `OPERATION_MANUAL_URL` 指向飞书 wiki，是全产品唯一的帮助入口（`project-list.tsx:506`、`landing-page.tsx:1049`）。产品内没有首次使用引导、没有阶段说明、没有术语解释，而界面直接使用"成熟度分级""发行任务书""P0 优化""上游已变更""已保存 · 待更新"等内部术语。

**L-2 决定整部剧规模的默认值藏在折叠区里。**
`components/workspace/new-project-form.tsx:427-443`：`发行配置` 默认折叠（仅"重新生成"场景默认展开），里面预置了 `目标集数 = 35`、`单集规格 = 90 秒`、`目标分级` 默认值（`:52-60`）。用户不展开就不知道系统替他选了 35 集，而这个值决定后续所有阶段的产出规模。

**L-3 "已保存"标签容易被读成"自动保存"。**
`components/workspace/markdown-workspace.tsx:1573-1578`：类名 `.autosave`，仅在 markdown 模式且未修改时显示"已保存"。产品实际没有自动保存，也没有离开守卫（见 P-1），这个组合会让用户建立错误预期。

### 4.7 值得补齐的功能缺口

| 编号 | 缺口 | 为什么显著改善体验 |
| --- | --- | --- |
| G-1 | 没有跨项目的"任务进度中心" | 运行中/排队中的任务只在打开该项目时可见；用户同时推进多个剧本时只能逐个点开确认 |
| G-2 | 没有本地草稿与自动保存 | 与 P-1 叠加，是当前最大的信任风险；长文档编辑必须有兜底 |
| G-3 | 版本历史无差异对比 | `file-version-dialog` 能看和恢复版本，但看不出两版差在哪，"重新生成"后无法快速判断改动是否符合预期 |
| G-4 | 没有一次性打包导出 | 交付时要逐个阶段下载；`file-rail` 的导出菜单已经区分 md/docx/交付稿，缺的只是"整项目打包" |
| G-5 | 无内容级检索（同 IA-3） | 剧本改到第 30 集时，"某个角色在哪几集出现"只能靠人工翻 |

---

## 5. 架构级统一决策

六项决策的共同目标：**把"同一件事的多套做法"收敛成一套，并让偏离在 CI 上可被发现**。每项都给出落地位置，供实现槽直接领取。

### D1 统一错误契约（覆盖 C-1/C-2/C-3、S-3、P-2）

- 服务端错误统一为结构化载荷：`{ code, message, hint }`。`code` 是稳定标识（如 `STAGE_UNKNOWN`、`SESSION_EXPIRED`），`message` 是"发生了什么"，`hint` 是"下一步怎么办"，两者都必须是中文用户视角文案。
- 建立错误码注册表（单一出处，前后端共用），前端按 `code` 渲染，**禁止对错误文本做字符串匹配**。
- 保留渐进迁移：前端优先读 `code`，读不到时回落 `message`，兜底文案不再包含 HTTP 状态码。
- 新增码必须同时写入注册表并带 `hint`，缺失即 CI 失败。

### D2 会话过期作为独立路径（覆盖 P-2）

401 不走通用错误横幅，而是触发"会话已过期"处理：保留当前页面状态与未保存草稿，就地提供重新登录，登录成功后回到原位置继续。这条路径与 D3 的草稿保护共用同一份草稿存储。

### D3 防丢失基线（覆盖 P-1、L-3、G-2）

三道防线，缺一不可：
1. **切换前拦截**——切换阶段文件、切换项目、打开会覆盖草稿的弹窗前，若 `dirty` 则确认（保存 / 放弃 / 取消）。
2. **离开前拦截**——`beforeunload` 守卫 + 路由跳转守卫（头像菜单里的 `/preferences`、`/batch-tasks`、`/admin` 链接）。
3. **本地草稿**——按 `项目:阶段` 键持久化草稿，重进时提示"有一份未提交的修改"，可恢复或丢弃。落地后"已保存"标签的含义要同步澄清。

### D4 三级加载与真实进度（覆盖 P-4、S-5）

- **加载分三级**：全页（仅首屏会话与基础数据）、区域骨架（文档区、文件栏、列表）、内联（按钮忙碌态）。硬约束：**文档加载不得升级为全页加载**，即 `pageLoading` 不再包含 `contentLoading`。
- **长任务进度模型**：`{ 当前步骤名, 已完成/总量, 已用时长, 预计剩余 }`，由后端已有的进度事件驱动；静态估时降级为"还没有进度事件时"的兜底，并按历史任务实际耗时校准，而不是写死。
- 加载文案必须与实际动作一致（"正在打开《故事梗概》"而不是"正在加载工作台"）。

### D5 统一反馈层（覆盖 S-3、S-4、A-4）

一个反馈层承载三种形态并规定用法：

| 形态 | 用于 | 无障碍 | 消失方式 |
| --- | --- | --- | --- |
| 内联（字段/区域旁） | 表单校验、局部失败 | 关联控件 | 随状态改变 |
| 提示条（toast） | 操作成功、非阻断信息 | `aria-live="polite"` | 自动消失 |
| 横幅（banner） | 阻断性错误、需要决策 | `role="alert"` | **必须手动关闭或执行动作** |

配套规则：错误必须带可执行动作（重试/重新登录/查看详情）；可同时存在多条而非互相覆盖；所有 `fetch` 调用点必须有 `catch`（含 S-4 这类 `void` 调用）；管理台的 `window.confirm` 全部替换为产品内确认弹窗。

### D6 界面基线：弹窗原语 + 空态三要素 + 可达性下限（覆盖 A-1/A-2/A-3、S-1/S-2、L-1/L-2）

- **弹窗原语**：抽取一个 `Modal`（焦点环、Escape、焦点还原、`role`/`aria-modal`/`aria-labelledby`、遮罩点击策略、忙碌态禁止关闭），所有弹窗改为基于它实现，包括 `app/workspace/page.tsx` 内联的"重新生成"与"重新初始化"弹窗。
- **空态三要素**：说明现状 + 说明原因 + 给出下一步按钮；并区分"没有数据"与"筛选无结果"（后者必须提供清空筛选）。
- **可达性下限**：正文与需读数文本不小于 12px；`prefers-reduced-motion` 覆盖全部动画；焦点可见样式覆盖全部可交互元素。
- **降低学习成本**：影响产出规模的默认值（目标集数、单集规格、目标分级）必须在折叠区外可见；界面术语提供就地解释；首次进入工作台给一次可跳过的流程说明。

---

## 6. 可核验的门槛

这些是能被脚本或 CI 直接判定的二值条件，建议在实现槽落地时一并加入检查，避免回归。基线列是 `main @ abb779e` 上的实测值，已逐条跑过。

| 编号 | 门槛 | 判定命令 | 基线 | 目标 | 归属 |
| --- | --- | --- | --- | --- | --- |
| GATE-01 | 服务端错误文案无纯 ASCII 工程用语 | `rg -o 'detail="[^"]*"' apps/api/app/{routers,services}/*.py \| rg -v '[\x{4e00}-\x{9fff}]' \| wc -l` | 33 | 0 | T01 |
| GATE-02 | 界面文案不靠匹配后端/事件字符串拼出 | `rg -n 'message\.includes\(' apps/web/src \| wc -l` | 5 | 0 | T01（1 处）、T09（4 处） |
| GATE-03 | 兜底错误文案不含 HTTP 状态码 | 检查 `apiErrorMessage()` 兜底分支 | 含 `${status}` | 不含 | T01 |
| GATE-04 | 文档加载不触发全页加载 | `rg -n 'pageLoading = ' apps/web/src/app/workspace/page.tsx` | 含 `contentLoading` | 不含 | T04 |
| GATE-05 | 每个 `role="dialog"` 都来自弹窗原语 | `rg -l 'role="dialog"' apps/web/src \| wc -l` | 15 个文件 | 仅原语 1 个文件 | T08 |
| GATE-06 | 无浏览器原生确认框 | `rg -n 'window\.(confirm\|alert\|prompt)\(' apps/web/src \| wc -l` | 2 | 0 | T05 |
| GATE-07 | 无小于 12px 的字号 | `rg -o 'font-size: (9\|10\|11)px' apps/web/src/app/*.css apps/web/src/components/**/*.css \| wc -l` | 317 | 0 | T12 |
| GATE-08 | 存在离开页面守卫 | `rg -n 'beforeunload' apps/web/src \| wc -l` | 0 | ≥ 1 | T03 |
| GATE-09 | 异步调用点都有错误处理 | 人工走查 `app/workspace/page.tsx` 中所有 `void xxx(` 调用点是否有 `catch` | 至少 `handleSelectFile` 缺失 | 全覆盖 | T05 |
| GATE-10 | 无引用模块清零 | `rg -n 'TopNav\|mock-data' apps/web/src \| wc -l` | 2 | 0 | T10 |

现有测试基线（不得降低）：`npm run test:agent`（`Agents/tests` 19 个套件）、`npm run test:api`（`apps/api/tests` 39 个套件）、`npm run test:zdebug`、`npm run check`（Web TypeScript + API 编译 + Agent 检查）。

---

## 7. 明确不做的事

| 不做 | 原因 |
| --- | --- |
| 引入 i18n 框架做界面多语言 | 用户是中文编剧团队；错误文案问题是"缺契约"而非"缺翻译层"，引入 i18n 会掩盖 D1 |
| 移动端 / 响应式适配 | 工作台是长文档编辑场景，桌面优先；本周期不投入 |
| CSS 体系重构（如迁移到原子化框架） | `globals.css` 11498 行确实偏大，但重构收益不确定、回归面极大，本周期只做基线约束 |
| 改动 Agent 生成质量、提示词、Skill 逻辑 | 属其他槽范围；本槽只处理 Agent **对用户呈现**的文案 |
| 调整额度定价、并发上限、计费模型 | 属产品与商务决策，不是易用性问题 |
| 实时协同编辑 | 现有权限模型是单人编辑 + 评论；协同是独立大特性 |
| 在 W1 内大范围改代码 | 本波定位是架构与方案；W1 只允许零风险的死代码清理 |
| 代为处置历史 w1-\*/w2-\*/w3-\*/w4-\* 分支 | 跨槽动作，需集成槽统一裁定（见第 2 节） |

---

## 8. 与其他槽的边界

| 槽位 | 边界 |
| --- | --- |
| 交互与可靠性 | 本槽负责"用户看到什么"（文案、空态、进度呈现）；重试/幂等/并发这类机制归对方。交叉点是 D1 的错误码注册表，由本槽定契约、双方共用 |
| Agent 智能 | 本槽只管 Agent 活动在界面上的表述（C-4）；提示词、Skill、生成质量归对方 |
| 重大体验功能 | G-1…G-5 已登记为 P2，若对方要接手，直接领取对应任务号即可 |
| 集成槽 | 历史分支裁定、`docs/evidence` 约定是否并入 `main`（第 2 节） |

---

## 9. 就绪任务

17 项任务的完整定义、改动范围、二值验收标准与依赖关系见 [w1-usability-backlog.md](./w1-usability-backlog.md)。
