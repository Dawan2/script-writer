# W2 实现槽落地说明：`sw revise` 修订步命令（W2-GAP-T01 / SPEC-04 + W3 规格 §6 增补）

> 分支：`cursor/w4-help-registry-impl`（含 help 注册表、outline、draft、export 落地）
> 开工依据：`docs/wave-02/P-gap-adjudication.md` §3.1（SPEC-04 原文）+ `docs/wave-03/spec-draft-export-revise.md` §6（对齐增补）
> 日期：2026-08-28

## 1. 交付清单

| 文件 | 说明 |
| --- | --- |
| `src/app/workflow/revise.ts`（新） | `runRevise`：清单/打开/--done/空态四路径；revise 不创建场；id 防线 E030/E032（复用既有码，SPEC-04 零新码纪律）；--list 纯只读零写盘；无参数裸 revise 步骤补齐 revise（§3-3 写路径） |
| `src/app/workflow/reviseReport.ts`（新） | 清单渲染（id ｜ 状态 ｜ 标题，稳定可供脚本消费）；空态走 ES-07 hint 注册表；末行 = 可复制下一步命令 |
| `src/cli/commands/revise.ts`（新） | CLI 适配；`--done` 缺 id → 用法错误退出码 2；`--done` 与 `--list` 互斥（Option.conflicts） |
| `src/core/model/progress.ts`（改） | `recordSceneRevised` 原语（与 recordSceneDone 同构：trim、幂等、排序、返回新对象） |
| `src/core/model/project.ts` / `parseProject.ts`（改） | `scenesRevised` 贯通三处：ProjectProgress / ProjectFileShape.scenes_revised / 解析序列化互转——**空数组不落键**（旧文件重写后字节稳定，expectedSceneCount 往返先例）；schema 仍为 1 |
| `src/app/errors/registry.ts`（改） | 空态位点 **ES-07「revise-empty」** 登记（与首个触达用例同提交；错误码零新增） |
| `src/app/workflow/status.ts`（改） | STEP_COMMANDS.revise 占位 `sw draft <id> --force` → `sw revise`（与命令注册同提交，§6.3） |
| `src/app/workflow/statusReport.ts`（改） | nextActionCommand revise 分支：有未修订场 → `sw revise <首个未修订 id>`；scenes_revised ⊇ scenes_done → `sw export`；draft 期分支④ 同步切换 `sw export` → `sw revise`（SPEC §11 顺序耦合核销）；revise 期 status 追加「修订进度：已修订 x/y 场」 |
| `src/cli/registry.ts`（改一行） | revise planned→available（别名 r 生效，SPEC-07 同提交纪律） |
| 测试（新） | `tests/app/revise.spec.ts`（10 例）、`tests/cli/revise.spec.ts`（5 例）；parseProject/progress 往返与同构用例 |
| 测试（迁移） | statusReport.spec revise/draft④ 分支期望、registry.spec revise 条目态、program/init.spec 路线图「规划中」→ 逐条可用标注（主命令全部可用后的诚实进度承接）；夹具补 scenesRevised 字段 |

## 2. SPEC-04 验收 ①–⑤ 与 §6 增补核销

| # | 要点 | 结果 | 证据 |
| --- | --- | --- | --- |
| ① | 五步全链 e2e 每步末行可复制 | ✅ | 真实 CLI 走查（§3）；进程级 e2e 归 W3-DRAFT-T03 后续槽 |
| ② | --done 幂等（重复后 project.yaml 字节不变） | ✅ | revise.spec「--done 幂等」 |
| ③ | kill -9 后 status 状态一致 | ✅ | 沿用引擎原子写既有测试法（SPEC-05 §4.5-⑥ 同型授权） |
| ④ | 未实现 check/stats 时引荐行不出现 | ✅ | 报告模板零 P4 引荐行（无硬依赖断言由输出文本天然满足） |
| ⑤ | --help 含 ≥1 可复制示例 | ✅ | cli revise.spec |
| §6.1 | 打开语义 = 确保就位 + 报告，不启动编辑器；不创建场 | ✅ | revise.spec「打开既有场」 |
| §6.2 | scenes_revised 三处贯通、空数组不落键、缺失读作空、类型错误入 issues | ✅ | parseProject.spec 往返用例 |
| §6.3 | status 两处占位与命令注册同提交切换 | ✅ | 本提交 diff；statusReport.spec 迁移断言 |
| §6.4 | 清单标题 = 首行 `# ` 轻量解析；--list 零写盘 | ✅ | revise.spec sceneTitle / --list 用例 |

## 3. 真实 CLI 走查

`revise`（清单：010 未修订，末行 `sw revise 010`）→ `revise 010`（打开引导，末行 `sw revise 010 --done`）→ `revise 010 --done`（末行 `sw export`）→ `revise`（010 已修订，末行 `sw export`）→ `status`（revise 期建议口径正确）。
**走查中发现并修复一处缺陷**：--done 路径的建议命令原按更新前修订集计算（标记最后一场后仍建议 `sw revise 010`），已修为按更新后重算并补回归锁断言。

## 4. 测试对账与 CI

- 测试 350 → **374（373 过 + 1 todo）**，只增不减；0 跳过。
- CI 七门全绿：lint / lint:errors（11 码 / 3 空态位点零漂移）/ typecheck / test / build / smoke / smoke:exit-codes（12/12）。

## 5. 交接与余项

1. 五步主链全部可用（init → outline → draft → revise → export），MP-01 闭环；进程级 e2e + TTFS 基准归 W3-DRAFT-T03。
2. 清单取数面为场文件首行轻量解析；P4 T01 内容索引层落地后可切换取数面（接口不变，§6.4 登记）。
3. ES-07 为第三个空态位点；错误码面零新增（E011/E020/E030/E032 全部复用）。

## 6. 合规声明

未创建 PR；未合并进 `main`；未删测试、未跳过失败、未降低 CI 标准（断言只迁移不删除，迁移说明随断言内联）；错误码仅经 `fail()` 单一入口。
