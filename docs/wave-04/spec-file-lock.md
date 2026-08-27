# W4 计划槽：SPEC-07 项目级文件锁实现规格（W2-GAP-T04 开工依据）

| 项目 | 内容 |
| --- | --- |
| 波次 / 槽位 | 第 4 波（wave-04）/ 周期 W4 / 计划槽「W2-GAP-T04 文件锁实现规格」 |
| 仓库 | github.com/Dawan2/script-writer |
| 基线 | `main @ deda75a`（docs / 计划槽按集成图 §5 约定基于 main；引用的实现与规格均在各分支，锚点见 §2） |
| 工作分支 | `cursor/w4-spec-file-lock-a3e6`（已 push，未开 PR） |
| 文档性质 | 可实现级规格（SPEC-07）：把 GAP-04 裁决的「机制要点」（`docs/wave-02/P-gap-adjudication.md` §3.4）细化到「实现槽拿到即可开工」——锁文件形态与内容 schema、获取/释放协议与接线次序、stale 判定与自动接管（含全部边缘裁定）、`SW-E012` 三段式、全命令锁矩阵 v1（写命令清单）、doctor 锁健康检查项四态、验收测试清单 AT-L01…L15 逐条定死 |
| 硬边界 | **docs-only**：本槽零 `src/` 改动、零测试与 CI 配置改动（集成线仍在推进，任何提前实现都会加宽冲突面） |
| 配套文档 | `docs/wave-04/ready-tasks.md`（新建，仅含 WAVE04-LOCK 分区）、`docs/DISPATCH-receipt.md`（追加回执） |

> **给合并者的索引行**（并入 `docs/README.md` wave-04 分区时粘贴）：
> `- [wave-04/spec-file-lock.md](./wave-04/spec-file-lock.md) — SPEC-07 项目级文件锁（.sw/lock）可实现规格：获取/释放协议、stale 接管、SW-E012、全命令锁矩阵 v1、doctor 锁检查项四态、验收测试 AT-L01…L15（W4 计划槽，W2-GAP-T04 开工依据）`

---

## 1. 结论速览（TL;DR）

1. **GAP-04 裁决全部条款原样沿用，本文只细化不改义**：项目级建议性文件锁 `.sw/lock`（pid / hostname / acquired_at），写命令启动获取、退出释放，只读命令不加锁；占用报 `SW-E012`；stale（持锁 pid 不存活）自动接管并告警；doctor 增锁健康检查项。以上每条在 GAP-04（§3.4）均已裁决——本文补的是开工缺口：**内容 schema 逐字段定死（§3.2）、获取的系统调用语义与接线次序定死（§3.3–3.5）、stale 的四类边缘（不可解析 / 他机 / pid 复用 / 接管竞态）逐一裁定（§4）、`SW-E012` 的 ctx 与三段式成文（§5）、写命令清单从「三命令」扩到全命令正典矩阵（§6）、doctor 检查项从「未实现」skip 到四态契约（§7）、验收从 4 条要点扩到 15 条二值 AT（§9）**。
2. **锁矩阵 v1 正典在本文 §6**：SPEC-05/06 公共契约 §3-3 的锁矩阵（draft/export/revise 三命令）与 SPEC-F2 §5.2-4 的「并发由 GAP-04 统一约束」注记都是本矩阵的子集/前向引用；矩阵覆盖已实现与已规格化的全部命令（init / outline / draft / revise / export / status / doctor / check / snapshot / restore / history / diff），并给出**新命令默认规则**（凡写项目目录内任何文件——含 `.sw/` 存档——者加锁；纯只读不加锁）与漏接线防线（表驱动覆盖度测试 AT-L15，与 W2-Q1-T01 幂等契约矩阵同源对齐，§8.3）。
3. **实现任务不重复立项**：实现任务仍为 **W2-GAP-T04**（GAP-04 承接任务，ID 不复用不改义）。`docs/wave-04/ready-tasks.md` WAVE04-LOCK 分区按 W3-CHECK 承接先例登记 W4-LOCK-T01/T02 细化并核销 W2-GAP-T04（实现槽提交信息同时引用两个 ID），拆分理由：doctor 检查项接入依赖 doctor 分支并入集成线，与锁基元的前置不同。
4. **发现一处跨分支撞号并登记（不裁决）**：集成分支已把 `SW-E013` 登记为 init「目标是文件」（W3 集成 E010 双现场拆分），而 doctor 分支把 `SW-E013` 用作红项聚合——doctor 并入集成线时必撞号（§11-2）。本文用码仅 `SW-E012`（两个谱系一致预留给锁），不受影响；裁决归集成槽。
5. 本槽 docs-only：不做功能开发、不开 PR、不建子代理、不触碰任何测试与 CI 配置。

---

## 2. 输入与依据（只引用，不重做）

