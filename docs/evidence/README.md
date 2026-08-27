# docs/evidence/ —— 证据存档区

> **性质**：本目录存放支撑成熟度评级与任务验收的证据文件（E1–E5），供 W5 核验槽离线复核。
> 本文件是**操作速查**；完整约定的唯一权威来源是
> [`docs/wave-02/evidence-and-ci-conventions.md`](../wave-02/evidence-and-ci-conventions.md)（下称“约定”），
> 两者不一致时以约定为准。E1–E5 的**定义**见
> [`docs/wave-01/maturity-baseline.md`](../wave-01/maturity-baseline.md) §2，本目录不另立标准。

## 目录结构

```
docs/evidence/
├── README.md                  # 本文件
├── wave-<NN>/                 # 按“采集时所处波次”分目录（如 wave-02/）
│   └── <TASK-ID>/             # 目录名照抄任务 ID 原大小写（W1-P1-T04 / TASK-P3-01 / W2-PLAN-T03…）
│       ├── E<1-5>-<slug>.md   # 证据主文件
│       ├── *.raw.log          # 超长原始输出旁存（可选）
│       └── *-NN.png           # 截图附件（可选，≤300KB/张，禁录屏）
└── spot-checks/               # TASK-P3-10 抽检记录（P3 既有约定，长期滚动，格式随 P3-10 交付定义）
```

无任务锚点的证据放 `wave-<NN>/_wave/`。目录随第一份证据创建，不预建空目录。
`runs/*.jsonl` 原始 trace 永不入本目录（也不入 git），只归档脱敏摘要。

## 文件命名

`<证据类型>-<slug>[-<序号>].md`，正则 `^E[1-5]-[a-z0-9]+(-[a-z0-9]+)*(-[0-9]{2})?\.md$`。

例：`E2-lint-typecheck.md`、`E3-vitest-suite.md`、`E4-init-walkthrough.md`、`E4-run-a1b2c3.md`、`E5-ttfs-bench.md`。
重采不覆盖旧文件，追加 `-02` 序号另立新档；**被回执/核验报告/状态行引用过的文件冻结（append-only）**。

## 归档五步（实现槽每完成一个任务执行一遍）

1. 对照该任务验收标准中标注的证据类型（E1–E5），逐条准备证据。
2. 按约定 §3.1 模板写主文件：文件头表（任务 ID / 证据类型 / **锚定 commit** / 日期 / 环境 / 采集人 / 脱敏声明）+ **复现命令** + **原始输出（含退出码）**。缺任一项即证据无效。
3. 原始输出 ≤300 行且 ≤20KB 直接内嵌；超限则“头 50 行 + 尾 50 行 + 截断说明”内嵌，完整版旁存 `.raw.log`（≤200KB）。CI run URL 只能当旁证，**不能替代仓库内存档**。
4. 跑脱敏自查（零命中方可提交，命中须逐条确认误报并写入脱敏声明）：

```bash
rg -n -i -g '!README.md' "(api[_-]?key|secret|token|passwd|password|bearer |sk-[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{16}|-----BEGIN)" docs/evidence/
rg -n -g '!README.md' "(/home/[a-z0-9_-]+|/Users/[A-Za-z0-9_-]+)" docs/evidence/
```

5. 与代码同分支提交；在 DISPATCH 回执列出证据路径。**无证据不得在 ready-tasks 标“完成”**。

## 脱敏底线（全文见约定 §5）

- 凭据（含已失效的）零容忍；来源只写“注入自环境变量 `<变量名>`”。
- 用户路径归一化（`/home/<user>` → `<HOME>`）；邮箱/主机名/内网 IP/云账户 ID 不入档。
- 剧本正文：`tests/`、`templates/` 夹具可全文（注明路径）；真实创作内容只存“场号 + SHA-256 前 12 位 + 字数”。
- 泄露凭据的处置是**立即轮换**并回执登记，删文件不算处置。

## CI 证据红线（全文见约定 §6）

lint（`--max-warnings 0`）/ typecheck / test / build / smoke 五步全绿方可合入；测试通过数只增不减；
新增子命令必附 help 结构性断言（T10 后进 `tests/help-snapshots/`）；
禁止删测、skip/only、`continue-on-error`、放宽 lint/类型严格度、缩小 CI 触发与矩阵、盲更快照。
例外必须走约定 §6.5 登记通道，静默降标 = 违规。
