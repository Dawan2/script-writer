# W4 实现槽落地说明：项目级文件锁（W4-LOCK-T01/T02 核销 W2-GAP-T04 / SPEC-07）

> 分支：`cursor/w4-help-registry-impl`（含 help 注册表、五步主链、doctor 落地）
> 开工依据：`docs/wave-04/spec-file-lock.md`（SPEC-07，分支 `cursor/w4-spec-file-lock-a3e6`）
> 日期：2026-08-28

## 1. 交付清单

| 文件 | 说明 |
| --- | --- |
| `src/infra/store/lock.ts`（新） | 锁原语：`acquireProjectLock`（'wx' 独占创建 + stale 判定/接管）/ `releaseProjectLock`（尽力而为）/ `withProjectLock`（finally 语义）；`renderLockContent`/`parseLockContent`（§3.2 schema v1）；`LockDeps` 全注入测试缝（含 writeExclusive，AT-L11 用） |
| `src/infra/store/layout.ts`（改） | `LOCK_FILE = '.sw/lock'` 常量正典落位（SPEC-07 §11-1） |
| `src/cli/lockGuard.ts`（新） | **全库唯一取装点** `runWithProjectLock`（§3.5 执行次序：探测 project.yaml 缺失则不取锁走 E011 路径，防 .sw/ 垃圾）+ `LOCKED_WRITE_COMMANDS` 清单（AT-L15 数据源） |
| `src/cli/commands/{draft,outline,export,revise,init}.ts`（改） | 五命令接线：revise --list 纯只读不加锁；init 按 §6.2 特殊次序（E010/E013 判定先于取锁，prelocked 旗标使「仅含 .sw/」视同空目录） |
| `src/app/workflow/init.ts`（改） | InitFlags.prelocked：持锁路径下目录仅含 `.sw/` 不误判 E010 |
| `src/app/diagnostics/checks.ts`（改） | `lockCheck` 四态落地（§7，W4-LOCK-T02）：无锁绿 / 活锁绿（正常并发）/ stale 红 + `rm` 修复命令 / 不可解析红（§4.4 自愈出口）/ 他机 skip；LOCK_FILE 改从 layout 导入再导出（接口零变化） |
| `src/app/errors/registry.ts`（改） | **SW-E012** 与首个触达用例同提交登记（§5 三段式成文；holder 预格式化，不可解析时「未知…」——§5 授权的渲染细节实现槽定） |
| `scripts/smoke-exit-codes.mjs`（只加不改） | +1 用例：活锁下 `sw outline` → 退出码 1（AT-L13；13/13） |
| 测试（新） | `tests/infra/lock.spec.ts`（10 例：schema/stale/不可解析/他机/竞态/finally 双分支）、`tests/cli/lock.spec.ts`（8 例：互斥零副作用/只读照常/接管告警/init 特殊次序/AT-L15 矩阵） |
| 测试（迁移） | init.spec 布局断言 +`.sw`（§6.2 留存合法）；diagnostics.spec 锁检查两例迁四态；errors-registry.spec 回归锁 +E012 |

## 2. AT-L01…L15 核销表

| AT | 结果 | 落点 |
| --- | --- | --- |
| L01 并发互斥（E012 + 零写盘副作用） | ✅ 命令层 | cli/lock.spec 目录快照逐字节对比（双进程形态由 smoke 活锁用例 + 同一 O_EXCL 语义覆盖） |
| L02 stale 接管（恰一行告警、锁内容更新、退出码 0） | ✅ | infra/lock.spec + cli/lock.spec（stderr 单行 + stdout 末行契约） |
| L03 活锁下 status/doctor/revise --list 照常 | ✅ | cli/lock.spec |
| L04 stale 锁 doctor 红项 + 修复命令 | ✅ | app/diagnostics.spec 锁四态（进程级删除后全绿由 §3 手测覆盖） |
| L05 doctor 四态 | ✅ | app/diagnostics.spec |
| L06 finally 双分支 | ✅ | infra/lock.spec（成功 + 主体抛错两分支） |
| L07 删锁后行为逐字节一致、自动重建 | ✅ | cli/lock.spec |
| L08 锁内容 schema | ✅ | infra/lock.spec（三键/往返/非法形态五例） |
| L09 不可解析锁不接管 | ✅ | infra/lock.spec（锁原样留存断言） |
| L10 他机锁 E012 / doctor skip | ✅ | infra/lock.spec + app/diagnostics.spec |
| L11 接管竞态恰一次重试 | ✅ | infra/lock.spec（writeExclusive 注入确定性序列） |
| L12 幂等回归 | ✅ | 既有套件零删除零跳过全绿（426 例）；cli/lock.spec kept 路径逐字节 |
| L13 登记纪律 + smoke | ✅ | gen:errors 零漂移（13 码）；smoke:exit-codes 13/13 |
| L14 init 特殊次序 | ✅ | cli/lock.spec（活锁 --force → E012 零变化；E010 先于取锁；stale 接管产物完整） |
| L15 表驱动覆盖度 | ✅ | cli/lock.spec（清单常量 + 逐命令活锁断言） |

## 3. 测试对账与 CI

- 测试 402 → **426（425 过 + 1 todo）**，只增不减；0 跳过。
- CI 七门全绿：lint / lint:errors（13 码 / 3 位点）/ typecheck / test / build / smoke / smoke:exit-codes（13/13）。

## 4. 偏差与登记

1. E012 ctx 形态：`{dir, holder}`（holder 预格式化，不可解析时为「未知（锁文件内容不完整或损坏）」）——SPEC-07 §5「渲染细节实现槽定，消息语义以本行为准」授权；why 段语义与 §5 成文一致。
2. doctor 聚合码维持 SW-E014（doctor 槽撞号裁定）；SPEC-07 §11-2 建议的 E015 不再适用（doctor 已先于本槽并入并改号 E014），登记备查。
3. `.sw/` 空目录在 init 后留存（§6.2 明文合法），init.spec 布局断言已迁移。

## 5. 交接

- check/snapshot/restore（SPEC-F1/F2）落地时按 §6.1 矩阵接线（lockGuard 一行 + LOCKED_WRITE_COMMANDS 追加）。
- W2-Q1-T01 幂等契约矩阵与本清单的合表（§11-5）留待先落地者定表结构——本清单已是代码内单一常量，合表时直接并入列。

## 6. 合规声明

未创建 PR；未合并进 `main`；未删测试、未跳过失败、未降低 CI 标准；错误码仅经 `fail()` 单一入口；业务代码零 `process.exit` 触碰。