| 来源 | 分支 @ 提交 | 消费内容 |
| --- | --- | --- |
| GAP-04 裁决（上游正典） | `cursor/w2-gap-adjudication-c82d @ 661b313` | §3.4 机制要点全文（锁形态 / SW-E012 / stale / doctor 联动 / 与 P2 D32 对应 / 与 ADR-0002 兼容）、W2-GAP-T04 任务定义（`src/infra/store/lock.ts`、独占创建而非 flock 的可移植性裁定）、勘误表 #7 |
| P2 可靠性裁决 | `cursor/w1-p2-interaction-reliability-a3c2 @ 7873b66` | D5–D7（幂等键 / 客户端 ID upsert）、D32–D34（If-Match 版本前置写 / 409 UX / 分块）——对齐基准，不迁移 |
| W2-Q1 CLI 适配 | `cursor/w2-q1-p2-cli-adaptation-1f96 @ b9966cd` | §3 T05 行「D32 的 CLI 单机对应物 = 项目级文件锁（承接 W2-GAP-T04，不新立）」、W2-Q1-T01 命令幂等契约矩阵（「未声明策略的新写命令 CI 失败」防线，§8.3 对齐） |
| doctor 实现 | `cursor/w3-doctor-3e3d @ 6fdc03c` | `checks.ts` 的 `lockCheck`（id `project-lock`，现为「未实现」skip）与 `LOCK_FILE = '.sw/lock'` 常量、`DOCTOR_CHECKS` 可注册数组、pass/fail/skip 三态契约（fail 必附可复制修复命令）、§5 交接项「T04 落地后替换 lockCheck」 |
| 集成分支（正典实现线） | `cursor/w3-integrate-w2-f334 @ e2721d4` | 错误注册表（E010/E011/E013/E020/E021/E022/E030/E031 在用；**E013 = init「目标是文件」**）、`fail(code, ctx)` 唯一入口、`run.ts` 顶层 catch 与退出码 0/1/2、`writeFileAtomic`（temp+rename）、`runInitWorkflow` 的 E010/E013 判定次序 |
| outline 实现 | `cursor/w3-outline-templates-5596 @ 425c44f` | `ensureOutline` 写面（outline.md + project.yaml 状态回写）——锁矩阵 outline 行的事实依据 |
| SPEC-05/06 与公共契约 | `cursor/w3-spec-draft-export-revise-193d @ 017212c` | §3-3 锁矩阵（draft/export/revise 行先例：「实现前本行为空转不阻塞」）、§3-2 退出码、draft D3 自动补大纲（嵌套调用不得重入取锁的事实依据） |
| SPEC-F1/F2（check/快照） | `cursor/w3-spec-check-snapshot-973a @ f751d2e` | §5.2-4「并发……GAP-04 文件锁落地后由其统一约束，本规格不预置」、§5.11 ADR-0002 要点（`.sw/lock` 为运行时临时物，锁语义由 GAP-04 自治）、check `--fix --write` 写面、restore 写面 |
| 集成图 | `cursor/w3-integration-map-bf24 @ 43a6ecf` | §5 基分支纪律（docs / 计划槽基于 main；功能槽基于集成分支头）、W3-PLAN-T02（集成分支就绪） |
| SPEC-03-EXT 退出码 | `docs/wave-02/P-gap-adjudication.md` §3.6（已吸收进集成分支） | 0 成功 / 1 运行期错误 / 2 用法错误，禁止自定义 |

冲突处理沿用既定纪律：先落地者为准、追加勘误不删改他槽原文、任务 / 字段 / 错误码 ID 一经引用不复用不改义。

---

## 3. SPEC-07 锁机制核心

### 3.1 形态与定位（GAP-04 原文，逐条落实）

- **路径**：`<项目根>/.sw/lock`。常量正典迁至 `src/infra/store/layout.ts`（`LOCK_FILE = '.sw/lock'`），doctor 分支 `checks.ts` 的同名导出改为从 layout 导入（迁移随实现同提交，登记 §11-1）。
- **性质**：**建议性锁（advisory）+ 瞬态互斥件**。互斥的凭据是**文件的存在本身**（独占创建成功 = 持有），文件内容只是给人看与给判定用的元数据。非状态源：删除无持有者的 `.sw/lock` 后一切命令行为不变，下次写命令自动重建（ADR-0002 边界，AT-L07 锁死）。
- **粒度**：项目级单锁。同一项目同一时刻至多一个写命令进程；不同项目互不影响；不做文件级 / 场级细粒度锁（非目标 §10-6）。
- **实现取向**：**独占创建锁文件（`O_EXCL`），不用 `flock`/`fcntl` 系统调用**——GAP-04 任务风险条款既定（Windows 无 POSIX flock 语义，可移植性优先），本文不重裁。

### 3.2 锁文件内容 schema（v1 冻结）

```yaml
pid: 12345
hostname: writers-laptop
acquired_at: 2026-08-27T10:31:07Z
```

