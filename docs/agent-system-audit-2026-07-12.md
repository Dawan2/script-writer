# 《十八岁太奶奶》1-90 集案例驱动的 Agent 系统深度审计

> 审计日期：2026-07-12
>
> 最后验证：2026-07-13
>
> 审计范围：`project_init -> outline_rewrite -> character_rewrite -> trial_generate -> full_generate -> foreign_review`，以及 Memory、审批、质量扫描和运行复盘
>
> 案例范围：`Agents/workspaces/2026-07-12_admin_《十八岁太奶奶》1-90集`
>
> 结论性质：系统诊断与改造验收，不是对该项目的又一份文学审稿，也不构成平台采购、法律或商业回报意见

## 一、执行结论

### 1. 直接回答

这次结果评级低、修改项多，**主因不是审稿标准过严，而是上游生成链路产出并放行了一份不具备生产完整性的全稿**。旧审稿确实存在标准和执行问题，但它没有制造第 11-90 集的模板化；相反，它只识别到第 46 集以后，实际还低估了问题范围。

按因果强度排序：

| 层级 | 结论 | 责任归属 |
| --- | --- | --- |
| 直接主因 | `full_generate` 实际定义统一 `epText(n,d)`，用代码循环把第 11-90 集的逐集事件填入固定场景、问答、证据和收尾骨架 | 全稿生成方法与执行 |
| 直接系统原因 | 旧质量门禁只验证长度、标题、双语和占位符等交付卫生，没有验证跨集重复、正文密度、人物选择和场面功能，仍将全稿标为 `passed/approved` | 阶段门禁与审批 |
| 重要促成因素 | 初始输入只有“北美 / en-US”，系统却自行确定受众、PG-13 和第 8-10 集付费卡点，并未经核验地把原作航天所映射为现实机构 NASA | 项目任务书、梗概方法 |
| 审稿缺陷 | 实际语义阅读 31/90 集，却声称覆盖 88%、高置信度和“全稿 90 集”；旧等级又把 63.8 标成 A | 审稿证据与评分协议 |
| 非主因 | PDF 转换、双语格式、角色改名、题材设定本身、AI 审稿的存在 | 不应成为主要修复方向 |

因此，这不是“用户严格按照流程操作却误触了一个偶发坏结果”，而是旧系统把**流程完成**误当成了**内容可用**。用户的手动批准不应承担主要责任：系统在批准前没有把生产完整性错误作为不可越过的阻断项。

### 2. 对审稿标准的判断

旧审稿的六个方向——选品与市场、故事结构、人物驱动、留存与节奏、台词与可拍性、海外适配与风险——总体是合理的质量画像，问题主要不在“评什么”，而在“如何举证、如何封顶、如何表达结论”：

1. **判断方向正确**：模板化、角色声音互换、占位式动作和现实机构/网络安全风险都是真问题。
2. **证据执行不合格**：未按声称范围阅读，证据只写集数概括，无法回到具体行；还误报了乱码。
3. **评分语义不合格**：生产完整性失败仍可被市场和开局分补偿；“返修、不可制作”却显示 A，容易让用户误以为只是局部润色。
4. **商业规则过度泛化**：未知商业模式时仍把第 8-10 集当作固定付费卡点，不适合出海多平台、多变现模式。

结论是：**审稿标准需要重构证据和门禁，但低质全稿的首要修复点仍在上游 Skills，尤其是全稿生成与放行机制。**

## 二、第一性质量模型

海外竖屏短剧的“真实可用”不能由格式、名字本土化或单一爽点频率定义。最低成立链路应是：

```text
明确国家、平台、变现、单集规格和受众
-> 明确一条可持续兑现的观看承诺
-> 人物在压力下主动选择
-> 选择造成权力、关系、知识或代价的不可逆变化
-> 变化制造下一集问题并在后续兑现
-> 场面、对白、动作可拍、可演、可译
-> 在目标地区、平台、分级和制作边界内可发行
```

这条链路是非补偿性的：90 集标题齐全、双语格式正确，不能抵消 80 集正文模板化；题材有市场潜力，也不能抵消不可拍、不可演或不可发行。统一质量定义已经写入 `Agents/.claude/skills/_shared/references/vertical_drama_quality_gates.md:L14-L36`，并将任务书、故事、人物、回报、生产和出海风险拆开，见 `Agents/.claude/skills/_shared/references/vertical_drama_quality_gates.md:L38-L108`。

## 三、案例证据链

### 1. 项目在输入阶段就缺少“可验证的出海任务书”

`01-user-input.json` 只记录目标区域为北美、语言为 en-US，没有具体国家、平台/渠道、IAP/AVOD/订阅模式、单集时长、核心受众、目标分级或制作模式：`Agents/workspaces/2026-07-12_admin_《十八岁太奶奶》1-90集/01-user-input.json:L15-L19`。

但梗概及下游试稿将以下内容写成确定事实：

