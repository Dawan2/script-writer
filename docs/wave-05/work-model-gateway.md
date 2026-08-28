# TASK-P3-01 落地说明：模型网关最小实现（回放模式半程，方案 R-2）

- **日期**：2026-08-28（UTC）
- **分支**：`cursor/w4-help-registry-impl`
- **核销对象**：TASK-P3-01 半程——模块入库（E1）达成；真实调用脱敏记录（E4）受 BLK-W1-02（无模型凭据）阻塞，按方案 R-2 以录制/回放模式先行，凭据到位后补证据。

## 文件改动

| 文件 | 改动 |
|---|---|
| `src/agent/gateway/types.ts`（新） | ChatMessage/ModelRequest/ModelResponse、ProviderError（7 类归类 + retryable 机器可读位）、ProviderAdapter 接口（单次调用不重试、signal 超时语义）、GatewayConfig/GatewayDeps/GatewayResult/ModelGateway |
| `src/agent/gateway/redact.ts`（新） | `redactSecrets`：秘密集显式注入、<4 字符不替换（防误伤）；任何离开进程的供应商文本必过 |
| `src/agent/gateway/providers/openaiCompat.ts`（新） | OpenAI 兼容 /chat/completions 适配器：Bearer 头注入、AbortError→timeout、HTTP 状态分档（429/5xx/4xx）、响应 schema 检查、错误文本脱敏 |
| `src/agent/gateway/providers/replay.ts`（新） | 夹具回放适配器：sha1(model+messages) 前 16 位指纹寻址；夹具可录制成功或失败（按录制 kind 拒绝），重试路径亦可回放；缺夹具 = fixture-miss（不可重试） |
| `src/agent/gateway/gateway.ts`（新） | `createGateway` 唯一调用出口：单次超时（AbortSignal，缺省 30s）；F3 指数退避（base×2^n，缺省 500ms/3 次）；重试耗尽切备用模型一次（预算重置）；终失败 `fail('SW-E040')`；缺凭据 `fail('SW-E041')`；`gatewayConfigFromEnv`（SW_LLM_API_KEY/BASE_URL/MODEL/FALLBACK_MODEL/REPLAY_DIR，凭据只进内存） |
| `src/app/errors/registry.ts`（改） | 登记 SW-E040（{model, attempts, lastError}）/ SW-E041（无 ctx）——E04x AI 供应商段首批，与首个触达用例同提交；`gen:errors` 零漂移 |
| `tests/agent/gateway.spec.ts`（新） | 31 例：回放命中/缺失/录制失败/指纹稳定性、脱敏、F3 退避序列 [500,1000,2000]、4xx 不重试、降级切换（attempts=5、model 序列断言）、主备耗尽（attempts=8 + 回包恶意回显凭据的脱敏断言）、超时归类、SW-E041 两路径、环境装配 |
| `tests/app/errors-registry.spec.ts`（断言迁移，内联注释） | 「E04x 不得登记」翻转为「恰好 E040/E041」；回归锁保留 |

## 验收对照

| TASK-P3-01 验收项 | 状态 |
|---|---|
| E1 模型调用模块入库 | ✅ `src/agent/gateway/` 四文件 + 31 测试，八门全绿 |
| 唯一调用出口 / 供应商适配 / 超时 / F3 重试 / 凭据环境注入永不落盘 | ✅ 见上表；脱敏有恶意回显用例回归锁 |
| E4 真实调用脱敏记录 | ⏸ 阻塞于 BLK-W1-02；回放夹具格式即录制格式（`error` 键可录失败），凭据到位后同网关切 `openai-compatible` 补归档 `docs/evidence/` |
| 仓库全文检索不到凭据明文 | ✅ 测试凭据均为 `sk-testkey-*` 假值 |

## 关键裁定

1. **重试单点**：适配器只发单次请求，F3 策略全在网关层（方案 §2.4「策略表是配置」的落点）。
2. **超时实现**：AbortSignal 注入适配器；不尊重 signal 的适配器（回放/夹具）由网关兜底归 timeout。
3. **SW-E040 ctx.lastError 预格式化**（沿用 SW-E012 holder 先例：渲染细节实现槽定授权），且已过脱敏。
4. **回放即录制格式**：凭据到位补 E4 时无需改夹具结构，加 `record` 开关即可（本半程不建，防无触达预建）。

## 阻塞

- BLK-W1-02（模型凭据）仍开放：E4 真实调用证据、TASK-P3-02/03/04 的端到端验收同受此阻塞（模块开发可继续以回放模式推进）。

## 合规声明

未创建子代理；未创建 PR；未删测试（仅一处断言迁移，内联注释）；未跳过失败；CI 八门全绿；未合并任何内容进 `main`。