- 三键齐备、无更多键；YAML 子集（三行标量），可被 doctor 的子集解析器与未来严格解析器同样读出。
- `pid`：持锁进程 `process.pid`（正整数）。
- `hostname`：`os.hostname()` 原样字符串——stale 判定的同机前提（§4.2）。
- `acquired_at`：UTC ISO-8601（`YYYY-MM-DDTHH:mm:ssZ`，秒级）——纯展示用（E012 消息与 doctor 报告），**不参与任何判定**（不做 TTL / 超时过期，非目标 §10-3；挂钟不可信）。
- 单测锁 schema：AT-L08。

### 3.3 获取协议

```text
① mkdir -p <项目根>/.sw/                        # 幂等；.sw/ 与快照存档共居（ADR-0002 兼容）
② open(<项目根>/.sw/lock, 'wx') 并写入 §3.2 内容  # 'wx' = O_CREAT|O_EXCL|O_WRONLY，独占创建
   ├─ 成功 → 持有，进入命令主体
   └─ EEXIST → 进入 stale 判定（§4）：
        ├─ 判定 stale → 自动接管（§4.3）
        └─ 判定持有中 → fail('SW-E012', ctx)（§5）
```

- **锁文件不走 `writeFileAtomic`**（temp+rename 会绕过 `O_EXCL`，摧毁互斥）；用 `fs.writeFile(path, content, { flag: 'wx' })` 一次调用完成独占创建 + 写内容。创建成功与内容写完之间存在微秒级窗口，此窗口内被 kill 会留下空/半内容锁——该边缘的处置见 §4.4（不自愈、doctor 红项），登记为 v1 已知限制。
- `EEXIST` 之外的失败（权限、磁盘满等）不属锁语义：原样上抛，走顶层 catch 的裸异常兜底（退出码 1），不伪装成 E012。

### 3.4 释放协议

- **`finally` 语义**：命令主体无论成功、`fail()` 失败还是抛裸异常，只要本进程**已获得**锁就必须释放（AT-L06 双分支锁死）。未获得锁（E012 路径、只读命令）绝不删别人的锁。
- 释放 = `unlink` 锁文件。**尽力而为**：
  - `ENOENT`（已被用户手工删除）→ 静默容忍（ADR-0002「删锁行为不变」的对偶：删了就删了，不报错）；
  - 其他失败（权限漂移等）→ stderr 输出一行告警（`⚠ 项目锁释放失败：<原因>；下次写命令将按陈旧锁自动接管`），**不改变命令退出码**——本进程退出后 pid 不再存活，残锁会被下一次写命令按 §4 自动接管，自愈闭环成立。
- kill -9 等硬终止无法执行释放：这正是 stale 接管（§4）存在的原因，不做额外补救（无 signal handler 花活——`SIGKILL` 本就接不住，接 `SIGINT/SIGTERM` 做清理属锦上添花，v1 不做，非目标 §10-7）。

### 3.5 接线位置与执行次序（防重入的结构性裁定）

- **锁的获取/释放只发生在 CLI 命令层**（`src/cli/commands/*`）的统一包装器中：infra 提供原语（`src/infra/store/lock.ts`：`acquireProjectLock(dir)` / `releaseProjectLock(dir)` / 高层 `withProjectLock(dir, fn)`），**app 层工作流函数（`runInitWorkflow` / `ensureOutline` / 未来 draft/export/revise 用例）一律不取锁**。由此 draft D3 内部调用 `ensureOutline`、restore 内部触发 auto-safety 快照等嵌套场景**结构性无重入问题**——每进程每命令至多取锁一次，无需实现可重入计数（非目标 §10-5）。
- **既有项目写命令的执行次序**（init 除外，见 §6.2）：

```text
① argparse（用法错误退出码 2，不触锁、零副作用）
② 探测 <dir>/project.yaml 存在性（cheap stat，不解析）
   └─ 缺失 → 不取锁，直接进入既有 loadProject 失败路径（SW-E011）
      ——防止在任意非项目目录留下 .sw/ 垃圾
③ 取锁（§3.3；含 stale 接管）
④ loadProject 完整读取校验（E020/E021/E022 等既有路径）
⑤ 命令主体（读-改-写全程在锁内——锁在 load 之前取，杜绝「基于陈旧读的写」）
⑥ finally 释放（§3.4）
```

- ②③ 之间的竞态（探测后项目被删）良性：④ 会以既有错误路径失败，锁在 finally 释放，无残留副作用。
- **测试缝**：`withProjectLock` 的锁原语可注入（同 doctor `DoctorContext` 注入先例），供 AT-L11 竞态单测模拟。

---

## 4. stale 判定与自动接管

### 4.1 判定入口

仅在取锁遇 `EEXIST` 时进入（只读命令与 doctor 永不判定、永不接管——doctor 只报告，§7）。读取锁文件内容并解析（§3.2 schema）：

