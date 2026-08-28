# TASK-P3-03 落地说明：受控输出层（schema 校验 + F1 重试降级）

- **日期**：2026-08-28（UTC）
- **分支**：`cursor/w4-help-registry-impl`
- **核销对象**：TASK-P3-03——`skill:*` 调用输出全经 JSON Schema 校验；F1 三路径（一次通过 / 重试后通过 / 降级）；E4 真实 F1 重试 trace 待 BLK-W1-02（回放模式已验证事件形态）。

## 文件改动

| 文件 | 改动 |
|---|---|
| `src/agent/orchestrator/output-guard/index.ts`（新） | ① 最小 JSON Schema 校验器（type/required/properties/additionalProperties/items/minItems/minLength/pattern/enum；超子集关键字加载即抛，不静默跳过）；② `renderSkillPrompt`（槽位填充 + 保留槽 {{rules}} + 必填缺失抛错）；③ `guardedSkillCall`（F1：带校验错误反馈重试 ≤2 → 降级「纯文本草稿+需人工确认」；repair_event F1 recovered/degraded 落盘） |
| `tests/agent/output-guard.spec.ts`（新） | 14 例：校验器逐类检出（带 JSON 指针路径）、真实仓库 schema 加载、超子集拒载、模板渲染、F1 三路径端到端（trace 事件序列断言）、F3 不混 F1 边界 |

## 验收对照

| TASK-P3-03 验收项 | 状态 |
|---|---|
| E3 三路径测试（一次通过 / 重试后通过 / 降级） | ✅ 事件序列逐路径断言（重试请求体含校验错误反馈 `/scenes/0/scene_id`） |
| 杜绝不受控输出进入业务逻辑 | ✅ validated 才返回 output；degraded 只给 draftText + 人工确认标记 |
| E4 真实 F1 重试 trace | ⏸ BLK-W1-02；回放路径已验证 repair_event(F1) 形态与字段 |

## 关键裁定

1. **校验器自写最小子集而非引 ajv**：依赖面零新增（ADR-0001 轻依赖取向）；超子集关键字加载即抛，防「以为校验了实际没校验」的假阴性（对齐 SPEC-P3-01 反假阴性纪律）。
2. **F1 与 F3 正交**：网关层失败（SW-E040）已由 tracedLlmCall 落 F3 repair_event 并上抛，本层不拦截不重复记——失败码与处置层一一对应（方案 §2.4 表）。
3. **降级不丢原文**：degraded 携带最后一次模型原文 draftText，人工可救（方案 §2.4 要点 3：兜底 = 可用部分交用户 + 明确原因）。

## 合规声明

未创建子代理；未创建 PR；测试只增不减（479 → 487）；CI 八门全绿；未合并进 `main`。
