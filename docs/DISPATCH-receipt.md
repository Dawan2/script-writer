# DISPATCH 回执（append-only）

> **追加约定**：每个工作槽完成后在文件末尾追加一节回执，不得修改或删除既有回执。
>
> 注：本分支（`cursor/w4-spec-file-lock-a3e6`）基于 `main @ deda75a`（无此文件）创建，
> 仅含本槽一节回执，不携带他槽回执副本；合并时按既定约定与其他分支版本取**并集追加**，
> 保留全部历史回执。

---

## 回执：W4 / 计划槽「W2-GAP-T04 文件锁实现规格」

- **日期**：2026-08-27（UTC）
- **槽位**：第 4 波 / 周期 W4 / 计划槽 W2-GAP-T04 文件锁实现规格
- **分支**：`cursor/w4-spec-file-lock-a3e6`（基于 `main @ deda75a`，docs-only，已 push，未开 PR）
- **产出**：
  - `docs/wave-04/spec-file-lock.md` — **SPEC-07** 项目级文件锁可实现规格（GAP-04 裁决 §3.4「机制要点」的开工级细化，全部裁决条款原样沿用不改义）：`.sw/lock` 内容 schema v1 冻结（pid/hostname/acquired_at 三键，acquired_at 纯展示不参与判定）；获取协议 = `mkdir -p .sw/` + `'wx'` 独占创建（GAP-04「独占创建而非 flock」裁定落实，明令禁用 temp+rename——会摧毁 `O_EXCL` 互斥）；释放 = finally 语义 + 尽力而为 unlink（ENOENT 容忍对偶 ADR-0002）；接线只在 CLI 命令层包装器（app 层不取锁 → draft D3 补大纲、restore auto-safety 快照等嵌套结构性无重入）；「锁在 load 之前取」杜绝陈旧读写窗口（D32 If-Match 的单机化语义）；stale 判定四边缘逐一裁定（同机 pid 不存活→接管 + stderr 告警、他机 hostname→按持有中、不可解析→不接管走 doctor 自愈出口、接管竞态→单次重试输家 E012）；`SW-E012` ctx 与三段式成文（登记仍随首个触达用例，非预填）；**全命令锁矩阵 v1 正典**（init 特殊次序——E010/E013 判定先于取锁防自我否决；outline/draft/revise/export/check --fix --write/snapshot/restore 加锁，status/doctor/revise --list/check 只读/history/diff 不加锁；新命令默认规则 + 表驱动覆盖度防线）；doctor `project-lock` 检查项四态契约（替换「未实现」skip；GAP-04「可由 doctor 修复」解释裁定为检测 + 给修复命令、不自动删改）；验收 **AT-L01…L15** 二值清单（GAP-04 验收 ①–④ 全覆盖 + 幂等回归 EP-04 不回退 + ADR-0002 边界字节级断言）；非目标 10 条红线；对齐点与勘误登记 7 条（append-only）
  - `docs/wave-04/ready-tasks.md` — 新建 wave-04 队列，**仅含 WAVE04-LOCK 分区**（wave-04 首个分区）：W4-LOCK-T01（锁基元 + 既有写命令接线 + SW-E012 + stale 接管，P1/M，ready——集成分支已就绪）、W4-LOCK-T02（doctor 四态接入，P1/S，blocked 于 T01 与 doctor 并入集成线）；按 W3-CHECK 承接先例 **T01+T02 细化并核销 W2-GAP-T04**（ID 不复用不改义，实现槽提交信息同时引用两个 ID）；draft/export/revise/check/snapshot 各行锁接线归各自实现任务，不重复立项
  - `docs/DISPATCH-receipt.md` — 本回执（本分支仅此一节，合并取并集）
- **关键结论**：GAP-04 的四条验收要点全部细化为可执行 AT 且无一改义；最重的三处裁定是 ① 锁获取次序（argparse → project.yaml 存在性探测 → 取锁 → loadProject，防止非项目目录留 `.sw/` 垃圾且杜绝陈旧读；init 走特殊次序）、② 不可解析锁不自动接管（微秒级创建窗口内删锁可能误杀活锁，自愈出口走 doctor 红项 + 手工删除，登记为 v1 已知限制）、③ 「可由 sw doctor 修复陈旧锁」解释定案为 doctor 只诊断给命令不自动删改（与 doctor 既有契约一致，不新增 --fix-lock）。锁与幂等正交：EP-04 字节级幂等断言原样成立（AT-L12 回归锁死）；与 W2-Q1-T01 幂等契约矩阵建议合表（对齐点，不重立机制）。**新发现并登记一处跨分支撞号**：集成分支 E013 = init「目标是文件」vs doctor 分支 E013 = 红项聚合，doctor 并入必撞——已核对占用建议顺延 E015，裁决归集成槽（规格 §11-2）。
- **复用声明**：只引用不重做——GAP-04 裁决全文、P2 D5–D7/D32–D34、W2-Q1 承接确认、doctor `lockCheck` 承接位与 `LOCK_FILE` 常量、集成分支错误注册表与 `run.ts` 退出码、`writeFileAtomic` 与 init 判定次序、SPEC-05 §3-3 锁矩阵先例、SPEC-F2 §5.2-4/§5.11 并发与 ADR-0002 条款（锚点均在规格 §2）；错误码占用经全分支实测核对（E010/E011/E012 预留/E013 双占用/E014/E030–E034/E04x/E05x）；`SW-E012` 只成文未登记（SPEC-03 非预填纪律由 W4-LOCK-T01 随触达用例执行）；SPEC-07 与 W4-LOCK 编号经全分支检索确认未被占用。
- **阻塞**：无新增。W4-LOCK-T01 就绪（W3-PLAN-T02 集成分支已存在）；T02 blocked 于 doctor 并入集成线属正常前置；E013 撞号是集成槽的先行定案项，非本槽阻塞。
- **合规声明**：未创建子代理；未创建 PR；未使用 Task；本槽 docs-only，零 `src/` 改动、零测试与 CI 配置改动（未删测、未跳过失败、未降低 CI 标准，且规格与任务明细均明确「CI 门不可降标、测试只增不减、断言只迁移不删除」）；未合并任何内容进 `main`。