| 解析结果 | 走向 |
| --- | --- |
| 三键齐备可解析 | → §4.2 存活判定 |
| 文件消失（读时 ENOENT——持有者恰好释放） | → 重试独占创建一次；再失败按当次结果重新判定 |
| 空文件 / 缺键 / 不可解析 | → §4.4 不可解析锁（不接管） |

### 4.2 存活判定（同机前提）

- `hostname` ≠ 本机 `os.hostname()` → **无法判定存活，按持有中处理**（fail E012，消息含他机名；网络盘共享项目属 v1 例外场景，登记已知限制）。doctor 侧对应 skip 态（§7）。
- `hostname` = 本机 → `process.kill(pid, 0)` 探测：
  - 抛 `ESRCH` → pid 不存活 → **stale**，进入接管（§4.3）；
  - 成功或抛 `EPERM`（进程存在但无权限发信号）→ 存活 → fail E012。
- **pid 复用假阳性**（持锁进程已死、pid 被无关进程复用 → 误判存活）：v1 接受，由 E012「怎么办」段的 doctor 指引兜底（§5）；不做进程启动时间比对等身份校验（非目标 §10-4）。

### 4.3 自动接管

```text
① unlink 陈旧锁（ENOENT 容忍——别的进程抢先接管了）
② 重新独占创建（§3.3 的 'wx'，仅重试这一次）
   ├─ 成功 → stderr 告警一行，命令照常执行，退出码不变
   └─ EEXIST → 接管竞态输家：不再循环，按当前锁内容 fail('SW-E012', ctx)
```

- **告警行**（stderr，保持 stdout 的「末行可复制」契约零污染）：
  `⚠ 检测到陈旧项目锁（pid <pid> 已不存活，acquired_at <acquired_at>），已自动接管`
- 接管竞态（两进程同时发现同一 stale 锁）：unlink + 重建非原子，靠「只重试一次、输家 E012」保证**恰一个进程获锁、无死锁、无双写**（AT-L11 注入式单测锁死）。输家收到的 E012 是正确结果——此刻锁确实被赢家（存活进程）持有。

### 4.4 不可解析锁（不自愈路径）

- 空文件 / 缺键 / 不可解析 → **按持有中处理，不自动接管**：无法确认 pid，删除可能误杀活锁（§3.3 的微秒窗口内可能正有进程刚创建未写完）。fail E012，持有者字段显示「未知（锁文件内容不完整或损坏）」。
- 自愈出口：doctor 红项 + 可复制修复命令（§7），用户确认无 `sw` 进程后手工删除；下次写命令自动重建。
- 登记为 v1 已知限制（与 §3.3 的创建窗口同源）；不引入「按 mtime 老化视为 stale」的时间阈值（挂钟不可信，非目标 §10-3）。

---

## 5. `SW-E012` 规格（三段式成文）

- **段位**：E01x 项目 / 文件系统（编号顺延 E010/E011，GAP-04 预留且两谱系一致，本文确认占用）。
- **ctx**（注册表 `ErrorContexts` 条目）：

```ts
'SW-E012': {
  dir: string;                    // 项目根（用户书写形态）
  holderPid: number | null;       // 锁文件解析出的 pid；不可解析时 null
  holderHostname: string | null;  // 同上
  acquiredAt: string | null;      // 同上（原样字符串，不重格式化）
}
```

- **三段式模板**（成文供登记，字段占位符按注册表既有 `{name}` 形态）：
  - **what**：`项目正被另一个进程写入（项目锁被占用）`
  - **why**：`{dir}/.sw/lock 当前由 pid {holderPid}（主机 {holderHostname}，获取于 {acquiredAt}）持有；同一项目同一时刻只允许一个写命令，以防两个进程互相覆盖（丢失更新，GAP-04 裁决）。`（ctx 为 null 时渲染层显示「未知（锁文件内容不完整或损坏）」——渲染细节实现槽定，消息语义以本行为准）
  - **fix**：`若确有另一条 sw 命令正在运行，等它完成后重试。若确认没有 sw 进程在运行（进程残留、pid 被复用、他机残留或锁文件损坏），运行 \`sw doctor\` 核对锁健康，并按其红项给出的命令删除 .sw/lock——确认无持有进程后删除是安全的，下次写命令会自动重建。`
- **「可由 sw doctor 修复陈旧锁」的解释裁定**（GAP-04 原文该句存在两读）：doctor **检测并给出可复制修复命令**，不自动删改（与 doctor 既有「fail 必附修复命令、诊断不写盘」契约一致）；不新增 `--fix-lock` 旗标（非目标 §10-8）。登记 §11-4。
- **登记纪律**：预留 ≠ 登记——`SW-E012` 随首个实际触达用例（AT-L01 并发互斥）在 W4-LOCK-T01 实现提交内登记进 `ErrorContexts`/`ERROR_REGISTRY` + `gen:errors` 产出 `docs/errors/SW-E012.md` + `lint:errors` 全绿（SPEC-03「禁止预填未用码」）。
- **退出码**：1（SPEC-03-EXT 第 1 行实例，经 `fail()` 唯一入口，业务代码零 `process.exit`）。

