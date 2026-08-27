# W3 规格细化：模型网关录制/回放形态（TASK-P3-01 无凭据可实现规格）

| 项目 | 内容 |
| --- | --- |
| 波次 / 槽位 | 第 3 波 / 周期 W3 / 计划槽「TASK-P3-01 录制/回放网关规格」 |
| 仓库 | github.com/Dawan2/script-writer |
| 基线 | `main @ deda75a`（docs-only；集成进行中，按集成图 §5 纪律禁止触碰 `src/`） |
| 工作分支 | `cursor/w3-spec-model-gateway-replay-266c`（已 push，未开 PR） |
| 文档性质 | 可实现级规格（SPEC）：把 TASK-P3-01（模型网关）在 **BLK-W1-02（凭据未定）仍未解除**的前提下细化到「实现槽拿到即可开工」——三模式模型、接口、fixtures 目录与 schema、脱敏协议、doctor `ai-key` 检查项对齐、错误码提案与验收测试逐条定死 |
| 上游依据 | `docs/wave-01/P3-agent-intelligence.md` §1.3（网关层职责）/§2.4 F3（重试）/§2.7（脱敏）/§6 R-2（录制/回放裁定）；`docs/wave-01/ready-tasks.md` TASK-P3-01；W1-C 盘点 C1 行与缺口登记（`cursor/w1-c-agent-tooling-inventory-0ec2`）；W2-Q1 裁定「网关继续录制/回放，不得阻塞非模型路径」与 W2-Q1-T03 验收④（`cursor/w2-q1-p2-cli-adaptation-1f96`）；doctor `ai-key` 检查项现实现与交接条款（`cursor/w3-doctor-3e3d`）；SPEC-03 错误框架 E04x 段位（`cursor/w3-integrate-w2-f334` 注册表）；证据与 CI 约定 §5 脱敏 / §6 CI 红线（`cursor/w2-evidence-ci-conventions-a17c`）；集成图 §5 基分支纪律（`cursor/w3-integration-map-bf24`） |
| 配套文档 | `docs/wave-03/ready-tasks.md` WAVE03-AGENT 分区（W3-AGENT-T01…T04）、`docs/DISPATCH-receipt.md`（回执） |

> **给合并者的索引行**（并入 `docs/README.md` 时粘贴到 wave-03 分区）：
> `- [wave-03/spec-model-gateway-replay.md](./wave-03/spec-model-gateway-replay.md) — TASK-P3-01 模型网关的录制/回放可实现规格：三模式（默认 replay）、网关接口、fixtures 目录与 schema v1、脱敏协议、doctor ai-key 检查项对齐、E04x 错误码提案、验收测试清单 AT-G（W3 计划槽）`

---

## 1. 结论（TL;DR）

1. **网关默认 replay，无 key 时 CI 全绿是硬性设计约束而非巧合**：网关三模式 `replay | record | live`，缺省一律 `replay`（§3）。replay 不出网、不需要任何凭据，全部模型响应来自入库 fixtures（§5）；`record` / `live` 属显式 opt-in 且缺 key 即 fail（结构化错误，非静默降级）。CI 环境不配置任何模型凭据与网关环境变量，因此天然落在 replay——「无凭据环境 CI 全绿」由此机制化，与 W2-Q1 裁定（网关继续录制/回放，不得阻塞非模型路径）和 W2-Q1-T03 验收④逐字对齐。
2. **BLK-W1-02 不因本规格解除，但被切开了**：TASK-P3-01 原验收里「一次真实调用的脱敏存档（E4）」仍等凭据；其余全部工作——网关模块、供应商适配器接口、replay 引擎、fixture schema、脱敏录制器、doctor 接线——无凭据即可交付并全量测试（假适配器注入，§4.2）。切分结果任务化为 W3-AGENT-T01…T04（ready-tasks WAVE03-AGENT 分区），仅 T04（真实联调收口）blocked 于 BLK-W1-02。
3. **doctor `ai-key` 检查项的升级路径定死**（§7）：现「未实现」skip 分支在网关落地后替换为五行为表——`enabled:false → pass`（不变）、replay（默认）→ skip「不适用，无需 key」、record/live 缺 key → fail + 可复制修复命令、record/live 有 key → pass（离线存在性检查，不打真实请求）。任何分支都不会让「无 key + 默认配置」的环境出红项，doctor 与 CI 的绿保持一致。检查项与网关共用同一模式/凭据解析函数（单一数据源，禁止 diagnostics 层复制 env 解析副本）。
4. **fixtures 与 trace/evidence 三者边界定死**（§5.1）：fixtures 是**测试夹具**，入 git（`tests/fixtures/gateway/`，命中只认指纹字段不认文件名）；`runs/*.jsonl` 是运行轨迹，gitignore（TASK-P3-04 职责，网关不写）；`docs/evidence/` 是脱敏摘要存档（证据约定 §3.2）。录制器以**白名单序列化**落 fixture（鉴权头等根本不进序列化对象），外加写盘前 key 字符串字节级自查与 `lint:fixtures` CI 门（§6）。
5. 错误码提案 **SW-E040…E044**（E04x AI 供应商段首批占用，§8）：模式值非法 / 缺凭据 / fixture 未命中 / 供应商失败重试耗尽 / fixture 损坏。遵守「禁止预填未用码」——实现槽在实际触达的同一提交登记 + `gen:errors`；已核对与 E012（锁预留）/E013（doctor）/E014（check 提案）/E05x（快照提案）零冲突。

---

## 2. 输入基线与一致性锚点

### 2.1 本规格向既有事实看齐的锚点（实现槽照此接线，不重造）

