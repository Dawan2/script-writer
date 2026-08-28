# W3 实现槽落地说明：`sw draft` 场景写作命令（W3-DRAFT-T01 / SPEC-05）

> 分支：`cursor/w4-help-registry-impl`（基于 W3 集成分支头 `b99cb92`，已含 W4 help 注册表与 outline 落地）
> 开工依据：`docs/wave-03/spec-draft-export-revise.md` §4（SPEC-05）、§3 公共契约、§10 测试验收总表
> 日期：2026-08-28

## 1. 交付清单

| 文件 | 说明 |
| --- | --- |
| `src/infra/store/sceneFile.ts`（新） | 场文件存取：`normalizeSceneId`（`10` ≡ `010` 归一）、`findSceneFileById`、`listSceneFiles`、`writeSceneFile` |
| `src/app/workflow/draft.ts`（新） | `runDraftScene`：行为矩阵 D1–D7 全实现；D3 复用 `ensureOutline` 自动补骨架（MP-05）；D5 防线 `fail('SW-E032')` |
| `src/app/workflow/draftReport.ts`（新） | 成功态报告渲染；末行 = 可复制执行的下一步命令（SPEC-02 输出契约） |
| `src/cli/commands/draft.ts`（新） | CLI 适配：`registerDraftCommand(program, io)` 统一 CliIo；`new Option('--done').conflicts(['title'])` → 互斥走退出码 2 |
| `src/cli/registry.ts`（改一行） | draft planned→available（别名 `d` 随挂载循环生效，SPEC-07 §4 同提交纪律；taskId `W3-DRAFT-T01`） |
| `src/app/errors/registry.ts`（改） | 登记 **SW-E032**「场景 id 冲突」（ctx `{sceneId, existingIds}`，与首个触达用例同提交；`npm run gen:errors` 生成 `docs/errors/SW-E032.md`，注册表 lint 零漂移） |
| `src/app/workflow/statusReport.ts`（改） | `nextActionCommand` draft 期细化：①无场→建议首场；②有未完成场→`sw draft <id> --done`；③全完成且未达 `expectedSceneCount`→`sw draft <下一场>`；④否则→`sw export`（revise 未注册前不落 `sw revise`，规格 §11 渐进增强口径） |
| 测试（新） | `tests/infra/sceneFile.spec.ts`、`tests/app/draft.spec.ts`（11 例）、`tests/cli/draft.spec.ts`（6 例） |
| 测试（迁移） | `tests/app/errors-registry.spec.ts` 回归锁清单 +SW-E032；`tests/app/outline.spec.ts` kept 场景末行断言随 draft 期细化迁移为 `sw draft 010 --done`（断言迁移不删除） |

## 2. SPEC-05 §4.5 验收 ①–⑨ 核销表

| # | 验收要点 | 结果 | 证据 |
| --- | --- | --- | --- |
| ① | 空 `scenes/` 创建场骨架、步骤 ≥ draft、退出码 0、末行逐字 `sw draft 010 --done` | ✅ | `tests/app/draft.spec.ts`；真实 CLI 走查（见 §3） |
| ② | 重复执行幂等：文件与 project.yaml 字节不变、报告 kept、退出码 0（EP-04） | ✅ | `tests/app/draft.spec.ts` 幂等例 |
| ③ | `--done` 后 `scenes_done` 含 id；重复 `--done` 字节不变 | ✅ | `tests/app/draft.spec.ts` |
| ④ | D5/D6 退出码 1、三段式、零写盘副作用 | ✅ | `tests/app/draft.spec.ts` 目录快照对比 |
| ⑤ | outline 缺失自动补骨架且无 `{{` 残留（MP-05） | ✅ | `tests/app/draft.spec.ts` |
| ⑥ | kill -9 后重跑 status 状态一致（EP-03） | ✅ | 沿用引擎原子写既有测试法（spec 授权「沿用」，未新增用例） |
| ⑦ | `--title` 与 `--done` 同给退出码 2、零副作用 | ✅ | `tests/cli/draft.spec.ts`（Option.conflicts） |
| ⑧ | `--help` 含 ≥1 可复制示例 | ✅ | `tests/cli/draft.spec.ts` |
| ⑨ | `sw draft 10` ≡ `sw draft 010` 逐字节等价 | ✅ | `normalizeSceneId` 归一测试（infra + app 双层） |

## 3. 真实 CLI 走查（手测证据）

`sw init --yes` → `sw draft 010 --title 开场` → `sw draft 010 --done` → `sw status`：
创建 `scenes/010-开场.md`（末行 `sw draft 010 --done`）→ 标记完成（末行 `sw draft 020`）→ status 显示「1/5 场已完成」、当前步骤 draft、末行 `sw draft 020`。全链退出码 0。

## 4. 测试对账与 CI

- 测试 289 → **321（320 过 + 1 todo 占位）**，只增不减；0 跳过。
- CI 七门全绿：lint / lint:errors（10 错误码零漂移）/ typecheck / test / build / smoke / smoke:exit-codes（12/12）。

## 5. 交接与余项

1. **给 W3-DRAFT-T02（export）**：status 末行「全完成→`sw export`」分支已就绪；export 注册后无需改动 statusReport。错误码 SW-E033/E034 编号已预留，随首个触达用例登记。
2. **给 W2-GAP-T01（revise）**：`nextActionCommand` 的 revise 分支当前落 `sw export`（规格 §11 顺序耦合口径）；revise 注册同提交内切换为 `sw revise` 系命令。
3. **给 W1-P1-T08（doctor）**：`checks.ts` 的 scenesDoneCheck 修复文案可指向 `sw draft <id> --done`（SPEC-05 §8.2 交接项）。
4. SW-E032 文档锚点 `docs/errors/SW-E032.md` 已生成并入列。

## 6. 合规声明

未创建 PR；未合并进 `main`；未删测试、未跳过失败、未降低 CI 标准；错误码仅经 `fail()` 单一入口；退出码三档纪律遵守（业务代码零 `process.exit` 触碰）。
