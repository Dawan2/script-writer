# TASK-P3-04 落地说明：运行轨迹 trace 最小实现

- **日期**：2026-08-28（UTC）
- **分支**：`cursor/w4-help-registry-impl`
- **核销对象**：TASK-P3-04 最小版——JSONL 事件流（run_start / run_end / llm_call / repair_event 四件）、token/延迟/技能版本/槽位引用字段契约、runs/ gitignore、脱敏摘要导出；同时为 TASK-P3-02「trace 技能引用含版本号」补上运行记录佐证（回放 run 的 llm_call 事件 `skill: generate_outline@1`）。

## 文件改动

| 文件 | 改动 |
|---|---|
| `src/agent/trace/types.ts`（新） | 四件最小事件字段契约（开放集合，其余事件随编排层扩充）；LlmTotals 汇总口径 |
| `src/agent/trace/tracer.ts`（新） | `createTracer`（emit 前 redactSecrets 强制脱敏 + llm_call 成本累计 + end 落 run_end 汇总）；`tracedLlmCall` 网关观测包装（成功落 llm_call；SW-E040 落 repair_event F3/failed 后原样上抛） |
| `src/agent/trace/summary.ts`（新） | `parseTraceJsonl`（行级坏 JSON 带行号）+ `summarizeRun` Markdown 脱敏摘要（计数/成本/技能版本/修复分布；无正文全文、无凭据） |
| `.gitignore`（改） | +`runs/`（运行期瞬态件，方案 §2.7 规则 3） |
| `tests/agent/trace.spec.ts`（新） | 6 例：完整 run 三事件字段齐全、F3 失败路径 repair_event + run_end(failed)、凭据混进事件字段不落盘、摘要口径与无凭据无正文断言、坏行号/空行 |

## 验收对照

| TASK-P3-04 验收项 | 状态 |
|---|---|
| E4 一次运行 JSONL 含全部最小事件且字段齐全 | ✅（回放模式 run：run_start → llm_call → run_end，token/延迟/attempts/fallback/skill@version/context_slots 逐项断言；真实模型 run 待 BLK-W1-02） |
| E3 脱敏导出测试：无凭据、无正文全文（仅引用） | ✅ 两条断言常驻（含「凭据混进事件字段也被抹除」强制点回归） |
| runs/ 进 gitignore；摘要可导出 docs/evidence/ | ✅ gitignore 已加；summarizeRun 即归档产出器（本次无实 run 可归档，故 docs/evidence/ 不建档——防空证据） |

## 关键裁定

1. **脱敏强制点在 emit**：序列化每行前过 redactSecrets，秘密集由创建方显式给出——与网关同一纪律（秘密集显式注入，不做模式猜测）。
2. **tracedLlmCall 是唯一粘接点**：编排层经此拿观测，不直接摸 runs/ 文件；SW-E040→repair_event(F3) 的映射在此单点维护（F1 由 TASK-P3-03 受控输出层落 `repair_event(F1)`）。
3. **事件类型开放集合**：本任务只钉死四件字段契约；plan_created / step_* / tool_call / clarify_event / human_gate 随 TASK-P3-05/07 落地扩充，不预建。

## 合规声明

未创建子代理；未创建 PR；测试只增不减（474 → 479）；CI 八门全绿；未合并进 `main`。