| 锚点 | 出处（分支 @ 位置） | 本规格的消费方式 |
| --- | --- | --- |
| 网关层职责四要素：供应商适配、重试、限额、脱敏 | P3 方案 §1.3 分层图「模型网关层」 | §4 接口按四要素切分；限额（预算硬顶 F4）属编排层计数、网关只上报 usage，不在网关内实现预算逻辑 |
| 录制/回放裁定 | P3 方案 §6 R-2：「网关先以录制/回放（fixture）模式开发与测试，凭据到位后补真实调用证据」；TASK-P3-01 依赖注记同文 | 本规格就是该裁定的可实现化；「补真实调用证据」收口在 W3-AGENT-T04 |
| 非模型路径不阻塞纪律 | W2-Q1 裁定：「P3 网关继续录制/回放，不得阻塞非模型路径」「任何以『等凭据』为由挂起的做法都违反本裁定」；W2-Q1-T03 验收④「全部用例以录制/回放 fixture 驱动，无模型凭据环境 CI 全绿」 | §3.4 把「无 key CI 全绿」定为二值验收（AT-G09）；W2-Q1-T03 是本规格 fixtures 的直接下游消费方，schema v1 冻结后其不需自造格式 |
| F3 重试策略 | P3 方案 §2.4 策略表：供应商错误/超时 → 指数退避 3 次；备用模型切换 1 次 | §4.4 逐字沿用退避 3 次；**备用模型切换 v1 不做**（单 provider，见 §10 非目标），策略表位置保留 |
| 脱敏原则 | P3 方案 §2.7 规则 1（凭据永不落盘；正文默认只存引用）；证据与 CI 约定 §5 全部五条与自查命令 | §6 逐条映射到 fixture 场景；自查命令扩展到 `tests/fixtures/gateway/` 并建议固化为 `lint:fixtures` |
| doctor `ai-key` 检查项现实现 | `cursor/w3-doctor-3e3d @ src/app/diagnostics/checks.ts` `aiKeyCheck`：findings 空 → skip；`settings.ai.enabled:false` → pass；启用 → skip「未实现——供应商网关属 TASK-P3-01」；work-doctor §5 交接：「网关落地后替换 aiKeyCheck 的『未实现』分支为真实 key 校验（E04x 段错误码按 SPEC-03 注册）」 | §7 给出替换后的完整行为表与单一数据源约束；skip/pass/fail 三态语义沿用 doctor 注册表（skip 不计红） |
| `settings.ai` schema | `src/core/model/project.ts`：`AiSettings { enabled: boolean; provider: string | null }`，默认 `{ enabled: false, provider: null }`（P1「AI 为可空适配器」） | §4.3 供应商选择从 `settings.ai.provider` 读取；schema 零改动（仍为 1） |
| 错误码段位与登记纪律 | SPEC-03 注册表（集成分支 `registry.ts`）：E04x = AI 供应商段，现空置——「禁止预填未用码（AI 段 SW-E04x 待 AI 适配器落地再登记）」；`fail(code, ctx)` 唯一入口；`gen:errors` / `lint:errors` 防漂移 | §8 提案 E040–E044，实现槽触达时登记；与 E014/E050–E053（check/快照规格提案）零冲突 |
| 证据类型与归档 | 证据与 CI 约定 §1（`docs/evidence/wave-<NN>/<TASK-ID>/`）、§3.2 E4 行「模型调用记录…字段细节以 TASK-P3-01/P3-04 验收标准为准」 | §9.2 把 E4 真实调用存档的字段清单定死（W3-AGENT-T04 消费） |
| CI 门与只增不减纪律 | 集成分支 CI 七步（lint / lint:errors / typecheck / test / build / smoke / smoke:exit-codes，Node 20/22 矩阵）；证据约定 §6.4 禁止清单、§6.6「CI 修改只允许新增步骤或收紧」 | §6.3 的 `lint:fixtures` 为**新增收紧步骤**（合规）；CI 不新增任何 secret（§3.4） |
| 基分支纪律 | 集成图 §5：集成完成前并行槽 docs-only 基于 main；集成完成后的功能槽一律基于集成分支头 | 本槽 docs-only；W3-AGENT-T01…T03 全部 blocked 于 W3-PLAN-T02（集成分支头） |
| trace 边界 | TASK-P3-04（trace 最小实现）：JSONL 事件流、`runs/` gitignore | 网关**不写** `runs/`；只在返回值中带足 `llm_call` 事件所需字段（usage/latency/source，§4.1），落盘归 P3-04 |

### 2.2 术语

- **fixture**：一次模型调用的「请求指纹 + 录制响应」JSON 文件，入 git，是 replay 模式的唯一数据源。
- **指纹（fingerprint）**：请求的规范化哈希（§5.4），fixture 命中的唯一键。
- **模式（mode）**：网关运行形态 `replay | record | live`（§3.1）。
- **假适配器（fake adapter）**：测试注入的 `ProviderAdapter` 实现（进程内、不出网），用于无凭据测试 record/live 代码路径（§4.2）。

---

## 3. 模式模型：replay 默认，record/live 显式 opt-in

### 3.1 三模式语义

| 模式 | 出网 | 需要 key | 读 fixtures | 写 fixtures | 用途 |
| --- | --- | --- | --- | --- | --- |
| `replay`（**默认**） | 否 | 否 | 是（命中失败即 fail，见 §8 E042） | 否 | CI、全部自动化测试、无凭据环境的一切运行 |
| `record` | 是 | 是（缺 key → fail E041） | 否 | 是（经 §6 脱敏管线） | 开发者本地手动录制/更新 fixtures；**CI 禁止**（§3.4） |
| `live` | 是 | 是（缺 key → fail E041） | 否 | 否 | 凭据到位后的真实运行形态（生产/联调） |