---

## 6. 写命令清单与锁矩阵 v1（正典）

### 6.1 矩阵

判定标准（新命令默认规则，一句话）：**凡向项目目录内写任何文件者（含 `.sw/` 存档与 `exports/` 派生物）= 写命令，加锁；纯只读 = 不加锁。**

| 命令 | 写面 | 锁 | 接线归属 | 状态 |
| --- | --- | --- | --- | --- |
| `sw init`（含 `--yes` / `--force`） | 项目文件树创建 / 重建 | **加锁**（特殊次序 §6.2） | W4-LOCK-T01 | 已实现（集成分支） |
| `sw outline` | `outline.md` 骨架 + `project.yaml` 步骤回写 | **加锁** | W4-LOCK-T01（outline 并入集成线后接线） | 已实现（outline 分支） |
| `sw draft <id> [--title]`（含 D3 自动补大纲） | `scenes/` + `project.yaml` | **加锁** | W3-DRAFT-T01 按本矩阵接线 | 已规格（SPEC-05） |
| `sw draft <id> --done` | `project.yaml` | **加锁** | 同上 | 已规格（SPEC-05） |
| `sw revise`（无参数）/ `<id>` / `--done` | `project.yaml`（步骤 / `scenes_revised` 回写） | **加锁** | W2-GAP-T01 按本矩阵接线 | 已规格（SPEC-04 + 增补） |
| `sw revise --list` | 无（纯只读，供脚本消费） | 不加锁 | — | 已规格（SPEC-04） |
| `sw export [--format] [--out]` | `exports/` 产物 + `project.yaml` | **加锁** | W3-DRAFT-T02 按本矩阵接线 | 已规格（SPEC-06） |
| `sw status` | 无 | 不加锁 | — | 已实现 |
| `sw doctor` | 无（诊断不写盘） | 不加锁（活锁持有期间照常运行——GAP-04 验收 ③） | — | 已实现（doctor 分支） |
| `sw check`（默认 / `--format` / `--profile` / `--fix` dry-run） | 无（dry-run 零写盘） | 不加锁 | — | 已规格（SPEC-F1） |
| `sw check --fix --write` | 内容文件（白名单） | **加锁** | W3-CHECK-T02 按本矩阵接线 | 已规格（SPEC-F1 §4.7） |
| `sw snapshot [--label]` | `.sw/history/`（对象 + index 提交点） | **加锁**（快照的跨文件一致性依赖：锁内快照读到的多文件组合不含半事务） | W3-CHECK-T03 按本矩阵接线 | 已规格（SPEC-F2） |
| `sw restore <ref> [--scene]` | 内容文件 + auto-safety 快照 | **加锁** | W3-CHECK-T03/T04 按本矩阵接线 | 已规格（SPEC-F2） |
| `sw history` / `sw diff` | 无 | 不加锁 | — | 已规格（SPEC-F2） |

- SPEC-05/06 公共契约 §3-3 的三命令锁矩阵是本表子集，两者一致、无勘误必要；其「实现前本行为空转不阻塞」条款对本表所有「已规格」行同样适用——**锁先落地则未实现命令的行为不受影响；命令先落地则暂不取锁，锁落地时由对应实现任务按本表接线**（接线归属列即责任任务，随各自实现提交交付，不在 WAVE04-LOCK 重复立项）。
- 模型网关的 fixtures 写入面（`tests/fixtures/gateway/`，SPEC-G2）在**仓库**而非用户项目目录，不属本矩阵范围。

### 6.2 `sw init` 的特殊次序

init 运行时项目可能尚不存在，且「目录非空」判定（E010）先于一切副作用——若先创建 `.sw/lock` 会把空目录变非空、自我否决。裁定次序：

```text
① argparse
② inspectDir 判定（E013 目标是文件 / E010 非空且无 --force）——沿用既有实现，零改动
③ mkdir -p <target>/.sw/ + 独占创建锁（§3.3；含 stale 接管）
④ 收集答案 → 模板渲染 → materialize 原子写入（既有流程）
⑤ finally 释放
```

- ②③ 间竞态（两个并发 init 同时通过 ② 的判定）由 ③ 收敛：恰一个获锁，输家 E012（AT-L14）。
- init 结束后 `.sw/` 目录留存（空目录，锁已释放）：合法——`.sw/` 属本地存档区（ADR-0002），模板 `.gitignore` 已收录整行 `.sw/`（SPEC-F2 / AT-S13）；不做「用完删目录」的洁癖清理（快照/后续锁都要用它）。

### 6.3 漏接线防线

