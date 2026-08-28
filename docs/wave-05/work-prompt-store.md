# TASK-P3-02 落地说明：提示词库与技能注册（最小版）

- **日期**：2026-08-28（UTC）
- **分支**：`cursor/w4-help-registry-impl`
- **核销对象**：TASK-P3-02 最小版——三层结构入库（E1）+ 加载器拒载测试（E3）；完整版（版本化已含；注册校验已含）仅剩多技能扩充。trace 技能引用佐证待 TASK-P3-04。

## 文件改动

| 文件 | 改动 |
|---|---|
| `prompts/rules/base.md`（新） | 硬规则集 ×1（输出语言/剧本格式/事实纪律/安全边界/输出纪律） |
| `prompts/skills/generate_outline.md`（新） | 技能 ×1：`id@version` = `generate_outline@1`，inputs {premise: required, format: required, scene_count: optional}，output_schema → outline-draft.json |
| `prompts/schemas/outline-draft.json`（新） | 输出 JSON Schema（scenes[] ≥1，scene_id 三位数字模式 + summary 非空） |
| `src/agent/prompts/types.ts`（新） | SkillMeta/Skill/RuleFile/PromptStore；`PromptStoreError`（file + 机器可读 reason 七值） |
| `src/agent/prompts/loader.ts`（新） | `parseSkillMarkdown` / `extractPlaceholders` / `validateSkill` / `loadPromptStore`：注册即校验六类拒载；保留槽 `{{rules}}`；`skillRef(id)` 恒返 `id@version` |
| `tests/agent/prompts.spec.ts`（新） | 17 例：真实库正例 + 拒载矩阵（缺 schema 声明/文件/双向槽位不匹配/非法 version/inputs 值/无头/重复/坏 JSON/版本并存） |
| `eslint.config.js`（改一行） | no-console 强制通道扩至 `src/agent/**`（agent 层同守 UX 单通道纪律） |

## 验收对照

| TASK-P3-02 验收项 | 状态 |
|---|---|
| E1 三层结构入库 | ✅ prompts/rules\\|skills\\|schemas 各 1 件，真实目录加载测试常驻 |
| E3 加载器：合法可载、缺 output_schema 拒载、槽位不匹配拒载 | ✅ 拒载矩阵 9 负例全绿 |
| 版本化 `id@version` + 注册时校验 | ✅（最小版即含，非完整版独占） |
| trace 技能引用含版本号 | ⏸ 数据源就绪（skillRef），运行记录佐证随 TASK-P3-04 |

## 关键裁定

1. **PromptStoreError 不走 fail()/SW-E04x**：prompts/ 是仓库管理资产，非法属构建期/开发期错误，非用户运行期错态；编排层捕获后再映射用户可见面（防预填未用码）。
2. **槽位双向严格一致**：正文占位符 ⊆ inputs ∪ 保留槽，且声明必用——方案 §2.8 规则 2「槽位与模板占位符一致」的严格化。
3. **同 id 多版本并存**：索引键取文件名排序后者（测试以排序显式命名锁定）；版本回溯靠 trace 记 ref，不靠索引键。

## 合规声明

未创建子代理；未创建 PR；测试只增不减（457 → 474）；CI 八门全绿；未合并进 `main`。