- 三模式共用同一 `ModelGateway` 接口（§4.1），调用方无感知；`GatewayResponse.source` 字段（`'replay' | 'live'`）如实标记响应来源，供 trace 与 W5 证据区分——**回放产物不得充当「真实调用」E4 证据**（TASK-P3-01 原验收的「真实调用」以 `source:'live'` 或 record 联调记录为准）。
- record 成功后返回值与 live 相同（响应来自真实供应商），`source:'live'`；副作用是按 §5/§6 落一个 fixture 文件。
- **没有静默降级**：record/live 缺 key 不回落 replay，replay 未命中不偷跑网络。每个失败面都是结构化错误（§8），这是「回放驱动的测试是确定性的」的前提。

### 3.2 模式解析（唯一函数，doctor 共用）

解析优先级（高 → 低）：

1. **编程注入**：`createGateway({ mode })` 显式传入（测试与未来编排层用）；
2. **环境变量 `SW_GATEWAY_MODE`**：合法值 `replay | record | live`（全小写逐字），非法值 → fail `SW-E040`（不猜测、不回落默认）；
3. **默认 `replay`**。

约束：

- 解析实现为网关模块导出的纯函数 `resolveGatewayMode(env)`（入参注入 `process.env` 以便测试），**doctor 的 `ai-key` 检查项必须导入同一函数**（§7.3），禁止在 diagnostics 层写第二份 env 读取逻辑。
- 不引入项目级配置字段：`project.yaml` 的 `settings.ai` 仍只有 `enabled`/`provider` 两键（schema 零改动）——模式是**运行环境属性**（同一项目在 CI 回放、在开发者机器录制），不是项目属性。

### 3.3 凭据解析（唯一函数，doctor 共用）

- 凭据唯一来源：环境变量 **`SW_AI_KEY`**（P3 方案「凭据从环境注入且永不落盘」的具体化）。v1 单变量：供应商由 `settings.ai.provider` 选择，key 随环境切换，不做 per-provider 变量矩阵（BLK-W1-02 连供应商都未定，多变量命名是无据猜测；真实供应商定案后如需拆分，由 W3-AGENT-T04 在落地说明登记）。
- 解析函数 `resolveAiKey(env)`：返回「非空白字符串」或 `null`（空串/纯空白视同未设置）。**key 值不进任何日志、错误消息、trace、fixture**——错误文案只说「环境变量 `SW_AI_KEY` 未设置」，永不回显值。
- replay 模式**完全不读** `SW_AI_KEY`（即使设置了也不消费）——保证回放路径与凭据零耦合。

### 3.4 「无 key 时 CI 全绿」的机制化（二值可验）

1. CI 工作流**不新增任何 secret**、不设置 `SW_GATEWAY_MODE` / `SW_AI_KEY`——CI 环境天然落在默认 replay。
2. 仓库内全部测试（单元/集成/冒烟）在 replay 模式或假适配器注入下运行，**零真实网络依赖**；任何「需要真实 key 才能跑」的测试都不得进入测试套件（等价于把 CI 绿寄托在凭据上，违反 W2-Q1 裁定）。
3. record 模式在 CI 的双保险：CI 无 key（record 会 fail E041）+ 纪律禁止在 CI 步骤设置网关环境变量（证据约定 §6.6 的 CI 修改纪律覆盖）。
4. 验收：AT-G09（§9.1）在清空 `SW_GATEWAY_MODE`/`SW_AI_KEY` 的环境跑全套 CI 门，全绿 0 跳过。

---

## 4. SPEC-G1：网关接口（`src/agent/gateway/`）

> 目录契约沿用 P3 §1.3：`src/agent/gateway/`。ADR-0001 已定 TypeScript/ESM/Node≥20，本节直接给 TS 接口（P3 撰写时的「栈中立」约束已被选型解除）。**v1 网关是库模块，不新增任何 `sw` 子命令**——用户可见接触面只有 doctor 的 `ai-key` 检查项（§7）；`sw` 命令层的 AI 功能属 TASK-P3-02+ 与后续波次。

### 4.1 核心类型与网关接口

```ts
// src/agent/gateway/types.ts（字段冻结 v1；扩展走可选字段，不破坏既有 fixture）

/** 一次补全请求。message 结构对齐主流 chat 形态，v1 只用 system/user/assistant 三角色。 */
export interface GatewayRequest {
  /** 供应商适配器 id（缺省取 project settings.ai.provider；两处皆空 → fail SW-E040 供应商未指定现场） */
  provider?: string;
  /** 模型名（透传给适配器；参与指纹） */
  model: string;
  messages: ReadonlyArray<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  /** 采样参数：只收显式传入的键（参与指纹，见 §5.4 归一化规则） */
  params?: Readonly<Record<string, string | number | boolean>>;
  /** 运行元数据：不参与指纹、不进 fixture（runId 等易变项），仅透传给 trace 消费方 */
  metadata?: { runId?: string };
}

export interface GatewayUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface GatewayResponse {
  content: string;
  finishReason: 'stop' | 'length' | 'content_filter' | 'other';
  usage: GatewayUsage;
  /** 真实调用为实测值；replay 为 fixture 记录的原值（不 sleep 复现延迟） */
  latencyMs: number;
  model: string;
  /** 响应来源如实标记：replay 产物不得充当真实调用证据 */
  source: 'replay' | 'live';
}

export interface ModelGateway {
  complete(request: GatewayRequest): Promise<GatewayResponse>;
}
```

### 4.2 供应商适配器接口（真实实现等凭据，假实现即刻可测）