- 实现槽交付**表驱动覆盖度测试**（AT-L15）：以锁矩阵的「加锁」行清单为数据源（代码内单一常量声明），逐命令断言「锁被活进程持有 → 命令 fail E012 且零写盘副作用」；命令已声明加锁但未接线、或新写命令未进清单，测试即红。
- 该清单与 W2-Q1-T01 的「命令幂等契约矩阵（未声明策略的新写命令 CI 失败）」是同一防线的两列——**建议合表**（每写命令一行：幂等策略 + 锁策略），登记为对齐点 §11-5，由先落地者定表结构，不在本文重立机制。

---

## 7. doctor 锁健康检查项（替换 `project-lock` 的「未实现」）

承接 doctor 槽交接项：替换 `src/app/diagnostics/checks.ts` 的 `lockCheck`（id `project-lock`、title `项目锁` 均不变，`DOCTOR_CHECKS` 数组零结构变动）。四态契约：

| # | 现场 | 态 | detail / fix |
| --- | --- | --- | --- |
| 1 | 无 `.sw/lock` 文件 | **pass** | `无项目锁文件，无持有者` |
| 2 | 锁存在、可解析、同机 pid 存活 | **pass** | `项目锁由 pid <pid> 持有（存活，获取于 <acquired_at>）——另一条写命令正在运行，属正常并发` |
| 3 | 锁存在、可解析、同机 pid 不存活（stale） | **fail（红）** | detail：`发现陈旧项目锁：pid <pid> 已不存活（获取于 <acquired_at>）`；fix：`rm <dir>/.sw/lock`（可复制；或注明「任意写命令会自动接管并告警」）——GAP-04 验收 ④ |
| 4a | 锁存在、内容不可解析（空 / 缺键 / 损坏） | **fail（红）** | detail：`项目锁文件内容不完整或损坏，无法判定持有者`；fix：`确认无 sw 进程在运行后执行 rm <dir>/.sw/lock`（§4.4 的自愈出口） |
| 4b | 锁存在、可解析、hostname 非本机 | **skip** | `锁由他机 <hostname> 持有（pid <pid>），无法在本机判定存活；确认该机无 sw 进程后可手工删除 <dir>/.sw/lock`——不出假红（doctor 红项必须本机可行动），如实登记 |

- doctor 全程只读：**永不删锁、永不接管**（接管只属写命令取锁路径，§4.1）。
- 检查项异常（读锁文件权限错误等）沿用 doctor 既有「单项异常转红项、报告完整产出」的编排契约，零新机制。
- 退出码沿用 doctor 既有裁定：红项>0 → `SW-E013`（doctor 分支现行聚合码）→ 1；**注意该聚合码在集成时须改号**（撞号登记 §11-2），本文不依赖其具体码值。

---

## 8. 与 P2 幂等 / ADR-0002 的对齐（引用不改义）

### 8.1 与 P2 D32–D34（版本前置写）

- 文件锁是 **D32（If-Match 版本前置写）的 CLI 单机对应物**——目标同为杜绝丢失更新，形态不同实现不同（GAP-04 原句；W2-Q1 §3 T05 行确认承接）。本文 §3.5 的「锁在 load 之前取」正是 If-Match 语义的单机化：写基于的读永远发生在互斥区内，不存在「陈旧读 → 覆盖写」窗口。
- Web 形态启动后写路径切 D32/D33（409 三选一 UX 属延后清单），**文件锁不迁移、不废弃**（本地 CLI 继续用）——W2-Q1 §4 已确认，本文原样沿用。
- D34（分块存储留 CRDT 余地）在 CLI 阶段由分场即一文件天然满足（W2-Q1 登记事实），与锁无交互。

### 8.2 与 D5–D7 幂等语义（EP-04）

- **锁不改变任何幂等契约**：加锁后，重复执行 `--done` 类命令 `project.yaml` 仍字节不变、重复 export 产物仍字节级相同（SPEC-05 ②③ / SPEC-06 ② 验收原样成立，AT-L12 回归锁死）。锁管「同时写」，幂等管「重复写」，正交。
- scene-id 即客户端 ID upsert（D7 的 CLI 映射，W1-B EP-04）不受影响；W1-B EP-11「并发写未裁决」由 GAP-04 闭合、由本文可实现化。

### 8.3 与 W2-Q1-T01 幂等契约矩阵

- 本文 §6.3 的锁接线清单与 Q1 的幂等策略矩阵共享「写命令全集 + 未声明即 CI 失败」结构，建议合表（对齐点 §11-5）；两任务先落地者定表结构，后者并入列，互不阻塞。

### 8.4 与 ADR-0002（状态 vs 存档）

- `.sw/lock` 为**瞬态互斥件、非状态源**：删除（无持有者时）行为不变、自动重建（GAP-04 勘误表 #7 已请 ADR-0002 定案时纳入说明；SPEC-F2 §5.11-2 已含「锁的语义由 GAP-04 自治」条款——本文即该自治语义的正典）。AT-L07 以字节级断言锁死该边界，形态对齐快照规格的 AT-S12。
- 锁与 `.sw/history/` 共居 `.sw/`：互不感知——快照白名单（G6）不含 `.sw/` 自身，锁文件永不入快照。