- 北美 18-35 岁女性受众和一组信托/董事会/平台机制：`Agents/workspaces/2026-07-12_admin_《十八岁太奶奶》1-90集/02-故事梗概.md:L4-L10`。
- 试稿进一步确定为 PG-13：`Agents/workspaces/2026-07-12_admin_《十八岁太奶奶》1-90集/04-剧本试稿.md:L6-L6`。
- 原作本来就有“第四航天所/空间站危机”，并非无源新增，见 `Agents/workspaces/2026-07-12_admin_《十八岁太奶奶》1-90集/01-国内原始剧本.md:L1666-L1681`；问题是梗概未经具体国家、制作与法务核验，直接把它映射成现实机构 NASA 并进入季终：`Agents/workspaces/2026-07-12_admin_《十八岁太奶奶》1-90集/02-故事梗概.md:L9-L14`。
- 第 8-10 集为“强付费卡点”：`Agents/workspaces/2026-07-12_admin_《十八岁太奶奶》1-90集/02-故事梗概.md:L16-L21`。

这些可能是可讨论的创作假设，但在没有国家、平台和商业模式时不能当作已确认行业事实。它会污染后续的梗概、试稿和审稿，使系统在错误确定性上继续加工。

### 2. 梗概和人物并非完全没有后段设计，不能把全责推给它们

梗概对中后段实际给出了差异化事件与机制：第 46-49 集分别涉及安全演练、治理、邮件钓鱼和家庭关系，见 `Agents/workspaces/2026-07-12_admin_《十八岁太奶奶》1-90集/02-故事梗概.md:L430-L464`；第 76 集明确了合法取证水印和安全沙箱，见 `Agents/workspaces/2026-07-12_admin_《十八岁太奶奶》1-90集/02-故事梗概.md:L700-L707`；第 80-89 集也规划了不同危机、选择和兑现，见 `Agents/workspaces/2026-07-12_admin_《十八岁太奶奶》1-90集/02-故事梗概.md:L736-L824`，并给出只写授权测试、诱饵、审计和后果的边界，见 `Agents/workspaces/2026-07-12_admin_《十八岁太奶奶》1-90集/02-故事梗概.md:L835-L840`。

人物小传也试图区分核心角色声音与行为边界，见 `Agents/workspaces/2026-07-12_admin_《十八岁太奶奶》1-90集/03-人物小传.md:L35-L44`、`Agents/workspaces/2026-07-12_admin_《十八岁太奶奶》1-90集/03-人物小传.md:L398-L404`。

这说明：梗概的任务书与逐集因果颗粒度仍需加强，人物声音规则也需从形容词变成可测试行为，但**第 11-90 集的大规模复制不是梗概天然要求，而是全稿阶段丢失了同集 Canon 和场面创作。**

### 3. 全稿从第 11 集开始发生生产性坍缩

第 1-10 集正文相对完整；第 11 集从 `Agents/workspaces/2026-07-12_admin_《十八岁太奶奶》1-90集/99-剧本稿.md:L1093-L1093` 开始。第 11 集与第 12 集只替换少量人物和事件句，场景顺序、问答逻辑、动作和收尾高度一致：`Agents/workspaces/2026-07-12_admin_《十八岁太奶奶》1-90集/99-剧本稿.md:L1093-L1189`。

问题不是单纯“AI 味重”，而是模板开始破坏故事因果、角色策略和时空连续性：

- 第 21 集本应处理病醒与寻母，却被写成“课堂—谁撒谎—证据链—按规则付账”：`Agents/workspaces/2026-07-12_admin_《十八岁太奶奶》1-90集/99-剧本稿.md:L1583-L1630`。
- 母子认亲仍沿用同一对抗骨架，奥利弗刚拥抱母亲又指责其“没资格/不公平”：`Agents/workspaces/2026-07-12_admin_《十八岁太奶奶》1-90集/99-剧本稿.md:L1632-L1679`。
- 第 46-49 集不同梗概被压成相同的“课堂/纠错/资格/公平/规则”结构：`Agents/workspaces/2026-07-12_admin_《十八岁太奶奶》1-90集/99-剧本稿.md:L2808-L3003`。
- 家庭应援喜剧也被写成“谁在撒谎—证据链—责任付账”：`Agents/workspaces/2026-07-12_admin_《十八岁太奶奶》1-90集/99-剧本稿.md:L4621-L4668`。
- 第 84 集主角先开口、后赶到、再推门进场，产生直接连续性错误：`Agents/workspaces/2026-07-12_admin_《十八岁太奶奶》1-90集/99-剧本稿.md:L4670-L4717`。
- 第 90 集团圆与旧友邀请仍使用相同的撒谎、公平、证据和付账模板：`Agents/workspaces/2026-07-12_admin_《十八岁太奶奶》1-90集/99-剧本稿.md:L4964-L5011`。

新质量扫描器对旧稿回放的结果为 `failed`：90 集均能解析，但有 2 个 error 和 2 个 warning，见 `Agents/workspaces/2026-07-12_admin_《十八岁太奶奶》1-90集/runtime/jobs/43/script-quality-report.json:L1-L14`。关键量化结果是：

