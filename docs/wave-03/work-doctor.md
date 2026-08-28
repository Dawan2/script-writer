# W3 实现槽落地说明：`sw doctor` 诊断命令（W1-P1-T08，移植自 `cursor/w3-doctor-3e3d`）

> 分支：`cursor/w4-help-registry-impl`（含 help 注册表与五步主链全部落地）
> 开工依据：P1 方案 §6.7、ready-tasks W1-P1-T08（验收①②③）、GAP-04 §3.4、GAP-06 §3.6、源分支 `docs/wave-03/work-doctor.md`
> 日期：2026-08-28

## 1. 交付清单（移植 + 适配）

| 文件 | 说明 |
| --- | --- |
| `src/app/diagnostics/checks.ts`（移植） | 可注册检查项数组 `DOCTOR_CHECKS` 七项原样保留（runtime-node / project-file / meta-schema / layout / scenes-done / project-lock / ai-key）；DoctorContext.projectFile 四态改为引擎读侧适配 |
| `src/app/diagnostics/validate.ts`（重写） | **子集解析器整体退役**：validateProjectMeta 直接消费引擎 parseProjectMeta（源分支 work-doctor.md §4-2/§5 交接注记明文允许的替换）；schema-incompatible 映射为「期望/实际」单条，malformed issues 逐条透传 |
| `src/app/diagnostics/doctor.ts`（移植） | 编排：inspectDir 判 not-file + readProjectFileRaw 一次 IO 多检查共享；单项异常转红项不崩溃 |
| `src/cli/commands/doctor.ts`（移植适配） | 报告渲染 ✔/✖/○ 原样；错误面从旧 sw-error.ts 体系重写为 `fail('SW-E014')`；io 统一 CliIo |
| `src/cli/registry.ts`（改一行） | doctor planned→available（aux 组，无别名——SPEC-07 不预占） |
| `src/app/errors/registry.ts`（改） | 登记 **SW-E014**（{count, findings}）红项聚合码 |
| 测试 | `tests/app/diagnostics.spec.ts`（18 例移植适配）、`tests/cli/doctor.spec.ts`（6 例新写） |

## 2. 撞号裁定（勘误登记）

源分支红项聚合码为 SW-E013，但集成分支已把 E013 用于 init「目标路径是文件」（W3 集成先落地，按先落地为准）；E012 为 GAP-04 锁占用既定预留。故顺延取 **SW-E014**，与首个触达用例同提交登记。

## 3. W1-P1-T08 验收 ①②③ 核销

| 验收 | 结果 | 证据 |
| --- | --- | --- |
| ① 健康项目输出全绿 | ✅ | 真实 CLI：`sw init --yes` 项目 6 绿 / 0 红 / 1 跳过（锁按调度指令报「未实现」不计红），退出码 0 |
| ② 三类损坏各得含修复命令的红项 | ✅ | 删 project.yaml → ✖ 项目文件 + `sw init`；改坏 schema → ✖ 元数据 schema（期望 1 实际 2）；scenes_done 漂移 → ✖ 场景一致性只列缺失编号（app+cli 双层断言） |
| ③ 退出码全绿 0 否则 1 | ✅ | cli doctor.spec 退出码断言 + 手测 exit=0/1 |
| 风险注记「可注册检查项数组」 | ✅ | DOCTOR_CHECKS 数组，GAP-04 锁检查承接位保留 |

## 4. 偏差与适配登记（相对源分支）

1. 子集解析器 `projectMetaRead.ts` 不移植（被引擎严格解析器替代）——校验文案随之迁移到 parseProjectMeta 实际文案（断言迁移不删除，测试头注释已注明）。
2. scenes-done 修复文案按 SPEC-05 §8.2 交接项更新：`sw draft <id>` 重建路径（draft 已交付，移除「随 T05 交付」标注）。
3. layout 红项的 outline.md 修复路径从 `sw init --force` 重建改为 `sw outline` 幂等补骨架（outline 已交付，破坏性更小的真实命令）。
4. 旧 sw-error.ts 体系错误面重写为 fail()/注册表（E014），CliIo 统一。

## 5. 测试对账与 CI

- 测试 374 → **402（401 过 + 1 todo）**，只增不减；0 跳过。
- CI 七门全绿：lint / lint:errors（12 码 / 3 位点零漂移）/ typecheck / test / build / smoke / smoke:exit-codes（12/12）。

## 6. 交接

- **W2-GAP-T04（文件锁）**：承接位即 `checks.ts` 的 `lockCheck`（LOCK_FILE 常量已导出）；落地时替换为 stale 判定 + 修复命令，锁占用错误码用预留的 012 号。
- **TASK-P3-01（模型网关）**：网关落地后替换 `aiKeyCheck` 的「未实现」分支（E04x 段按 SPEC-03 注册）。

## 7. 合规声明

未创建 PR；未合并进 `main`；未删测试、未跳过失败、未降低 CI 标准；错误码仅经 `fail()` 单一入口。
