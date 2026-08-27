# Wave-03 就绪任务队列（Ready Tasks）

> **追加约定（append-only）**：沿用 wave-01/wave-02 同名文件的分区纪律——每个槽的内容包裹在
> `<!-- BEGIN:xxx -->` / `<!-- END:xxx -->` 标记之间；各槽**只在文件末尾追加自己的分区**，
> 不修改、不覆盖其他分区的有效内容。对已有分区的勘误由原槽负责人以追加「修订记录」小节完成。
> 任务 ID 格式 `W{波次}-{槽位}-T{序号}`，全库唯一，被引用后不得复用或改义。
>
> 说明：本文件在分支 `cursor/w3-spec-model-gateway-replay-266c` 上基于 `main @ deda75a`（无此文件）创建，
> **仅含 WAVE03-AGENT 分区**。既有 wave-03 分区分布：WAVE03-PLAN 在 `cursor/w3-integration-map-bf24`、
> WAVE03-CHECK 在 `cursor/w3-spec-check-snapshot-973a`、WAVE03-DRAFT 在 `cursor/w3-spec-draft-export-revise-193d`
> 的同名文件。合并时按 BEGIN/END 分区标记取**并集**拼接即可，本分区未改写任何既有分区的任何内容，无冲突。

---

<!-- BEGIN:WAVE03-AGENT -->
## WAVE03-AGENT 模型网关录制/回放实现任务（TASK-P3-01 规格细化产出）

- 来源规格：[`docs/wave-03/spec-model-gateway-replay.md`](./spec-model-gateway-replay.md)（下称「规格」；模式模型 §3、接口 §4、fixtures §5、脱敏 §6、doctor 对齐 §7、错误码提案 §8、验收清单 §9 AT-G01…G12）
- 产出分支：`cursor/w3-spec-model-gateway-replay-266c`
- **与既有任务的承接映射**（原任务 ID 不复用不改义，实现槽提交信息同时引用两个 ID）：
  W3-AGENT-T01+T02 细化并核销 **TASK-P3-01 的无凭据部分**（E1 模块入库 + 凭据零明文）；W3-AGENT-T03 核销 **work-doctor §5 的 aiKeyCheck 交接项**；
  W3-AGENT-T04 收口 **TASK-P3-01 的真实调用验收（E4）**——TASK-P3-01 整体只在 T04 完成后方可标完成。
  **W2-Q1-T03 不在本分区重复任务化**（仍以原任务号执行，其回放夹具直接消费本规格 §5 的 schema 与目录）。
- 公共约束：**基分支一律取集成分支头**（集成图 §5：功能槽禁止再从 scaffold 或单个 W2/W3 分支分叉），故 T01–T03 blocked 于 W3-PLAN-T02；CI 门不可降标（lint / lint:errors / typecheck / test / build / smoke / smoke:exit-codes 全绿 0 跳过，`lint:fixtures` 为新增收紧步骤）、测试只增不减；错误码（SW-E040…E044）在实际触达的同一提交内登记 + `gen:errors`；**CI 不新增任何 secret、不设置网关环境变量**（规格 §3.4）；不开 PR。
- 凭据纪律（BLK-W1-02）：T01–T03 **全部无模型凭据可完成**（假适配器注入，规格 §4.2）；仅 T04 等凭据。任何以「等凭据」为由挂起 T01–T03 的做法违反 W2-Q1 裁定。
- 工作量为技术规模（S/M/L），非日历时间。

### 总览

| 任务 ID | 名称 | 对应依据 | 优先级 | 工作量 | 依赖 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| W3-AGENT-T01 | 网关核心：模式/凭据解析 + replay 引擎 + fixture schema v1 + 指纹 | 规格 §3、§4.1–4.3、§5.2–5.5；承接 TASK-P3-01 | P0 | M | W3-PLAN-T02 | blocked(W3-PLAN-T02) |
| W3-AGENT-T02 | record 管线 + 脱敏自查 + `lint:fixtures` CI 门 + F3 重试 | 规格 §4.4、§5.6、§6 | P0 | M | W3-AGENT-T01 | blocked(T01) |
| W3-AGENT-T03 | doctor `ai-key` 检查项升级（行为表六分支） | 规格 §7；承接 work-doctor §5 交接项 | P1 | S | W3-AGENT-T01、doctor（`cursor/w3-doctor-3e3d`）并入集成线 | blocked(T01, doctor 并线) |
| W3-AGENT-T04 | 真实供应商适配器 + 一次真实调用 E4 脱敏存档（TASK-P3-01 收口） | 规格 §4.2、§9.2；TASK-P3-01 验收 E4 | P1 | M | W3-AGENT-T01、T02、**BLK-W1-02 解除** | blocked(BLK-W1-02) |