- 第 11-90 集连续模板化，共 80 集，邻集平均 Jaccard 相似度 0.7074：`Agents/workspaces/2026-07-12_admin_《十八岁太奶奶》1-90集/runtime/jobs/43/script-quality-report.json:L4153-L4799`。
- 相对试稿基准的正文密度中位比仅 0.4205，80/90 集低于基准阈值：`Agents/workspaces/2026-07-12_admin_《十八岁太奶奶》1-90集/runtime/jobs/43/script-quality-report.json:L3398-L3489`。
- 发现 26 条高频重复创作句与 318 对近重复集：`Agents/workspaces/2026-07-12_admin_《十八岁太奶奶》1-90集/runtime/jobs/43/script-quality-report.json:L4888-L12513`、`Agents/workspaces/2026-07-12_admin_《十八岁太奶奶》1-90集/runtime/jobs/43/script-quality-report.json:L13780-L14402`。
- Unicode replacement character 与常见 mojibake 均为 0：`Agents/workspaces/2026-07-12_admin_《十八岁太奶奶》1-90集/runtime/jobs/43/script-quality-report.json:L43-L48`。旧审稿所谓“乱码”没有文件证据。

这些数据证明本稿不能靠“润色第 46 集后”修复，必须从第 11 集开始按逐集目标、阻碍、选择和后果重新生成场面。

### 4. 原始执行日志直接证明正文由代码模板循环生成

ZDebug 的可观察工具调用完整保留了生成命令。Job 42 先把第 11-90 集梗概压进 `eps` 对象，再定义统一的 `epText(n,d)`：固定插入“镜头贴近……”“课堂/纠错”“资格来自事实”“公平不是给你赢的”“证据链”“按规则办”等场景与台词，最后执行 `for(let i=11;i<=90;i++) out+=epText(i,eps[i])` 写入全稿：`data/zdebug/jobs/agent_job_42.jsonl:L10056`。

这条证据把根因从“模型可能因长上下文而自然重复”升级为确定事实：**Agent 主动用字符串模板、循环和数据填槽生成了 80 集创作正文。** 单次全稿 Job 用约 6 分 43 秒、103 turns 和 14,169 个输出 token 完成并宣布 90 集通过，见 `data/zdebug/jobs/agent_job_42.jsonl:L12209`。速度和 token 数本身不是质量判据，但与模板命令共同证明该运行优化的是“快速生成完整文件”，不是逐集场面质量。

旧规则虽要求事件、场景和对白原创、人物不可跑偏，却没有明确禁止用代码生成正文，也没有强制小批次、逐批 Canon 读取和可执行重复扫描。于是 Agent 将“按时得到 90 集并通过格式检查”当成局部最优。当前 `full_generate` 对循环/模板的显式禁令正是针对这一事故类别，而不是针对本剧某句台词。

### 5. 运行上下文提供了正确 Canon，但执行没有留下逐集读取证据

全稿 Job 42 的运行上下文明确规定：梗概是 `story_canon_source`，试稿只是 `style_baseline_source`，见 `Agents/workspaces/2026-07-12_admin_《十八岁太奶奶》1-90集/runtime/jobs/42/stage-context.json:L20-L29`；并提供了按集读取梗概、试稿和人物状态的命令，见 `Agents/workspaces/2026-07-12_admin_《十八岁太奶奶》1-90集/runtime/jobs/42/stage-context.json:L6217-L6225`。

但 Job 42 没有 `episode-access.jsonl`，无法证明全稿阶段实际按批次读取过对应梗概。与之对照，审稿 Job 43 明确留下三次读取日志。合理结论不是“Memory 没给资料”，而是旧 `full_generate` 没有把逐集检索、批次创作和读取留痕变成强制执行契约。

### 6. 旧门禁把格式完整误判为内容通过

全稿阶段在模板化 80 集的情况下仍记录 `quality_check.passed=true`，检查内容主要是总字符数、集数标题、格式和“AI 痕迹可控”等主观断言：`Agents/workspaces/2026-07-12_admin_《十八岁太奶奶》1-90集/01-project-progress.json:L230-L245`。随后该稿进入 `approved`，同时 `consistency_status` 仍为 `review_required`：`Agents/workspaces/2026-07-12_admin_《十八岁太奶奶》1-90集/01-project-progress.json:L278-L293`。

一致性报告实际留下 29 个 warning，并把知识边界、关系、声音和弧光全部交给人工复核：`Agents/workspaces/2026-07-12_admin_《十八岁太奶奶》1-90集/runtime/jobs/42/consistency-report.json:L7-L20`。Memory delta 却在角色状态为空对象时标为 approved：`Agents/workspaces/2026-07-12_admin_《十八岁太奶奶》1-90集/runtime/jobs/42/memory-delta.json:L9-L18`。

审批日志也证明被批准的是与当前扫描一致的同一份全稿哈希，而非后来被意外覆盖：`Agents/workspaces/2026-07-12_admin_《十八岁太奶奶》1-90集/memory/decisions.jsonl:L2-L3`。

所以真正的问题是：**旧系统采用 fail-open——警告存在也继续批准；目标质量合同必须采用 fail-closed——生产完整性 error 未清零就不能进入审批。** 当前人工编辑和历史批准路径尚未满足这一目标，见第九节。

### 7. 旧运行复盘同样没有观测“内容是否坍缩”