---

## 9. 验收测试清单 AT-L01…L15（全部二值）

| # | 断言 | 层级 | 对应 GAP-04 验收 |
| --- | --- | --- | --- |
| AT-L01 | 双进程并发写互斥：进程 A 持锁执行写命令（测试注入慢写挂起），进程 B 对同一项目执行写命令 → B 得 `SW-E012` 三段式、退出码 1、**零写盘副作用**（B 运行前后目录快照字节级一致）；A 正常完成、数据完整 | 进程级集成 | ① |
| AT-L02 | kill -9 持锁进程（锁内容已写全）→ 下一次写命令自动接管：stderr 恰一行告警（含 stale pid 与 acquired_at）、stdout 契约不变、退出码 0、锁文件内容更新为新进程 pid | 进程级 | ② |
| AT-L03 | 锁被存活进程持有期间：`sw status`、`sw doctor`、`sw revise --list`（落地后）照常运行，输出与无锁时一致（doctor 的 project-lock 行除外），退出码按各自语义 | 进程级 | ③ |
| AT-L04 | stale 锁下 `sw doctor`：`project-lock` 红项 + 可复制修复命令（含真实路径）；按命令删除后重跑 doctor 全绿退出码 0 | 进程级 | ④ |
| AT-L05 | doctor 四态另三态：无锁 → pass；活锁 → pass（注明持有者 pid 存活）；不可解析锁 → 红项 + 修复命令 | app 层 + cli 层 | ④ 扩展 |
| AT-L06 | 释放的 finally 语义双分支：命令成功后锁文件不存在；命令以 `fail()` 失败（如 E030）后锁文件同样不存在 | app 层 | — |
| AT-L07 | 删除无持有者的 `.sw/lock` 后，写命令行为与删除前**逐字节一致**（stdout/退出码/产物），且锁被自动重建——ADR-0002 边界（形态对齐 AT-S12） | 进程级 | — |
| AT-L08 | 锁内容 schema：pid/hostname/acquired_at 三键齐备无多余键、pid = 持锁进程实际 pid、acquired_at 合法 UTC ISO-8601 | 单测 | — |
| AT-L09 | 不可解析锁（空文件）→ 写命令 `SW-E012`（持有者显示未知）、**不**自动接管、锁文件原样留存 | 进程级 | — |
| AT-L10 | 他机 hostname 锁 → 写命令 `SW-E012`（消息含他机名）不接管；doctor 该项 skip 且注明他机与手工处置指引 | app 层 | — |
| AT-L11 | 接管竞态：注入锁原语模拟「unlink 后重建遇 EEXIST」→ 输家恰好一次重试后 `SW-E012`、无循环无死锁；赢家路径正常（§3.5 测试缝） | 单测 | — |
| AT-L12 | 幂等回归：接线后重复 `--done` 类命令 `project.yaml` 字节不变（EP-04）；全部既有命令 stdout 契约（末行可复制）与既有测试**零删除零跳过** | 既有套件回归 | — |
| AT-L13 | 登记纪律：`SW-E012` 进注册表 + `docs/errors/SW-E012.md` 生成 + `lint:errors` 全绿；进程级退出码断言进 `smoke:exit-codes`（E012 → 1） | CI 门 | — |
| AT-L14 | init 接线：预置活锁于目标目录 → `sw init --force` 报 E012 且目录内容零变化；预置 stale 锁 → init 接管成功、产物完整；E010/E013 判定仍先于取锁（用法错误与非空目录路径零 `.sw/` 副作用） | 进程级 | ①②扩展 |
| AT-L15 | 表驱动覆盖度：锁矩阵「加锁」行清单（代码内单一常量）逐命令断言「活锁持有 → E012 + 零写盘」；清单外新写命令或未接线命令即红（§6.3 防线；未实现命令行自动跳过并注明，落地即纳入） | 集成 | — |

执行口径：全部 AT 进 CI；kill -9 / 双进程用例沿用引擎原子写与 `smoke:exit-codes` 的进程级测试先例；CI 门不可降标（lint / lint:errors / typecheck / test / build / smoke / smoke:exit-codes 全绿 0 跳过）、测试只增不减、断言只迁移不删除。

---

## 10. 非目标（出现即偏离规格）