```ts
// src/agent/gateway/provider.ts
export interface ProviderAdapter {
  /** 适配器 id（与 settings.ai.provider / fixture 的 provider 字段对账） */
  readonly id: string;
  /** 真实调用：实现负责 HTTP、超时、供应商错误归一化；不实现重试（重试归网关 §4.4） */
  complete(request: GatewayRequest, key: string): Promise<GatewayResponse>;
}
```

- **真实适配器**（HTTP 实现）属 W3-AGENT-T04（blocked BLK-W1-02：供应商未定，端点/协议无据可写）。
- **假适配器**属测试基础设施（`tests/` 内，进程内实现、不出网）：record/live 的全部代码路径（key 校验、重试、脱敏录制、指纹落盘）用假适配器注入即可全量测试——这就是「无凭据也能交付 record 代码」的机制。
- 适配器注册 v1 为静态映射（`Record<string, ProviderAdapter>` 常量 + 构造注入覆盖），不做动态发现/插件机制（§10 非目标）。

### 4.3 工厂与装配

```ts
// src/agent/gateway/index.ts
export interface GatewayOptions {
  mode?: GatewayMode;                       // 缺省走 resolveGatewayMode(env)
  env?: NodeJS.ProcessEnv;                  // 缺省 process.env（测试注入点）
  fixturesDir?: string;                     // 缺省 tests/fixtures/gateway（§5.2；测试注入临时目录）
  adapters?: Record<string, ProviderAdapter>; // 缺省内置注册表（测试注入假适配器）
  defaultProvider?: string | null;          // 调用方从 project settings.ai.provider 传入
}
export function createGateway(options?: GatewayOptions): ModelGateway;

export type GatewayMode = 'replay' | 'record' | 'live';
export function resolveGatewayMode(env: NodeJS.ProcessEnv): GatewayMode; // §3.2；非法值 fail SW-E040
export function resolveAiKey(env: NodeJS.ProcessEnv): string | null;     // §3.3
```

- 网关不读 `project.yaml`（保持库层零项目 IO）；`settings.ai.provider` 由消费方（未来编排层 / doctor）读出后经 `defaultProvider` 传入。
- 全部失败路径经 SPEC-03 `fail(code, ctx)` 抛出（§8），由消费方的 CLI 顶层渲染；网关自身零 `console.*`、零 `process.exit`（既有 ESLint 拦截适用）。

### 4.4 重试（F3 的网关落点）

- 仅 record/live 适用：适配器抛出的**可重试错误**（网络/超时/5xx/限流——适配器负责归一化标注）按指数退避重试，**上限 3 次**（P3 §2.4 F3 逐字）；耗尽 → fail `SW-E043`。
- 不可重试错误（4xx 鉴权/参数类）直接 fail `SW-E043`（why 段带适配器归一化后的原因，剥离账户标识，§6）。
- replay 不重试：fixture 命中是确定性 IO，未命中直接 `SW-E042`。
- 备用模型切换（F3 表「切换 1 次」）v1 不做（单 provider 前提下无从切换），策略表位置在实现注释中标注留位。
- 退避基数与抖动由实现槽定（建议 500ms 基数 ×2 退避 + 全抖动），测试用注入时钟（fake timers）断言重试次数与退避序列，不真实等待。

---

## 5. SPEC-G2：fixtures 目录与 schema

### 5.1 三类产物边界（谁入 git、谁不入）

| 产物 | 位置 | git | 写入方 | 消费方 |
| --- | --- | --- | --- | --- |
| fixture（请求指纹+录制响应） | `tests/fixtures/gateway/**` | **入库**（脱敏后，§6） | record 模式（自动脱敏管线）或手工编写（测试作者） | replay 引擎；W2-Q1-T03 等回放驱动测试 |
| 运行轨迹 trace | `runs/*.jsonl` | **gitignore**（TASK-P3-04 既有约定） | trace 层（P3-04；网关不写） | 本地调试；脱敏摘要导出 |
| 证据存档 | `docs/evidence/wave-<NN>/<TASK-ID>/` | 入库（证据约定 §1–§3） | 实现槽手工归档 | W5 核验 |

### 5.2 目录布局与命名

```text
tests/fixtures/gateway/
├── README.md                        # 目录说明 + 脱敏声明 + 重录方法（随 W3-AGENT-T01 交付）
├── <consumer>/                      # 按消费方分组：如 gateway/（网关自测）、q1-run/（W2-Q1-T03）…
│   ├── <fp12>-<slug>.json           # fp12 = 指纹前 12 位十六进制；slug 人读用（小写字母数字短横线）
│   └── …
```

- **命中只认文件内 `fingerprint` 字段，不认文件名/路径**：replay 引擎启动时递归索引 `fixturesDir` 下全部 `*.json`，按指纹建内存索引。文件名的 `<fp12>` 前缀是防重名与可 grep 约定，改名不影响行为。
- **指纹重复即加载失败**：索引期发现两个 fixture 同指纹 → fail `SW-E044`（列出两个路径）——重复意味着录制流程出错或手工复制未改，静默取其一会造成测试假绿。
- 子目录 `<consumer>` 仅为人类组织习惯，索引不区分；跨消费方复用同一 fixture 合法（同指纹只允许存在一份）。

### 5.3 fixture schema v1（字段冻结）

```json
{
  "schema": 1,
  "fingerprint": "9f2a41c8b7e6…（64 位十六进制 SHA-256）",
  "recordedAt": "2026-08-27",
  "provider": "fake-provider",
  "model": "test-model-1",
  "request": {
    "messages": [
      { "role": "system", "content": "（夹具文本，可全文——脱敏规则见 §6）" },
      { "role": "user", "content": "把第 010 场改写为雨夜街头" }
    ],
    "params": { "temperature": 0.7 }
  },
  "response": {
    "content": "（录制的模型输出全文）",
    "finishReason": "stop",
    "usage": { "promptTokens": 4200, "completionTokens": 800 }
  },
  "latencyMs": 3100
}
```

