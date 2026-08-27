---
name: foreign_review
description: 对解说漫或短剧剧本进行取证式主编审稿，生成审稿评分卡与审稿报告。用于独立剧本审核、剧本改写、小说改编或爆款复刻完成后的正式审稿，以及 full_generate 调用的不落盘预审。
---

本 Skill 的目的，是根据当前待审剧本、发行任务信息和可用的项目资料，生成 `review-scorecard.json`、`output/审稿报告.md` 与内部评分状态，为主编审稿、项目判断和后续返修提供依据。

## 工作流程

1. 判断执行模式。
   - `full_generate` 调用预审时，只执行第 2 步所述预审流程，不创建文件、不更新进度。
   - 正式审稿时，继续执行以下完整流程。独立审稿不要求世界观、大纲或人物资料存在；改编项目审稿沿用项目进度与返修链路。
2. 执行预审时，读取当前全稿和与问题相关的维度资料，返回定位到集数、场次或正文范围的修改意见。不得调用初始化、覆盖、台账、检查或返修工具。
3. 正式审稿开始前确认输入来源。`requires_translation` 为 true 的改编项目优先审读已通过的台词译稿，并以中文全稿核对行动意图；为 false 时直接审读中文全稿。独立审稿使用已准备的待审剧本；只有用户直接提供 Word、PDF、TXT 或 Markdown，且没有审稿工作区时，调用“导入待审剧本”。缺少剧本文本时停止。
4. 调用“初始化审稿”。改编或爆款复刻项目要求 `full_generate` 已完成，且只在 `requires_translation` 为 true 时要求 `dialogue_translate` 已完成；独立审稿由工具补齐审稿所需状态。初始化工具会兼容升级旧版评分卡，并按评分表生成 `runtime/review-scoring.json`，不覆盖已填写内容。
5. 项目审稿调用“读取用户需求”工具，确认目标市场、主要交付语言、时长、目标集数、内容分级和用户要求；独立审稿读取 `review-input.json` 确认审稿模式、版本和审稿范围。目标集数仅用于交付规划，不作为审稿准入条件。调用“读取用户偏好”和“获取地区规则”。未提供的信息写入判断边界，不作推断。
6. 调用“建立审读索引”，读取 `runtime/review-source-index.json`。连续“场<集号>-<场号>”须按集号归并为剧集；只有工具确认的“规范分集”可以使用第 X 集，其余按候选单元、场次或正文区块描述。
7. 读取[正文审读与取证](references/正文审读与取证.md)，完成全文审读。先核对机械统计，再覆盖第一集、一卡、各故事阶段、中后段、结局和索引异常区间；每完成一个范围调用“记录审读覆盖”。为每个审读单元填写冲突、选择、结果、卡点与证据，再调用“写入审读台账”。未覆盖全文，不得给出全剧结论。
8. 爆款复刻时，深度阅读 `output/爆款分析报告.md`，结合全文审读核对当前剧本是否以新的故事外壳保留报告中明确的剧情功能、冲突机制、权力关系和节奏承诺；不得沿用具体人名、地点或专有设定，也不得把报告推断写成既定事实。
9. 读取[审稿表达](references/审稿表达.md)，再填写所有会进入评分卡和报告的用户可见文字。先完成事实、证据和评分判断，再按“对象 → 剧情事实或判断 → 对观看、人物、故事或制作的影响”改写；不改变评分、评级或证据，不调用额外的去 AI 味 Skill。
10. 读取[剧本信息](references/剧本信息.md)，填写剧本名称、题材、标签和剧情梗概。剧本信息只陈述事实，不混入卖点判断；报告直接使用列表，不使用表格，也不展示当前版本、频类或一句话介绍。
11. 读取[核心卖点](references/核心卖点.md)，提炼 1 至 3 项核心卖点，核对其观众吸引力和前、中、后段兑现情况。核心卖点在报告中与剧本信息平级，使用结论和分项说明，不使用表格。
12. 外部主编意见、用户批注或附件意见必须逐条回到正文核实。称谓、集数或事实不准确的意见不得直接写入报告。
13. 读取[准入标准](references/准入标准.md)，按固定顺序填写十项检查的结果、说明和原稿证据。先按索引确认正式集数：30 集及以上为通过，10 至 29 集为部分通过，少于 10 集为不通过；目标集数不参与此项判定。再判断内容密度；不得以未提供单集时长或分集标题替代判断。标题承诺兑现只能填写“通过”或“不通过”。说明固定为一条加粗的编辑结论：通过项只保留结论，部分通过或不通过项用一句话说明事实与问题；行号仅保存在原稿证据字段，不写入报告。再调用“检查准入标准”。十项全部为“通过/部分通过”时继续；任一项“不通过”时停止六维分析和评分，直接生成准入不通过报告，修改建议写入最终结论。
14. 准入后，通过多个 task 并行的高效读取六个维度资料并填写评分卡：市场与选题、故事结构与逻辑、人物与关系、单集节奏与留存、成片与制作、发行与风险。“发行与风险”必须对照 `maturity_target` 判断暴力、性、粗口和毒品呈现是否越界；每个维度先写一句明确、可直接给编辑使用的结论，再按资料规定的串行检查顺序填写一张表；细则只写检查项、评级、问题说明和原稿证据，不写修改建议。
15. 对每个检查项完成判断后，只在 `runtime/review-scoring.json` 填写 0-100 分的内部评分；不得自行归并或手写评分卡中的评级。六维完成后调用“计算审稿评分”，由工具按[评分表](references/评分表.json5)的权重计算检查项、维度和总分，并将对外评级同步至评分卡。分数、权重和内部评分状态不得写入评分卡、报告或用户可见页面。
16. 读取[评分与结论](references/评分与结论.md)，在评分工具同步评级后完成综合判定、维度结论和总体结论。综合判定提炼正文最主要的成立点、损耗位置和返修方向，不复述六维等级。对外只使用字母评级与“通过/可改进/不通过”，总体评级只可使用基础评级或 `+`，不使用负号。读取[审稿方法](references/审稿方法.md)，将固定评估流程原样写入“评级依据.审稿方法”。
17. 读取[问题分级与返修](references/问题分级与返修.md)，从低评级项归并 P0、P1 和人工复核事项。P0 展开原稿情况、问题影响和修改建议；P1 使用一句话建议。没有真实问题时明确为空，不得凑数。
18. 读取[审稿报告模板](references/审稿报告模板.md)，从评分卡生成报告。使用标准 Markdown 和固定章节，不写 HTML，不使用反问式或自问自答标题。加粗标签闭合后须留一个空格，例如 `**审核结论：** 返修`。每一节先给结论，再提供表格、事实或依据；不得出现审读、核对、工具、模型等过程化表述。按[审稿表达](references/审稿表达.md)逐句复核后再写入报告。准入后固定顺序为：
    - 审核结论：整体结论、剧本信息、核心卖点。
    - 准入标准：一句话准入结论和十项检查表。
    - 评级概述：先直接写综合判定，再依次写审读范围、固定审稿方法、维度结论。
    - 评分细则：先用一句话说明本稿最应关注的维度、对应检查项及其影响；维度名称和至少两项检查项使用 Markdown 加粗，后续对应行将以浅红底标记，再展开六维结论及细则表。
    - 修改建议：P0、P1。
    - 最终结论：当前处理结论和下一步顺序。
    - 准入不通过时只保留“审核结论 → 准入标准 → 最终结论”，总体评级显示“未评级”。
