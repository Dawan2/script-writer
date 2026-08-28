# TASK-P3-05 落地说明：工具注册表 + 首批只读工具

- **日期**：2026-08-28（UTC）
- **分支**：`cursor/w4-help-registry-impl`
- **核销对象**：TASK-P3-05——工具描述 schema + 注册表校验；首批只读工具 read_scene / list_scenes / get_bible_entry；F2 前置参数校验。E4（模型发起的工具调用 trace）待编排层/真实调用（BLK-W1-02）。

## 文件改动

| 文件 | 改动 |
|---|---|
| `src/agent/tools/types.ts`（新） | ToolDescription 强制字段契约（side_effect 三枚举 / description 含「用于」/ failure_modes 非空）；ToolCallError（failure_modes 码 + TOOL_ARG_* 内置码）；ToolRegistryError（六类拒载原因） |
| `src/agent/tools/registry.ts`（新） | `createToolRegistry` 注册即校验 fail fast（重名拒载）；`validateArgs` F2 前置校验（未知参数/缺必填/类型错，执行前拦截不进 handler）；`call` 统一入口 |
| `src/agent/tools/builtin.ts`（新） | 首批三只（均 side_effect=none）：read_scene（场号归一复用 normalizeSceneId/findSceneFileById）、list_scenes、get_bible_entry（story-bible/ 优先、characters/ 兼容、路径穿越拦截） |
| `tests/agent/tools.spec.ts`（新） | 14 例：拒载矩阵 6 负例、F2 三码、三工具夹具断言（场号归一/不存在/非法、升序、目录优先级、穿越拦截） |

## 验收对照

| TASK-P3-05 验收项 | 状态 |
|---|---|
| E3 注册表拒载非法描述 | ✅ 6 负例（坏名/描述无「用于」/destructive/空失败码/参数 desc 空/重名） |
| E3 三工具对测试剧本返回正确结果 | ✅ 夹具断言全绿 |
| F2 前置参数校验生效 | ✅ TOOL_ARG_UNKNOWN/MISSING/TYPE 三码 + 不进 handler |
| E4 模型发起的工具调用 trace | ⏸ 待编排层（TASK-P3-07）+ BLK-W1-02 |

## 关键裁定

1. **取数面纪律**：剧本正文走 P1 既有 store 层（sceneFile/layout），工具层不自带解析器——与 W2-PLAN-T02（search_script 须建于 P4-T01 索引层）同一取向。
2. **get_bible_entry 目录优先级**：story-bible/ 优先、characters/ 兼容（P1 既有目录）；TASK-P3-06 结构化 Story Bible 落地后切换取数面，工具描述不变（方案 §6 R-4 接口不变条款）。
3. **ToolCallError/ToolRegistryError 不走 fail()**：编排层内部载体（同 PromptStoreError 先例）；用户可见面由编排层映射。

## 合规声明

未创建子代理；未创建 PR；测试只增不减（487 → 501）；CI 八门全绿；未合并进 `main`。