依赖图：`W3-PLAN-T02 → T01 → { T02 ∥ T03 }`；`{ T01, T02, BLK-W1-02 } → T04`。T03 另需 doctor 实现在同一集成线上可用（doctor 是 W3 落地分支，不在 W2 四源分支内，其并线动作由集成/调度侧安排——T03 领取前先确认 `DOCTOR_CHECKS` 在基分支存在）。

### 任务明细

#### W3-AGENT-T01 · P0 · 网关核心：模式/凭据解析 + replay 引擎 + fixture schema v1 + 指纹

- **目标**：按规格 §3–§5 交付 `src/agent/gateway/`：`resolveGatewayMode`（默认 replay，非法值 SW-E040）、`resolveAiKey`（`SW_AI_KEY`，空白视同未设置）、`types.ts` 冻结类型（`GatewayRequest/GatewayResponse/ModelGateway`，`source` 字段如实标记）、`createGateway` 工厂（mode/env/fixturesDir/adapters/defaultProvider 全注入点）、replay 引擎（递归索引 `tests/fixtures/gateway/**/*.json`，命中只认 `fingerprint` 字段，未命中 SW-E042，指纹重复/schema 破损 SW-E044）、指纹算法（canonicalJSON + SHA-256，§5.4 五条规则）、指纹辅助脚本 `scripts/gateway-fingerprint.ts`、`tests/fixtures/gateway/README.md`（目录说明 + 脱敏声明 + 重录方法 + §6.4 夹具豁免边界）。record/live 在本任务只做模式识别与缺 key 拦截（SW-E041），真实/假出网路径随 T02。
- **文件范围**：`src/agent/gateway/`（新目录）、`scripts/gateway-fingerprint.ts`、`tests/fixtures/gateway/README.md` 与首批网关自测夹具、`tests/agent/`（新增测试）、`registry.ts` + `docs/errors/`（触达码登记与生成物）。**不触碰** `src/cli/`（v1 无命令面，规格 §4 前注）。
- **验收标准（二值）**：规格 AT-G01、AT-G02、AT-G03、AT-G04、AT-G05、AT-G08 全绿；全套 CI 门通过（无凭据环境，AT-G09 的 T01 范围子集）；`lint:errors` 全绿（E040/E041/E042/E044 中实际触达的码已登记、无未注册码字面量、无预填未用码）。
- **风险**：指纹算法一旦有 fixture 入库即冻结（规格 §5.4-5）——实现期先用充分单测锁定 canonicalJSON 语义（键序无关/params 归一/metadata 排除）再录首批夹具，避免返工重录。
- **依赖**：W3-PLAN-T02（集成分支头：错误框架 `fail()`、`writeFileAtomic`、CI 七步均就位）。

#### W3-AGENT-T02 · P0 · record 管线 + 脱敏自查 + `lint:fixtures` CI 门 + F3 重试

- **目标**：按规格 §4.4/§5.6/§6 交付：`ProviderAdapter` 接口 + 静态注册表（真实适配器不在本任务，测试用假适配器注入）；record 落盘管线（白名单字段构造 → 指纹 → §6.2 写盘前字节级自查（含 key 串与通用凭据模式，命中拒写）→ `writeFileAtomic` → 同指纹幂等/覆盖语义 §5.6-3）；F3 重试（可重试错误指数退避上限 3 次耗尽 SW-E043，不可重试直达，replay 零重试，注入时钟测试）；`scripts/lint-fixtures.ts` + npm script `lint:fixtures`（schema v1 结构、指纹自洽与唯一、凭据模式零命中）并作为**新增收紧步骤**进 CI。
- **文件范围**：`src/agent/gateway/`（provider.ts、record 管线、retry）、`scripts/lint-fixtures.ts`、`package.json` scripts、`.github/workflows/ci.yml`（仅新增 `lint:fixtures` 步骤——CI 修改属收紧允许面，回执单独列出并附前后对比）、`tests/`（假适配器 + 管线与重试测试）。
- **验收标准（二值）**：规格 AT-G06、AT-G07、AT-G10、AT-G11 全绿；AT-G09 全量通过（清空网关环境变量跑含 `lint:fixtures` 的全套 CI 门，全绿 0 跳过）；SW-E043 与 SW-E044 录制变体触达即登记。
- **风险**：脱敏靠白名单构造而非事后清洗（规格 §6.1）——review 重点盯「任何把原始 HTTP 请求/响应整包序列化」的代码路径，出现即打回；写盘自查是纵深防御，不是主防线。
- **依赖**：W3-AGENT-T01。