规则：

1. 顶层八键 `schema / fingerprint / recordedAt / provider / model / request / response / latencyMs` **全必填**；`request` 内只有 `messages`（必填）与 `params`（可选，仅当录制请求显式传参时存在）。多一键、少一键、类型不符 → 加载期 fail `SW-E044`（列出文件路径与首个问题）。
2. `schema` 当前恒为 `1`；未来演进走版本号递增 + 读侧兼容，不静默改字段含义。
3. `metadata`（runId 等）**永不进 fixture**——易变字段入库会让指纹与内容漂移检测失去意义。
4. `latencyMs` 是录制时实测值，replay 原样回填到 `GatewayResponse.latencyMs`，**不 sleep 复现**（测试要快且确定）。
5. 手工编写 fixture 合法（测试作者构造边界响应，如 `finishReason:"length"`），指纹可用实现槽交付的辅助脚本计算（建议 `scripts/gateway-fingerprint.ts`，属 T01 交付物），杜绝手算。

### 5.4 指纹算法（v1 冻结）

```text
fingerprint = SHA-256( canonicalJSON( { provider, model, messages, params? } ) ) 的十六进制小写
```

1. **参与字段**：`provider`（解析后的实际适配器 id，非「缺省」）、`model`、`messages`（全量，含 role/content）、`params`（**仅显式传入的键**，见下）。
2. **排除字段**：`metadata` 全部（runId 等）、模式、latency、时间——任何「同请求不同值」的字段都不得参与，否则回放永不命中。
3. **`params` 归一化**：网关不给 params 补默认值再哈希——只哈希调用方显式传入的键。适配器侧的默认值（如供应商默认 temperature）不参与指纹；调用方想让参数参与命中判定就显式传。`params` 缺省与空对象 `{}` 同指纹（canonicalJSON 层归一为省略该键）。
4. **canonicalJSON**：递归按键名字典序排序、无空白、UTF-8 编码、字符串不转义非必要字符（`JSON.stringify` + 递归键排序即可，实现槽给单测锁定「键序无关、语义等价请求同指纹」）。
5. 指纹算法变更 = fixture 全量失配，属破坏性变更：v1 冻结，未来变更须连带 `schema` 版本递增与重录计划，禁止顺手调整。

### 5.5 replay 引擎行为

1. 启动（或首次调用）时按 §5.2 索引 `fixturesDir`；目录不存在视同空索引（错误留到未命中时报，方便纯非模型路径的消费方零成本引入）。
2. `complete(request)`：计算指纹 → 命中 → 返回 `GatewayResponse`（fixture 的 `response` + `latencyMs` + `model`，`source:'replay'`）；未命中 → fail `SW-E042`（ctx 含指纹前 12 位、检索目录、请求的 provider/model——**不含 messages 正文**，避免错误消息成为正文泄漏面）。
3. 命中判定纯等值（指纹字符串相等），**无模糊匹配、无「最接近」回退**（§10 非目标）——回放的价值就是确定性。

### 5.6 record 模式落盘管线

1. 前置：`resolveAiKey` 非空（否则 fail `SW-E041`，根本不出网）。
2. 真实调用成功后：构造 fixture 对象（§5.3 白名单字段，逐字段显式赋值——**不存在「把原始 HTTP 响应/请求整包序列化」的路径**，鉴权头、供应商账户元数据在构造点就不进对象，§6.1）→ 计算指纹 → 写盘前自查（§6.2）→ 经 `writeFileAtomic`（复用 `src/infra/store/atomicFile.ts` 既有原语）写入 `fixturesDir/<consumer 由调用方传或缺省 gateway>/<fp12>-<slug>.json`（slug 由调用方提供或取 model+序号）。
3. 同指纹 fixture 已存在 → **覆盖前先比对**：内容等价则跳过写盘（幂等）；不等价（同请求录出不同响应，模型非确定性）→ 覆盖并在返回值外打印一次性提示由调用方呈现——记录进落地说明即可，v1 不做多版本 fixture。
4. record 落盘失败（磁盘/权限）走既有 IO 异常路径，不吞错。

---

## 6. SPEC-G3：脱敏协议（对齐证据与 CI 约定 §5）

### 6.1 结构性脱敏（白名单序列化，优先于扫描）

- fixture 对象按 §5.3 schema **逐字段显式构造**：`Authorization` 等鉴权头、cookie、供应商组织/账户 id、配额信息、请求 id 的账户段（证据约定 §5-1/§5-4）**没有进入序列化对象的代码路径**——脱敏不靠「录完再删」，靠「从未写入」。
- 适配器返回的 `GatewayResponse` 同样是白名单结构（§4.1），供应商侧原始响应体不透传出适配器。
- key 的消费点只有一处：适配器 `complete(request, key)` 的运行时参数——不进对象属性、不进闭包外泄、不进错误消息（§3.3）。

### 6.2 写盘前字节级自查（record 管线内建）

序列化产物落盘前断言：

1. 不含当前 `resolveAiKey` 解析出的 key 字符串（字节级 `includes` 检查——这是对白名单实现的纵深防御）；
2. 不匹配通用凭据模式（沿用证据约定 §5-5 的模式集：`api[_-]?key` / `bearer ` / `sk-[A-Za-z0-9]{8,}` / `AKIA[0-9A-Z]{16}` / `-----BEGIN` 等）。

命中任一 → **拒绝写盘** + fail（归 `SW-E044` 的录制变体现场：what「fixture 录制被脱敏自查拦截」）。宁可录制失败，不可脏数据入库。