19. 调用“检查海外审稿”。未通过时，逐项按返回的 `repair_instructions` 修复评分卡、内部评分状态或报告，并再次检查；该返回已说明文件、字段、要求和修改动作，无需读取工具源码。检查通过后记录审稿结论、建议修改范围和报告依据。改编项目审稿结论为返修时，不修改任何剧本文件状态、不自动回退或生成；用户据报告自行决定需要调整的文件。“通过”进入用户确认。
20. 收到新的审稿要求时，先调用“记录用户要求”并重新读取偏好。报告通过后如用户实际修改了项目内容，改编项目才调用“返修路由”同步真实文件变更；独立审稿重新审读并生成新报告。

## 资料文件清单

- `review-input.json`：独立审稿的审稿模式、版本、市场、目标语、时长、内容分级和用户要求；独立审稿时读取。
- 当前台词译稿或待审剧本：所有目标语与制作判断的正文依据；改编和爆款复刻项目同时回读中文全稿，全文审读时读取。
- `output/爆款分析报告.md`：仅爆款复刻时深度阅读，用于核对报告中明确的剧情功能、冲突机制、权力关系和节奏承诺是否完成转化。
- `runtime/review-source-index.json`：分集结构、审读单元和机械统计；建立索引后读取。
- `runtime/review-coverage.json`、`runtime/review-ledger.json`：全文覆盖和逐单元审读记录；取证及检查时使用。
- `runtime/review-scoring.json`：仅供检查项打分、加权计算和评级同步；评分时读取和更新，禁止对外引用。
- [正文审读与取证](references/正文审读与取证.md)：全文审读、证据定位和台账填写规则；开始正文审读时读取。
- [审稿表达](references/审稿表达.md)：面向读者写结论、判断、问题说明和建议的自然表达规则；填写第一个用户可见字段前读取，并在报告生成前复核。
- [剧本信息](references/剧本信息.md)：剧本基础信息的提炼规则；填写剧本信息时读取。
- [核心卖点](references/核心卖点.md)：卖点识别、兑现核验和报告表达规则；提炼核心卖点时读取。
- [准入标准](references/准入标准.md)：十项准入门槛、结果口径和证据要求；六维分析前读取。
- [市场与选题](references/市场与选题.md)：市场与选题的串行检查规则；分析该维度时读取。
- [故事结构与逻辑](references/故事结构与逻辑.md)：第一集、一卡、中段与终局的检查规则；分析该维度时读取。
- [人物与关系](references/人物与关系.md)：主角、核心关系、对手和人物弧光的检查规则；分析该维度时读取。
- [单集节奏与留存](references/单集节奏与留存.md)：开场、情绪回报、单集任务和卡点的检查规则；分析该维度时读取。
- [成片与制作](references/成片与制作.md)：内容量承载、目标语、AI 画面和连续性规则；分析该维度时读取。
- [发行与风险](references/发行与风险.md)：用户粘性、传播潜力、内容合规性和价值观导向的串行检查规则；分析该维度时读取。
- [评分表](references/评分表.json5)：六维及检查项权重、满分和评级阈值；初始化和计算评分时由工具读取，不手动修改。
- [评分与结论](references/评分与结论.md)：综合判定和总体结论规则；评分工具同步评级后读取。
- [审稿方法](references/审稿方法.md)：报告固定的完整评估链路；填写评级概述时读取并原样使用。
- [问题分级与返修](references/问题分级与返修.md)：P0/P1 归并和返修范围规则；形成修改建议时读取。
- [审稿报告模板](references/审稿报告模板.md)：固定报告结构与表达要求；生成用户报告时读取。