#### W3-AGENT-T03 · P1 · doctor `ai-key` 检查项升级（行为表六分支）

- **目标**：按规格 §7.2 行为表替换 `src/app/diagnostics/checks.ts` 的 `aiKeyCheck`「未实现」分支：#1/#2 分支文案零改动；#3 replay → skip（不适用文案含切换指引）；#4 record/live 缺 key → fail + 可复制 fix（`export SW_AI_KEY=…` 或 `unset SW_GATEWAY_MODE`）；#5 有 key → pass（存在性检查、离线不验证有效性的诚实文案）；#6 非法模式值 → fail + 合法值清单。**单一数据源**：导入网关 `resolveGatewayMode`/`resolveAiKey`，diagnostics 层零 env 解析副本；不注册新错误码（红项聚合走既有 SW-E013）。
- **文件范围**：`src/app/diagnostics/checks.ts`（`aiKeyCheck` 替换 + `DoctorContext` 注入 env 的最小扩展）、`tests/app/diagnostics.spec.ts` 与 `tests/cli/doctor.spec.ts`（六分支断言追加；既有断言只增不删）。
- **验收标准（二值）**：规格 AT-G12 全绿（含「无 key + 默认配置环境 doctor 零红项、退出码 0」的一致性断言）；doctor 既有测试全数存活；`rg 'SW_GATEWAY_MODE|SW_AI_KEY' src/app/diagnostics/` 只命中 import 的消费点、无字面量解析逻辑。
- **风险**：低。唯一敏感点是 doctor 与网关的解析函数版本漂移——单一数据源约束（规格 §7.3）已封死，review 核对 import 即可。
- **依赖**：W3-AGENT-T01；doctor 实现（`cursor/w3-doctor-3e3d`）已并入基分支（并线动作归集成/调度侧，本任务不自行合并他槽分支）。

#### W3-AGENT-T04 · P1 · 真实供应商适配器 + 一次真实调用 E4 脱敏存档（TASK-P3-01 收口）

- **目标**：BLK-W1-02 解除（供应商与凭据定案）后：实现首个真实 `ProviderAdapter`（HTTP、超时、错误归一化并剥离账户标识）；以 live 或 record 完成**一次返回剧本创作相关内容的真实调用**，按规格 §9.2 字段清单落 E4 证据至 `docs/evidence/wave-<NN>/TASK-P3-01/`（模型名、采样参数、prompt 概要、响应内容、usage、latencyMs、`source:'live'`、脱敏声明 + 证据约定 §5-5 自查零命中）；D2 变量命名如需按供应商拆分在落地说明登记；record 首批真实 fixtures 经 `lint:fixtures` 入库。完成后 TASK-P3-01 方可整体标完成（提交信息同时引用 TASK-P3-01 与本 ID）。
- **文件范围**：`src/agent/gateway/`（真实适配器）、`tests/`（适配器归一化测试——仍用注入桩，不在 CI 打真实请求）、`docs/evidence/wave-<NN>/TASK-P3-01/`、`tests/fixtures/gateway/`（真实录制夹具，脱敏门约束不变）。
- **验收标准（二值）**：TASK-P3-01 原验收三条逐条核销（E1 已由 T01/T02 覆盖、E4 存档齐备、`rg` 全库凭据零明文）；CI 在无凭据环境仍全绿（真实调用只发生在持凭据的本地/联调环境，CI 行为与 T02 交付态零差异）。
- **风险**：供应商协议与 D2 变量拆分属未定项——落地说明登记决策即可，禁止回头改动已冻结的 fixture schema 与指纹算法（改动即触发规格修订流程）。
- **依赖**：W3-AGENT-T01、W3-AGENT-T02、**BLK-W1-02 解除**（解除判定与登记在基线侧，本分区不代宣）。

### 领取与状态约定

沿用既有分区约定：领取任务的执行槽位在对应任务明细末尾追加一行 `> 状态：<领取|完成> —— <槽位> / <日期> / <分支或commit>`；完成判定以验收标准逐条核对为准，证据不合格视为未完成。W3-AGENT-T01/T02 领取时须在状态行注明「E04x 触达登记、无预填」；W3-AGENT-T03 领取时须注明「单一数据源，diagnostics 零 env 副本」；W3-AGENT-T04 领取前确认 BLK-W1-02 已在基线侧登记解除。

### 修订记录

（暂无）
<!-- END:WAVE03-AGENT -->