### 6.3 入库门：`lint:fixtures`（CI 收紧步骤）

- 实现槽交付 `scripts/lint-fixtures.ts` + npm script `lint:fixtures`：对 `tests/fixtures/gateway/**/*.json` 逐文件断言——schema v1 结构合法、指纹与内容自洽（重算相等）、指纹全库唯一、§6.2 模式集零命中。
- 进 CI 作为**新增收紧步骤**（证据约定 §6.6 允许面）；与 `lint:errors` 同族（生成物/夹具防漂移 lint）。
- 手工编写的 fixture 同受此门约束——lint 是入库唯一门，不区分产出方式。

### 6.4 剧本正文分级（证据约定 §5-3 的落点）

- `tests/fixtures/gateway/` 位于 `tests/` 下，属证据约定 §5-3 的**夹具豁免区**：夹具文本可全文入库。因此 **record 模式只允许对夹具/演示项目录制**——对真实用户创作内容录制 fixture 并入库违反 §5-3（真实创作内容只存引用）。此约束是纪律 + code review 判定（工具无法识别「内容是否真实创作」），写入 fixtures README 与本规格，违规按证据无效处置。
- trace 层的正文引用规则（场号+哈希+字数）属 TASK-P3-04，本规格不重复。

---

## 7. SPEC-G4：doctor `ai-key` 检查项对齐

### 7.1 现状（锚定 `cursor/w3-doctor-3e3d`）

`aiKeyCheck`（id `ai-key`，title「AI key」）：① findings 空（前置红项）→ skip；② `settings.ai.enabled:false` → pass「AI 辅助未启用…无需检查 key」；③ 启用 → skip「未实现——AI 已启用，但供应商网关属 TASK-P3-01（BLK-W1-02 凭据未定），key 有效性检查随其交付」。work-doctor §5 已把「替换③」交接给 TASK-P3-01。

### 7.2 网关落地后的行为表（W3-AGENT-T03 按此替换，五分支全覆盖）

| # | 条件 | 状态 | detail / fix 要点 |
| --- | --- | --- | --- |
| 1 | findings 空（前置红项未通过） | skip | 不变（文案照旧） |
| 2 | `enabled: false` | pass | 不变（文案照旧——本规格零改动既有绿/skip 路径的原则） |
| 3 | `enabled: true` 且 `resolveGatewayMode` = `replay`（含缺省） | **skip** | 「回放模式（默认）不使用模型凭据，key 检查不适用；如需真实调用，设置 `SW_AI_KEY` 并显式设 `SW_GATEWAY_MODE=live`」——skip 而非 pass 的理由见 §11 D4 |
| 4 | `enabled: true` 且 mode ∈ {record, live} 且 `resolveAiKey` = null | **fail** | detail「模式 {mode} 需要模型凭据，但环境变量 `SW_AI_KEY` 未设置」；fix「`export SW_AI_KEY=<你的 key>` 后重跑 `sw doctor`；或改回默认回放模式（`unset SW_GATEWAY_MODE`）」——fail 必附可复制修复命令（doctor 既有纪律） |
| 5 | `enabled: true` 且 mode ∈ {record, live} 且 key 非空 | pass | 「`SW_AI_KEY` 已设置（存在性检查；离线不验证有效性——真实有效性以一次 `live` 调用为准）」 |
| 6 | `SW_GATEWAY_MODE` 为非法值 | fail | 与网关 `SW-E040` 同因（检查项内不 throw，转红项 + fix「合法值：replay / record / live」）——doctor 报告完整产出的既有原则（单项异常不崩溃） |

一致性断言（这就是「与 CI 绿对齐」的核心）：**行为表中「无 key + 无环境变量」的环境只可能落在 #1/#2/#3——全部不计红**。doctor 在无凭据环境永远零红项（就 `ai-key` 项而言），与 §3.4 的 CI 全绿同构。

### 7.3 单一数据源约束

- `checks.ts` 的新 `aiKeyCheck` **导入** `resolveGatewayMode` / `resolveAiKey`（§4.3 导出），零复制实现——两处 env 解析漂移会造成「doctor 绿但网关红」的假诊断。
- v1 **不做在线 key 验证**（不打真实请求）：doctor 必须离线、确定、快（既有七项检查全部离线的先例）；「key 在供应商侧是否有效」属 W3-AGENT-T04 联调证据（E4），不属诊断项。若未来立项在线验证，属 `DOCTOR_CHECKS` 新增检查项（如 `ai-key-live`），不改本项语义。
- doctor 侧此项检查**不注册新错误码**：检查项以红项聚合走既有 `SW-E013`，E04x 只属网关运行期（§8 与 doctor 的 E013 分界 = check 规格 §4.2 与 E014 的同款分界）。

---

## 8. 错误码提案（E04x 段首批，触达时登记）

> 纪律重申（SPEC-03）：**禁止预填未用码**——下表是提案，实现槽在实际触达的同一提交内登记进 `ErrorContexts`/`ERROR_REGISTRY` 并跑 `gen:errors`；未触达的码不登记。段位核对：E012（GAP-04 锁预留）、E013（doctor 已登记）、E014（check 规格提案）、E031–E034（init/draft/export 已用或提案）、E050–E053（快照规格提案）——E040–E044 零冲突。