## 工具清单

---
Tool name: 导入待审剧本
Tool description: 将 Word、PDF、TXT 或 Markdown 原稿转换为独立审稿可取证文本；没有审稿工作区时调用。
Usage:
node .claude/skills/foreign_review/scripts/prepare-review-source.mjs --workspace <审稿目录> --source <剧本路径>
---

---
Tool name: 初始化审稿
Tool description: 创建或升级评分卡、报告骨架、索引、覆盖记录和审读台账；正式审稿开始时调用。
Usage:
node .claude/skills/foreign_review/scripts/init-foreign-review.mjs --workspace <项目目录> --updated-by <用户>
---

---
Tool name: 读取用户需求
Tool description: 返回项目审稿所需的明确任务、发行和素材要求；项目审稿初始化后调用。
Usage:
node .claude/tools/get-user-requirements.mjs --workspace <项目目录>
---

---
Tool name: 建立审读索引
Tool description: 建立正文结构与机械统计，不作剧作判断。
Usage:
node .claude/skills/foreign_review/scripts/index-review-source.mjs --workspace <项目目录>
---

---
Tool name: 记录审读覆盖
Tool description: 记录已完成的正文范围；每完成一个审读范围后调用。
Usage:
node .claude/skills/foreign_review/scripts/record-review-coverage.mjs --workspace <项目目录> --start-line <行号> --end-line <行号>
---

---
Tool name: 写入审读台账
Tool description: 将每个审读单元的结论与正文证据写入内部台账。
Usage:
node .claude/skills/foreign_review/scripts/record-review-ledger.mjs --workspace <项目目录> --records <审读记录JSON路径>
---

---
Tool name: 检查准入标准
Tool description: 校验十项准入结果与原稿证据；集数达到 30 集通过，10 至 29 集部分通过，少于 10 集不通过。准入不通过时清除评分并停止六维分析。
Usage:
node .claude/skills/foreign_review/scripts/check-review-admission.mjs --workspace <项目目录>
---

---
Tool name: 计算审稿评分
Tool description: 准入通过后，根据内部评分状态和评分表计算六维及总体评级，并同步评分卡；所有检查项完成打分后调用。
Usage:
node .claude/skills/foreign_review/scripts/calculate-review-score.mjs --workspace <项目目录>
---

---
Tool name: 读取用户偏好
Tool description: 读取当前审稿步骤可用的用户要求与已启用的系统偏好。
Usage:
node .claude/tools/get-user-preferences.mjs --workspace <项目目录> --stage foreign_review
---

---
Tool name: 获取地区规则
Tool description: 返回目标地区的本地化规则。
Usage:
node .claude/tools/get-region-rules.mjs --workspace <项目目录> --stage foreign_review
---

---
Tool name: 读取小说高光原文
Tool description: 小说改编按小说解读中的原文索引读取高光正文，用于核对改编忠实度。
Usage:
node .claude/skills/novel_analysis/scripts/read-novel-source.mjs --workspace <项目目录> --index <L起始行-L结束行>
---

---
Tool name: 检查海外审稿
Tool description: 检查评分卡、全文证据、报告结构和内容顺序。
Usage:
node .claude/skills/foreign_review/scripts/check-foreign-review.mjs --workspace <项目目录> --updated-by <用户>
---

---
Tool name: 批准阶段
Tool description: 用户明确认可审稿报告后完成项目；仅在用户确认后调用。
Usage:
node .claude/tools/approve-stage.mjs --workspace <项目目录> --stage foreign_review --approved-by <用户>
---

---
Tool name: 记录用户要求
Tool description: 记录新增审稿要求，供本轮和后续返修读取。
Usage:
node .claude/tools/update-stage-preferences.mjs --workspace <项目目录> --stage foreign_review --content <要求> --updated-by <用户>
---

---
Tool name: 返修路由
Tool description: 报告通过后出现实质调整时，按最早受影响阶段回退，不删除现有文件。
Usage:
node .claude/tools/route-revision.mjs --workspace <项目目录> --stage <Skill 名称> --reason <返修原因> --updated-by <用户>
---