旧复盘记录 7 个 Job、0 个失败、593 次 turns、约 6.42 美元成本和 7 次上下文压缩，但质量层只统计未知角色标签，没有跨集模板和密度指标：`Agents/workspaces/2026-07-12_admin_《十八岁太奶奶》1-90集/memory/evolution/review-20260712T041119Z.json:L11-L33`、`Agents/workspaces/2026-07-12_admin_《十八岁太奶奶》1-90集/memory/evolution/review-20260712T041119Z.json:L121-L127`。因此它把 80 集模板化视为“运行成功”，改进建议也只集中在上下文重复读取和角色标签：`Agents/workspaces/2026-07-12_admin_《十八岁太奶奶》1-90集/memory/evolution/review-20260712T041119Z.json:L142-L162`。

这解释了为什么系统“每一步都成功”，结果却不可用：成功指标只覆盖流程健康，没有覆盖内容生产完整性。

## 四、旧审稿为什么既发现真问题，又给出失真的报告

### 1. 实际覆盖率只有 34%

Job 43 只读取了第 1-10、46-50、75-90 集：`Agents/workspaces/2026-07-12_admin_《十八岁太奶奶》1-90集/runtime/jobs/43/episode-access.jsonl:L1-L3`。去重后为 31/90 集，即 34%。

但评分 JSON 写的是“全稿 90 集”、`confidence=high`、`evidence_coverage=88`：`Agents/workspaces/2026-07-12_admin_《十八岁太奶奶》1-90集/99-海外审稿评分.json:L18-L18`、`Agents/workspaces/2026-07-12_admin_《十八岁太奶奶》1-90集/99-海外审稿评分.json:L36-L40`。这使读者无法区分“全量机器预检”和“语义阅读范围”，属于证据披露错误。

### 2. 它找对了问题类型，却找错了范围和部分事实

旧报告正确指出重复问答、角色声音坍缩和不可制作，见 `Agents/workspaces/2026-07-12_admin_《十八岁太奶奶》1-90集/99-海外审稿报告.md:L40-L74`；但将异常起点写成第 46 集，漏掉第 11-45 集，见 `Agents/workspaces/2026-07-12_admin_《十八岁太奶奶》1-90集/99-海外审稿报告.md:L44-L45`。它还称第 8、80 集有乱码，见 `Agents/workspaces/2026-07-12_admin_《十八岁太奶奶》1-90集/99-海外审稿报告.md:L69-L74`、`Agents/workspaces/2026-07-12_admin_《十八岁太奶奶》1-90集/99-海外审稿报告.md:L91-L91`，而新扫描的乱码计数为 0。

原始审稿 Job 的工具序列也只有 overview 与上述三个区间，随后直接写评分；它在没有全量扫描的情况下手填“全稿 90 集”、88% 和 high：`data/zdebug/jobs/agent_job_43.jsonl:L1107`。源剧本乱码为 0，而 ZDebug 工具流本身曾出现 replacement character，说明旧审稿把传输/日志层字符损坏误判成源稿缺陷。当前规则已要求乱码等机器结论必须与 scanner 一致：`Agents/.claude/skills/foreign_review/references/海外审稿规则.md:L137-L143`。

因此，旧审稿不能被当作“严格但准确”的金标准。它的方向可保留，具体范围、证据和分数必须重算。

### 3. 旧等级放大了误导

旧评分为 63.8，却按旧映射标为 A，同时总体结论是返修且不能制作：`Agents/workspaces/2026-07-12_admin_《十八岁太奶奶》1-90集/99-海外审稿评分.json:L21-L48`、`Agents/workspaces/2026-07-12_admin_《十八岁太奶奶》1-90集/99-海外审稿报告.md:L13-L21`。

当前协议已将等级修订为 C 0-59.9、B 60-69.9、A 70-79.9、A+ 80-89.9、S 90-94.9、SS 95-100，并规定“通过”至少 80 分、六维不低于 60 且无阻断项：`Agents/.claude/skills/foreign_review/references/审稿评分与输出协议.md:L157-L175`。因此旧 63.8 即使只做等级重映射也应为 B；若按新模板化封顶规则，故事、人物、留存、台词四维均须重新计算且不高于 39，不能直接沿用 63.8。

## 五、对三个外部 AI 审稿报告的借鉴边界

三份附件可作为**审稿报告产品形态的基准**，不能作为北美/全球竖屏短剧的统一行业标准。三份均为 12 页；第一份只审前 10 集，后两份只审前 30 集。它们共同采用约 15 个维度（市场 3、叙事 8、商业 2、合规 2），并补充格式、制作、资产和 Top 5 问题，说明“分层、举证、给动作”比一个总分更有价值。

### 1. 可迁移的方法

| 方法 | 附件证据 | 对本系统的用法 |
| --- | --- | --- |
| 设定承诺必须在正文兑现 | 《你一个公考讲师，怎么成国师了？》第 4 页指出核心身份仍停留在概念层 | 建立承诺-兑现账本，检查早、中、后段是否产生不同结果 |
| 找跨集重复与节奏疲劳 | 《重回，从赶海系统开始》第 6 页指出“赶海-卖鱼-分钱”循环 | 机器扫描近重复，人工判断场面功能与情绪是否真的变化 |
| 检查角色能动性 | 同报告第 7 页指出女主主要功能是被保护 | 每个核心角色都要有不可替代行动、选择和代价 |
| 把连续性问题落到具体集 | 《偷听古董心声，我在废品站赢麻了》第 5 页指出姓名混淆 | 使用文件行号、集号、影响和验收条件组成证据链 |
| 将生产、合规与故事分开 | 《偷听古董心声，我在废品站赢麻了》第 10 页讨论断指、人彘风险 | 生产完整性、内容质量、分级/法律风险采用不同 gate，不用一个总分互相抵消 |