| 码 | 触达面 | what / why / fix 提案（三段式） |
| --- | --- | --- |
| SW-E040 | 网关配置无效，双现场（先例：E010 双现场归并 + 落地说明登记）：① `resolveGatewayMode` 读到非法 `SW_GATEWAY_MODE`；② provider 两处皆空（请求未传且 `settings.ai.provider` 为 null） | what「模型网关配置无效」；why「{problem}」（现场①「环境变量 SW_GATEWAY_MODE 的值是 …，合法值只有 replay / record / live」；现场②「未指定模型供应商——请求未传 provider，project.yaml 的 settings.ai.provider 也为空」）；fix「按原因修正：清除或改正该环境变量（`unset SW_GATEWAY_MODE` 回到默认 replay）；或在 project.yaml 的 settings.ai.provider 填入供应商 id」 |
| SW-E041 | record/live 模式且 `resolveAiKey` 为空（出网前拦截） | what「模型调用需要凭据，但未配置」；why「当前网关模式是 {mode}，需要环境变量 SW_AI_KEY，而它未设置或为空」；fix「`export SW_AI_KEY=<你的 key>` 后重试；或改用默认回放模式（`unset SW_GATEWAY_MODE`）」 |
| SW-E042 | replay 未命中 fixture | what「回放模式没有找到匹配的录制响应」；why「请求指纹 {fingerprint12}（provider {provider} / model {model}）在 {fixturesDir} 下无对应 fixture」；fix「检查请求是否发生漂移（messages/params 任何字节变化都会改变指纹）；确属新请求时由持有凭据者以 record 模式录制后入库」 |
| SW-E043 | 供应商调用失败：可重试错误退避 3 次耗尽，或不可重试错误 | what「模型供应商调用失败」；why「{provider} 返回错误：{reason}（重试 {attempts} 次后放弃）」——reason 经适配器归一化并剥离账户标识；fix「稍后重试；持续失败时检查供应商服务状态与 SW_AI_KEY 是否有效」 |
| SW-E044 | fixture 加载/录制完整性：schema 不符、指纹重复、指纹与内容不自洽、录制被脱敏自查拦截 | what「模型回放夹具不可用」；why「{path}：{problem}」（首个问题，含指纹重复时的双路径）；fix「按 why 修复该 fixture 或删除后重录（`npm run lint:fixtures` 可全库自查）」 |

- 全部经 `fail(code, ctx)` 抛出，渲染归消费方 CLI 顶层（网关 v1 无自有命令面，§4）。
- 退出码：网关错误属「运行期错误」，未来任何消费命令按 GAP-06 表映射到 1；本规格不新增退出码。

---

## 9. 验收测试清单与追溯

### 9.1 AT-G01…G12（实现槽的二值验收断言，全部无凭据可跑）

| # | 断言 | 对应章节 |
| --- | --- | --- |
| AT-G01 | 环境无 `SW_GATEWAY_MODE`/`SW_AI_KEY` 时 `resolveGatewayMode` = `replay`；显式注入三合法值各自生效；非法值 fail SW-E040 | §3.2 |
| AT-G02 | replay 命中：预置 fixture 后 `complete` 返回其 response，`source:'replay'`、`latencyMs` 为记录值且调用耗时 < 记录值（不 sleep） | §5.5 |
| AT-G03 | replay 未命中：fail SW-E042，错误 ctx 含指纹前 12 位与目录、**不含 messages 正文** | §5.5 |
| AT-G04 | record 与 live 在 key 缺失/空白时 fail SW-E041，且假适配器的 `complete` 未被调用（出网前拦截） | §3.3 |
| AT-G05 | 指纹稳定性：键序打乱的等价请求同指纹；`metadata.runId` 变化不改指纹；`params` 省略与 `{}` 同指纹；messages 单字节变化改指纹 | §5.4 |
| AT-G06 | record（假适配器注入）成功：落盘 fixture 逐字段符合 schema v1、指纹重算相等、`writeFileAtomic` 路径（临时文件无残留） | §5.6 |
| AT-G07 | F3 重试：假适配器注入 2 次可重试错误后成功 → 共 3 次调用且成功返回；注入 4 次连续失败 → 3 次重试耗尽 fail SW-E043（注入时钟断言退避序列，不真实等待） | §4.4 |
| AT-G08 | fixture 完整性：缺键/多键/类型错 → SW-E044；两文件同指纹 → SW-E044 且列双路径 | §5.3/§5.2 |
| AT-G09 | 进程级：清空网关环境变量跑全套 CI 门（lint / lint:errors / lint:fixtures / typecheck / test / build / smoke / smoke:exit-codes）全绿 0 跳过 | §3.4 |
| AT-G10 | key 永不落盘：假适配器 + 注入 key `test-key-in-band-canary` 走完整 record 管线 → 产物文件与全部错误消息字节级不含该串；写盘自查对注入 `sk-` 样式串的 fixture 拒写 | §6.2 |
| AT-G11 | `lint:fixtures`：合法夹具库通过；注入 schema 破损/指纹不自洽/凭据模式串的 fixture 各自红 | §6.3 |
| AT-G12 | doctor `ai-key` 行为表六分支各一断言（表 §7.2；#3 断言 skip 不计红、doctor 仍可全绿退出码 0；#4 断言红项含可复制 fix） | §7.2 |

### 9.2 与上游验收的追溯矩阵

