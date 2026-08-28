# TASK-P3-06 落地说明：Story Bible schema 定稿 + 上下文组装器 v1

- **日期**：2026-08-28（UTC）
- **分支**：`cursor/w4-help-registry-impl`
- **核销对象**：TASK-P3-06 v1——人物卡/地点/伏笔 schema 定稿（story-bible/README.md）+ 上下文组装器确定性检出（E3）；E4 trace context_slots 一致性为断言锚点（真 run 待 BLK-W1-02）。

## 文件改动

| 文件 | 改动 |
|---|---|
| `story-bible/README.md`（新） | schema 定稿：目录布局 + 人物卡最小 schema + facts 纪律（一致性守卫唯一依据、变更走草稿 P-3） |
| `story-bible/characters/li-mei.yaml`（新） | 人物卡样例（方案 §2.3 示例原样入库） |
| `src/agent/context/assembler.ts`（新） | `assembleContext`：六槽位固定顺序与配额（5/10/20/45/10/10%）；确定性检出（bible=人物卡、script=目标场全文+相邻场概要）；超预算确定性截断不丢槽位；`estimateTokens`（1 token≈2 字符，单点可换）；`loadBibleCards` / `summarizeScene` |
| `tests/agent/assembler.spec.ts`（新） | 9 例：E3 三要素（目标场全文/相邻概要/人物卡）+ contextSlots 引用一致 + 槽位预算 + 截断 + 缺省行为 + 未注册技能/无目录边界 |

## 验收对照

| TASK-P3-06 验收项 | 状态 |
|---|---|
| E3：产物含目标场全文、相邻场概要、对应人物卡，各槽位不超预算 | ✅ 逐槽断言（含截断容差） |
| E4：trace context_slots 与实际一致 | ✅ 形态锚点断言（`bible:[id]`、`script:[场号#full\|#summary]` ≡ LlmCallEvent.context_slots）；真 run 佐证待 BLK-W1-02 |
| v1 确定性检出（无向量检索） | ✅ 行为可预测可测试 |

## 关键裁定

1. **prompts/ 库根 = 仓库根**（技能/规则/schema 是仓库资产），story-bible/ 根 = 用户项目根（M2 属项目数据）——两取数面分离，测试中显式区分。
2. **截断不丢槽位**：超预算槽位截断并明示标记——「模型看到了什么」可复盘优先于内容完整。
3. **token 估算是近似器**（1 token ≈ 2 字符，CJK 偏保守），单点 `estimateTokens` 可替换，v2 再评估真 tokenizer。

## 合规声明

未创建子代理；未创建 PR；测试只增不减（501 → 510）；CI 八门全绿；未合并进 `main`。
