# DISPATCH 回执（append-only）

> **追加约定**：每个工作槽完成后在文件末尾追加一节回执，不得修改或删除既有回执。
>
> 注：本分支（`cursor/w3-spec-model-gateway-replay-266c`）基于 `main @ deda75a`（无此文件）创建，
> 仅含本槽一节回执，不携带他槽回执副本；合并时按既定约定与其他分支版本取**并集追加**，
> 保留全部历史回执。

---

## 回执：W3 / 计划槽「TASK-P3-01 录制/回放网关规格」

- **日期**：2026-08-27（UTC）
- **槽位**：第 3 波 / 周期 W3 / 计划槽 TASK-P3-01 录制/回放网关规格（模型网关在 BLK-W1-02 未解除前提下的可实现级规格）
- **分支**：`cursor/w3-spec-model-gateway-replay-266c`（基于 `main @ deda75a`，docs-only，已 push，未开 PR）
- **产出**：
  - `docs/wave-03/spec-model-gateway-replay.md` — 可实现级规格：**三模式模型定稿**（`replay | record | live`，缺省一律 replay；record/live 显式 opt-in 且缺 key 结构化 fail、零静默降级；「无 key 时 CI 全绿」由「CI 不配任何 secret/网关变量 → 天然落 replay → fixtures 驱动」机制化，与 W2-Q1 裁定及 W2-Q1-T03 验收④逐字对齐）；**网关接口冻结**（`src/agent/gateway/` 目录契约承 P3 §1.3；`GatewayRequest/GatewayResponse/ModelGateway` 字段冻结 v1，`source: 'replay'|'live'` 如实标记防止回放产物顶替真实调用证据；`ProviderAdapter` 接口使 record/live 全部代码路径可用假适配器无凭据全量测试；`resolveGatewayMode`/`resolveAiKey` 双解析函数为唯一数据源；F3 重试退避 3 次逐字沿用、备用切换留位不实现；v1 网关是库模块、零 CLI 子命令）；**fixtures 目录与 schema v1 冻结**（`tests/fixtures/gateway/`，命中只认文件内指纹不认文件名、指纹重复即加载失败；顶层八键 schema、`metadata` 永不入库、latency 不 sleep 复现；指纹 = canonicalJSON(provider/model/messages/显式 params) 的 SHA-256，五条归一化规则定死）；**脱敏协议**（对齐证据约定 §5：白名单序列化使鉴权头/账户元数据无入库代码路径、写盘前字节级自查命中拒写、`lint:fixtures` 新增 CI 收紧门、`tests/` 夹具全文豁免边界 + 「record 只对夹具/演示项目」纪律）；**doctor `ai-key` 检查项对齐**（承 work-doctor §5 交接：六分支行为表——`enabled:false → pass` 不变、replay → skip 不适用、record/live 缺 key → fail + 可复制 fix、有 key → 离线存在性 pass、非法模式值 → fail；「无 key + 默认配置」恒零红项与 CI 绿同构；doctor 导入网关解析函数、diagnostics 零 env 副本、不注册新码）；**错误码提案 E040–E044**（E04x AI 供应商段首批：模式非法/缺凭据/回放未命中/供应商失败/夹具完整性，触达时登记，已核对与 E012/E013/E014/E03x/E05x 零冲突）；**验收测试清单 AT-G01…G12**（全部无凭据可跑）与 TASK-P3-01 三条原验收、W2-Q1-T03 验收④、work-doctor 交接项、GOAL-W1-03 的追溯矩阵；非目标 8 项（无流式、无多供应商路由、无模糊匹配、无预算强制、无在线 key 验证等）与细化决策 D1–D6 登记
  - `docs/wave-03/ready-tasks.md` — **WAVE03-AGENT 分区**（本分支仅此分区；WAVE03-PLAN/WAVE03-CHECK/WAVE03-DRAFT 各在其产出分支，合并取分区并集）：W3-AGENT-T01…T04（网关核心+replay 引擎、record 管线+脱敏+`lint:fixtures`+F3 重试、doctor ai-key 六分支升级、真实适配器+E4 存档收口），含与 TASK-P3-01/work-doctor 交接项的承接核销映射（TASK-P3-01 整体只在 T04 后标完成）、二值验收（引用规格 AT 编号）、依赖图；T01–T03 blocked 于 W3-PLAN-T02（集成分支头纪律），**仅 T04 blocked 于 BLK-W1-02**，W2-Q1-T03 不重复立项（直接消费本规格 fixtures）
  - `docs/DISPATCH-receipt.md` — 本回执（本分支仅此一节，合并取并集）
- **关键结论**：① BLK-W1-02 被本规格**切开而非解除**——TASK-P3-01 的模块、接口、回放引擎、录制管线、脱敏门、doctor 接线全部无凭据可交付并全量测试（假适配器注入），唯「一次真实调用 E4 证据」收口在 W3-AGENT-T04 等凭据；② 「网关默认 replay、无 key 时 CI 全绿」从纪律变为机制：CI 零 secret + 缺省 replay + fixtures 入库 + record/live 缺 key 即 fail，四件事互相咬合，任何一件被破坏都有对应 AT 断言红；③ doctor `ai-key` 检查项升级路径与 CI 绿严格同构（无 key + 默认配置恒零红项），且与网关共用解析函数封死两处漂移；④ fixture schema 与指纹算法 v1 冻结是回放确定性的根——变更即破坏性（全库失配），已在规格与任务风险条款双重登记；⑤ 登记 6 项细化决策（D1 模式走环境变量不进 project.yaml、D2 单 key 变量、D3 fixtures 置于 tests/ 下、D4 replay 报 skip 非 pass、D5 五码分立、D6 指纹只哈希显式 params），均附理由与弃选原因供调度器复核。
- **复用声明**：只读引用 `main` 与 9 条远端分支（w1-p3 方案与 TASK-P3-01 原文、w1-c 对账清单、w2-q1 裁定与 T03 验收、w3-doctor 的 aiKeyCheck 实现与交接条款、集成分支的错误注册表/CI/atomicFile、w2-evidence 脱敏与 CI 红线、w3-integration-map 的 §5 纪律与 WAVE03-PLAN 队列、w3-spec-check-snapshot 与 w3-spec-draft-export-revise 的分区与错误码占位核对），未改写未覆盖任何他槽产出；未携带 `docs/README.md` 副本（索引追加行已写入规格文首供合并者粘贴）。
- **阻塞**：无新增。BLK-W1-02 状态未变（解除判定与登记在基线侧）；提示一条：W3-AGENT-T03 依赖 doctor 实现并入集成线，而 doctor 分支不在集成图 §4 的 W2 四源梯队内，其并线安排需调度器在集成收尾时裁定（本分区已在依赖列显式登记，不抢跑）。
- **合规声明**：未创建子代理；未创建 PR；未使用 Task；本槽 docs-only、未触碰 `src/`（集成进行中纪律，基于 `main @ deda75a`）；未删测试、未跳过失败、未降低 CI 标准（规格与任务队列明确「CI 门不可降标、`lint:fixtures` 只增不减、错误码触达同提交登记、CI 零新增 secret」）；未合并任何内容进 `main`。