| 上游验收 | 本规格落点 |
| --- | --- |
| TASK-P3-01「E1 模块入主分支」 | W3-AGENT-T01/T02 交付面（§4–§6）；AT-G01…G11 |
| TASK-P3-01「E4 一次真实调用脱敏存档、内容与剧本创作相关」 | **等 BLK-W1-02**：W3-AGENT-T04 以 live/record 完成一次真实调用，按证据约定 §3.2 E4「模型调用记录」落 `docs/evidence/wave-<NN>/TASK-P3-01/`——字段清单：模型名、采样参数、prompt 概要（夹具或概要，遵 §6.4）、响应内容、usage、latencyMs、`source:'live'` 标记、脱敏声明。回放产物不得顶替（§3.1） |
| TASK-P3-01「仓库全文检索不到任何凭据明文」 | §6 全节 + AT-G10/G11 + 证据约定 §5-5 自查命令扩展到 fixtures 目录 |
| W2-Q1-T03 验收④「全部用例以录制/回放 fixture 驱动，无模型凭据环境 CI 全绿」 | §3.4、§5（其夹具直接用本 schema 与目录，建议 consumer 子目录 `q1-run/`）、AT-G09 |
| work-doctor §5 交接「网关落地后替换 aiKeyCheck」 | §7 行为表 + W3-AGENT-T03 + AT-G12 |
| GOAL-W1-03（C-L1：模型调用模块入库 + 一次真实调用脱敏记录） | 前半随 T01/T02；后半随 T04（BLK-W1-02 解除后）。**本规格不宣布 C-L1 达成**——判定归基线量表与 W5 |

---

## 10. 非目标（v1 明确不做，出现即范围违规）

1. **流式输出（streaming）**：P3 方案 v1 未要求；`complete` 单发单收。流式属未来接口演进（新增方法，不改 `complete` 签名）。
2. **多供应商路由 / 备用模型切换 / 成本路由**：单 provider（BLK-W1-02 连首个供应商都未定）；F3 的「切换 1 次」留位不实现（§4.4）。
3. **fixture 模糊匹配 / 最近邻回退**：命中纯等值（§5.5）。
4. **预算强制（F4）**：步数/token/时长预算属编排层（P3 §2.2/§2.4），网关只如实上报 usage。
5. **提示词/技能层**（TASK-P3-02）、**受控输出 schema 校验**（TASK-P3-03）、**trace 落盘**（TASK-P3-04）：均为独立任务，网关不越界代做。
6. **doctor 在线 key 验证**：§7.3。
7. **`sw` 命令面**：网关 v1 无 CLI 子命令（§4 前注）。
8. **fixture 多版本/GC**：同指纹恒一份（§5.6-3）；库体量治理待实际膨胀再立项。

---

## 11. 细化决策登记（D1–D6，供调度器复核）

| # | 决策 | 理由 | 备选及弃选原因 |
| --- | --- | --- | --- |
| D1 | 模式经环境变量 `SW_GATEWAY_MODE`，默认 replay；不进 `project.yaml` | 模式是运行环境属性（同一项目 CI 回放/本地录制）；schema 零改动 | 项目字段 `settings.ai.mode`——弃：把环境形态写进项目文件会让「同项目在 CI 必须绿」依赖文件改动 |
| D2 | 凭据单变量 `SW_AI_KEY`，供应商由 `settings.ai.provider` 决定 | BLK-W1-02 未定供应商，per-provider 变量矩阵是无据猜测；单变量已满足「环境注入、永不落盘」 | `SW_<PROVIDER>_KEY` 矩阵——留给 T04 按真实供应商定案时评估，登记进落地说明即可 |
| D3 | fixtures 放 `tests/fixtures/gateway/`（非顶层 `fixtures/`） | 证据约定 §5-3 对 `tests/` 夹具的全文豁免直接适用；与 vitest 套件邻近；`files` 发布白名单（dist/templates）天然不带出 | 顶层 `fixtures/`——弃：需要为脱敏豁免另立条款，且发布边界要重新论证 |
| D4 | replay 下 `ai-key` 检查报 **skip（不适用）** 而非 pass | pass 会暗示「key 已检查没问题」，而 replay 根本没读 key——skip 的三义项「不适用」正是此场景，且 skip 不计红、不破坏全绿 | pass「回放模式无需 key」——弃：与 #5 的 pass（真的查了存在性）混淆检查语义 |
| D5 | 错误码取 E040–E044 五码 | E04x 段位（AI 供应商）是 SPEC-03 注册表注释预留的既定归属；五码对应五个不可归并的失败面（配置/凭据/未命中/供应商/夹具完整性） | 归并为两三个宽码——弃：三段式 fix 无法同时给出「设 key」「重录 fixture」「修 schema」等互斥指引 |
| D6 | 指纹只哈希显式传入的 `params`，适配器默认值不参与 | 让「调用方视角的同一请求」恒同指纹；适配器默认值变化不应使全库 fixture 失配 | 哈希「适配器补全后的有效参数」——弃：把供应商实现细节耦合进指纹，违背回放确定性初衷 |

---

## 12. 给后续槽位的交接

- **实现槽（W3-AGENT-T01…T03 认领者）**：任务粒度、依赖与二值验收见 `docs/wave-03/ready-tasks.md` WAVE03-AGENT 分区；基分支一律取集成分支头（W3-PLAN-T02 之后），禁止从旧基线抢跑。错误码触达才登记；CI 只增不减；fixtures README 随 T01 一并交付。
- **W2-Q1-T03 承接者**：你的回放夹具直接用 §5.3 schema 与 §5.2 目录（建议子目录 `q1-run/`），不要自造格式；故障注入用 §4.2 假适配器模式。
- **TASK-P3-04（trace）承接者**：`llm_call` 事件所需字段已由 `GatewayResponse` 备齐（usage/latencyMs/source/model）；`source` 字段请原样落 trace，供 W5 区分回放/真实证据。
- **W3-AGENT-T04（等 BLK-W1-02）**：真实适配器落地时按 §9.2 E4 字段清单存档；D2 的变量命名如需拆分在落地说明登记；`ai-key` 检查项语义（§7.2）不因真实供应商而改（在线验证另立检查项）。
- **调度器**：本规格 6 项细化决策（§11）与「C-L1 不宣布达成」（§9.2 末行）供复核；BLK-W1-02 状态未变，解除条件与判定权在基线侧。