### 2. 明确不能照搬的内容

- 《公考讲师》第 5 页把“每 15 秒一冲突”当统一标准。实际节拍应由单集时长、平台、题材和变现方式决定。
- 《赶海系统》第 4 页用“31-50 岁下沉男性、无女频内容混入”判断受众纯度。这是国内特定产品画像，不是海外通用受众模型。
- 国内热播榜对标、网络热梗/金句密度、乡村振兴或“正能量”政策加分，不能迁移为北美或其他国家的发行质量项。
- 三份报告的 A+/S 等级和总分不可审计：维度均值约为 79.7、83.2、82.4，总分却分别显示 79、85、83；第一份只评 10 集，另两份只评 30 集。
- 《偷听古董心声》第 4 页还泄露了“评分与输出规则，不要输出规则”等内部提示，说明其报告生成链路本身存在提示污染。

外部报告应只贡献“问题分类和证据表达”，不能贡献固定阈值、权重、爆款公式、国内监管价值判断或不透明等级。

## 六、行业依据及其系统含义

以下公开资料用于约束方法，不用于承诺某个项目必然成功。来源于 2026-07-12 检索，Deloitte、Screen Australia 与 IARC 于 2026-07-13 再次核验。

| 来源 | 发布/更新 | 可支持的结论 | 不能推出的结论 |
| --- | --- | --- | --- |
| Deloitte, [Tiny episodes, massive appeal](https://www.deloitte.com/us/en/insights/industry/technology/technology-media-and-telecom-predictions/2026/short-form-video-series.html) | 页面显示 2025-11-18 | 微短剧常见 60-90 秒；小额付费、订阅、广告及混合模式并存 | 所有项目都应在第 8-10 集付费 |
| Harvard Business Review, [Lessons from China's Short-Drama Boom](https://hbr.org/2026/03/lessons-from-chinas-short-drama-boom) | 发布 2026-03-13 | 应测试概念/钩子；本土制作/IAP 与翻译/广告模式不同；只换语言会同质化 | 中国成功公式可原样迁移海外 |
| Screen Australia, [Narrative Content Development](https://www.screenaustralia.gov.au/fund/narrative-content-development/) | 页面当前规则（访问 2026-07-13） | 故事、人才/开发、受众/预算应分开评价 | 其资助标准就是全球短剧评分权重 |
| CHI/arXiv, [Audience in the Loop](https://arxiv.org/html/2602.14045v1) | 预印本版本 2026-02-15 | 28 位中国创作者访谈显示反馈循环有价值，也可能放大刻板印象、破坏连贯性 | 中国创作者样本可直接代表海外用户 |
| Apple, [App Store Review Guidelines](https://developer.apple.com/app-store/review/guidelines/) | 更新 2026-06-08 | 内容、元数据和 IAP 都有平台级规则，商业模式必须进入任务书 | Apple 规则等同于所有短剧平台规则 |
| IARC, [How IARC Works](https://globalratings.com/how-iarc-works/) | 页面当前规则（访问 2026-07-13） | 参与 IARC 的应用商店中，游戏/应用分级会按地区映射，证明风险标签不应无视地区 | IARC 覆盖所有短剧渠道，或一个“PG-13”标签可覆盖所有国家 |
| U.S. Copyright Office, [Copyright and Artificial Intelligence, Part 2](https://www.copyright.gov/newsnet/2025/1060.html) | 发布 2025-01-29 | 单靠提示通常不足以证明人类表达控制；人工选择、修改和创作留痕重要 | AI 生成文本当然拥有完整可执行版权 |
| NPR, [Micro-drama soap opera apps](https://www.npr.org/2025/03/19/nx-s1-5330470/micro-drama-soap-opera-app) | 发布 2025-03-19 | 可核验竖屏、连续、常见不足一分钟的观看形态 | ReelShort 自报的 70% 女性可变成全球默认受众 |

这些资料共同支持一个工程决策：发行 brief 必须先于创作假设，平台/变现/分级是变量；故事质量需要独立门禁；真实受众结论必须来自项目自己的测试数据。

## 七、已落地的系统优化

本轮修改采用通用契约和检测器，没有把《十八岁太奶奶》的角色、台词或情节作为 few-shot 写入 Skills。案例只用于回放验证。

以下规则、生成工具、finalize 门禁、API 审批和自动测试已落到当前工作树。本案暴露的已知 fail-open 旁路已关闭；仍然存在的生产验证边界列在第九节。

### 1. 建立跨阶段统一质量契约

- 新增 `vertical_drama_quality_gates.md`，明确“格式不等于质量”，拒绝固定 3 秒、15 秒、第 8-10 集付费和每集打脸等伪通则：`Agents/.claude/skills/_shared/references/vertical_drama_quality_gates.md:L14-L36`。
- 要求国家、显式 BCP 47 `target_locale`、发行形态、平台、单集规格、商业卡点、受众、分级、制作与改编边界；国家只提供 locale 候选，不自动成为语言事实；多 locale 必须拆成独立版本项目：`Agents/.claude/skills/_shared/references/vertical_drama_quality_gates.md:L38-L60`。
- 把梗概、人物、试稿、全稿门禁写成同一套非补偿链路：`Agents/.claude/skills/_shared/references/vertical_drama_quality_gates.md:L110-L152`。

### 2. 将发行任务书前置

- `project_init` 新增国家、显式 `target_locale`、平台、商业模式、时长、受众、分级和制作模式参数。缺少 locale 或目标国家跨越多个 locale 时，`distribution_brief` 保持 `provisional`，不允许后续阶段把它伪装为单语言项目：`Agents/.claude/skills/_shared/lib/stage-runner.mjs:L65-L150`。
- 任务书已接入 Web/API/CLI 确认流程；修改后会将已开始的下游阶段标为 `stale`，避免旧梗概继续生效：`apps/api/tests/test_distribution_brief_update.py:L129-L158`。
- `outline_rewrite` 必须列出暂定值、依据、风险和待确认项；逐集卡新增视角目标、阻碍与选择、不可逆变化/代价：`Agents/.claude/skills/outline_rewrite/SKILL.md:L26-L30`、`Agents/.claude/skills/outline_rewrite/SKILL.md:L41-L44`。

### 3. 把人物小传与试稿改成“可执行实验”

- 人物不再只写身份和形容词，必须写主动策略、不可替代行动、选择代价和可测试声音指纹：`Agents/.claude/skills/character_rewrite/SKILL.md:L27-L27`、`Agents/.claude/skills/character_rewrite/SKILL.md:L41-L42`。
- 人物 Canon 解析器会把顶层口吻规则映射回角色，并对前两位核心角色的身份、目标、主动策略、不可替代行动、选择代价、声音和弧光做硬校验：`Agents/.claude/skills/_shared/lib/character-context.mjs:L79-L108`、`Agents/.claude/skills/_shared/lib/character-context.mjs:L186-L257`、`Agents/.claude/skills/_shared/lib/character-context.mjs:L292-L323`。
- 试稿必须逐集证明目标、阻碍、选择、变化和承接，并进行遮名辨声、目标语口语和反方审稿：`Agents/.claude/skills/trial_generate/SKILL.md:L28-L28`、`Agents/.claude/skills/trial_generate/SKILL.md:L44-L44`。
- 卡点位置由任务书决定，不再默认第 8-10 集：`Agents/.claude/skills/trial_generate/references/试稿生成规则.md:L59-L60`。

### 4. 重构长全稿生成

- 默认每批不超过 10 集，独立文件写作、逐批 `validate`、最终 `assemble`。每批必须绑定当前梗概、人物小传、人物状态和试稿哈希，并以本 Job 访问日志证明已读取同集梗概 Canon 和人物状态：`Agents/.claude/skills/full_generate/scripts/full-draft-tool.mjs:L153-L251`、`Agents/.claude/skills/full_generate/scripts/full-draft-tool.mjs:L254-L374`。
- 明确禁止用循环、字符串模板、数据填槽和批量替换生成创作正文：`Agents/.claude/skills/full_generate/SKILL.md:L32-L32`，以及 `Agents/.claude/skills/full_generate/references/全稿生成规则.md:L73-L91`。
- 新增跨集重复、近重复、连续模板、正文密度、缺集、乱码和格式扫描。任何 error 都使阶段进入 `needs_revision`；API 普通批准会对当前文件哈希实时重跑 finalize，不再信任人工编辑前的报告：`apps/api/app/services/memory_sync_service.py:L412-L510`。
- manifest 更新采用短时文件锁、锁内重读和原子写回，并发 `validate` 不会丢失另一批状态：`Agents/.claude/skills/full_generate/scripts/full-draft-tool.mjs:L88-L129`、`Agents/.claude/skills/_shared/tests/full-draft-tool.test.mjs:L354-L381`。

### 5. 重构审稿证据和评分

- 审稿先读全量机器预检，再按前 10 集、最后 5 集、各段落、全部卡点/反转/高风险集和异常区间抽样：`Agents/.claude/skills/foreign_review/references/海外审稿规则.md:L26-L43`、`Agents/.claude/skills/foreign_review/references/海外审稿规则.md:L103-L109`。
- 语义覆盖率由本 Job 的真实读取日志计算；30%-79% 最高只能为 medium，80% 以上才可 high：`Agents/.claude/skills/_shared/references/vertical_drama_quality_gates.md:L166-L194`。
- 证据必须是当前文件真实行号，不能再用“第 46-50 集·重复”代替：`Agents/.claude/skills/foreign_review/references/审稿评分与输出协议.md:L24-L31`。
- 至少 20% 集数模板化时，故事、人物、留存、台词四维均封顶 39；任务书不完整不能给通过：`Agents/.claude/skills/foreign_review/references/审稿评分与输出协议.md:L54-L64`。
- 等级已与 80 分通过阈值重新对齐，映射实现见 `Agents/.claude/skills/_shared/lib/stage-runner.mjs:L55-L62`，Schema 见 `Agents/.claude/skills/_shared/schemas/foreign-review-score.schema.json:L141-L175`。

### 6. 自动化验证结果

- `Agents` 53/53、API 35/35、ZDebug 3/3，合计 91/91 自动测试通过；项目检查 82 项通过，Web 生产构建成功。覆盖批次汇总与失效、Memory 状态审批、等级边界、真实覆盖率、行号证据、模板封顶、任务书、跨集重复、密度、乱码、缺集、批次并发和审批旁路。
- 关键测试位置：`Agents/.claude/skills/_shared/tests/review-gates.test.mjs:L15-L16`、`Agents/.claude/skills/_shared/tests/review-gates.test.mjs:L93-L152`；`Agents/.claude/skills/_shared/tests/script-quality.test.mjs:L39-L112`。
- 回放结果：《十八岁太奶奶》试稿 1-10 集通过，全稿在第 11-90 集因正文密度坍缩与连续模板化失败，扫描到 318 对近重复。
- 《今夜星辰闪耀》历史原稿不能直接当“健康稿”：`99-剧本稿.md:L894-L903` 在第 10/11 集之间混入 10 行文档级创作原则，当前扫描器正确阻断。仅在内存中移除该污染段后，30 集正文样本通过；这只证明当前重复/密度阈值未误伤该正文，**不证明新流程已能稳定产出商业成功或母语级剧本**。

## 八、阶段 Gate 矩阵

下表是系统应执行的非补偿质量合同。状态“通过”只表示可以进入下一阶段，不表示商业成功。

| 阶段 | 必需输入 | 必需产物 | 自动硬门禁 | 语义门禁 | 失败状态 |
| --- | --- | --- | --- | --- | --- |
| 项目初始化 | 源稿、具体国家、显式 BCP 47 locale、平台类型、变现、时长、集数、受众、分级、制作边界 | 单一主 locale 的可追溯 `distribution_brief` | Schema、来源哈希、缺项列表、国家-locale 契约 | 暂定假设是否最少且可解释 | 缺显式 locale 或跨 locale 时保持 `provisional`；多 locale 拆独立项目 |
| 故事梗概 | 源稿、任务书、当前公开平台/分级依据 | 5-10 集段落架构、承诺/回收账本、逐集因果卡 | 集号连续；每集新字段非空；公开依据有日期 | 故事发动机能否撑全季；选择是否造成不可逆变化；机制是否轮换 | `needs_revision`，不能进入人物定稿 |
| 人物小传 | 已批准梗概、关系与知识边界 | 欲望/恐惧/策略/底线/误信念、不可替代行动、选择代价、声音指纹 | 核心角色字段完整；角色 ID 唯一 | 压力测试、遮名辨声、关系能否制造剧情 | `needs_revision` |
| 剧本试稿 | 已批准任务书、梗概、人物 | 第一集、首个完整叙事单元、已确认卡点样本 | 集数、双语、角色标签、密度、连续性 | 逐集目标-阻碍-选择-变化-钩子；口语、场面、反方审稿 | `needs_revision`；不得以“风格可用”跳过内容问题 |
| 完整剧本 | 同集梗概 Canon、当前人物状态、开放循环、试稿风格基准 | 每批不超过 10 集的独立正文、批次报告、汇总稿 | 缺/重集、近重复、连续模板、密度坍缩、乱码、Hash、批次 manifest | 每场进入状态、目标、冲突动作、转折、离场变化；角色选择与兑现 | 任一 error 为 `needs_revision`；禁止汇总/批准 |
| 海外审稿 | 全稿、任务书、梗概、人物、扫描报告、读取日志 | 单一 JSON 评分源和镜像 Markdown | 覆盖率、置信度、证据行号、分数计算、模板封顶、Schema | 选品、故事、人物、留存、可拍、海外风险；优缺点与动作 | `revise/reject/supplement_materials`；不得被总分补偿 |
| 人工批准 | 所有 Gate 报告和未决风险 | 带人、时间、依据的决策 | 对当前哈希重跑 finalize；P0/error 未清零则不提供普通批准 | 主编、母语、制片、法务按风险签核 | 普通批准不得越过；未来如做例外流程，必须独立权限与留痕 |
| 运行复盘 | Job、成本、上下文、质量和用户反馈 | 过程与内容质量联合报告 | failed job、重试、重复读取、模板/密度、未知角色均统计 | 失败原因是否可归到任务书、故事、人物、生成或审稿 | 不以“Job 成功”代替“稿件通过” |

## 九、剩余风险与边界

### 1. 已关闭的已知旁路

- 人工编辑后的批准会重跑当前阶段 finalize，校验当前稿件哈希、script-quality、角色一致性、Memory delta 和全稿 manifest：`apps/api/app/services/memory_sync_service.py:L412-L560`。
- 历史批准记录不再跳过当前契约；`stage_approvals` 带 `quality_contract_version`，幂等返回前仍重跑实时门禁：`apps/api/app/routers/projects.py:L392-L438`。
- 全稿批次已强制绑定当前梗概与人物来源哈希、同集读取日志和集数范围；API 审批对 manifest 与批次报告做镜像校验：`apps/api/app/services/memory_sync_service.py:L286-L409`。
- manifest 已使用文件锁、锁内重读和原子写回；发行任务书也已有 Web/API/CLI 补全与下游 `stale` 失效流程。

### 2. 真正剩余的风险

1. 本轮已完成事故回放和自动验证，但尚未用新流程在未见题材上从头生成、审核并人工签核一部完整 90 集剧本。不能把“已知事故可阻断”写成“生产已验证”。
2. 词面相似度和正文密度扫描能抓大面积复制，但无法证明同义改写不是同一结构，也可能遇到刻意复沓。它是生产完整性 Gate，不是主编语义判断器。
3. 人物 Canon 对前两位核心角色做硬完整性校验，但全季人物弧、语用自然度、演员可辨识度和重要配角能动性仍需主编、母语编辑和围读判断。
4. 任务书要求公开检索，但自动门禁无法独立证明每条市场、平台、分级和现实机构结论都来自最新、适用地区的权威来源。
5. 多 locale 已被阻断在单项目之外，但尚没有“从一个已批准母版批量创建并维护多个 locale 版本项目”的产品化编排。
6. 普通批准已 fail-closed。若未来真需越过某个机器 error，必须另建例外权限、原因、时间、责任人和底层检测结果留痕，不应复用现有普通批准。

### 3. 必须保留的人类责任

- **目标语母语审校**：口语自然度、社会语域、幽默、阶层/族群含义、名字和本地生活常识。
- **法律审查**：版权链、AI 人类创作控制留痕、诽谤、隐私、商标/机构背书、未成年人、危险行为和网络安全呈现。
- **平台核验**：实际投放平台的当前内容政策、IAP/广告规则、元数据、分级与地区差异。
- **制片与围读**：演员遮名辨声、动作可执行性、场景/道具/群演/特效成本、单集真实时长和情绪节拍。
- **真实用户数据**：概念测试、首集完成率、分集留存、卡点转化、退款/投诉和分群差异。没有这些数据，不能声称“符合海外市场”或“具备爆款潜力”。

## 十、验证与上线建议

### 1. 先做事故回放，不把个案写进 Skill

1. 保留旧全稿哈希作为负样本，只用于 scanner 回归，不把角色名、台词或情节写入通用提示。
2. 补齐并人工确认该项目的具体国家、单一主 `target_locale`、平台/渠道、商业模式、单集时长、核心受众、分级和制作模式；其他 locale 另建版本项目。
3. 从已批准梗概重新生成第 11-20 集一个批次，逐集读取 Canon，完成自动扫描、主编检查、母语检查和围读。
4. 只有该批次通过，再继续 21-30；禁止一次性重写 80 集后再统一审稿。
5. 全部批次通过后汇总，再由新审稿器披露“全量机器预检 90/90 + 实际语义阅读 X/90”。

### 2. 用未见项目做交叉验证

至少选择三个未被写入规则的不同题材、不同国家/locale、不同变现模式项目，验证：

- 健康稿不会因合理复沓被误报；模板稿、密度坍缩稿和缺集稿必然被阻断。
- 梗概的逐集选择与代价能在全稿中找到对应场面，而不只是标题或动作摘要。
- 主要角色遮住名字后仍可区分；反派和配角不是主角口号的复读者。
- 实际覆盖率、证据行号、置信度、分数和 verdict 完全一致。
- 受众和卡点结论只在有平台/用户数据时升级为事实。

### 3. 上线准入

建议同时满足以下条件后，才能称为“系统可用于生产试运行”：

- 自动测试持续通过，旧事故稿稳定被拒绝。
- 至少三部盲测项目完成全流程，无生产完整性 error。
- 目标语母语编辑、主编和制片分别签核代表批次。
- 高风险项目完成法务与实际平台政策核验。
- 真实小流量测试达到项目预先设定的对照基线；阈值由平台和商业模式决定，不写成跨项目固定秒数或固定付费集数。

## 十一、最终判断

《十八岁太奶奶》暴露的不是某一条提示词不够精致，而是旧系统缺少一份贯穿各阶段的质量合同：任务书可以缺失，假设可以冒充事实，试稿通过不能约束长全稿，长稿可以模板化，警告可以被批准，审稿又可以夸大覆盖率。

本轮优化已经在 Skills、生成工具、Memory、finalize 和 API 审批路径补上关键结构：**显式单 locale 发行任务书、逐集因果字段、人物选择与声音测试、可恢复小批次、Canon 读取证据、全量生产扫描、真实审稿覆盖、行号证据和非补偿评分门禁**。人工编辑审批、历史批准幂等、生成端 Canon 读取和并发 manifest 这四个已知旁路已闭环；对本案同类生产完整性事故，当前工程路径已 fail-closed。

但系统是否真正“生产可用”，不能由这一个案例或 91 个自动测试证明。下一步的正确目标不是把当前稿修得像样后宣布成功，而是让新流程在未见题材、不同国家/locale 和不同变现模式下持续产出：可追溯、可拍、可演、可译、可审，并通过母语、法务、平台、制片和真实用户数据的多层验证。