1. `flock`/`fcntl` 等 OS 锁系统调用（GAP-04 可移植性裁定，独占创建为准）。
2. 锁等待 / 排队 / `--wait` 旗标——占用即 fail-fast E012，等待策略属未来勘误。
3. TTL / 按 mtime 老化过期——挂钟不可信，stale 判定只认 pid 存活。
4. pid 身份校验（启动时间比对防 pid 复用）——v1 接受假阳性，E012 指引兜底。
5. 可重入锁 / 引用计数——接线层结构性保证每进程至多取一次（§3.5）。
6. 文件级 / 场级细粒度锁；读锁 / 共享锁。
7. `SIGINT`/`SIGTERM` 信号钩子清理——stale 接管已闭环。
8. `sw doctor --fix-lock` 之类自动修复旗标——doctor 只诊断（§5 解释裁定）。
9. 跨主机锁协调（网络盘多机共享）——他机锁按持有中处理 + doctor skip 如实登记。
10. Web 形态并发协议（D32/D33 HTTP 语义）——延后清单原样，锁不迁移不废弃。

---

## 11. 对齐点与勘误登记（append-only，不改写他槽原文）

合并者与相关槽按下表处置；处置前，本表即权威记录。

| # | 对象（分支） | 内容 | 性质 |
| --- | --- | --- | --- |
| 1 | doctor 分支 `src/app/diagnostics/checks.ts` | `LOCK_FILE` 常量正典迁至 `src/infra/store/layout.ts`，checks.ts 改导入（W4-LOCK-T01 实现同提交完成，接口零变化） | 对齐点（代码迁移） |
| 2 | 集成槽（doctor 分支并入时） | **`SW-E013` 跨分支撞号**：集成分支 `@e2721d4` 已登记 E013 = init「目标是文件」（W3 集成 E010 双现场拆分裁定）；doctor 分支 `@6fdc03c` 以 E013 为红项聚合码。按「先落地者为准」，集成分支为正典线——doctor 聚合码并入时须改号；已核对占用：E012 锁（本文）、E014 check 提案（SPEC-F1）、E05x 快照提案、E04x AI 段，**建议顺延取 E015**（裁决归集成槽，本文只登记事实与占用核对） | 冲突登记（不裁决） |
| 3 | SPEC-05/06 公共契约 §3-3（`cursor/w3-spec-draft-export-revise-193d`） | 锁矩阵正典移至本文 §6.1，§3-3 为子集引用，两者现状一致、原文无需回改；仅当未来矩阵变更时以本文为准并追加修订 | 对齐点（无需回写） |
| 4 | GAP-04 原文 §3.4（`cursor/w2-gap-adjudication-c82d`） | 「确认无进程运行后可由 `sw doctor` 修复陈旧锁」解释裁定：doctor 检测 + 给出可复制修复命令，不自动删改（§5、§7）；原文无需回改，语义由本行定案 | 解释裁定 |
| 5 | W2-Q1-T01（`cursor/w2-q1-p2-cli-adaptation-1f96`） | 幂等契约矩阵与本文锁接线清单（§6.3）建议合表——每写命令一行：幂等策略 + 锁策略；先落地者定表结构，后者并入列 | 对齐点（建议） |
| 6 | W1-B §4.5 ER 表（`cursor/w1-b-features-flows-9843`） | `SW-E012` 行由「GAP-04 预留」推进为「已规格化（SPEC-07 本文 §5），登记随 W4-LOCK-T01 触达用例」 | 勘误（合并后回写） |
| 7 | ADR-0002 起草者（W3-CHECK-T03） | 定案时纳入的「`.sw/lock` 瞬态互斥件」一句（GAP-04 勘误表 #7 既有义务）可直接引用本文 §8.4 成文 | 对齐点（供引用） |

---

## 12. 交接

- **给实现槽（W4-LOCK-T01/T02 承接者）**：开工粒度全在本文——原语接口与接线次序 §3、stale 全边缘 §4、E012 成文 §5、矩阵与 init 特殊次序 §6、doctor 四态 §7、AT 清单 §9、非目标红线 §10。基分支**必须取集成分支头**（集成图 §5；禁止从 doctor / outline 单分支分叉）；outline 行与 doctor 检查项的接线分别以 outline / doctor 分支并入集成线为前置（依赖细节见 ready-tasks 分区）。
- **给 draft / export / revise / check / snapshot 实现槽**（W3-DRAFT-T01/T02、W2-GAP-T01、W3-CHECK-T02/T03/T04）：各自落地时按 §6.1 矩阵行接线（CLI 层包装器一行）并把命令加入锁接线清单常量（AT-L15 数据源）；锁未落地时空转不阻塞（SPEC-05 §3-3 既定条款）。
- **给集成槽**：优先处置 §11-2 的 E013 撞号（doctor 并入前定案改号）；本分支三个 docs 文件（`docs/wave-04/` 两个 + 回执追加）与既有分支无同名冲突，按既定并集约定收编。
- **阻塞**：无新增。W4-LOCK-T01 blocked 于集成分支就绪属正常前置；BLK 清单零变化。

---

*W4 计划槽产出 · 分支 `cursor/w4-spec-file-lock-a3e6` · 基线 `main @ deda75a` · 引用锚点见 §2*
